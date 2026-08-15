import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import path from "node:path";
import { completedSeriesFromMaps, OPENDOTA_TEAMS } from "./live-series.mjs";
import { scheduledSeriesFromCybersportHtml } from "./schedule-source.mjs";
import { buildForecastSource, ROUND_ONE } from "./forecast-engine.mjs";
import { predictTemporalDraft } from "./draft-inference.mjs";
import { liveDraftsFromOpenDota, mergeLiveDraftGames } from "./live-drafts.mjs";
import { buildSnapshotCalculationTrace, probabilityFor as diagnosticProbabilityFor, scoreDiagnosticMatch } from "./forecast-diagnostics.mjs";
import { combinedSeriesForecast, orientedProbability } from "./combined-forecast.mjs";
import { estimateLiveMap } from "./live-map-prediction.mjs";
import { mostLikelyExactScore, predictionTimeliness, projectPlayoffBracket } from "./projected-bracket.mjs";
import { selectProductionVariant } from "./model-gate.mjs";
import { calculateActiveDraftPrediction } from "./active-draft-service.mjs";

const PORT = Number(process.env.API_PORT || 3001);
const DATA_DIR = path.resolve(process.env.DATA_DIR || "data");
const DB_PATH = path.join(DATA_DIR, "ti-predictor.sqlite");
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";
const SESSION_DAYS = 30;
const TI_LEAGUE_ID = Number(process.env.TI_LEAGUE_ID || 19719);
const LIVE_SYNC_ENABLED = process.env.LIVE_SYNC_ENABLED !== "false";
const LIVE_SYNC_INTERVAL_MINUTES = Math.max(2, Number(process.env.LIVE_SYNC_INTERVAL_MINUTES || 10));
const LIVE_DRAFT_INTERVAL_SECONDS = Math.max(5, Number(process.env.LIVE_DRAFT_INTERVAL_SECONDS || 10));
const LIVE_DRAFT_GRACE_SECONDS = Math.max(30, Number(process.env.LIVE_DRAFT_GRACE_SECONDS || 120));
const LIVE_DRAFT_SYNC_ENABLED = process.env.LIVE_DRAFT_SYNC_ENABLED !== "false";
const MAP_DETAIL_SYNC_LIMIT = Math.max(0, Number(process.env.MAP_DETAIL_SYNC_LIMIT || 12));
const DECISION_MIN_LEAD_MINUTES = Math.max(0, Number(process.env.DECISION_MIN_LEAD_MINUTES || 15));
const OPENDOTA_API_URL = process.env.OPENDOTA_API_URL || "https://api.opendota.com/api";
const SCHEDULE_SYNC_ENABLED = process.env.SCHEDULE_SYNC_ENABLED !== "false";
const SCHEDULE_SOURCE_URL = process.env.SCHEDULE_SOURCE_URL || "https://www.cybersport.ru/tournaments/dota-2/the-international-2026";
const SCHEDULE_TIMEZONE_OFFSET = process.env.SCHEDULE_TIMEZONE_OFFSET || "+03:00";
const AUTO_SNAPSHOT_ITERATIONS = Math.max(10_000, Number(process.env.AUTO_SNAPSHOT_ITERATIONS || 1_000_000));
const AUTO_SNAPSHOT_MAX_ITERATIONS = Math.max(AUTO_SNAPSHOT_ITERATIONS, Number(process.env.AUTO_SNAPSHOT_MAX_ITERATIONS || AUTO_SNAPSHOT_ITERATIONS * 4));
const AUTO_SNAPSHOT_BATCH_SIZE = Math.max(10_000, Number(process.env.AUTO_SNAPSHOT_BATCH_SIZE || AUTO_SNAPSHOT_ITERATIONS));
const AUTO_SNAPSHOT_TOLERANCE_PP = Math.max(.01, Number(process.env.AUTO_SNAPSHOT_TOLERANCE_PP || .1));
const OFFICIAL_FORECAST_CONFIG = Object.freeze({ forecastMode: "stats", opinionWeight: 0, iterations: AUTO_SNAPSHOT_ITERATIONS, adaptive: true, maxIterations: AUTO_SNAPSHOT_MAX_ITERATIONS, batchSize: AUTO_SNAPSHOT_BATCH_SIZE, tolerancePp: AUTO_SNAPSHOT_TOLERANCE_PP });
const FORECAST_JOB_MIN_ITERATIONS = Math.max(10_000, Number(process.env.FORECAST_JOB_MIN_ITERATIONS || 10_000));
const FORECAST_JOB_MAX_ITERATIONS = Math.max(FORECAST_JOB_MIN_ITERATIONS, Number(process.env.FORECAST_JOB_MAX_ITERATIONS || 1_000_000));
const FORECAST_CONDITIONAL_ITERATIONS = Math.min(50_000, FORECAST_JOB_MAX_ITERATIONS);
const FORECAST_JOB_LEASE_SECONDS = Math.max(30, Number(process.env.FORECAST_JOB_LEASE_SECONDS || 300));
const FORECAST_JOB_POLL_MS = Math.max(100, Number(process.env.FORECAST_JOB_POLL_MS || 500));
const FORECAST_JOB_MAX_ATTEMPTS = Math.max(1, Number(process.env.FORECAST_JOB_MAX_ATTEMPTS || 3));
const FORECAST_SCENARIO_RATE_LIMIT = Math.max(1, Number(process.env.FORECAST_SCENARIO_RATE_LIMIT || 30));
const FORECAST_CANONICAL_WEIGHTS = new Set([0, 10, 20, 30]);
const TI_PLAYIN_START = Date.parse(process.env.TI_PLAYIN_START || "2026-08-16T00:00:00+08:00") / 1000;
const TI_PLAYOFF_START = Date.parse(process.env.TI_PLAYOFF_START || "2026-08-20T00:00:00+08:00") / 1000;
const DRAFT_TEMPORAL_MODEL = path.resolve(process.env.DRAFT_TEMPORAL_MODEL || "public/draft-temporal-model.json");
const LIVE_MAP_MODEL = path.resolve(process.env.LIVE_MAP_MODEL || "public/live-map-model.json");
const NEXTGEN_MODEL_FILES = {
  team: path.resolve(process.env.ALL_PRO_TEAM_MODEL || "public/all-pro-team-model.json"),
  draft: path.resolve(process.env.DRAFT_NEXTGEN_MODEL || "public/draft-nextgen-model.json"),
  series: path.resolve(process.env.NEXTGEN_SERIES_CALIBRATION || "public/nextgen-series-calibration.json"),
};

mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS answers (
    pair_key TEXT PRIMARY KEY,
    probability REAL NOT NULL CHECK(probability >= 0 AND probability <= 100),
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stage TEXT NOT NULL DEFAULT 'swiss',
    round INTEGER NOT NULL,
    team_a TEXT NOT NULL,
    team_b TEXT NOT NULL,
    winner TEXT,
    score_a INTEGER,
    score_b INTEGER,
    scheduled_at TEXT,
    source_match_id TEXT,
    predicted_probability REAL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS prediction_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger TEXT NOT NULL,
    forecast_mode TEXT NOT NULL,
    opinion_weight INTEGER NOT NULL,
    iterations INTEGER NOT NULL,
    seed INTEGER NOT NULL,
    completed_match_count INTEGER NOT NULL,
    model_generated_at TEXT,
    probabilities_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    inputs_json TEXT,
    snapshot_kind TEXT NOT NULL DEFAULT 'original',
    root_snapshot_id INTEGER,
    parent_snapshot_id INTEGER,
    profile_key TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_prediction_snapshots_created_at
  ON prediction_snapshots(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_matches_stage_round ON matches(stage, round);
  CREATE INDEX IF NOT EXISTS idx_matches_scheduled ON matches(stage, winner, team_a, team_b) WHERE winner IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_source_match_id ON matches(source_match_id) WHERE source_match_id IS NOT NULL;
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS live_draft_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT NOT NULL,
    series_id TEXT,
    phase TEXT NOT NULL,
    state_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    UNIQUE(match_id, state_hash)
  );
  CREATE TABLE IF NOT EXISTS live_draft_predictions (
    match_id TEXT PRIMARY KEY,
    series_id TEXT,
    radiant_team TEXT NOT NULL,
    dire_team TEXT NOT NULL,
    picks_hash TEXT NOT NULL,
    picks_json TEXT NOT NULL,
    probability_radiant REAL NOT NULL CHECK(probability_radiant >= 0.01 AND probability_radiant <= 0.99),
    model_id TEXT,
    evidence_json TEXT,
    captured_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tournament_maps (
    match_id TEXT PRIMARY KEY,
    series_id TEXT,
    radiant_team TEXT NOT NULL,
    dire_team TEXT NOT NULL,
    winner TEXT,
    start_time INTEGER,
    duration INTEGER,
    patch INTEGER,
    first_pick_team TEXT,
    picks_json TEXT,
    bans_json TEXT,
    draft_json TEXT,
    players_json TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bet_locks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL CHECK(scope IN ('series','map')),
    subject_id TEXT NOT NULL,
    team_a TEXT NOT NULL,
    team_b TEXT NOT NULL,
    probability_a REAL NOT NULL CHECK(probability_a >= 0.01 AND probability_a <= 0.99),
    recommended_winner TEXT NOT NULL,
    exact_score TEXT,
    source TEXT NOT NULL,
    opinion_weight INTEGER NOT NULL,
    snapshot_id INTEGER,
    model_id TEXT,
    evidence_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(scope,subject_id)
  );
  CREATE TABLE IF NOT EXISTS series_links (
    match_id INTEGER NOT NULL UNIQUE,
    opendota_series_id TEXT NOT NULL UNIQUE,
    linked_at TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    PRIMARY KEY(match_id,opendota_series_id)
  );
  CREATE TABLE IF NOT EXISTS live_draft_candidates (
    match_id TEXT PRIMARY KEY,
    picks_hash TEXT NOT NULL,
    observations INTEGER NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS materialized_views (
    view_key TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    input_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('ready','building','failed')),
    payload_json TEXT,
    error TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS automation_jobs (
    job_key TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','leased','ready','failed')),
    lease_until TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    updated_at TEXT NOT NULL
  );
`);
const snapshotColumns = new Set(db.prepare("PRAGMA table_info(prediction_snapshots)").all().map((row) => row.name));
for (const [name, definition] of Object.entries({ inputs_json: "TEXT", diagnostics_json: "TEXT", snapshot_kind: "TEXT NOT NULL DEFAULT 'original'", root_snapshot_id: "INTEGER", parent_snapshot_id: "INTEGER", profile_key: "TEXT" })) {
  if (!snapshotColumns.has(name)) db.exec(`ALTER TABLE prediction_snapshots ADD COLUMN ${name} ${definition}`);
}
const liveDraftPredictionColumns = new Set(db.prepare("PRAGMA table_info(live_draft_predictions)").all().map((row) => row.name));
if (!liveDraftPredictionColumns.has("evidence_json")) db.exec("ALTER TABLE live_draft_predictions ADD COLUMN evidence_json TEXT");
const materializedViewColumns = new Set(db.prepare("PRAGMA table_info(materialized_views)").all().map((row) => row.name));
for (const [name, definition] of Object.entries({
  kind: "TEXT",
  profile_key: "TEXT",
  job_key: "TEXT",
  building_input_hash: "TEXT",
  snapshot_id: "INTEGER",
  stale_since: "TEXT",
  ready_at: "TEXT",
})) {
  if (!materializedViewColumns.has(name)) db.exec(`ALTER TABLE materialized_views ADD COLUMN ${name} ${definition}`);
}
const automationJobColumns = new Set(db.prepare("PRAGMA table_info(automation_jobs)").all().map((row) => row.name));
for (const [name, definition] of Object.entries({
  kind: "TEXT",
  profile_key: "TEXT",
  input_json: "TEXT",
  progress_current: "INTEGER NOT NULL DEFAULT 0",
  progress_total: "INTEGER NOT NULL DEFAULT 0",
  result_json: "TEXT",
  snapshot_id: "INTEGER",
  lease_token: "TEXT",
  superseded_by: "TEXT",
  cancel_requested_at: "TEXT",
  canceled_at: "TEXT",
  trigger: "TEXT",
  created_at: "TEXT",
  started_at: "TEXT",
  completed_at: "TEXT",
})) {
  if (!automationJobColumns.has(name)) db.exec(`ALTER TABLE automation_jobs ADD COLUMN ${name} ${definition}`);
}
db.exec("CREATE INDEX IF NOT EXISTS idx_prediction_snapshots_root ON prediction_snapshots(root_snapshot_id, completed_match_count DESC); CREATE INDEX IF NOT EXISTS idx_prediction_snapshots_profile ON prediction_snapshots(profile_key, completed_match_count DESC); CREATE INDEX IF NOT EXISTS idx_live_draft_snapshots_match ON live_draft_snapshots(match_id, observed_at DESC)");
db.exec("CREATE INDEX IF NOT EXISTS idx_tournament_maps_series ON tournament_maps(series_id,start_time,match_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_bet_locks_created ON bet_locks(created_at DESC)");
db.exec("CREATE INDEX IF NOT EXISTS idx_automation_jobs_claim ON automation_jobs(status,lease_until,created_at); CREATE INDEX IF NOT EXISTS idx_automation_jobs_profile ON automation_jobs(profile_key,created_at DESC); CREATE INDEX IF NOT EXISTS idx_materialized_views_profile ON materialized_views(kind,profile_key)");
db.exec("PRAGMA optimize");

let refreshProcess = null;
let liveSyncPromise = null;
let liveDraftPromise = null;
let liveDraftCache = { games: [], fetchedAt: null, error: null };
const liveDraftErrors = new Map();
let liveLeagueMapsCache = { maps: [], fetchedAt: null };
let autoSnapshotTimer = null;
let pendingAutomaticSnapshotTrigger = null;
let forecastJobTimer = null;
let forecastJobRunning = false;
const activeForecastWorkers = new Map();
const loginAttempts = new Map();
const scenarioRequests = new Map();
let temporalModelCache = { mtimeMs: -1, value: null };
let liveMapModelCache = { mtimeMs: -1, value: null };
const combinedMaterializationPromises = new Map();
const json = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
};
const now = () => new Date().toISOString();
const tokenHash = (token) => createHash("sha256").update(token).digest("hex");
function canonicalPicks(picks) {
  return [...(picks ?? [])].map(Number).filter((id) => Number.isInteger(id) && id > 0).sort((left, right) => left - right);
}

function sameCompleteDraft(left, right) {
  const radiantLeft = canonicalPicks(left?.radiant);
  const direLeft = canonicalPicks(left?.dire);
  const radiantRight = canonicalPicks(right?.radiant);
  const direRight = canonicalPicks(right?.dire);
  return radiantLeft.length === 5 && direLeft.length === 5
    && JSON.stringify(radiantLeft) === JSON.stringify(radiantRight)
    && JSON.stringify(direLeft) === JSON.stringify(direRight);
}

const livePicksHash = (game) => createHash("sha256").update(JSON.stringify([canonicalPicks(game.radiantPicks), canonicalPicks(game.direPicks)])).digest("hex").slice(0, 20);

function liveSnapshotPayload(game, draftPrediction = null) {
  let liveEstimate = null;
  if (draftPrediction?.probabilityRadiant !== null && draftPrediction?.probabilityRadiant !== undefined) {
    try {
      const estimate = estimateLiveMap(currentLiveMapModel(), { draftProbabilityRadiant: draftPrediction.probabilityRadiant, game });
      liveEstimate = {
        probabilityRadiant: estimate.liveProbabilityRadiant,
        availability: estimate.availability,
        modelId: estimate.modelId,
        stateImpactPp: estimate.stateImpactPp,
      };
    } catch { liveEstimate = null; }
  }
  return {
    matchId: String(game.matchId),
    radiantTeam: game.radiantTeam,
    direTeam: game.direTeam,
    phase: game.phase,
    gameTime: Number(game.gameTime || 0),
    radiantPicks: game.radiantPicks ?? [],
    direPicks: game.direPicks ?? [],
    radiantScore: Number(game.radiantScore || 0),
    direScore: Number(game.direScore || 0),
    radiantLead: Number.isFinite(Number(game.radiantLead)) ? Number(game.radiantLead) : null,
    lastUpdateAt: game.lastUpdateAt ?? null,
    draftPrediction: draftPrediction ? {
      probabilityRadiant: Number(draftPrediction.probabilityRadiant),
      modelId: draftPrediction.modelId ?? null,
      capturedAt: draftPrediction.capturedAt ?? null,
    } : null,
    liveEstimate,
  };
}

function persistLiveDraftSnapshot(game, observedAt, draftPrediction = null) {
  const payload = liveSnapshotPayload(game, draftPrediction);
  const signature = JSON.stringify({
    phase: payload.phase,
    timeBucket: Math.floor(payload.gameTime / 30),
    radiantPicks: payload.radiantPicks,
    direPicks: payload.direPicks,
    radiantScore: payload.radiantScore,
    direScore: payload.direScore,
    goldBucket: payload.radiantLead === null ? null : Math.round(payload.radiantLead / 250),
    draftCapturedAt: payload.draftPrediction?.capturedAt ?? null,
    liveAvailability: payload.liveEstimate?.availability ?? null,
  });
  const stateHash = createHash("sha256").update(signature).digest("hex").slice(0, 24);
  db.prepare("INSERT OR IGNORE INTO live_draft_snapshots(match_id,series_id,phase,state_hash,payload_json,observed_at) VALUES (?,?,?,?,?,?)")
    .run(String(game.matchId), String(game.seriesId || ""), String(game.phase), stateHash, JSON.stringify(payload), observedAt);
  db.prepare(`INSERT INTO tournament_maps(match_id,series_id,radiant_team,dire_team,picks_json,players_json,updated_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(match_id) DO UPDATE SET
    series_id=excluded.series_id,radiant_team=excluded.radiant_team,dire_team=excluded.dire_team,
    picks_json=excluded.picks_json,players_json=excluded.players_json,updated_at=excluded.updated_at`)
    .run(String(game.matchId), String(game.seriesId || ""), game.radiantTeam, game.direTeam,
      JSON.stringify({ radiant: game.radiantPicks ?? [], dire: game.direPicks ?? [] }),
      JSON.stringify({ radiant: game.radiantPlayers ?? [], dire: game.direPlayers ?? [] }), observedAt);
}

function storedLiveDraftPrediction(matchId) {
  const row = db.prepare("SELECT * FROM live_draft_predictions WHERE match_id = ?").get(String(matchId));
  return row ? {
    probabilityRadiant: Number(row.probability_radiant),
    modelId: row.model_id || null,
    picksHash: row.picks_hash,
    picks: row.picks_json ? JSON.parse(row.picks_json) : null,
    capturedAt: row.captured_at,
    evidence: row.evidence_json ? JSON.parse(row.evidence_json) : null,
  } : null;
}

function storedDraftMatchesGame(stored, game) {
  if (!stored) return false;
  if (stored.picksHash === livePicksHash(game)) return true;
  return sameCompleteDraft(stored.picks, { radiant: game.radiantPicks, dire: game.direPicks });
}

function liveDraftHistory(matchId, limit = 120) {
  const winner = db.prepare("SELECT winner FROM tournament_maps WHERE match_id=?").get(String(matchId))?.winner ?? null;
  return db.prepare("SELECT payload_json,observed_at FROM live_draft_snapshots WHERE match_id = ? ORDER BY observed_at DESC LIMIT ?")
    .all(String(matchId), Number(limit)).reverse().map((row) => {
      const payload = JSON.parse(row.payload_json);
      const draftWinner = Number(payload.draftPrediction?.probabilityRadiant) >= .5 ? payload.radiantTeam : payload.direTeam;
      const liveWinner = Number(payload.liveEstimate?.probabilityRadiant) >= .5 ? payload.radiantTeam : payload.direTeam;
      return {
        ...payload,
        observedAt: row.observed_at,
        evaluation: winner ? {
          winner,
          draftPredictionCorrect: payload.draftPrediction ? draftWinner === winner : null,
          livePredictionCorrect: payload.liveEstimate?.probabilityRadiant !== null
            && payload.liveEstimate?.probabilityRadiant !== undefined
            && Number.isFinite(Number(payload.liveEstimate.probabilityRadiant))
            ? liveWinner === winner
            : null,
        } : null,
      };
    });
}

function decorateLiveDraft(game) {
  const storedPrediction = storedLiveDraftPrediction(game.matchId);
  const draftPrediction = storedDraftMatchesGame(storedPrediction, game) ? storedPrediction : null;
  if (draftPrediction) liveDraftErrors.delete(String(game.matchId));
  return { ...game, draftPrediction, draftError: draftPrediction ? null : liveDraftErrors.get(String(game.matchId)) ?? null, history: liveDraftHistory(game.matchId) };
}

function loadJson(relativePath) {
  return JSON.parse(readFileSync(path.resolve(relativePath), "utf8"));
}

function observeStableDraft(game, observedAt) {
  if ((game.radiantPicks?.length ?? 0) !== 5 || (game.direPicks?.length ?? 0) !== 5) return null;
  const picksHash = livePicksHash(game);
  const existingPrediction = storedLiveDraftPrediction(game.matchId);
  if (storedDraftMatchesGame(existingPrediction, game)) {
    liveDraftErrors.delete(String(game.matchId));
    return existingPrediction;
  }
  const candidate = db.prepare("SELECT * FROM live_draft_candidates WHERE match_id=?").get(String(game.matchId));
  const observations = candidate?.picks_hash === picksHash ? Number(candidate.observations) + 1 : 1;
  db.prepare(`INSERT INTO live_draft_candidates(match_id,picks_hash,observations,first_seen_at,last_seen_at)
    VALUES (?,?,?,?,?) ON CONFLICT(match_id) DO UPDATE SET picks_hash=excluded.picks_hash,
    observations=excluded.observations,first_seen_at=CASE WHEN live_draft_candidates.picks_hash=excluded.picks_hash THEN live_draft_candidates.first_seen_at ELSE excluded.first_seen_at END,
    last_seen_at=excluded.last_seen_at`).run(String(game.matchId), picksHash, observations, observedAt, observedAt);
  try {
    const prediction = calculateActiveDraftPrediction({ draftStats: loadJson("public/draft-stats.json"), teamStats: loadJson("public/team-stats.json"), game });
    const evidence = JSON.stringify({ sourceTeamProbability: prediction.sourceTeamProbability, completeness: prediction.completeness, signals: prediction.signals, ...prediction.evidence });
    db.prepare(`INSERT INTO live_draft_predictions(match_id,series_id,radiant_team,dire_team,picks_hash,picks_json,probability_radiant,model_id,evidence_json,captured_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(match_id) DO UPDATE SET series_id=excluded.series_id,radiant_team=excluded.radiant_team,
      dire_team=excluded.dire_team,picks_hash=excluded.picks_hash,picks_json=excluded.picks_json,
      probability_radiant=excluded.probability_radiant,model_id=excluded.model_id,evidence_json=excluded.evidence_json,captured_at=excluded.captured_at
      WHERE live_draft_predictions.picks_hash<>excluded.picks_hash`).run(String(game.matchId), String(game.seriesId || ""), game.radiantTeam, game.direTeam, picksHash,
      JSON.stringify({ radiant: game.radiantPicks, dire: game.direPicks }), prediction.probabilityRadiant, prediction.modelId, evidence, observedAt);
    audit(existingPrediction ? "server_draft_refrozen" : "server_draft_frozen", { matchId: String(game.matchId), seriesId: String(game.seriesId || ""), picksHash, modelId: prediction.modelId });
    liveDraftErrors.delete(String(game.matchId));
    return storedLiveDraftPrediction(game.matchId);
  } catch (error) {
    console.error("Server draft calculation failed:", error);
    const reason = error instanceof Error ? error.message : String(error);
    liveDraftErrors.set(String(game.matchId), reason);
    audit("server_draft_failed", { matchId: String(game.matchId), error: reason });
    return null;
  }
}

function canonicalSeriesMatch(seriesId) {
  const link = db.prepare("SELECT match_id FROM series_links WHERE opendota_series_id=?").get(String(seriesId || ""));
  return link ? Number(link.match_id) : null;
}

function linkActiveSeries(game, observedAt) {
  if (!game.seriesId || canonicalSeriesMatch(game.seriesId)) return canonicalSeriesMatch(game.seriesId);
  const pair = [game.radiantTeam, game.direTeam];
  const observedMs = Date.parse(game.lastUpdateAt || observedAt);
  const candidates = db.prepare(`SELECT match.* FROM matches match
    LEFT JOIN series_links link ON link.match_id=match.id
    WHERE match.winner IS NULL AND link.match_id IS NULL
      AND ((match.team_a=? AND match.team_b=?) OR (match.team_a=? AND match.team_b=?))`).all(pair[0], pair[1], pair[1], pair[0])
    .filter((match) => {
      if (!match.scheduled_at) return match.stage === stageForTimestamp(observedMs / 1000);
      return Math.abs(Date.parse(match.scheduled_at) - observedMs) <= 12 * 60 * 60_000;
    });
  if (candidates.length !== 1) {
    if (candidates.length > 1) audit("series_link_ambiguous", { seriesId: String(game.seriesId), candidateIds: candidates.map((row) => row.id) });
    return null;
  }
  const selected = candidates[0];
  db.prepare("INSERT OR IGNORE INTO series_links(match_id,opendota_series_id,linked_at,evidence_json) VALUES (?,?,?,?)")
    .run(selected.id, String(game.seriesId), observedAt, JSON.stringify({ rule: "team_pair_active_time_stage_unique", scheduledAt: selected.scheduled_at, observedAt }));
  return canonicalSeriesMatch(game.seriesId);
}

const safeEqual = (a, b) => {
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};
const passwordDigest = (password) => scryptSync(password, "ti-2026-admin-v1", 32).toString("hex");

function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").filter(Boolean).map((item) => {
    const [key, ...rest] = item.trim().split("=");
    return [key, decodeURIComponent(rest.join("="))];
  }));
}

function isAdmin(req) {
  const token = cookies(req).ti26_session;
  if (!token) return false;
  const row = db.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").get(tokenHash(token));
  return Boolean(row && Date.parse(row.expires_at) > Date.now());
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function currentTemporalModel() {
  const mtimeMs = statSync(DRAFT_TEMPORAL_MODEL).mtimeMs;
  if (temporalModelCache.mtimeMs !== mtimeMs) {
    const value = JSON.parse(readFileSync(DRAFT_TEMPORAL_MODEL, "utf8"));
    if (value.schemaVersion !== 1 || !value.modelId) throw new Error("invalid_temporal_model");
    temporalModelCache = { mtimeMs, value };
  }
  return temporalModelCache.value;
}

function currentLiveMapModel() {
  const mtimeMs = statSync(LIVE_MAP_MODEL).mtimeMs;
  if (liveMapModelCache.mtimeMs !== mtimeMs) {
    const value = JSON.parse(readFileSync(LIVE_MAP_MODEL, "utf8"));
    if (value.schemaVersion !== 1 || !value.modelId || !Array.isArray(value.coefficients)) throw new Error("invalid_live_map_model");
    liveMapModelCache = { mtimeMs, value };
  }
  return liveMapModelCache.value;
}

function temporalModelMetadata(model) {
  return {
    modelId: model.modelId,
    modelFamily: model.modelFamily,
    trainedAt: model.trainedAt,
    dataset: model.dataset,
    deployment: model.deployment,
    backtest: { eligiblePatches: model.backtest?.eligiblePatches ?? 0, aggregate: model.backtest?.aggregate ?? null },
    arena: model.arena ? { leaderboard: model.arena.leaderboard, finalStack: model.arena.finalStack } : null,
  };
}

function nextgenModelMetadata() {
  const team = JSON.parse(readFileSync(NEXTGEN_MODEL_FILES.team, "utf8"));
  const draft = JSON.parse(readFileSync(NEXTGEN_MODEL_FILES.draft, "utf8"));
  const series = JSON.parse(readFileSync(NEXTGEN_MODEL_FILES.series, "utf8"));
  return {
    deployment: "diagnostic_only",
    activeForecastUnchanged: true,
    team: { modelId: team.modelId, status: team.status, selected: team.selected, training: team.training, frozenHoldout: team.validation?.frozenHoldout },
    draft: { modelId: draft.modelId, status: draft.status, winner: draft.winner, training: draft.training, test: draft.test, sideFlip: draft.sideFlip },
    series: { sourceModelId: series.sourceModelId, sourceModel: series.sourceModel, status: series.status, dataset: series.dataset, holdout: series.holdout, monteCarlo: series.monteCarlo },
  };
}

function publicState() {
  const answers = Object.fromEntries(db.prepare("SELECT pair_key, probability FROM answers").all().map((row) => [row.pair_key, row.probability]));
  const matches = db.prepare("SELECT * FROM matches ORDER BY round, id").all();
  const refresh = db.prepare("SELECT value, updated_at FROM settings WHERE key = 'last_refresh'").get() || null;
  const snapshots = db.prepare("SELECT id, trigger, forecast_mode, opinion_weight, iterations, seed, completed_match_count, model_generated_at, probabilities_json, result_json, inputs_json, snapshot_kind, root_snapshot_id, parent_snapshot_id, profile_key, created_at FROM prediction_snapshots ORDER BY id DESC LIMIT 150").all()
    .map((row) => ({ ...row, probabilities: JSON.parse(row.probabilities_json), result: JSON.parse(row.result_json), inputs: row.inputs_json ? JSON.parse(row.inputs_json) : null, probabilities_json: undefined, result_json: undefined, inputs_json: undefined }));
  const liveSyncRow = db.prepare("SELECT value, updated_at FROM settings WHERE key = 'live_sync'").get() || null;
  let lastSync = null;
  try { lastSync = liveSyncRow ? { ...JSON.parse(liveSyncRow.value), updatedAt: liveSyncRow.updated_at } : null; } catch { lastSync = null; }
  return {
    answers, matches, snapshots, officialForecast: OFFICIAL_FORECAST_CONFIG, refresh, refreshRunning: Boolean(refreshProcess),
    liveSync: { enabled: LIVE_SYNC_ENABLED, scheduleEnabled: SCHEDULE_SYNC_ENABLED, leagueId: TI_LEAGUE_ID, intervalMinutes: LIVE_SYNC_INTERVAL_MINUTES, running: Boolean(liveSyncPromise), lastSync, autoForecastRunning: Boolean(db.prepare("SELECT 1 FROM automation_jobs WHERE job_type='forecast' AND kind='scenario_refresh' AND status IN ('pending','leased') AND superseded_by IS NULL LIMIT 1").get()) },
  };
}

function audit(kind, payload) {
  db.prepare("INSERT INTO events(kind, payload, created_at) VALUES (?, ?, ?)").run(kind, JSON.stringify(payload), now());
}

function profileKey(mode, opinionWeight, answers) {
  return createHash("sha256").update(JSON.stringify({ mode, opinionWeight: Number(opinionWeight), answers })).digest("hex").slice(0, 24);
}

function liveConstraintSignature(matches) {
  return matches.map((match) => `${match.id}:${match.stage}:${match.round}:${match.team_a}:${match.team_b}:${match.winner ?? "scheduled"}:${match.score_a ?? ""}:${match.score_b ?? ""}`).join(";");
}

function officialSnapshotNeedsRefresh(matches) {
  const latest = db.prepare("SELECT completed_match_count, inputs_json FROM prediction_snapshots WHERE snapshot_kind!='revision' AND forecast_mode='stats' AND trigger!='manual_run' ORDER BY completed_match_count DESC,id DESC LIMIT 1").get();
  if (!latest) return true;
  if (Number(latest.completed_match_count) !== matches.filter((match) => match.winner).length) return true;
  try {
    const savedSignature = latest.inputs_json ? JSON.parse(latest.inputs_json).liveConstraintSignature : null;
    return Boolean(savedSignature && savedSignature !== liveConstraintSignature(matches));
  } catch { return true; }
}

function storedAnswers() {
  return Object.fromEntries(db.prepare("SELECT pair_key, probability FROM answers ORDER BY pair_key").all().map((row) => [row.pair_key, Number(row.probability)]));
}

function currentForecast(config = OFFICIAL_FORECAST_CONFIG, profileAnswers = null) {
  const answers = Object.fromEntries(db.prepare("SELECT pair_key, probability FROM answers").all().map((row) => [row.pair_key, row.probability]));
  const selectedAnswers = profileAnswers ?? answers;
  const matches = db.prepare("SELECT * FROM matches ORDER BY round, id").all();
  const stats = JSON.parse(readFileSync(path.resolve("public/team-stats.json"), "utf8"));
  const probabilities = buildForecastSource({ answers: selectedAnswers, stats, matches, mode: config.forecastMode, opinionWeight: config.opinionWeight });
  return { answers: selectedAnswers, matches, stats, config, probabilities };
}

function insertSnapshot({ trigger, config, probabilities, result, stats, matches, inputs, kind = "original", rootId = null, parentId = null, key }) {
  const completedMatchCount = matches.filter((match) => match.winner).length;
  const stamp = now();
  const inserted = db.prepare(`INSERT INTO prediction_snapshots(trigger, forecast_mode, opinion_weight, iterations, seed, completed_match_count, model_generated_at, probabilities_json, result_json, inputs_json, snapshot_kind, root_snapshot_id, parent_snapshot_id, profile_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(trigger, config.forecastMode, Number(config.opinionWeight), result.iterations, result.seed, completedMatchCount, stats.generatedAt || null, JSON.stringify(probabilities), JSON.stringify(result), JSON.stringify(inputs), kind, rootId, parentId, key, stamp);
  const id = Number(inserted.lastInsertRowid);
  if (kind === "original" && !rootId) db.prepare("UPDATE prediction_snapshots SET root_snapshot_id=? WHERE id=?").run(id, id);
  const resolvedRootId = rootId ?? id;
  const trace = buildSnapshotCalculationTrace({ snapshotId: id, createdAt: stamp, trigger, kind, rootId: resolvedRootId, parentId, config, answers: inputs?.answers ?? {}, probabilities, result, stats, matches, exactAtSave: true });
  db.prepare("UPDATE prediction_snapshots SET diagnostics_json=? WHERE id=?").run(JSON.stringify(trace), id);
  return id;
}

function parsedSnapshotRow(row) {
  if (!row) return null;
  let inputs = null; let diagnostics = null;
  try { inputs = row.inputs_json ? JSON.parse(row.inputs_json) : null; } catch { inputs = null; }
  try { diagnostics = row.diagnostics_json ? JSON.parse(row.diagnostics_json) : null; } catch { diagnostics = null; }
  return { ...row, probabilities: JSON.parse(row.probabilities_json), result: JSON.parse(row.result_json), inputs, diagnostics };
}

function reconstructMatchesAtSnapshot(snapshot, matches) {
  const cutoff = Date.parse(snapshot.created_at);
  return matches.filter((match) => Date.parse(match.created_at) <= cutoff).map((match) => {
    if (!match.winner || Date.parse(match.updated_at) <= cutoff) return match;
    return { ...match, winner: null, score_a: null, score_b: null };
  });
}

function aggregateDiagnosticScores(records, variant) {
  const scores = records.map((record) => record[variant]).filter(Boolean);
  return {
    count: scores.length,
    correct: scores.filter((score) => score.correct).length,
    brier: scores.length ? scores.reduce((sum, score) => sum + score.brier, 0) / scores.length : null,
    logLoss: scores.length ? scores.reduce((sum, score) => sum + score.logLoss, 0) / scores.length : null,
  };
}

function snapshotDecisionEvaluation(requestedId) {
  const requested = parsedSnapshotRow(db.prepare("SELECT * FROM prediction_snapshots WHERE id=?").get(requestedId));
  if (!requested) return null;
  const rootId = Number(requested.root_snapshot_id ?? requested.id);
  const rows = db.prepare("SELECT * FROM prediction_snapshots WHERE root_snapshot_id=? OR id=? ORDER BY created_at,id").all(rootId, rootId).map(parsedSnapshotRow);
  const root = rows.find((row) => Number(row.id) === rootId) ?? requested;
  const matches = db.prepare("SELECT * FROM matches WHERE winner IS NOT NULL ORDER BY round,id").all()
    .filter((match) => Date.parse(match.updated_at || match.created_at) > Date.parse(root.created_at));
  const evaluated = matches.map((match) => {
    const cutoff = Date.parse(match.scheduled_at || match.created_at);
    const adaptiveSnapshot = rows.filter((snapshot) => Date.parse(snapshot.created_at) <= cutoff).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)[0] ?? null;
    const staticProbability = diagnosticProbabilityFor(match.team_a, match.team_b, root.probabilities);
    const adaptiveProbability = root.forecast_mode === "stats" && match.predicted_probability !== null && Number.isFinite(Number(match.predicted_probability))
      ? Number(match.predicted_probability)
      : adaptiveSnapshot ? diagnosticProbabilityFor(match.team_a, match.team_b, adaptiveSnapshot.probabilities) : null;
    return { match, static: scoreDiagnosticMatch(match, staticProbability), adaptive: scoreDiagnosticMatch(match, adaptiveProbability) };
  });
  const staticScore = aggregateDiagnosticScores(evaluated, "static");
  const adaptiveScore = aggregateDiagnosticScores(evaluated, "adaptive");
  const gate = selectProductionVariant(staticScore, adaptiveScore);
  const timeline = evaluated.map((row, index) => {
    const prefix = evaluated.slice(0, index + 1);
    return {
      matchId: row.match.id,
      stage: row.match.stage,
      label: `${row.match.team_a} — ${row.match.team_b}`,
      static: aggregateDiagnosticScores(prefix, "static"),
      adaptive: aggregateDiagnosticScores(prefix, "adaptive"),
    };
  }).slice(-24);
  const stages = ["swiss", "playin", "playoff"].map((stage) => {
    const rowsForStage = evaluated.filter((row) => row.match.stage === stage);
    return { stage, static: aggregateDiagnosticScores(rowsForStage, "static"), adaptive: aggregateDiagnosticScores(rowsForStage, "adaptive") };
  });
  const accepted = evaluated.filter((row) => row.adaptive && Math.max(row.adaptive.probabilityA, 100 - row.adaptive.probabilityA) >= 58);
  return {
    rootId, static: staticScore, adaptive: adaptiveScore,
    timeline,
    stages,
    decision: {
      total: evaluated.length,
      accepted: accepted.length,
      correct: accepted.filter((row) => row.adaptive.correct).length,
      pass: evaluated.length - accepted.length,
    },
    ...gate,
  };
}

function snapshotExportBundle(requestedId) {
  const requested = parsedSnapshotRow(db.prepare("SELECT * FROM prediction_snapshots WHERE id=?").get(requestedId));
  if (!requested) return null;
  const rootId = Number(requested.root_snapshot_id ?? requested.id);
  const rows = db.prepare("SELECT * FROM prediction_snapshots WHERE root_snapshot_id=? OR id=? ORDER BY created_at,id").all(rootId, rootId).map(parsedSnapshotRow);
  const root = rows.find((row) => Number(row.id) === rootId) ?? requested;
  const allMatches = db.prepare("SELECT * FROM matches ORDER BY round,id").all();
  const stats = JSON.parse(readFileSync(path.resolve("public/team-stats.json"), "utf8"));
  const forecasts = rows.map((snapshot) => {
    const trace = snapshot.diagnostics ?? buildSnapshotCalculationTrace({
      snapshotId: snapshot.id,
      createdAt: snapshot.created_at,
      trigger: snapshot.trigger,
      kind: snapshot.snapshot_kind,
      rootId: snapshot.root_snapshot_id,
      parentId: snapshot.parent_snapshot_id,
      config: { forecastMode: snapshot.forecast_mode, opinionWeight: snapshot.opinion_weight, iterations: snapshot.iterations },
      answers: snapshot.inputs?.answers ?? {},
      probabilities: snapshot.probabilities,
      result: snapshot.result,
      stats,
      matches: reconstructMatchesAtSnapshot(snapshot, allMatches),
      exactAtSave: false,
    });
    return {
      metadata: { id: snapshot.id, rootId, parentId: snapshot.parent_snapshot_id, kind: snapshot.snapshot_kind, trigger: snapshot.trigger, createdAt: snapshot.created_at, completedMatchCount: snapshot.completed_match_count, modelGeneratedAt: snapshot.model_generated_at },
      calculationTrace: trace,
      savedProbabilities: snapshot.probabilities,
      simulationResult: snapshot.result,
    };
  });
  const futureMatches = allMatches.filter((match) => match.winner && Date.parse(match.updated_at || match.created_at) > Date.parse(root.created_at));
  const evaluatedMatches = futureMatches.map((match) => {
    const cutoff = Date.parse(match.scheduled_at || match.created_at);
    const adaptiveSnapshot = rows.filter((snapshot) => Date.parse(snapshot.created_at) <= cutoff).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)[0] ?? null;
    const staticProbability = diagnosticProbabilityFor(match.team_a, match.team_b, root.probabilities);
    const adaptiveProbability = root.forecast_mode === "stats" && match.predicted_probability !== null && Number.isFinite(Number(match.predicted_probability))
      ? Number(match.predicted_probability)
      : adaptiveSnapshot ? diagnosticProbabilityFor(match.team_a, match.team_b, adaptiveSnapshot.probabilities) : null;
    return {
      match: { id: match.id, stage: match.stage, round: match.round, teamA: match.team_a, teamB: match.team_b, winner: match.winner, scoreA: match.score_a, scoreB: match.score_b, scheduledAt: match.scheduled_at, completedAt: match.updated_at },
      static: scoreDiagnosticMatch(match, staticProbability),
      adaptive: scoreDiagnosticMatch(match, adaptiveProbability),
      adaptiveSnapshotId: adaptiveSnapshot?.id ?? null,
    };
  });
  return {
    schema: "ti2026.forecast-diagnostic-export",
    schemaVersion: 1,
    exportedAt: now(),
    requestedSnapshotId: requestedId,
    rootSnapshotId: rootId,
    readme: [
      "calculationTrace.pairs содержит разложение каждой матчевой вероятности и замороженные коэффициенты.",
      "traceResidualPp около нуля подтверждает воспроизводимость сохранённой вероятности.",
      "liveSeriesMarginal — условное leave-one-out влияние серии; строки коррелируют и не должны суммироваться.",
      "evaluation сравнивает первоначальный STATIC с последней доступной до матча ADAPTIVE-ревизией.",
      "exactAtSave=false означает, что старый trace реконструирован; savedProbabilities и simulationResult при этом остаются оригинальными.",
    ],
    forecasts,
    evaluation: {
      static: aggregateDiagnosticScores(evaluatedMatches, "static"),
      adaptive: aggregateDiagnosticScores(evaluatedMatches, "adaptive"),
      matches: evaluatedMatches,
    },
  };
}

function runForecastWorker(payload, onProgress = () => {}, jobKey = null) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./forecast-worker.mjs", import.meta.url), { workerData: payload });
    if (jobKey) activeForecastWorkers.set(jobKey, worker);
    const cleanup = () => {
      if (jobKey && activeForecastWorkers.get(jobKey) === worker) activeForecastWorkers.delete(jobKey);
    };
    worker.on("message", (message) => {
      if (message?.progress) {
        onProgress(message.progress);
        return;
      }
      cleanup();
      if (message?.ok) resolve(message.result);
      else reject(new Error(message?.error || "forecast_worker_failed"));
    });
    worker.once("error", (error) => { cleanup(); reject(error); });
    worker.once("exit", (code) => { cleanup(); if (code !== 0) reject(new Error(`forecast_worker_exit_${code}`)); });
  });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function validateForecastAnswers(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value);
  if (entries.length > 120) throw new Error("too_many_answers");
  if (entries.some(([key, probability]) => !/^[a-z0-9]+\|[a-z0-9]+$/.test(key) || !Number.isFinite(probability) || probability < 0 || probability > 100)) {
    throw new Error("invalid_answers");
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)).map(([key, probability]) => [key, Number(probability)]));
}

