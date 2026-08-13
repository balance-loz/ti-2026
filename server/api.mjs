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
const OPENDOTA_API_URL = process.env.OPENDOTA_API_URL || "https://api.opendota.com/api";
const SCHEDULE_SYNC_ENABLED = process.env.SCHEDULE_SYNC_ENABLED !== "false";
const SCHEDULE_SOURCE_URL = process.env.SCHEDULE_SOURCE_URL || "https://www.cybersport.ru/tournaments/dota-2/the-international-2026";
const SCHEDULE_TIMEZONE_OFFSET = process.env.SCHEDULE_TIMEZONE_OFFSET || "+03:00";
const AUTO_SNAPSHOT_ITERATIONS = Math.max(10_000, Number(process.env.AUTO_SNAPSHOT_ITERATIONS || 250_000));
const AUTO_SNAPSHOT_MAX_ITERATIONS = Math.max(AUTO_SNAPSHOT_ITERATIONS, Number(process.env.AUTO_SNAPSHOT_MAX_ITERATIONS || AUTO_SNAPSHOT_ITERATIONS * 4));
const AUTO_SNAPSHOT_BATCH_SIZE = Math.max(10_000, Number(process.env.AUTO_SNAPSHOT_BATCH_SIZE || AUTO_SNAPSHOT_ITERATIONS));
const AUTO_SNAPSHOT_TOLERANCE_PP = Math.max(.01, Number(process.env.AUTO_SNAPSHOT_TOLERANCE_PP || .1));
const OFFICIAL_FORECAST_CONFIG = Object.freeze({ forecastMode: "stats", opinionWeight: 0, iterations: AUTO_SNAPSHOT_ITERATIONS, adaptive: true, maxIterations: AUTO_SNAPSHOT_MAX_ITERATIONS, batchSize: AUTO_SNAPSHOT_BATCH_SIZE, tolerancePp: AUTO_SNAPSHOT_TOLERANCE_PP });
const TI_PLAYIN_START = Date.parse(process.env.TI_PLAYIN_START || "2026-08-17T00:00:00+08:00") / 1000;
const TI_PLAYOFF_START = Date.parse(process.env.TI_PLAYOFF_START || "2026-08-20T00:00:00+08:00") / 1000;
const DRAFT_TEMPORAL_MODEL = path.resolve(process.env.DRAFT_TEMPORAL_MODEL || "public/draft-temporal-model.json");
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
`);
const snapshotColumns = new Set(db.prepare("PRAGMA table_info(prediction_snapshots)").all().map((row) => row.name));
for (const [name, definition] of Object.entries({ inputs_json: "TEXT", snapshot_kind: "TEXT NOT NULL DEFAULT 'original'", root_snapshot_id: "INTEGER", parent_snapshot_id: "INTEGER", profile_key: "TEXT" })) {
  if (!snapshotColumns.has(name)) db.exec(`ALTER TABLE prediction_snapshots ADD COLUMN ${name} ${definition}`);
}
db.exec("CREATE INDEX IF NOT EXISTS idx_prediction_snapshots_root ON prediction_snapshots(root_snapshot_id, completed_match_count DESC); CREATE INDEX IF NOT EXISTS idx_prediction_snapshots_profile ON prediction_snapshots(profile_key, completed_match_count DESC)");
db.exec("PRAGMA optimize");

let refreshProcess = null;
let liveSyncPromise = null;
let autoForecastRunning = false;
let autoSnapshotTimer = null;
const loginAttempts = new Map();
let temporalModelCache = { mtimeMs: -1, value: null };
const json = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
};
const now = () => new Date().toISOString();
const tokenHash = (token) => createHash("sha256").update(token).digest("hex");
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
    liveSync: { enabled: LIVE_SYNC_ENABLED, scheduleEnabled: SCHEDULE_SYNC_ENABLED, leagueId: TI_LEAGUE_ID, intervalMinutes: LIVE_SYNC_INTERVAL_MINUTES, running: Boolean(liveSyncPromise), lastSync, autoForecastRunning },
  };
}

function audit(kind, payload) {
  db.prepare("INSERT INTO events(kind, payload, created_at) VALUES (?, ?, ?)").run(kind, JSON.stringify(payload), now());
}

function profileKey(mode, opinionWeight, answers) {
  return createHash("sha256").update(JSON.stringify({ mode, opinionWeight: Number(opinionWeight), answers })).digest("hex").slice(0, 24);
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
  return id;
}

function runForecastWorker(payload) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./forecast-worker.mjs", import.meta.url), { workerData: payload });
    worker.once("message", (message) => message?.ok ? resolve(message.result) : reject(new Error(message?.error || "forecast_worker_failed")));
    worker.once("error", reject);
    worker.once("exit", (code) => { if (code !== 0) reject(new Error(`forecast_worker_exit_${code}`)); });
  });
}

async function saveProfileSnapshot(trigger, config, profileAnswers, { kind = "original", rootId = null, parentId = null } = {}) {
    const { matches, stats, probabilities } = currentForecast(config, profileAnswers);
    const completedMatchCount = matches.filter((match) => match.winner).length;
    const key = profileKey(config.forecastMode, config.opinionWeight, profileAnswers);
    // A newly published pairing changes the forecast constraints without
    // changing completed_match_count. Pairing triggers include a hash of all
    // official scheduled series, so include the trigger in deduplication and
    // do not accidentally reuse the pre-draw baseline.
    const existing = db.prepare("SELECT id FROM prediction_snapshots WHERE profile_key=? AND completed_match_count=? AND snapshot_kind=? AND trigger=? ORDER BY id DESC LIMIT 1").get(key, completedMatchCount, kind, trigger);
    if (existing) return Number(existing.id);
    const seed = Math.floor(Date.now() % 0xffffffff);
    const minimum = Number(config.iterations || AUTO_SNAPSHOT_ITERATIONS);
    const adaptive = config.adaptive ? { enabled: true, minIterations: minimum, maxIterations: Number(config.maxIterations || AUTO_SNAPSHOT_MAX_ITERATIONS), batchSize: Number(config.batchSize || AUTO_SNAPSHOT_BATCH_SIZE), tolerancePp: Number(config.tolerancePp || AUTO_SNAPSHOT_TOLERANCE_PP), stableChecksRequired: 2 } : null;
    const result = await runForecastWorker({ probabilities, minimum, seed, matches, stats, adaptive });
    const id = insertSnapshot({ trigger, config, probabilities, result, stats, matches, inputs: { answers: profileAnswers, cutoffCompletedMatches: completedMatchCount }, kind, rootId, parentId, key });
    audit("snapshot_saved", { id, trigger, completedMatchCount, kind, rootId, profileKey: key });
    return id;
}

async function saveAutomaticSnapshots(trigger) {
  if (autoForecastRunning) return null;
  autoForecastRunning = true;
  try {
    const officialId = await saveProfileSnapshot(trigger, OFFICIAL_FORECAST_CONFIG, {}, { kind: "original" });
    const roots = db.prepare("SELECT * FROM prediction_snapshots WHERE snapshot_kind='original' AND id=root_snapshot_id AND forecast_mode!='stats' GROUP BY profile_key ORDER BY id").all();
    for (const root of roots) {
      let inputs = {}; try { inputs = root.inputs_json ? JSON.parse(root.inputs_json) : {}; } catch { inputs = {}; }
      const parent = db.prepare("SELECT id FROM prediction_snapshots WHERE root_snapshot_id=? ORDER BY completed_match_count DESC,id DESC LIMIT 1").get(root.id);
      await saveProfileSnapshot(`revision_${trigger}`, { ...OFFICIAL_FORECAST_CONFIG, forecastMode: root.forecast_mode, opinionWeight: root.opinion_weight }, inputs.answers ?? {}, { kind: "revision", rootId: root.id, parentId: parent?.id ?? root.id });
    }
    return officialId;
  } finally { autoForecastRunning = false; }
}

function queueAutomaticSnapshot(trigger, delay = 100) {
  if (autoSnapshotTimer) clearTimeout(autoSnapshotTimer);
  autoSnapshotTimer = setTimeout(async () => {
    autoSnapshotTimer = null;
    try { await saveAutomaticSnapshots(trigger); } catch (error) { console.error("Automatic forecast failed:", error); audit("automatic_snapshot_failed", { trigger, error: error instanceof Error ? error.message : String(error) }); }
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
const probabilityFor = (probabilities, teamA, teamB) => {
  const key = [teamA, teamB].sort().join("|");
  const value = probabilities[key];
  return Number.isFinite(value) ? (key.startsWith(`${teamA}|`) ? value : 100 - value) : 50;
};

function persistScheduledSeries(series, probabilities) {
  const timestamp = Date.parse(series.scheduledAt) / 1000;
  const stage = stageForTimestamp(timestamp);
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
  const timestamp = Date.parse(series.scheduledAt) / 1000;
  const stage = stageForTimestamp(timestamp);
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
  const manualResult = db.prepare(`SELECT * FROM matches WHERE stage = ? AND source_match_id IS NULL AND winner = ?
    AND ((team_a = ? AND team_b = ?) OR (team_a = ? AND team_b = ?)) ORDER BY id DESC LIMIT 1`).get(stage, winner, series.teamA, series.teamB, series.teamB, series.teamA);
  if (manualResult) {
    const scoreA = manualResult.team_a === series.teamA ? series.winsA : series.winsB;
    const scoreB = manualResult.team_b === series.teamB ? series.winsB : series.winsA;
    db.prepare("UPDATE matches SET score_a = ?, score_b = ?, source_match_id = ?, scheduled_at = COALESCE(scheduled_at, ?), updated_at = ? WHERE id = ?")
      .run(scoreA, scoreB, sourceMatchId, new Date(series.startTime * 1000).toISOString(), now(), manualResult.id);
    return "updated";
  }
  const scheduled = db.prepare(`SELECT * FROM matches
    WHERE stage = ? AND winner IS NULL AND ((team_a = ? AND team_b = ?) OR (team_a = ? AND team_b = ?))
    ORDER BY round, id LIMIT 1`).get(stage, series.teamA, series.teamB, series.teamB, series.teamA);
  const stamp = now();
  if (scheduled) {
    const scoreA = scheduled.team_a === series.teamA ? series.winsA : series.winsB;
    const scoreB = scheduled.team_b === series.teamB ? series.winsB : series.winsA;
    db.prepare("UPDATE matches SET winner = ?, score_a = ?, score_b = ?, source_match_id = ?, scheduled_at = COALESCE(scheduled_at, ?), updated_at = ? WHERE id = ?")
      .run(winner, scoreA, scoreB, sourceMatchId, new Date(series.startTime * 1000).toISOString(), stamp, scheduled.id);
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
      } catch (error) { resultError = error instanceof Error ? error.message : String(error); }
      if (SCHEDULE_SYNC_ENABLED) try {
        const response = await fetch(SCHEDULE_SOURCE_URL, { headers: { "user-agent": "ti-2026-predictor/1.0 (github.com/balance-loz/ti-2026)" }, signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`Cybersport HTTP ${response.status}`);
        schedule = scheduledSeriesFromCybersportHtml(await response.text(), { timezoneOffset: SCHEDULE_TIMEZONE_OFFSET });
      } catch (error) { scheduleError = error instanceof Error ? error.message : String(error); }
      if (resultError && (!SCHEDULE_SYNC_ENABLED || scheduleError)) throw new Error(`OpenDota: ${resultError}; schedule: ${scheduleError || "disabled"}`);
      const series = completedSeriesFromMaps(maps);
      const unknownTeamIds = [...new Set(maps.flatMap((map) => [Number(map.radiant_team_id), Number(map.dire_team_id)]).filter((id) => id && !OPENDOTA_TEAMS.has(id)))];
      const summary = { ok: !resultError && !scheduleError, partial: Boolean(resultError || scheduleError), trigger, startedAt, maps: maps.length, completedSeries: series.length, unknownTeamIds, resultError, scheduleError, scheduleSource: SCHEDULE_SYNC_ENABLED ? "Cybersport.ru" : "disabled", scheduledFound: schedule.length, scheduledInserted: 0, scheduledUpdated: 0, scheduledRemoved: 0, scheduledUnchanged: 0, forecastQueued: false, inserted: 0, updated: 0, unchanged: 0 };
      db.exec("BEGIN");
      try {
        const probabilities = schedule.length ? currentForecast().probabilities : {};
        for (const item of schedule) {
          summary.scheduledRemoved += removeConflictingScheduledSeries(item);
          summary[persistScheduledSeries(item, probabilities)] += 1;
        }
        for (const item of series) summary[persistLiveSeries(item)] += 1;
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      const scheduleChanged = summary.scheduledInserted || summary.scheduledUpdated || summary.scheduledRemoved;
      if (summary.inserted || summary.updated) { audit("live_sync_results", summary); queueAutomaticSnapshot("auto_live_result"); summary.forecastQueued = true; }
      if (scheduleChanged) {
        audit("official_schedule_sync", summary);
        queueAutomaticSnapshot(officialPairingTrigger());
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

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/api/health") {
      let nextgen = false;
      try { nextgen = Boolean(nextgenModelMetadata().team.modelId); } catch { nextgen = false; }
      return json(res, 200, { ok: true, models: { temporal: Boolean(currentTemporalModel().modelId), nextgen } });
    }
    if (req.method === "GET" && url.pathname === "/api/models/nextgen") return json(res, 200, nextgenModelMetadata());
    if (req.method === "GET" && url.pathname === "/api/draft/model") {
      try { return json(res, 200, temporalModelMetadata(currentTemporalModel())); }
      catch { return json(res, 503, { error: "temporal_model_unavailable" }); }
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
        try { entries.forEach(([key, value]) => save.run(key, value, now())); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
        audit("answers_saved", { count: entries.length });
        return json(res, 200, { ok: true, count: entries.length });
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
        if (!data.probabilities || !data.result || !Number.isInteger(data.iterations) || !Number.isInteger(data.seed)) return json(res, 400, { error: "invalid_snapshot" });
        const config = { forecastMode: data.forecastMode || "mixed", opinionWeight: Number(data.opinionWeight || 0), iterations: data.iterations };
        const profileAnswers = data.answers && typeof data.answers === "object" ? data.answers : {};
        const matches = db.prepare("SELECT * FROM matches ORDER BY round,id").all();
        const key = profileKey(config.forecastMode, config.opinionWeight, profileAnswers);
        const id = insertSnapshot({ trigger: data.trigger || "manual_run", config, probabilities: data.probabilities, result: data.result, stats: { generatedAt: data.modelGeneratedAt || null }, matches, inputs: { answers: profileAnswers, cutoffCompletedMatches: Number(data.completedMatchCount || 0) }, kind: "original", key });
        audit("snapshot_saved", { id, trigger: data.trigger || "manual_run", profileKey: key });
        return json(res, 201, { ok: true, id });
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
  if (LIVE_SYNC_ENABLED) {
    setTimeout(() => void syncLiveMatches("startup").catch((error) => console.error("Initial live sync failed:", error.message)), 5_000).unref();
    setInterval(() => void syncLiveMatches("timer").catch((error) => console.error("Live sync failed:", error.message)), LIVE_SYNC_INTERVAL_MINUTES * 60_000).unref();
  }
});