function normalizedForecastProfile(value = {}) {
  const forecastMode = ["personal", "mixed", "stats"].includes(value.forecastMode) ? value.forecastMode : "stats";
  const opinionWeight = forecastMode === "stats" ? 0 : Math.round(Number(value.opinionWeight ?? (forecastMode === "personal" ? 100 : 10)));
  if (!Number.isInteger(opinionWeight) || opinionWeight < 0 || opinionWeight > 100) throw new Error("invalid_opinion_weight");
  return { forecastMode, opinionWeight, answers: validateForecastAnswers(value.answers) };
}

function normalizedSimulationConfig(value = {}, kind = "manual") {
  const adaptive = kind !== "conditional" && Boolean(value.adaptive);
  const iterations = kind === "conditional" ? FORECAST_CONDITIONAL_ITERATIONS : Number(value.iterations || (adaptive ? Math.min(250_000, FORECAST_JOB_MAX_ITERATIONS) : AUTO_SNAPSHOT_ITERATIONS));
  if (!Number.isInteger(iterations) || iterations < FORECAST_JOB_MIN_ITERATIONS || iterations > FORECAST_JOB_MAX_ITERATIONS) throw new Error("invalid_iterations");
  const maxIterations = adaptive ? Math.min(FORECAST_JOB_MAX_ITERATIONS, Number(value.maxIterations || AUTO_SNAPSHOT_MAX_ITERATIONS)) : iterations;
  const batchSize = adaptive ? Math.min(maxIterations, Math.max(FORECAST_JOB_MIN_ITERATIONS, Number(value.batchSize || AUTO_SNAPSHOT_BATCH_SIZE))) : iterations;
  const tolerancePp = adaptive ? Number(value.tolerancePp || AUTO_SNAPSHOT_TOLERANCE_PP) : null;
  if (!Number.isInteger(maxIterations) || maxIterations < iterations || !Number.isInteger(batchSize) || !Number.isFinite(tolerancePp ?? 0) || (tolerancePp !== null && (tolerancePp < .01 || tolerancePp > 5))) throw new Error("invalid_simulation_config");
  return { iterations, adaptive, maxIterations, batchSize, tolerancePp };
}

function forecastStatsState() {
  const statsPath = path.resolve("public/team-stats.json");
  const contents = readFileSync(statsPath);
  const stats = JSON.parse(contents.toString("utf8"));
  return {
    stats,
    version: {
      generatedAt: stats.generatedAt ?? null,
      sha256: createHash("sha256").update(contents).digest("hex"),
    },
  };
}

function forecastReadModelKey(profile, rootSnapshotId = null) {
  const key = profileKey(profile.forecastMode, profile.opinionWeight, profile.answers);
  return { profileKey: key, viewKey: `forecast:v1:${key}:root:${rootSnapshotId || "current"}` };
}

function buildForecastJobInput({ kind, profile, simulation, rootSnapshotId = null, conditionalMatchId = null, trigger = null }) {
  const matches = db.prepare("SELECT * FROM matches ORDER BY round,id").all();
  const { stats, version: statsVersion } = forecastStatsState();
  let probabilities;
  let root = null;
  if (rootSnapshotId) {
    root = parsedSnapshotRow(db.prepare("SELECT * FROM prediction_snapshots WHERE id=?").get(rootSnapshotId));
    if (!root) throw new Error("snapshot_not_found");
    probabilities = root.probabilities;
  } else {
    probabilities = buildForecastSource({ answers: profile.answers, stats, matches, mode: profile.forecastMode, opinionWeight: profile.opinionWeight });
  }
  const conditionalMatch = conditionalMatchId === null ? null : matches.find((match) => Number(match.id) === Number(conditionalMatchId));
  if (kind === "conditional" && (!conditionalMatch || conditionalMatch.winner)) throw new Error("conditional_match_unavailable");
  const seedMaterial = {
    kind,
    profile,
    answers: profile.answers,
    matchesLiveSignature: liveConstraintSignature(matches),
    statsVersion,
    simulation,
    rootSnapshot: root ? {
      id: Number(root.id),
      createdAt: root.created_at,
      probabilitiesHash: createHash("sha256").update(stableJson(root.probabilities)).digest("hex"),
    } : null,
    conditionalMatch: conditionalMatch ? { id: conditionalMatch.id, teamA: conditionalMatch.team_a, teamB: conditionalMatch.team_b } : null,
  };
  const inputHash = createHash("sha256").update(stableJson(seedMaterial)).digest("hex");
  const seed = Number.parseInt(inputHash.slice(0, 8), 16);
  return { inputHash, seed, matches, stats, statsVersion, probabilities, root, conditionalMatch, trigger, seedMaterial };
}

function publicForecastJob(row, { includeResult = true } = {}) {
  if (!row) return null;
  let result = null;
  if (includeResult && row.result_json) {
    try { result = JSON.parse(row.result_json); } catch { result = null; }
  }
  const status = row.canceled_at ? "canceled" : row.status === "pending" ? "queued" : row.status === "leased" ? "running" : row.status === "failed" ? "error" : "ready";
  return {
    id: row.job_key,
    kind: row.kind || row.job_type,
    profileKey: row.profile_key,
    inputHash: row.input_hash,
    status,
    progress: { current: Number(row.progress_current || 0), total: Number(row.progress_total || 0) },
    snapshotId: row.snapshot_id === null ? null : Number(row.snapshot_id),
    supersededBy: row.superseded_by,
    error: row.error,
    createdAt: row.created_at || row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    result,
  };
}

function markForecastReadModelBuilding(viewKey, kind, profileKeyValue, jobKey, inputHash) {
  const stamp = now();
  const existing = db.prepare("SELECT payload_json FROM materialized_views WHERE view_key=?").get(viewKey);
  db.prepare(`INSERT INTO materialized_views(view_key,version,input_hash,status,payload_json,error,updated_at,kind,profile_key,job_key,building_input_hash,stale_since)
    VALUES (?,0,'','building',NULL,NULL,?,?,?,?,?,?)
    ON CONFLICT(view_key) DO UPDATE SET status='building',error=NULL,updated_at=excluded.updated_at,kind=excluded.kind,
    profile_key=excluded.profile_key,job_key=excluded.job_key,building_input_hash=excluded.building_input_hash,
    stale_since=CASE WHEN materialized_views.payload_json IS NOT NULL THEN excluded.stale_since ELSE NULL END`)
    .run(viewKey, stamp, kind, profileKeyValue, jobKey, inputHash, existing?.payload_json ? stamp : null);
}

function enqueueForecastJob({ kind, profile, simulation, rootSnapshotId = null, conditionalMatchId = null, trigger = null }) {
  const input = buildForecastJobInput({ kind, profile, simulation, rootSnapshotId, conditionalMatchId, trigger });
  const readModelIdentity = forecastReadModelKey(profile, rootSnapshotId);
  const profileKeyValue = readModelIdentity.profileKey;
  const viewKey = conditionalMatchId ? `${readModelIdentity.viewKey}:match:${conditionalMatchId}` : readModelIdentity.viewKey;
  const jobProfileKey = `${profileKeyValue}:${rootSnapshotId || "current"}:${conditionalMatchId || "main"}`;
  const jobKey = `forecast:${kind}:${input.inputHash}`;
  const existing = db.prepare("SELECT * FROM automation_jobs WHERE job_key=?").get(jobKey);
  if (existing) return publicForecastJob(existing);
  const payload = {
    kind, profile, simulation, rootSnapshotId, conditionalMatchId, viewKey, snapshotProfileKey: profileKeyValue,
    probabilities: input.probabilities, matches: input.matches, stats: input.stats,
    statsVersion: input.statsVersion, seed: input.seed, trigger,
  };
  const stamp = now();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`UPDATE automation_jobs SET superseded_by=?,updated_at=?
      WHERE profile_key=? AND kind=? AND status IN ('pending','leased') AND input_hash<>? AND superseded_by IS NULL`)
      .run(jobKey, stamp, jobProfileKey, kind, input.inputHash);
    db.prepare(`INSERT INTO automation_jobs(job_key,job_type,input_hash,status,attempts,updated_at,kind,profile_key,input_json,
      progress_current,progress_total,trigger,created_at)
      VALUES (?,?,?,'pending',0,?,?,?,?,0,?,?,?)`)
      .run(jobKey, "forecast", input.inputHash, stamp, kind, jobProfileKey, JSON.stringify(payload), simulation.iterations, trigger, stamp);
    markForecastReadModelBuilding(viewKey, kind, profileKeyValue, jobKey, input.inputHash);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  scheduleForecastJobs(0);
  return publicForecastJob(db.prepare("SELECT * FROM automation_jobs WHERE job_key=?").get(jobKey));
}

function claimForecastJob() {
  const stamp = now();
  const candidate = db.prepare(`SELECT job_key FROM automation_jobs
    WHERE job_type='forecast' AND superseded_by IS NULL AND cancel_requested_at IS NULL
      AND ((status='pending' AND attempts < ?) OR (status='leased' AND lease_until < ? AND attempts < ?))
    ORDER BY CASE kind WHEN 'manual' THEN 0 WHEN 'conditional' THEN 1 ELSE 2 END,created_at,updated_at LIMIT 1`)
    .get(FORECAST_JOB_MAX_ATTEMPTS, stamp, FORECAST_JOB_MAX_ATTEMPTS);
  if (!candidate) return null;
  const leaseToken = randomBytes(18).toString("base64url");
  const leaseUntil = new Date(Date.now() + FORECAST_JOB_LEASE_SECONDS * 1000).toISOString();
  const claimed = db.prepare(`UPDATE automation_jobs SET status='leased',lease_until=?,lease_token=?,attempts=attempts+1,
    started_at=COALESCE(started_at,?),error=NULL,updated_at=? WHERE job_key=? AND superseded_by IS NULL
    AND cancel_requested_at IS NULL AND (status='pending' OR (status='leased' AND lease_until < ?))`)
    .run(leaseUntil, leaseToken, stamp, stamp, candidate.job_key, stamp);
  return claimed.changes ? db.prepare("SELECT * FROM automation_jobs WHERE job_key=?").get(candidate.job_key) : null;
}

function publishForecastJob(row, payload, result) {
  const current = db.prepare("SELECT * FROM automation_jobs WHERE job_key=?").get(row.job_key);
  if (!current || current.lease_token !== row.lease_token || current.superseded_by || current.cancel_requested_at) return false;
  let snapshotId = null;
  if (payload.kind !== "conditional") {
    const completedMatchCount = payload.matches.filter((match) => match.winner).length;
    const rootId = payload.rootSnapshotId ? Number(payload.rootSnapshotId) : null;
    const parentId = rootId ? db.prepare("SELECT id FROM prediction_snapshots WHERE root_snapshot_id=? OR id=? ORDER BY completed_match_count DESC,id DESC LIMIT 1").get(rootId, rootId)?.id ?? rootId : null;
    const snapshotKind = rootId ? "revision" : "original";
    const config = { forecastMode: payload.profile.forecastMode, opinionWeight: payload.profile.opinionWeight, iterations: result.iterations };
    snapshotId = insertSnapshot({
      trigger: payload.trigger || (payload.kind === "manual" ? "manual_run" : "scenario_refresh"),
      config,
      probabilities: payload.probabilities,
      result,
      stats: payload.stats,
      matches: payload.matches,
      inputs: { answers: payload.profile.answers, cutoffCompletedMatches: completedMatchCount, liveConstraintSignature: liveConstraintSignature(payload.matches), statsVersion: payload.statsVersion },
      kind: snapshotKind,
      rootId,
      parentId,
      key: payload.snapshotProfileKey,
    });
  }
  const stamp = now();
  const readPayload = payload.kind === "conditional"
    ? { kind: payload.kind, matchId: payload.conditionalMatchId, ...result }
    : { kind: payload.kind, snapshotId, profile: payload.profile, probabilities: payload.probabilities, result };
  db.exec("BEGIN IMMEDIATE");
  try {
    const stillCurrent = db.prepare("SELECT lease_token,superseded_by,cancel_requested_at FROM automation_jobs WHERE job_key=?").get(row.job_key);
    if (!stillCurrent || stillCurrent.lease_token !== row.lease_token || stillCurrent.superseded_by || stillCurrent.cancel_requested_at) {
      db.exec("ROLLBACK");
      if (snapshotId) db.prepare("DELETE FROM prediction_snapshots WHERE id=?").run(snapshotId);
      return false;
    }
    const previous = db.prepare("SELECT version FROM materialized_views WHERE view_key=?").get(payload.viewKey);
    db.prepare(`UPDATE materialized_views SET version=?,input_hash=?,status='ready',payload_json=?,error=NULL,updated_at=?,ready_at=?,
      job_key=?,building_input_hash=NULL,snapshot_id=?,stale_since=NULL WHERE view_key=? AND job_key=?`)
      .run(Number(previous?.version || 0) + 1, row.input_hash, JSON.stringify(readPayload), stamp, stamp, row.job_key, snapshotId, payload.viewKey, row.job_key);
    db.prepare(`UPDATE automation_jobs SET status='ready',lease_until=NULL,lease_token=NULL,progress_current=progress_total,
      result_json=?,snapshot_id=?,completed_at=?,updated_at=? WHERE job_key=? AND lease_token=?`)
      .run(JSON.stringify(readPayload), snapshotId, stamp, stamp, row.job_key, row.lease_token);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  audit("forecast_job_ready", { jobKey: row.job_key, kind: payload.kind, snapshotId, inputHash: row.input_hash });
  return true;
}

async function executeForecastJob(row) {
  let payload;
  try {
    payload = JSON.parse(row.input_json);
    const adaptive = payload.simulation.adaptive ? {
      enabled: true,
      minIterations: payload.simulation.iterations,
      maxIterations: payload.simulation.maxIterations,
      batchSize: payload.simulation.batchSize,
      tolerancePp: payload.simulation.tolerancePp,
      stableChecksRequired: 2,
    } : null;
    const result = await runForecastWorker({
      kind: payload.kind,
      probabilities: payload.probabilities,
      minimum: payload.simulation.iterations,
      seed: payload.seed,
      matches: payload.matches,
      stats: payload.stats,
      adaptive,
      conditionalMatchId: payload.conditionalMatchId,
    }, ({ current, total }) => {
      db.prepare("UPDATE automation_jobs SET progress_current=?,progress_total=?,updated_at=? WHERE job_key=? AND lease_token=?")
        .run(current, total, now(), row.job_key, row.lease_token);
    }, row.job_key);
    const wasPublished = publishForecastJob(row, payload, result);
    if (!wasPublished) {
      const current = db.prepare("SELECT superseded_by,cancel_requested_at FROM automation_jobs WHERE job_key=?").get(row.job_key);
      const stamp = now();
      db.prepare(`UPDATE automation_jobs SET status='failed',lease_until=NULL,lease_token=NULL,error=?,canceled_at=?,
        completed_at=?,updated_at=? WHERE job_key=? AND status='leased'`)
        .run(current?.cancel_requested_at ? "canceled" : "superseded", current?.cancel_requested_at ? stamp : null, stamp, stamp, row.job_key);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = db.prepare("SELECT lease_token,superseded_by,cancel_requested_at FROM automation_jobs WHERE job_key=?").get(row.job_key);
    if (current?.lease_token === row.lease_token) {
      const canceledAt = current.cancel_requested_at ? now() : null;
      db.prepare("UPDATE automation_jobs SET status='failed',lease_until=NULL,lease_token=NULL,error=?,canceled_at=?,completed_at=?,updated_at=? WHERE job_key=?")
        .run(canceledAt ? "canceled" : message, canceledAt, now(), now(), row.job_key);
      if (!current.superseded_by && payload?.viewKey) {
        db.prepare("UPDATE materialized_views SET status=CASE WHEN payload_json IS NULL THEN 'failed' ELSE 'ready' END,error=?,updated_at=? WHERE view_key=? AND job_key=?")
          .run(message, now(), payload.viewKey, row.job_key);
      }
    }
    console.error("Forecast job failed:", row.job_key, error);
  }
}

function scheduleForecastJobs(delay = FORECAST_JOB_POLL_MS) {
  if (forecastJobTimer) return;
  forecastJobTimer = setTimeout(async () => {
    forecastJobTimer = null;
    if (forecastJobRunning) return scheduleForecastJobs();
    const row = claimForecastJob();
    if (!row) return scheduleForecastJobs();
    forecastJobRunning = true;
    try { await executeForecastJob(row); } finally {
      forecastJobRunning = false;
      scheduleForecastJobs(0);
    }
  }, delay);
  forecastJobTimer.unref();
}

function readyForecastReadModel(profile, rootSnapshotId = null) {
  const { viewKey } = forecastReadModelKey(profile, rootSnapshotId);
  const row = db.prepare("SELECT * FROM materialized_views WHERE view_key=?").get(viewKey);
  if (!row) return null;
  let payload = null;
  try { payload = row.payload_json ? JSON.parse(row.payload_json) : null; } catch { payload = null; }
  const isStale = Boolean(payload && row.building_input_hash && row.building_input_hash !== row.input_hash);
  return {
    key: viewKey,
    version: Number(row.version),
    status: row.status === "failed" && !payload ? "error" : row.status === "building" ? "running" : "ready",
    inputHash: row.input_hash || null,
    buildingInputHash: row.building_input_hash,
    stale: isStale,
    staleSince: isStale ? row.stale_since : null,
    readyAt: payload ? row.ready_at || row.updated_at : null,
    error: row.error,
    jobId: row.job_key,
    snapshotId: row.snapshot_id === null ? null : Number(row.snapshot_id),
    payload,
  };
}

function queueAutomaticSnapshot(trigger, delay = 100) {
  pendingAutomaticSnapshotTrigger = trigger;
  if (autoSnapshotTimer) clearTimeout(autoSnapshotTimer);
  autoSnapshotTimer = setTimeout(() => {
    autoSnapshotTimer = null;
    const queuedTrigger = pendingAutomaticSnapshotTrigger ?? trigger;
    pendingAutomaticSnapshotTrigger = null;
    try {
      const canonicalAnswers = Object.fromEntries(db.prepare("SELECT pair_key,probability FROM answers ORDER BY pair_key").all().map((row) => [row.pair_key, Number(row.probability)]));
      for (const weight of FORECAST_CANONICAL_WEIGHTS) {
        enqueueForecastJob({
          kind: "scenario_refresh",
          profile: { forecastMode: weight ? "mixed" : "stats", opinionWeight: weight, answers: weight ? canonicalAnswers : {} },
          simulation: normalizedSimulationConfig(OFFICIAL_FORECAST_CONFIG, "scenario_refresh"),
          trigger: queuedTrigger,
        });
      }
      const roots = db.prepare("SELECT * FROM prediction_snapshots WHERE snapshot_kind='original' AND id=root_snapshot_id AND forecast_mode!='stats' GROUP BY profile_key ORDER BY id").all();
      for (const root of roots) {
        let inputs = {};
        try { inputs = root.inputs_json ? JSON.parse(root.inputs_json) : {}; } catch { inputs = {}; }
        if (root.forecast_mode === "mixed" && FORECAST_CANONICAL_WEIGHTS.has(Number(root.opinion_weight))) continue;
        enqueueForecastJob({
          kind: "scenario_refresh",
          profile: normalizedForecastProfile({ forecastMode: root.forecast_mode, opinionWeight: root.opinion_weight, answers: inputs.answers ?? {} }),
          simulation: normalizedSimulationConfig(OFFICIAL_FORECAST_CONFIG, "scenario_refresh"),
          rootSnapshotId: Number(root.id),
          trigger: `revision_${queuedTrigger}`,
        });
      }
    } catch (error) {
      console.error("Automatic forecast enqueue failed:", error);
      audit("automatic_snapshot_failed", { trigger: queuedTrigger, error: error instanceof Error ? error.message : String(error) });
    }
    if (pendingAutomaticSnapshotTrigger) queueAutomaticSnapshot(pendingAutomaticSnapshotTrigger, 100);
  }, delay);
  autoSnapshotTimer.unref();
}

function probabilityBefore(teamA, teamB, timestamp) {
  const snapshot = db.prepare("SELECT probabilities_json FROM prediction_snapshots WHERE created_at <= ? ORDER BY created_at DESC LIMIT 1").get(new Date(timestamp * 1000).toISOString());
  if (!snapshot) return null;
  try {
    const probabilities = JSON.parse(snapshot.probabilities_json);
    const key = [teamA, teamB].sort().join("|");
    const stored = probabilities[key];
    if (!Number.isFinite(stored)) return null;
    return key.startsWith(`${teamA}|`) ? stored : 100 - stored;
  } catch { return null; }
}

const stageForTimestamp = (timestamp) => timestamp >= TI_PLAYOFF_START ? "playoff" : timestamp >= TI_PLAYIN_START ? "playin" : "swiss";
const stageForScheduledSeries = (series) => {
  if (["swiss", "playin", "playoff"].includes(series.stage)) return series.stage;
  const sourceDate = series.scheduledAt || (series.scheduledDate ? `${series.scheduledDate}T00:00:00${SCHEDULE_TIMEZONE_OFFSET}` : null);
  if (!sourceDate) return null;
  const timestamp = Date.parse(sourceDate) / 1000;
  return Number.isFinite(timestamp) ? stageForTimestamp(timestamp) : null;
};
const probabilityFor = (probabilities, teamA, teamB) => {
  const key = [teamA, teamB].sort().join("|");
  const value = probabilities[key];
  return Number.isFinite(value) ? (key.startsWith(`${teamA}|`) ? value : 100 - value) : 50;
};

function persistScheduledSeries(series, probabilities) {
  const stage = stageForScheduledSeries(series);
  if (!stage) return "scheduledUnchanged";
  const sourceMatchId = `cybersport:${stage}:${series.round}:${[series.teamA, series.teamB].sort().join("|")}`;
  const existing = db.prepare(`SELECT * FROM matches WHERE stage = ? AND round = ?
    AND ((team_a = ? AND team_b = ?) OR (team_a = ? AND team_b = ?)) ORDER BY id DESC LIMIT 1`)
    .get(stage, series.round, series.teamA, series.teamB, series.teamB, series.teamA);
  if (existing?.winner) return "scheduledUnchanged";
  const predictedProbability = probabilityFor(probabilities, series.teamA, series.teamB);
  if (existing) {
    if (existing.scheduled_at === series.scheduledAt && existing.predicted_probability !== null) return "scheduledUnchanged";
    const orientedProbability = existing.team_a === series.teamA ? predictedProbability : 100 - predictedProbability;
    db.prepare("UPDATE matches SET scheduled_at = ?, source_match_id = COALESCE(source_match_id, ?), predicted_probability = COALESCE(predicted_probability, ?), updated_at = ? WHERE id = ?")
      .run(series.scheduledAt, sourceMatchId, orientedProbability, now(), existing.id);
    return "scheduledUpdated";
  }
  const stamp = now();
  db.prepare(`INSERT INTO matches(stage, round, team_a, team_b, scheduled_at, source_match_id, predicted_probability, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(stage, series.round, series.teamA, series.teamB, series.scheduledAt, sourceMatchId, predictedProbability, stamp, stamp);
  return "scheduledInserted";
}

function removeConflictingScheduledSeries(series) {
  const stage = stageForScheduledSeries(series);
  if (!stage) return 0;
  const conflicts = db.prepare(`SELECT id FROM matches
    WHERE stage = ? AND round = ? AND winner IS NULL AND source_match_id LIKE 'cybersport:%'
      AND (team_a IN (?, ?) OR team_b IN (?, ?))
      AND NOT ((team_a = ? AND team_b = ?) OR (team_a = ? AND team_b = ?))`)
    .all(stage, series.round, series.teamA, series.teamB, series.teamA, series.teamB, series.teamA, series.teamB, series.teamB, series.teamA);
  const remove = db.prepare("DELETE FROM matches WHERE id = ?");
  for (const conflict of conflicts) remove.run(conflict.id);
  return conflicts.length;
}

function officialPairingTrigger() {
  const pairings = db.prepare(`SELECT stage, round, team_a, team_b FROM matches
    WHERE winner IS NULL AND source_match_id LIKE 'cybersport:%'
    ORDER BY stage, round, team_a, team_b`).all();
  const signature = pairings.map((match) => `${match.stage}:${match.round}:${[match.team_a, match.team_b].sort().join("|")}`).join(";");
  return `auto_pairing_${createHash("sha256").update(signature).digest("hex").slice(0, 12)}`;
}

function persistLiveSeries(series) {
  const sourceMatchId = `opendota:${TI_LEAGUE_ID}:${series.seriesId}`;
  if (db.prepare("SELECT id FROM matches WHERE source_match_id = ?").get(sourceMatchId)) return "unchanged";
  const stage = stageForTimestamp(series.startTime);
  const winner = series.winsA > series.winsB ? series.teamA : series.teamB;
  const linkedMatchId = canonicalSeriesMatch(series.seriesId);
  const linked = linkedMatchId ? db.prepare("SELECT * FROM matches WHERE id=?").get(linkedMatchId) : null;
  if (linked && !linked.winner) {
    const scoreA = linked.team_a === series.teamA ? series.winsA : series.winsB;
    const scoreB = linked.team_b === series.teamB ? series.winsB : series.winsA;
    db.prepare("UPDATE matches SET winner=?,score_a=?,score_b=?,source_match_id=?,scheduled_at=COALESCE(scheduled_at,?),updated_at=? WHERE id=?")
      .run(winner, scoreA, scoreB, sourceMatchId, new Date(series.startTime * 1000).toISOString(), now(), linked.id);
    return "updated";
  }
  const manualResult = db.prepare(`SELECT * FROM matches WHERE stage = ? AND source_match_id IS NULL AND winner = ?
    AND ((team_a = ? AND team_b = ?) OR (team_a = ? AND team_b = ?)) ORDER BY id DESC LIMIT 1`).get(stage, winner, series.teamA, series.teamB, series.teamB, series.teamA);
  if (manualResult) {
    const scoreA = manualResult.team_a === series.teamA ? series.winsA : series.winsB;
    const scoreB = manualResult.team_b === series.teamB ? series.winsB : series.winsA;
    db.prepare("UPDATE matches SET score_a = ?, score_b = ?, source_match_id = ?, scheduled_at = COALESCE(scheduled_at, ?), updated_at = ? WHERE id = ?")
      .run(scoreA, scoreB, sourceMatchId, new Date(series.startTime * 1000).toISOString(), now(), manualResult.id);
    return "updated";
  }
  const scheduledCandidates = db.prepare(`SELECT * FROM matches
    WHERE stage = ? AND winner IS NULL AND ((team_a = ? AND team_b = ?) OR (team_a = ? AND team_b = ?))
    ORDER BY round, id`).all(stage, series.teamA, series.teamB, series.teamB, series.teamA);
  const scheduled = scheduledCandidates.length === 1 ? scheduledCandidates[0] : null;
  if (scheduledCandidates.length > 1) audit("series_link_ambiguous", { seriesId: String(series.seriesId), candidateIds: scheduledCandidates.map((row) => row.id), phase: "completed" });
  const stamp = now();
  if (scheduled) {
    const scoreA = scheduled.team_a === series.teamA ? series.winsA : series.winsB;
    const scoreB = scheduled.team_b === series.teamB ? series.winsB : series.winsA;
    db.prepare("UPDATE matches SET winner = ?, score_a = ?, score_b = ?, source_match_id = ?, scheduled_at = COALESCE(scheduled_at, ?), updated_at = ? WHERE id = ?")
      .run(winner, scoreA, scoreB, sourceMatchId, new Date(series.startTime * 1000).toISOString(), stamp, scheduled.id);
    db.prepare("INSERT OR IGNORE INTO series_links(match_id,opendota_series_id,linked_at,evidence_json) VALUES (?,?,?,?)")
      .run(scheduled.id, String(series.seriesId), stamp, JSON.stringify({ rule: "completed_team_pair_stage_unique", startTime: series.startTime }));
    return "updated";
  }
  const appearances = db.prepare("SELECT team_a, team_b FROM matches WHERE stage = ? AND winner IS NOT NULL").all(stage);
  const playedA = appearances.filter((match) => match.team_a === series.teamA || match.team_b === series.teamA).length;
  const playedB = appearances.filter((match) => match.team_a === series.teamB || match.team_b === series.teamB).length;
  const round = Math.max(playedA, playedB) + 1;
  const predictedProbability = probabilityBefore(series.teamA, series.teamB, series.startTime);
  db.prepare(`INSERT INTO matches(stage, round, team_a, team_b, winner, score_a, score_b, scheduled_at, source_match_id, predicted_probability, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(stage, round, series.teamA, series.teamB, winner, series.winsA, series.winsB, new Date(series.startTime * 1000).toISOString(), sourceMatchId, predictedProbability, stamp, stamp);
  return "inserted";
}

function persistTournamentMap(map, detail = null) {
  const source = detail ?? map;
  const radiantTeam = OPENDOTA_TEAMS.get(Number(source.radiant_team_id ?? map.radiant_team_id));
  const direTeam = OPENDOTA_TEAMS.get(Number(source.dire_team_id ?? map.dire_team_id));
  if (!radiantTeam || !direTeam || radiantTeam === direTeam || !map.match_id) return false;
  const events = Array.isArray(source.picks_bans) ? [...source.picks_bans].sort((a, b) => Number(a.order) - Number(b.order)) : null;
  const picks = events ? {
    radiant: events.filter((event) => event.is_pick && Number(event.team) === 0).map((event) => Number(event.hero_id)),
    dire: events.filter((event) => event.is_pick && Number(event.team) === 1).map((event) => Number(event.hero_id)),
  } : null;
  const bans = events ? {
    radiant: events.filter((event) => !event.is_pick && Number(event.team) === 0).map((event) => Number(event.hero_id)),
    dire: events.filter((event) => !event.is_pick && Number(event.team) === 1).map((event) => Number(event.hero_id)),
  } : null;
  const firstPick = events?.find((event) => event.is_pick);
  const winner = typeof source.radiant_win === "boolean" ? (source.radiant_win ? radiantTeam : direTeam) : null;
  const players = Array.isArray(source.players) ? source.players.slice(0, 10).map((player) => ({
    accountId: Number(player.account_id || 0), heroId: Number(player.hero_id || 0), slot: Number(player.player_slot),
    name: player.name ? String(player.name) : null,
  })) : null;
  db.prepare(`INSERT INTO tournament_maps(match_id,series_id,radiant_team,dire_team,winner,start_time,duration,patch,first_pick_team,picks_json,bans_json,draft_json,players_json,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(match_id) DO UPDATE SET
    series_id=excluded.series_id,radiant_team=excluded.radiant_team,dire_team=excluded.dire_team,winner=COALESCE(excluded.winner,tournament_maps.winner),
    start_time=COALESCE(excluded.start_time,tournament_maps.start_time),duration=COALESCE(excluded.duration,tournament_maps.duration),
    patch=COALESCE(excluded.patch,tournament_maps.patch),first_pick_team=COALESCE(excluded.first_pick_team,tournament_maps.first_pick_team),
    picks_json=COALESCE(excluded.picks_json,tournament_maps.picks_json),bans_json=COALESCE(excluded.bans_json,tournament_maps.bans_json),
    draft_json=COALESCE(excluded.draft_json,tournament_maps.draft_json),players_json=COALESCE(excluded.players_json,tournament_maps.players_json),updated_at=excluded.updated_at`)
    .run(String(map.match_id), String(source.series_id ?? map.series_id ?? ""), radiantTeam, direTeam, winner,
      Number(source.start_time || map.start_time || 0) || null, Number(source.duration || map.duration || 0) || null,
      Number(source.patch || 0) || null, firstPick ? (Number(firstPick.team) === 0 ? "radiant" : "dire") : null,
      picks ? JSON.stringify(picks) : null, bans ? JSON.stringify(bans) : null, events ? JSON.stringify(events) : null,
      players ? JSON.stringify(players) : null, now());
  return true;
}

async function hydrateTournamentMapDetails(maps) {
  if (!MAP_DETAIL_SYNC_LIMIT) return { requested: 0, saved: 0, failed: 0, remaining: 0 };
  const missing = (maps || []).filter((map) => !db.prepare("SELECT draft_json FROM tournament_maps WHERE match_id=? AND draft_json IS NOT NULL").get(String(map.match_id)));
  const queue = missing.slice(0, MAP_DETAIL_SYNC_LIMIT);
  let saved = 0; let failed = 0;
  for (const map of queue) {
    try {
      const response = await fetch(`${OPENDOTA_API_URL}/matches/${map.match_id}`, { headers: { "user-agent": "ti-2026-predictor/1.0 (github.com/balance-loz/ti-2026)" }, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`OpenDota match ${map.match_id} HTTP ${response.status}`);
      if (persistTournamentMap(map, await response.json())) saved += 1;
    } catch { failed += 1; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { requested: queue.length, saved, failed, remaining: Math.max(0, missing.length - saved) };
}

function parsedTournamentMaps() {
  return db.prepare(`SELECT map.*,prediction.probability_radiant,prediction.model_id,prediction.evidence_json,prediction.captured_at
    FROM tournament_maps map LEFT JOIN live_draft_predictions prediction ON prediction.match_id=map.match_id
    ORDER BY map.start_time,map.match_id`).all().map((row) => {
      const probabilityRadiant = row.probability_radiant === null ? null : Number(row.probability_radiant);
      const predictedWinner = probabilityRadiant === null ? null : probabilityRadiant >= 0.5 ? row.radiant_team : row.dire_team;
      const timeliness = probabilityRadiant === null ? null : predictionTimeliness(row.captured_at, row.start_time ? new Date(Number(row.start_time) * 1000).toISOString() : null, 0);
      return {
        matchId: row.match_id, seriesId: row.series_id, radiantTeam: row.radiant_team, direTeam: row.dire_team,
        winner: row.winner, startTime: row.start_time, duration: row.duration, patch: row.patch, firstPickTeam: row.first_pick_team,
        picks: row.picks_json ? JSON.parse(row.picks_json) : null, bans: row.bans_json ? JSON.parse(row.bans_json) : null,
        draft: row.draft_json ? JSON.parse(row.draft_json) : null, players: row.players_json ? JSON.parse(row.players_json) : null,
        draftPrediction: probabilityRadiant === null ? null : {
          probabilityRadiant, modelId: row.model_id, capturedAt: row.captured_at, predictedWinner, timeliness,
          predictionCorrect: row.winner ? predictedWinner === row.winner : null,
          evidence: row.evidence_json ? JSON.parse(row.evidence_json) : null,
        },
      };
    });
}

function parsedBetLocks() {
  const seriesResults = new Map(db.prepare("SELECT id,winner,score_a,score_b FROM matches WHERE winner IS NOT NULL").all().map((row) => [String(row.id), row]));
  const mapResults = new Map(db.prepare("SELECT match_id,winner FROM tournament_maps WHERE winner IS NOT NULL").all().map((row) => [String(row.match_id), row]));
  return db.prepare("SELECT * FROM bet_locks ORDER BY created_at,id").all().map((row) => {
    const result = row.scope === "series" ? seriesResults.get(String(row.subject_id)) : mapResults.get(String(row.subject_id));
    const winner = result?.winner ?? null;
    const actualScore = row.scope === "series" && result ? `${result.score_a}:${result.score_b}` : null;
    return {
      id: row.id, scope: row.scope, subjectId: row.subject_id, teamA: row.team_a, teamB: row.team_b,
      probabilityA: Number(row.probability_a), recommendedWinner: row.recommended_winner, exactScore: row.exact_score,
      source: row.source, opinionWeight: row.opinion_weight, snapshotId: row.snapshot_id, modelId: row.model_id,
      evidence: JSON.parse(row.evidence_json), createdAt: row.created_at, winner, actualScore,
      predictionCorrect: winner ? winner === row.recommended_winner : null,
      exactScoreCorrect: actualScore && row.exact_score ? actualScore === row.exact_score : null,
    };
  });
}

async function syncLiveMatches(trigger = "timer") {
  if (liveSyncPromise) return liveSyncPromise;
  liveSyncPromise = (async () => {
    const startedAt = now();
    try {
      let maps = []; let schedule = []; let resultError = null; let scheduleError = null;
      try {
        const response = await fetch(`${OPENDOTA_API_URL}/leagues/${TI_LEAGUE_ID}/matches`, { headers: { "user-agent": "ti-2026-predictor/1.0 (github.com/balance-loz/ti-2026)" }, signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`OpenDota HTTP ${response.status}`);
        maps = await response.json();
        if (!Array.isArray(maps)) throw new Error("OpenDota returned an invalid payload");
        liveLeagueMapsCache = { maps, fetchedAt: now() };
      } catch (error) { resultError = error instanceof Error ? error.message : String(error); }
      if (SCHEDULE_SYNC_ENABLED) try {
        const response = await fetch(SCHEDULE_SOURCE_URL, { headers: { "user-agent": "ti-2026-predictor/1.0 (github.com/balance-loz/ti-2026)" }, signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`Cybersport HTTP ${response.status}`);
        schedule = scheduledSeriesFromCybersportHtml(await response.text(), { timezoneOffset: SCHEDULE_TIMEZONE_OFFSET });
      } catch (error) { scheduleError = error instanceof Error ? error.message : String(error); }
      if (resultError && (!SCHEDULE_SYNC_ENABLED || scheduleError)) throw new Error(`OpenDota: ${resultError}; schedule: ${scheduleError || "disabled"}`);
      const series = completedSeriesFromMaps(maps);
      const unknownTeamIds = [...new Set(maps.flatMap((map) => [Number(map.radiant_team_id), Number(map.dire_team_id)]).filter((id) => id && !OPENDOTA_TEAMS.has(id)))];
      const summary = { ok: !resultError && !scheduleError, partial: Boolean(resultError || scheduleError), trigger, startedAt, maps: maps.length, completedSeries: series.length, unknownTeamIds, resultError, scheduleError, scheduleSource: SCHEDULE_SYNC_ENABLED ? "Cybersport.ru" : "disabled", scheduledFound: schedule.length, scheduledInserted: 0, scheduledUpdated: 0, scheduledRemoved: 0, scheduledUnchanged: 0, mapDetails: null, forecastQueued: false, inserted: 0, updated: 0, unchanged: 0 };
      db.exec("BEGIN");
      try {
        const probabilities = schedule.length ? currentForecast().probabilities : {};
        for (const item of schedule) {
          summary.scheduledRemoved += removeConflictingScheduledSeries(item);
          summary[persistScheduledSeries(item, probabilities)] += 1;
        }
        for (const map of maps) persistTournamentMap(map);
        for (const item of series) summary[persistLiveSeries(item)] += 1;
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      summary.mapDetails = await hydrateTournamentMapDetails(maps);
      const scheduleChanged = summary.scheduledInserted || summary.scheduledUpdated || summary.scheduledRemoved;
      if (summary.inserted || summary.updated) { audit("live_sync_results", summary); queueAutomaticSnapshot("auto_live_result"); summary.forecastQueued = true; }
      if (scheduleChanged) {
        audit("official_schedule_sync", summary);
        queueAutomaticSnapshot(officialPairingTrigger());
        summary.forecastQueued = true;
      }
      const persistedMatches = db.prepare("SELECT * FROM matches ORDER BY round,id").all();
      if (!summary.forecastQueued && officialSnapshotNeedsRefresh(persistedMatches)) {
        queueAutomaticSnapshot("auto_reconcile");
        summary.forecastQueued = true;
      }
      db.prepare("INSERT INTO settings(key,value,updated_at) VALUES ('live_sync',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(JSON.stringify(summary), now());
      return summary;
    } catch (error) {
      const summary = { ok: false, trigger, startedAt, error: error instanceof Error ? error.message : String(error) };
      db.prepare("INSERT INTO settings(key,value,updated_at) VALUES ('live_sync',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(JSON.stringify(summary), now());
      audit("live_sync_failed", summary);
      throw error;
    } finally { liveSyncPromise = null; }
  })();
  return liveSyncPromise;
}

async function refreshLiveDrafts({ force = false } = {}) {
  const freshFor = LIVE_DRAFT_INTERVAL_SECONDS * 1000;
  if (!force && liveDraftCache.fetchedAt && Date.now() - Date.parse(liveDraftCache.fetchedAt) < freshFor) return liveDraftCache;
  if (liveDraftPromise) return liveDraftPromise;
  liveDraftPromise = (async () => {
    try {
      const headers = { "user-agent": "ti-2026-predictor/1.0 (github.com/balance-loz/ti-2026)" };
      const mapsAreStale = !liveLeagueMapsCache.fetchedAt || Date.now() - Date.parse(liveLeagueMapsCache.fetchedAt) > 30_000;
      const mapsPromise = mapsAreStale
        ? fetch(`${OPENDOTA_API_URL}/leagues/${TI_LEAGUE_ID}/matches`, { headers, signal: AbortSignal.timeout(10_000) })
          .then(async (response) => response.ok ? response.json() : Promise.reject(new Error(`OpenDota league HTTP ${response.status}`)))
          .then((maps) => { if (Array.isArray(maps)) liveLeagueMapsCache = { maps, fetchedAt: now() }; return liveLeagueMapsCache.maps; })
          .catch(() => liveLeagueMapsCache.maps)
        : Promise.resolve(liveLeagueMapsCache.maps);
      const response = await fetch(`${OPENDOTA_API_URL}/live`, { headers, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`OpenDota live HTTP ${response.status}`);
      const rows = await response.json();
      const leagueMaps = await mapsPromise;
      const fetchedAt = now();
      const games = liveDraftsFromOpenDota(rows, { leagueId: TI_LEAGUE_ID, nowSeconds: Date.parse(fetchedAt) / 1000, leagueMaps });
      for (const game of games) {
        linkActiveSeries(game, fetchedAt);
        const draftPrediction = observeStableDraft(game, fetchedAt);
        persistLiveDraftSnapshot(game, fetchedAt, draftPrediction);
      }
      const currentGames = games.map(decorateLiveDraft);
      liveDraftCache = {
        games: mergeLiveDraftGames(currentGames, liveDraftCache.games, leagueMaps, {
          fetchedAt,
          previousFetchedAt: liveDraftCache.fetchedAt,
          graceSeconds: LIVE_DRAFT_GRACE_SECONDS,
        }),
        fetchedAt,
        error: null,
      };
    } catch (error) {
      liveDraftCache = { ...liveDraftCache, error: error instanceof Error ? error.message : String(error) };
    } finally { liveDraftPromise = null; }
    return liveDraftCache;
  })();
  return liveDraftPromise;
}

function latestMainSnapshot(opinionWeight, requestedSnapshotId = null) {
  const weight = Math.round(Math.min(100, Math.max(0, Number(opinionWeight) || 0)));
  const mode = weight > 0 ? "mixed" : "stats";
  const fields = "id,trigger,forecast_mode,opinion_weight,completed_match_count,probabilities_json,result_json,snapshot_kind,root_snapshot_id,created_at";
  const requested = Number.isInteger(Number(requestedSnapshotId)) && Number(requestedSnapshotId) > 0
    ? db.prepare(`SELECT ${fields} FROM prediction_snapshots WHERE id=?`).get(Number(requestedSnapshotId))
    : null;
  const profileLatest = db.prepare(`SELECT ${fields}
    FROM prediction_snapshots WHERE forecast_mode=? AND opinion_weight=?
    ORDER BY completed_match_count DESC,id DESC LIMIT 1`).get(mode, weight)
    ?? (weight > 0 ? db.prepare(`SELECT ${fields}
      FROM prediction_snapshots WHERE forecast_mode='stats' ORDER BY completed_match_count DESC,id DESC LIMIT 1`).get() : null);
  const selected = requested ?? profileLatest;
  if (!selected) return null;
  const rootId = Number(selected.root_snapshot_id ?? selected.id);
  const root = db.prepare(`SELECT ${fields} FROM prediction_snapshots WHERE id=?`).get(rootId) ?? selected;
  const latest = requested
    ? db.prepare(`SELECT ${fields} FROM prediction_snapshots WHERE root_snapshot_id=? OR id=? ORDER BY completed_match_count DESC,id DESC LIMIT 1`).get(rootId, rootId) ?? selected
    : profileLatest ?? selected;
  return {
    id: latest.id, trigger: latest.trigger, mode: root.forecast_mode, opinionWeight: root.opinion_weight,
    completedMatchCount: latest.completed_match_count, createdAt: latest.created_at,
    probabilities: JSON.parse(latest.probabilities_json), result: JSON.parse(latest.result_json),
    baselineId: root.id, baselineCreatedAt: root.created_at, baselineMode: root.forecast_mode,
    baselineProbabilities: JSON.parse(root.probabilities_json), baselineResult: JSON.parse(root.result_json), requested: Boolean(requested),
  };
}

function bestOfForMatch(match, game = null) {
  if ([1, 3, 5].includes(Number(game?.seriesBestOf))) return Number(game.seriesBestOf);
  const decidingWins = Math.max(Number(match.score_a || 0), Number(match.score_b || 0));
  if (decidingWins >= 3) return 5;
  return 3;
}

function projectedMatchupState(simulationResult, matches) {
  const canonicalPair = (a, b) => [a, b].sort().join("|");
  const known = new Set(matches.map((match) => `${match.stage}:${Number(match.round)}:${canonicalPair(match.team_a, match.team_b)}`));
  const card = (stage, item, index) => {
    const probabilityA = Math.min(.99, Math.max(.01, Number(item.aWinProbability) / 100));
    const forecast = combinedSeriesForecast({ teamA: item.a, teamB: item.b, seriesProbabilityA: probabilityA, bestOf: 3 });
    const exact = mostLikelyExactScore(forecast.exactScores);
    return {
      id: `${stage}:${Number(item.round || 0)}:${canonicalPair(item.a, item.b)}:${index}`,
      stage, round: stage === "swiss" ? Number(item.round) : 1,
      teamA: item.a, teamB: item.b,
      pairProbability: Number(item.probability), probabilityA,
      predictedWinner: probabilityA >= .5 ? item.a : item.b,
      exactScore: exact?.score ?? null, exactScoreProbability: exact?.probability ?? null,
      exactScores: forecast.topExactScores,
      occurrences: Number(item.occurrences || 0),
    };
  };
  const swissByRound = new Map();
  for (const item of simulationResult?.swissMatchups || []) {
    if (known.has(`swiss:${Number(item.round)}:${canonicalPair(item.a, item.b)}`)) continue;
    const round = Number(item.round);
    swissByRound.set(round, [...(swissByRound.get(round) || []), item]);
  }
  const swiss = [...swissByRound.entries()].sort(([a], [b]) => a - b).flatMap(([, items]) => items.sort((a, b) => Number(b.probability) - Number(a.probability)).slice(0, 12)).map((item, index) => card("swiss", item, index));
  const officialPlayins = matches.filter((match) => match.stage === "playin");
  const officialTeams = new Set(officialPlayins.flatMap((match) => [match.team_a, match.team_b]));
  const official = officialPlayins.map((match, index) => {
    const probabilityA = match.predicted_probability !== null && match.predicted_probability !== undefined && Number.isFinite(Number(match.predicted_probability))
      ? Number(match.predicted_probability) / 100 : null;
    return {
      id: `playin:official:${match.id}`, stage: "playin", round: Number(match.round), teamA: match.team_a, teamB: match.team_b,
      probabilityA, predictedWinner: probabilityA === null ? null : probabilityA >= .5 ? match.team_a : match.team_b,
      exactScore: null, exactScoreProbability: null, pairProbability: 100, occurrences: 0,
      official: true, scheduledAt: match.scheduled_at ?? null, matchId: match.id, index,
    };
  });
  const alternatives = (simulationResult?.playinMatchups || [])
    .filter((item) => !officialTeams.has(item.a) && !officialTeams.has(item.b))
    .filter((item) => !known.has(`playin:1:${canonicalPair(item.a, item.b)}`))
    .slice(0, 10).map((item, index) => ({ ...card("playin", item, index), official: false, projectionScope: "marginal" }));
  return { swiss, playins: [...official, ...alternatives], officialPlayins: official, playinAlternatives: alternatives, playinProjectionScope: "marginal_not_joint_pairing_rule" };
}

async function combinedForecastState(opinionWeight = 10, requestedSnapshotId = null, { refreshLive = false } = {}) {
  const weight = Math.round(Math.min(100, Math.max(0, Number(opinionWeight) || 0)));
  const mode = weight > 0 ? "mixed" : "stats";
  const { matches, probabilities } = currentForecast({ ...OFFICIAL_FORECAST_CONFIG, forecastMode: mode, opinionWeight: weight });
  const mainSnapshot = latestMainSnapshot(weight, requestedSnapshotId);
  const modelComparison = mainSnapshot ? snapshotDecisionEvaluation(mainSnapshot.baselineId) : null;
  const productionProbabilities = modelComparison?.selected === "static" ? mainSnapshot?.baselineProbabilities ?? probabilities : mainSnapshot?.probabilities ?? probabilities;
  const live = refreshLive ? await refreshLiveDrafts() : liveDraftCache;
  const maps = parsedTournamentMaps();
  const series = matches.map((match) => {
    const seriesId = String(match.source_match_id || "").startsWith("opendota:") ? String(match.source_match_id).split(":").at(-1) : null;
    const game = live.games.find((item) => {
      const freshnessAnchor = item.serverSeenAt || item.lastUpdateAt;
      const isFresh = freshnessAnchor && Date.now() - Date.parse(freshnessAnchor) <= LIVE_DRAFT_GRACE_SECONDS * 1_000;
      if (!isFresh) return false;
      return (seriesId && String(item.seriesId) === seriesId) || canonicalSeriesMatch(item.seriesId) === Number(match.id);
    });
    const probabilityFromBlend = orientedProbability(match.team_a, match.team_b, probabilities);
    const storedProbability = match.predicted_probability !== null && match.predicted_probability !== undefined && Number.isFinite(Number(match.predicted_probability)) ? Number(match.predicted_probability) / 100 : null;
    const latestSeriesProbabilityA = probabilityFromBlend ?? storedProbability ?? 0.5;
    const lockedSeriesProbabilityA = storedProbability;
    const snapshotBaselineProbabilityA = mainSnapshot?.baselineMode === "stats" ? null : orientedProbability(match.team_a, match.team_b, mainSnapshot?.baselineProbabilities ?? {});
    const historicalProbabilityA = snapshotBaselineProbabilityA ?? lockedSeriesProbabilityA;
    const bestOf = bestOfForMatch(match, game);
    const historicalForecast = historicalProbabilityA === null ? null : combinedSeriesForecast({ teamA: match.team_a, teamB: match.team_b, seriesProbabilityA: historicalProbabilityA, sourceBestOf: 3, bestOf });
    const historicalExact = historicalForecast ? mostLikelyExactScore(historicalForecast.exactScores) : null;
    const lockTimeliness = lockedSeriesProbabilityA === null ? null : predictionTimeliness(match.created_at, match.scheduled_at, DECISION_MIN_LEAD_MINUTES);
    const draftProbabilityRadiant = game?.draftPrediction?.probabilityRadiant ?? null;
    const draftMapProbabilityA = game && Number.isFinite(Number(draftProbabilityRadiant))
      ? game.radiantTeam === match.team_a ? Number(draftProbabilityRadiant) : 1 - Number(draftProbabilityRadiant)
      : null;
    let liveEstimate = null; let currentMapProbabilityA = draftMapProbabilityA;
    if (game && draftProbabilityRadiant !== null && Number.isFinite(Number(draftProbabilityRadiant))) {
      try { liveEstimate = estimateLiveMap(currentLiveMapModel(), { draftProbabilityRadiant, game }); } catch { liveEstimate = null; }
      const canApplyLiveEstimate = !game?.stale && !game?.retained && !liveEstimate?.assessment?.stale
        && Number.isFinite(Number(liveEstimate?.liveProbabilityRadiant));
      const radiantProbability = canApplyLiveEstimate ? Number(liveEstimate.liveProbabilityRadiant) : Number(draftProbabilityRadiant);
      currentMapProbabilityA = game.radiantTeam === match.team_a ? radiantProbability : 1 - radiantProbability;
    }
    const presentedLiveEstimate = liveEstimate ? {
      ...liveEstimate,
      frozenProbabilityA: game?.radiantTeam === match.team_a
        ? liveEstimate.frozenDraftProbabilityRadiant
        : 1 - liveEstimate.frozenDraftProbabilityRadiant,
      observedProbabilityA: Number.isFinite(Number(liveEstimate.liveProbabilityRadiant))
        ? game?.radiantTeam === match.team_a ? Number(liveEstimate.liveProbabilityRadiant) : 1 - Number(liveEstimate.liveProbabilityRadiant)
        : null,
      source: "experimental_live_map_observation",
      stale: Boolean(game?.stale || game?.retained || liveEstimate.assessment?.stale),
    } : null;
    const winsA = game ? (game.radiantTeam === match.team_a ? game.seriesScoreRadiant : game.seriesScoreDire) : 0;
    const winsB = game ? (game.radiantTeam === match.team_b ? game.seriesScoreRadiant : game.seriesScoreDire) : 0;
    const productionProbabilityA = orientedProbability(match.team_a, match.team_b, productionProbabilities) ?? latestSeriesProbabilityA;
    const productionForecast = combinedSeriesForecast({ teamA: match.team_a, teamB: match.team_b, seriesProbabilityA: productionProbabilityA, sourceBestOf: 3, bestOf, winsA, winsB, currentMapProbabilityA: draftMapProbabilityA });
    const forecast = combinedSeriesForecast({ teamA: match.team_a, teamB: match.team_b, seriesProbabilityA: latestSeriesProbabilityA, bestOf, winsA, winsB, currentMapProbabilityA });
    const decisionForecast = combinedSeriesForecast({ teamA: match.team_a, teamB: match.team_b, seriesProbabilityA: lockedSeriesProbabilityA ?? latestSeriesProbabilityA, bestOf });
    const predictedExact = mostLikelyExactScore(decisionForecast.exactScores);
    const predictedWinner = (lockedSeriesProbabilityA ?? latestSeriesProbabilityA) >= 0.5 ? match.team_a : match.team_b;
    return {
      match,
      seriesId,
      main: { probabilityA: productionForecast.probabilityA, sourceProbabilityA: productionProbabilityA, exactScores: productionForecast.exactScores, topExactScores: productionForecast.topExactScores, exactScoresScope: productionForecast.exactScoresScope, baseMapProbabilityA: productionForecast.baseMapProbabilityA, currentMapProbabilityA: draftMapProbabilityA, targetSeriesProbabilityA: productionForecast.targetSeriesProbabilityA, sourceBestOf: 3, bestOf, variant: modelComparison?.selected ?? "adaptive" },
      forecast,
      decision: {
        probabilityA: lockedSeriesProbabilityA,
        fallbackProbabilityA: lockedSeriesProbabilityA ?? latestSeriesProbabilityA,
        targetProbabilityA: decisionForecast.probabilityA,
        capturedAt: lockedSeriesProbabilityA === null ? null : match.created_at,
        timeliness: lockTimeliness,
        predictedWinner,
        predictedExactScore: predictedExact?.score ?? null,
        predictedExactScoreProbability: predictedExact?.probability ?? null,
        predictionCorrect: match.winner && historicalProbabilityA !== null
          ? (historicalProbabilityA >= 0.5 ? match.team_a : match.team_b) === match.winner
          : null,
        exactScoreCorrect: match.winner && predictedExact ? predictedExact.score === `${match.score_a}:${match.score_b}` : null,
        historicalProbabilityA,
        historicalWinner: historicalProbabilityA === null ? null : historicalProbabilityA >= 0.5 ? match.team_a : match.team_b,
        historicalExactScore: historicalExact?.score ?? null,
        historicalExactScoreProbability: historicalExact?.probability ?? null,
        historicalSource: snapshotBaselineProbabilityA !== null ? "snapshot" : lockedSeriesProbabilityA !== null ? "prematch" : null,
        historicalSnapshotId: snapshotBaselineProbabilityA !== null ? mainSnapshot?.baselineId ?? null : null,
        historicalCapturedAt: snapshotBaselineProbabilityA !== null ? mainSnapshot?.baselineCreatedAt ?? null : lockedSeriesProbabilityA !== null ? match.created_at : null,
      },
      latest: { probabilityA: latestSeriesProbabilityA, sourceBestOf: 3, targetProbabilityA: forecast.targetSeriesProbabilityA, generatedAt: now() },
      live: game ? { ...game, history: undefined } : null,
      liveEstimate: presentedLiveEstimate,
      sources: {
        opinionWeight: weight,
        statisticsWeight: 100 - weight,
        onlineSeriesCount: matches.filter((item) => item.winner).length,
        draftApplied: draftProbabilityRadiant !== null && Number.isFinite(Number(draftProbabilityRadiant)),
        liveStateApplied: !presentedLiveEstimate?.stale && Number.isFinite(Number(presentedLiveEstimate?.observedProbabilityA)),
      },
    };
  });
  const betLocks = parsedBetLocks();
  const simulation = modelComparison?.selected === "static" ? mainSnapshot?.baselineResult ?? null : mainSnapshot?.result ?? null;
  const projections = projectedMatchupState(simulation, matches);
  if (!Array.isArray(simulation?.swissMatchups)) queueAutomaticSnapshot("combined_matchup_distribution", 100);
  const bracket = projectPlayoffBracket({ simulationResult: simulation, probabilities: productionProbabilities, matches, betLocks });
  return {
    generatedAt: now(),
    policy: {
      historicalBaseline: "frozen",
      tiResults: "online_bradley_terry_once",
      draft: "frozen_after_complete_draft",
      activeDraft: "published_main_weight_1",
      temporalDraft: "shadow_weight_0",
      nextgen: "shadow_weight_0",
      formLogitSd: 0,
      liveMap: "observation_latest_only_never_main_or_future_maps",
      onlineUpdate: "active_experimental",
      futureMaps: "frozen_pre_series_map_prior",
      probabilitySet: modelComparison?.selected ?? "adaptive",
      decisionHistory: "explicit_admin_bet_lock_is_immutable_latest_remains_live",
    },
    decisionPolicy: { minimumLeadMinutes: DECISION_MIN_LEAD_MINUTES, lateForecastsExcludedFromDecisionScore: true },
    opinionWeight: weight,
    mainSnapshot: mainSnapshot ? { id: mainSnapshot.id, baselineId: mainSnapshot.baselineId, baselineCreatedAt: mainSnapshot.baselineCreatedAt, requested: mainSnapshot.requested, trigger: mainSnapshot.trigger, mode: mainSnapshot.mode, opinionWeight: mainSnapshot.opinionWeight, completedMatchCount: mainSnapshot.completedMatchCount, createdAt: mainSnapshot.createdAt } : null,
    modelComparison,
    simulation,
    projections,
    series,
    maps,
    betLocks,
    bracket,
    live: { fetchedAt: live.fetchedAt, error: live.error },
  };
}

function combinedInputHash(opinionWeight = 10) {
  const latestSnapshot = db.prepare("SELECT id,created_at FROM prediction_snapshots ORDER BY id DESC LIMIT 1").get() ?? null;
  const matches = db.prepare("SELECT id,updated_at FROM matches ORDER BY id").all();
  const locks = db.prepare("SELECT id,created_at FROM bet_locks ORDER BY id").all();
  const drafts = db.prepare("SELECT match_id,picks_hash,captured_at FROM live_draft_predictions ORDER BY match_id").all();
  return createHash("sha256").update(JSON.stringify({ opinionWeight: Number(opinionWeight), latestSnapshot, matches, locks, drafts })).digest("hex");
}

function activeGameForSeries(row) {
  return liveDraftCache.games.find((game) => {
    const freshnessAnchor = game.serverSeenAt || game.lastUpdateAt;
    if (!freshnessAnchor || Date.now() - Date.parse(freshnessAnchor) > LIVE_DRAFT_GRACE_SECONDS * 1_000) return false;
    return (row.seriesId && String(game.seriesId) === String(row.seriesId))
      || canonicalSeriesMatch(game.seriesId) === Number(row.match.id);
  }) ?? null;
}

function liveOverlayForSeries(row) {
  const game = activeGameForSeries(row);
  if (!game) return { ...row, live: null, liveEstimate: null, sources: { ...row.sources, liveStateApplied: false } };
  const draftProbabilityRadiant = game.draftPrediction?.probabilityRadiant ?? null;
  const hasDraft = Number.isFinite(Number(draftProbabilityRadiant));
  const draftMapProbabilityA = hasDraft
    ? game.radiantTeam === row.match.team_a ? Number(draftProbabilityRadiant) : 1 - Number(draftProbabilityRadiant)
    : null;
  let liveEstimate = null; let currentMapProbabilityA = draftMapProbabilityA;
  if (hasDraft) {
    try { liveEstimate = estimateLiveMap(currentLiveMapModel(), { draftProbabilityRadiant, game }); } catch { liveEstimate = null; }
    const canApplyLive = !game.stale && !game.retained && !liveEstimate?.assessment?.stale && Number.isFinite(Number(liveEstimate?.liveProbabilityRadiant));
    const radiantProbability = canApplyLive ? Number(liveEstimate.liveProbabilityRadiant) : Number(draftProbabilityRadiant);
    currentMapProbabilityA = game.radiantTeam === row.match.team_a ? radiantProbability : 1 - radiantProbability;
  }
  const winsA = game.radiantTeam === row.match.team_a ? game.seriesScoreRadiant : game.seriesScoreDire;
  const winsB = game.radiantTeam === row.match.team_b ? game.seriesScoreRadiant : game.seriesScoreDire;
  const bestOf = bestOfForMatch(row.match, game);
  const forecast = combinedSeriesForecast({ teamA: row.match.team_a, teamB: row.match.team_b, seriesProbabilityA: row.latest.probabilityA, bestOf, winsA, winsB, currentMapProbabilityA });
  const presented = liveEstimate ? {
    ...liveEstimate,
    frozenProbabilityA: game.radiantTeam === row.match.team_a ? liveEstimate.frozenDraftProbabilityRadiant : 1 - liveEstimate.frozenDraftProbabilityRadiant,
    observedProbabilityA: Number.isFinite(Number(liveEstimate.liveProbabilityRadiant))
      ? game.radiantTeam === row.match.team_a ? Number(liveEstimate.liveProbabilityRadiant) : 1 - Number(liveEstimate.liveProbabilityRadiant)
      : null,
    source: "experimental_live_map_observation",
    stale: Boolean(game.stale || game.retained || liveEstimate.assessment?.stale),
  } : null;
  return {
    ...row,
    forecast,
    live: { ...game, history: undefined },
    liveEstimate: presented,
    sources: { ...row.sources, draftApplied: hasDraft, liveStateApplied: !presented?.stale && Number.isFinite(Number(presented?.observedProbabilityA)) },
  };
}

function overlayCombinedLive(state) {
  return {
    ...state,
    generatedAt: now(),
    series: state.series.map(liveOverlayForSeries),
    maps: parsedTournamentMaps(),
    live: { fetchedAt: liveDraftCache.fetchedAt, error: liveDraftCache.error },
  };
}

async function materializeCombinedForecast(opinionWeight = 10) {
  const viewKey = `combined:v2:weight:${Number(opinionWeight)}`;
  const running = combinedMaterializationPromises.get(viewKey);
  if (running) return running;
  const materializationPromise = (async () => {
    const inputHash = combinedInputHash(opinionWeight);
    const ready = db.prepare("SELECT input_hash FROM materialized_views WHERE view_key=? AND status='ready'").get(viewKey);
    if (ready?.input_hash === inputHash) return false;
    const leaseUntil = new Date(Date.now() + 60_000).toISOString();
    db.prepare(`INSERT INTO automation_jobs(job_key,job_type,input_hash,status,lease_until,attempts,updated_at)
      VALUES (?,?,?,?,?,1,?) ON CONFLICT(job_key) DO UPDATE SET input_hash=excluded.input_hash,status='leased',
      lease_until=excluded.lease_until,attempts=automation_jobs.attempts+1,error=NULL,updated_at=excluded.updated_at`)
      .run(viewKey, "combined_materialization", inputHash, "leased", leaseUntil, now());
    try {
      const payload = await combinedForecastState(opinionWeight, null, { refreshLive: false });
      const previous = db.prepare("SELECT version FROM materialized_views WHERE view_key=?").get(viewKey);
      db.prepare(`INSERT INTO materialized_views(view_key,version,input_hash,status,payload_json,error,updated_at)
        VALUES (?,?,?,'ready',?,NULL,?) ON CONFLICT(view_key) DO UPDATE SET version=excluded.version,input_hash=excluded.input_hash,
        status='ready',payload_json=excluded.payload_json,error=NULL,updated_at=excluded.updated_at`)
        .run(viewKey, Number(previous?.version || 0) + 1, inputHash, JSON.stringify(payload), now());
      db.prepare("UPDATE automation_jobs SET status='ready',lease_until=NULL,error=NULL,updated_at=? WHERE job_key=?").run(now(), viewKey);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Combined materialization failed:", error);
      db.prepare("UPDATE automation_jobs SET status='failed',lease_until=NULL,error=?,updated_at=? WHERE job_key=?").run(message, now(), viewKey);
      throw error;
    }
  })().finally(() => { combinedMaterializationPromises.delete(viewKey); });
  combinedMaterializationPromises.set(viewKey, materializationPromise);
  return materializationPromise;
}

function readyCombinedForecast(opinionWeight = 10) {
  const viewKey = `combined:v2:weight:${Number(opinionWeight)}`;
  const row = db.prepare("SELECT version,input_hash,payload_json,updated_at FROM materialized_views WHERE view_key=? AND status='ready'").get(viewKey);
  if (!row?.payload_json) return null;
  try {
    return { ...JSON.parse(row.payload_json), readModel: { key: viewKey, version: Number(row.version), inputHash: row.input_hash, readyAt: row.updated_at, status: "ready" } };
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/api/health") {
      let nextgen = false;
      try { nextgen = Boolean(nextgenModelMetadata().team.modelId); } catch { nextgen = false; }
      let liveMap = false;
      try { liveMap = Boolean(currentLiveMapModel().modelId); } catch { liveMap = false; }
      return json(res, 200, { ok: true, models: { temporal: Boolean(currentTemporalModel().modelId), nextgen, liveMap } });
    }
    if (req.method === "GET" && url.pathname === "/api/models/nextgen") return json(res, 200, nextgenModelMetadata());
    if (req.method === "GET" && url.pathname === "/api/draft/model") {
      try { return json(res, 200, temporalModelMetadata(currentTemporalModel())); }
      catch { return json(res, 503, { error: "temporal_model_unavailable" }); }
    }
    if (req.method === "GET" && url.pathname === "/api/draft/live/model") {
      try { return json(res, 200, currentLiveMapModel()); }
      catch { return json(res, 503, { error: "live_map_model_unavailable" }); }
    }
    const liveDraftHistoryMatch = req.method === "GET" ? url.pathname.match(/^\/api\/draft\/live\/history\/(\d+)$/) : null;
    if (liveDraftHistoryMatch) {
      const matchId = liveDraftHistoryMatch[1];
      const map = parsedTournamentMaps().find((item) => String(item.matchId) === matchId) ?? null;
      const history = liveDraftHistory(matchId, 500);
      if (!map && !history.length) return json(res, 404, { error: "live_map_history_not_found" });
      return json(res, 200, { matchId, map, history });
    }
    if (req.method === "GET" && url.pathname === "/api/draft/live") return json(res, 200, await refreshLiveDrafts());
    if (req.method === "POST" && url.pathname === "/api/forecast/jobs") {
      if (!sameOrigin(req)) return json(res, 403, { error: "origin" });
      const data = await body(req);
      const kind = ["scenario_refresh", "manual", "conditional"].includes(data.kind) ? data.kind : null;
      if (!kind) return json(res, 400, { error: "invalid_job_kind" });
      if ((kind === "manual" || kind === "conditional") && !isAdmin(req)) return json(res, 401, { error: "admin_required" });
      try {
        const rootSnapshotId = data.rootSnapshotId === null || data.rootSnapshotId === undefined ? null : Number(data.rootSnapshotId);
        const conditionalMatchId = data.conditionalMatchId === null || data.conditionalMatchId === undefined ? null : Number(data.conditionalMatchId);
        if (rootSnapshotId !== null && (!Number.isInteger(rootSnapshotId) || rootSnapshotId < 1)) return json(res, 400, { error: "invalid_root_snapshot" });
        if (kind === "conditional" && (!Number.isInteger(conditionalMatchId) || conditionalMatchId < 1)) return json(res, 400, { error: "invalid_conditional_match" });
        let profile = normalizedForecastProfile(data.profile);
        if (kind === "scenario_refresh" && !isAdmin(req)) {
          const ip = req.socket.remoteAddress || "unknown";
          const recent = (scenarioRequests.get(ip) || []).filter((stamp) => Date.now() - stamp < 60_000);
          if (recent.length >= FORECAST_SCENARIO_RATE_LIMIT) return json(res, 429, { error: "forecast_rate_limit" });
          recent.push(Date.now());
          scenarioRequests.set(ip, recent);
          if (rootSnapshotId) {
            const root = parsedSnapshotRow(db.prepare("SELECT * FROM prediction_snapshots WHERE id=?").get(rootSnapshotId));
            if (!root) return json(res, 404, { error: "snapshot_not_found" });
            profile = normalizedForecastProfile({ forecastMode: root.forecast_mode, opinionWeight: root.opinion_weight, answers: root.inputs?.answers ?? {} });
          } else {
            const weight = profile.forecastMode === "stats" ? 0 : profile.opinionWeight;
            if (!FORECAST_CANONICAL_WEIGHTS.has(weight)) return json(res, 403, { error: "canonical_profile_required" });
            const canonicalAnswers = weight ? Object.fromEntries(db.prepare("SELECT pair_key,probability FROM answers ORDER BY pair_key").all().map((row) => [row.pair_key, Number(row.probability)])) : {};
            profile = normalizedForecastProfile({ forecastMode: weight ? "mixed" : "stats", opinionWeight: weight, answers: canonicalAnswers });
          }
        }
        const simulation = kind === "scenario_refresh" && !isAdmin(req)
          ? normalizedSimulationConfig(OFFICIAL_FORECAST_CONFIG, kind)
          : normalizedSimulationConfig(data.simulation, kind);
        const job = enqueueForecastJob({ kind, profile, simulation, rootSnapshotId, conditionalMatchId, trigger: data.trigger || null });
        return json(res, job.status === "ready" ? 200 : 202, { job });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const status = reason === "snapshot_not_found" || reason === "conditional_match_unavailable" ? 404 : 400;
        return json(res, status, { error: reason });
      }
    }
    const forecastJobMatch = url.pathname.match(/^\/api\/forecast\/jobs\/([^/]+)$/);
    if (req.method === "GET" && forecastJobMatch) {
      const jobKey = decodeURIComponent(forecastJobMatch[1]);
      const row = db.prepare("SELECT * FROM automation_jobs WHERE job_key=? AND job_type='forecast'").get(jobKey);
      if (!row) return json(res, 404, { error: "forecast_job_not_found" });
      if (row.kind !== "scenario_refresh" && !isAdmin(req)) return json(res, 401, { error: "admin_required" });
      return json(res, 200, { job: publicForecastJob(row) });
    }
    if (req.method === "DELETE" && forecastJobMatch) {
      if (!sameOrigin(req)) return json(res, 403, { error: "origin" });
      if (!isAdmin(req)) return json(res, 401, { error: "admin_required" });
      const jobKey = decodeURIComponent(forecastJobMatch[1]);
      const row = db.prepare("SELECT * FROM automation_jobs WHERE job_key=? AND job_type='forecast'").get(jobKey);
      if (!row) return json(res, 404, { error: "forecast_job_not_found" });
      if (["ready", "failed"].includes(row.status)) return json(res, 200, { job: publicForecastJob(row) });
      const stamp = now();
      if (row.status === "pending") {
        db.prepare("UPDATE automation_jobs SET status='failed',error='canceled',cancel_requested_at=?,canceled_at=?,completed_at=?,updated_at=? WHERE job_key=?")
          .run(stamp, stamp, stamp, stamp, jobKey);
      } else {
        db.prepare("UPDATE automation_jobs SET cancel_requested_at=?,updated_at=? WHERE job_key=?").run(stamp, stamp, jobKey);
        void activeForecastWorkers.get(jobKey)?.terminate();
      }
      try {
        const payload = JSON.parse(row.input_json);
        db.prepare(`UPDATE materialized_views SET status=CASE WHEN payload_json IS NULL THEN 'failed' ELSE 'ready' END,
          error='canceled',building_input_hash=NULL,stale_since=NULL,updated_at=? WHERE view_key=? AND job_key=?`)
          .run(stamp, payload.viewKey, jobKey);
      } catch { /* malformed legacy job payload has no read-model to restore */ }
      return json(res, 202, { job: publicForecastJob(db.prepare("SELECT * FROM automation_jobs WHERE job_key=?").get(jobKey)) });
    }
    if (req.method === "GET" && url.pathname === "/api/forecast/read-model") {
      try {
        const rootSnapshotId = url.searchParams.has("rootSnapshotId") ? Number(url.searchParams.get("rootSnapshotId")) : null;
        let profile;
        if (rootSnapshotId) {
          const root = parsedSnapshotRow(db.prepare("SELECT * FROM prediction_snapshots WHERE id=?").get(rootSnapshotId));
          if (!root) return json(res, 404, { error: "snapshot_not_found" });
          profile = normalizedForecastProfile({ forecastMode: root.forecast_mode, opinionWeight: root.opinion_weight, answers: root.inputs?.answers ?? {} });
        } else {
          const opinionWeight = Number(url.searchParams.get("opinionWeight") || 0);
          if (!FORECAST_CANONICAL_WEIGHTS.has(opinionWeight)) return json(res, 400, { error: "canonical_profile_required" });
          const answers = opinionWeight ? Object.fromEntries(db.prepare("SELECT pair_key,probability FROM answers ORDER BY pair_key").all().map((row) => [row.pair_key, Number(row.probability)])) : {};
          profile = normalizedForecastProfile({ forecastMode: opinionWeight ? "mixed" : "stats", opinionWeight, answers });
        }
        const readModel = readyForecastReadModel(profile, rootSnapshotId);
        if (!readModel) return json(res, 404, { error: "forecast_read_model_not_found" });
        return json(res, 200, { readModel });
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/combined") {
      const opinionWeight = url.searchParams.get("opinionWeight") ?? 10;
      const requestedRun = url.searchParams.get("run");
      let ready = requestedRun ? null : readyCombinedForecast(opinionWeight);
      if (ready && ready.readModel?.inputHash !== combinedInputHash(opinionWeight)) {
        try {
          await materializeCombinedForecast(opinionWeight);
          ready = readyCombinedForecast(opinionWeight) ?? ready;
        } catch (error) {
          ready = {
            ...ready,
            readModel: {
              ...ready.readModel,
              status: "stale",
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }
      if (ready) return json(res, 200, { ...overlayCombinedLive(ready), isAdmin: isAdmin(req), answers: isAdmin(req) ? storedAnswers() : {} });
      void materializeCombinedForecast(opinionWeight).catch(() => {});
      const fallback = await combinedForecastState(opinionWeight, requestedRun, { refreshLive: false });
      return json(res, 200, { ...overlayCombinedLive(fallback), readModel: { status: "fallback", version: 0 }, isAdmin: isAdmin(req), answers: isAdmin(req) ? storedAnswers() : {} });
    }
    const liveDraftPredictionMatch = req.method === "POST" ? url.pathname.match(/^\/api\/draft\/live\/([^/]+)\/prediction$/) : null;
    if (liveDraftPredictionMatch) {
      if (!sameOrigin(req)) return json(res, 403, { error: "origin" });
      const matchId = decodeURIComponent(liveDraftPredictionMatch[1]);
      const state = await refreshLiveDrafts();
      const game = state.games.find((item) => String(item.matchId) === String(matchId));
      if (!game) return json(res, 404, { error: "live_match_not_found" });
      if ((game.radiantPicks?.length ?? 0) !== 5 || (game.direPicks?.length ?? 0) !== 5) return json(res, 409, { error: "draft_not_complete" });
      await body(req);
      const picksHash = livePicksHash(game);
      const existing = storedLiveDraftPrediction(matchId);
      if (existing && existing.picksHash !== picksHash) return json(res, 409, { error: "frozen_draft_mismatch" });
      if (!existing) {
        try {
          const calculated = calculateActiveDraftPrediction({ draftStats: loadJson("public/draft-stats.json"), teamStats: loadJson("public/team-stats.json"), game });
          const evidence = JSON.stringify({ sourceTeamProbability: calculated.sourceTeamProbability, completeness: calculated.completeness, signals: calculated.signals, ...calculated.evidence });
          db.prepare("INSERT OR IGNORE INTO live_draft_predictions(match_id,series_id,radiant_team,dire_team,picks_hash,picks_json,probability_radiant,model_id,evidence_json,captured_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
            .run(String(matchId), String(game.seriesId || ""), game.radiantTeam, game.direTeam, picksHash, JSON.stringify({ radiant: game.radiantPicks, dire: game.direPicks }), calculated.probabilityRadiant, calculated.modelId, evidence, now());
        } catch (error) {
          console.error("Authoritative draft prediction failed:", error);
          return json(res, 503, { error: "active_draft_model_unavailable" });
        }
      }
      const prediction = storedLiveDraftPrediction(matchId);
      liveDraftCache = { ...liveDraftCache, games: liveDraftCache.games.map((item) => String(item.matchId) === String(matchId) ? { ...item, draftPrediction: prediction } : item) };
      return json(res, existing ? 200 : 201, prediction);
    }
    const snapshotExportMatch = req.method === "GET" ? url.pathname.match(/^\/api\/snapshots\/(\d+)\/export$/) : null;
    if (snapshotExportMatch) {
      const bundle = snapshotExportBundle(Number(snapshotExportMatch[1]));
      if (!bundle) return json(res, 404, { error: "snapshot_not_found" });
      res.setHeader("content-disposition", `attachment; filename="ti2026-forecast-${bundle.rootSnapshotId}-diagnostics.json"`);
      return json(res, 200, bundle);
    }
    if (req.method === "POST" && url.pathname === "/api/draft/predict") {
      if (!sameOrigin(req)) return json(res, 403, { error: "origin" });
      try {
        const data = await body(req);
        const model = currentTemporalModel();
        const prediction = predictTemporalDraft(model, data);
        return json(res, 200, { ...prediction, deployment: model.deployment });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const status = reason === "invalid_picks" || reason === "invalid_side" ? 400 : 503;
        return json(res, status, { error: reason });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, { ...publicState(), isAdmin: isAdmin(req) });
    if (req.method === "POST" && url.pathname === "/api/login") {
      if (!sameOrigin(req)) return json(res, 403, { error: "origin" });
      const ip = req.socket.remoteAddress || "unknown";
      const history = (loginAttempts.get(ip) || []).filter((stamp) => Date.now() - stamp < 15 * 60_000);
      if (history.length >= 8) return json(res, 429, { error: "too_many_attempts" });
      const data = await body(req);
      const validUsername = safeEqual(String(data.username || ""), ADMIN_USERNAME);
      const validPassword = ADMIN_PASSWORD && safeEqual(passwordDigest(String(data.password || "")), passwordDigest(ADMIN_PASSWORD));
      const valid = validUsername && validPassword;
      if (!valid) {
        history.push(Date.now()); loginAttempts.set(ip, history);
        return json(res, 401, { error: "invalid_credentials" });
      }
      loginAttempts.delete(ip);
      const token = randomBytes(32).toString("base64url");
      const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
      db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now());
      db.prepare("INSERT INTO sessions(token_hash, expires_at) VALUES (?, ?)").run(tokenHash(token), expires.toISOString());
      res.setHeader("set-cookie", `ti26_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${COOKIE_SECURE ? "; Secure" : ""}`);
      audit("login", { ip });
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/logout") {
      const token = cookies(req).ti26_session;
      if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
      res.setHeader("set-cookie", "ti26_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
      return json(res, 200, { ok: true });
    }

    if (url.pathname.startsWith("/api/admin/")) {
      if (!sameOrigin(req)) return json(res, 403, { error: "origin" });
      if (!isAdmin(req)) return json(res, 401, { error: "admin_required" });
      if (req.method === "PUT" && url.pathname === "/api/admin/answers") {
        const data = await body(req);
        const entries = Object.entries(data.answers || {}).filter(([key, value]) => /^[a-z0-9]+\|[a-z0-9]+$/.test(key) && Number.isFinite(value) && value >= 0 && value <= 100);
        const save = db.prepare("INSERT INTO answers(pair_key, probability, updated_at) VALUES (?, ?, ?) ON CONFLICT(pair_key) DO UPDATE SET probability=excluded.probability, updated_at=excluded.updated_at");
        db.exec("BEGIN");
        try {
          if (data.replace === true) db.prepare("DELETE FROM answers").run();
          entries.forEach(([key, value]) => save.run(key, value, now()));
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
        audit("answers_saved", { count: entries.length });
        queueAutomaticSnapshot("auto_profile_change", 100);
        for (const weight of [0, 10, 20, 30]) void materializeCombinedForecast(weight).catch(() => {});
        return json(res, 200, { ok: true, count: entries.length });
      }
      if (req.method === "POST" && url.pathname === "/api/admin/bet-locks") {
        const data = await body(req);
        const scope = data.scope === "series" || data.scope === "map" ? data.scope : null;
        const subjectId = String(data.subjectId || "");
        if (!scope || !subjectId) return json(res, 400, { error: "invalid_bet_lock" });
        if (db.prepare("SELECT id FROM bet_locks WHERE scope=? AND subject_id=?").get(scope, subjectId)) return json(res, 409, { error: "bet_already_locked" });
        const subject = scope === "series"
          ? db.prepare(`SELECT match.id,match.team_a,match.team_b,match.winner,match.scheduled_at,match.source_match_id,
              EXISTS(SELECT 1 FROM series_links link WHERE link.match_id=match.id) AS has_series_link
              FROM matches match WHERE match.id=?`).get(Number(subjectId))
          : db.prepare("SELECT map.match_id AS id,map.radiant_team AS team_a,map.dire_team AS team_b,map.winner,map.start_time,prediction.probability_radiant,prediction.model_id,prediction.picks_json FROM tournament_maps map LEFT JOIN live_draft_predictions prediction ON prediction.match_id=map.match_id WHERE map.match_id=?").get(subjectId);
        if (!subject) return json(res, 404, { error: "bet_subject_not_found" });
        if (subject.winner) return json(res, 409, { error: "result_already_known" });
        const hasSeriesStarted = scope === "series" && (subject.has_series_link || String(subject.source_match_id || "").startsWith("opendota:")
          || (subject.scheduled_at && Date.parse(subject.scheduled_at) <= Date.now()));
        const liveMap = scope === "map" ? liveDraftCache.games.find((game) => String(game.matchId) === subjectId) : null;
        const liveMapIsFresh = Boolean(liveMap?.lastUpdateAt) && Date.now() - Date.parse(liveMap.lastUpdateAt) <= Math.max(30_000, LIVE_DRAFT_INTERVAL_SECONDS * 3_000);
        const hasMapStarted = scope === "map" && Number(subject.start_time || 0) > 0 && Number(subject.start_time) * 1000 <= Date.now()
          && (!liveMapIsFresh || Number(liveMap?.gameTime || 0) >= 10 * 60);
        if (hasSeriesStarted || hasMapStarted) return json(res, 409, { error: "bet_subject_started" });
        const probabilityA = Number(data.probabilityA);
        if (!Number.isFinite(probabilityA) || probabilityA < 0.01 || probabilityA > 0.99) return json(res, 400, { error: "invalid_probability" });
        const recommendedWinner = String(data.recommendedWinner || "");
        if (![subject.team_a, subject.team_b].includes(recommendedWinner)) return json(res, 400, { error: "invalid_recommended_winner" });
        if (scope === "map" && (!Number.isFinite(Number(subject.probability_radiant)) || Math.abs(probabilityA - Number(subject.probability_radiant)) > 0.000001)) return json(res, 409, { error: "draft_prediction_changed" });
        const exactScore = scope === "series" && /^\d:\d$/.test(String(data.exactScore || "")) ? String(data.exactScore) : null;
        const stamp = now();
        const evidence = {
          display: data.evidence && typeof data.evidence === "object" ? data.evidence : null,
          picks: scope === "map" && subject.picks_json ? JSON.parse(subject.picks_json) : null,
          serverCapturedAt: stamp,
        };
        const result = db.prepare(`INSERT INTO bet_locks(scope,subject_id,team_a,team_b,probability_a,recommended_winner,exact_score,source,opinion_weight,snapshot_id,model_id,evidence_json,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(scope, subjectId, subject.team_a, subject.team_b, probabilityA, recommendedWinner, exactScore,
          scope === "series" ? "series_latest" : "map_draft", Math.round(Math.min(100, Math.max(0, Number(data.opinionWeight) || 0))),
          Number.isInteger(Number(data.snapshotId)) ? Number(data.snapshotId) : null, scope === "map" ? subject.model_id : null, JSON.stringify(evidence), stamp);
        audit("bet_locked", { id: Number(result.lastInsertRowid), scope, subjectId, recommendedWinner, probabilityA, exactScore });
        return json(res, 201, { ok: true, id: Number(result.lastInsertRowid), createdAt: stamp });
      }
      if (req.method === "POST" && url.pathname === "/api/admin/matches") {
        const data = await body(req);
        const validTeams = /^[a-z0-9]+$/;
        const stage = ["swiss", "playin", "playoff"].includes(data.stage) ? data.stage : null;
        if (!stage || !validTeams.test(data.teamA) || !validTeams.test(data.teamB) || data.teamA === data.teamB || !(data.round >= 1 && data.round <= 20)) return json(res, 400, { error: "invalid_match" });
        const winner = data.winner || null;
        if (winner && winner !== data.teamA && winner !== data.teamB) return json(res, 400, { error: "invalid_winner" });
        const stamp = now();
        if (winner) {
          const scheduled = db.prepare(`SELECT id FROM matches WHERE stage = ? AND round = ? AND winner IS NULL
            AND ((team_a = ? AND team_b = ?) OR (team_a = ? AND team_b = ?)) ORDER BY id LIMIT 1`).get(stage, data.round, data.teamA, data.teamB, data.teamB, data.teamA);
          if (scheduled) {
            db.prepare(`UPDATE matches SET winner = ?, score_a = ?, score_b = ?, scheduled_at = COALESCE(scheduled_at, ?),
              source_match_id = COALESCE(source_match_id, ?), predicted_probability = COALESCE(predicted_probability, ?), updated_at = ? WHERE id = ?`)
              .run(winner, data.scoreA ?? null, data.scoreB ?? null, data.scheduledAt || null, data.sourceMatchId || null, data.predictedProbability ?? null, stamp, scheduled.id);
            audit("match_completed", { id: Number(scheduled.id), ...data });
            queueAutomaticSnapshot("auto_manual_result", 100);
            return json(res, 200, { ok: true, id: Number(scheduled.id), updated: true });
          }
        }
        const result = db.prepare(`INSERT INTO matches(stage, round, team_a, team_b, winner, score_a, score_b, scheduled_at, source_match_id, predicted_probability, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(stage, data.round, data.teamA, data.teamB, winner, data.scoreA ?? null, data.scoreB ?? null, data.scheduledAt || null, data.sourceMatchId || null, data.predictedProbability ?? null, stamp, stamp);
        audit("match_added", { id: Number(result.lastInsertRowid), ...data });
        queueAutomaticSnapshot(winner ? "auto_manual_result" : `pre_${stage}_${data.round}`, winner ? 100 : 5_000);
        return json(res, 201, { ok: true, id: Number(result.lastInsertRowid) });
      }
      if (req.method === "POST" && url.pathname === "/api/admin/snapshots") {
        const data = await body(req);
        try {
          const profile = normalizedForecastProfile({ forecastMode: data.forecastMode, opinionWeight: data.opinionWeight, answers: data.answers });
          const simulation = normalizedSimulationConfig({ iterations: data.iterations, adaptive: data.adaptive, maxIterations: data.maxIterations, batchSize: data.batchSize, tolerancePp: data.tolerancePp }, "manual");
          const job = enqueueForecastJob({ kind: "manual", profile, simulation, trigger: data.trigger || "manual_run" });
          return json(res, job.status === "ready" ? 200 : 202, { ok: true, job });
        } catch (error) {
          return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (req.method === "DELETE" && url.pathname.startsWith("/api/admin/snapshots/")) {
        const id = Number(url.pathname.split("/").at(-1));
        if (!Number.isInteger(id) || id < 1) return json(res, 400, { error: "invalid_id" });
        const snapshot = db.prepare("SELECT id, trigger, model_generated_at, created_at FROM prediction_snapshots WHERE id = ?").get(id);
        if (!snapshot) return json(res, 404, { error: "snapshot_not_found" });
        db.prepare("DELETE FROM prediction_snapshots WHERE id = ?").run(id);
        audit("snapshot_deleted", snapshot);
        return json(res, 200, { ok: true, id });
      }
      if (req.method === "POST" && url.pathname === "/api/admin/rounds/prepare") {
        const data = await body(req);
        const round = Number(data.round || 1);
        if (round !== 1) return json(res, 400, { error: "only_round_one_is_known" });
        const { probabilities } = currentForecast();
        const insert = db.prepare(`INSERT INTO matches(stage, round, team_a, team_b, winner, predicted_probability, created_at, updated_at)
          VALUES ('swiss', 1, ?, ?, NULL, ?, ?, ?)`);
        let inserted = 0;
        const stamp = now();
        db.exec("BEGIN");
        try {
          for (const [teamA, teamB] of ROUND_ONE) {
            const existing = db.prepare("SELECT id FROM matches WHERE stage = 'swiss' AND round = 1 AND ((team_a = ? AND team_b = ?) OR (team_a = ? AND team_b = ?)) LIMIT 1").get(teamA, teamB, teamB, teamA);
            if (existing) continue;
            const key = [teamA, teamB].sort().join("|");
            const stored = probabilities[key] ?? 50;
            const predictedProbability = key.startsWith(`${teamA}|`) ? stored : 100 - stored;
            insert.run(teamA, teamB, predictedProbability, stamp, stamp); inserted += 1;
          }
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
        audit("round_prepared", { round, inserted });
        if (inserted) queueAutomaticSnapshot("pre_round_1");
        return json(res, 200, { ok: true, round, inserted });
      }
      if (req.method === "DELETE" && url.pathname.startsWith("/api/admin/matches/")) {
        const id = Number(url.pathname.split("/").at(-1));
        if (!Number.isInteger(id)) return json(res, 400, { error: "invalid_id" });
        db.prepare("DELETE FROM matches WHERE id = ?").run(id); audit("match_deleted", { id });
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/admin/refresh") {
        if (refreshProcess) return json(res, 409, { error: "refresh_running" });
        refreshProcess = spawn(process.execPath, ["scripts/update-all-stats.mjs"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        refreshProcess.stdout.on("data", (chunk) => { output = (output + chunk).slice(-12000); });
        refreshProcess.stderr.on("data", (chunk) => { output = (output + chunk).slice(-12000); });
        refreshProcess.on("close", (code) => {
          const value = JSON.stringify({ ok: code === 0, code, output });
          db.prepare("INSERT INTO settings(key,value,updated_at) VALUES ('last_refresh',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(value, now());
          refreshProcess = null;
          if (code === 0) queueAutomaticSnapshot("auto_artifact_refresh", 100);
        });
        audit("refresh_started", {});
        return json(res, 202, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/admin/live/sync") {
        if (liveSyncPromise) return json(res, 409, { error: "live_sync_running" });
        const result = await syncLiveMatches("manual");
        return json(res, 200, result);
      }
    }
    return json(res, 404, { error: "not_found" });
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: "internal_error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`TI Predictor API listening on ${PORT}; database ${DB_PATH}`);
  db.prepare(`UPDATE automation_jobs SET status='pending',lease_until=NULL,lease_token=NULL,updated_at=?
    WHERE job_type='forecast' AND status='leased' AND (lease_until IS NULL OR lease_until < ?) AND superseded_by IS NULL AND cancel_requested_at IS NULL`)
    .run(now(), now());
  scheduleForecastJobs(0);
  queueAutomaticSnapshot("startup_reconcile", 1_000);
  if (LIVE_SYNC_ENABLED) {
    setTimeout(() => void syncLiveMatches("startup").catch((error) => console.error("Initial live sync failed:", error.message)), 5_000).unref();
    setInterval(() => void syncLiveMatches("timer").catch((error) => console.error("Live sync failed:", error.message)), LIVE_SYNC_INTERVAL_MINUTES * 60_000).unref();
  }
  const refreshLiveDraftCache = () => void refreshLiveDrafts({ force: true })
    .catch((error) => console.error("Live draft timer failed:", error.message));
  void Promise.all([0, 10, 20, 30].map((weight) => materializeCombinedForecast(weight)))
    .catch((error) => console.error("Initial combined materialization failed:", error.message));
  if (LIVE_DRAFT_SYNC_ENABLED) {
    setTimeout(refreshLiveDraftCache, 2_000).unref();
    setInterval(refreshLiveDraftCache, LIVE_DRAFT_INTERVAL_SECONDS * 1_000).unref();
  }
});
