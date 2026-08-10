import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { completedSeriesFromMaps, OPENDOTA_TEAMS } from "./live-series.mjs";
import { buildForecastSource, ROUND_ONE, runForecast } from "./forecast-engine.mjs";

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
const AUTO_SNAPSHOT_ITERATIONS = Math.max(10_000, Number(process.env.AUTO_SNAPSHOT_ITERATIONS || 100_000));
const TI_PLAYIN_START = Date.parse(process.env.TI_PLAYIN_START || "2026-08-17T00:00:00+08:00") / 1000;
const TI_PLAYOFF_START = Date.parse(process.env.TI_PLAYOFF_START || "2026-08-20T00:00:00+08:00") / 1000;

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
db.exec("PRAGMA optimize");

let refreshProcess = null;
let liveSyncPromise = null;
let autoForecastRunning = false;
let autoSnapshotTimer = null;
const loginAttempts = new Map();
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

function publicState() {
  const answers = Object.fromEntries(db.prepare("SELECT pair_key, probability FROM answers").all().map((row) => [row.pair_key, row.probability]));
  const matches = db.prepare("SELECT * FROM matches ORDER BY round, id").all();
  const refresh = db.prepare("SELECT value, updated_at FROM settings WHERE key = 'last_refresh'").get() || null;
  const snapshots = db.prepare("SELECT id, trigger, forecast_mode, opinion_weight, iterations, seed, completed_match_count, model_generated_at, probabilities_json, result_json, created_at FROM prediction_snapshots ORDER BY id DESC LIMIT 50").all()
    .map((row) => ({ ...row, probabilities: JSON.parse(row.probabilities_json), result: JSON.parse(row.result_json), probabilities_json: undefined, result_json: undefined }));
  const liveSyncRow = db.prepare("SELECT value, updated_at FROM settings WHERE key = 'live_sync'").get() || null;
  let lastSync = null;
  try { lastSync = liveSyncRow ? { ...JSON.parse(liveSyncRow.value), updatedAt: liveSyncRow.updated_at } : null; } catch { lastSync = null; }
  return {
    answers, matches, snapshots, refresh, refreshRunning: Boolean(refreshProcess),
    liveSync: { enabled: LIVE_SYNC_ENABLED, leagueId: TI_LEAGUE_ID, intervalMinutes: LIVE_SYNC_INTERVAL_MINUTES, running: Boolean(liveSyncPromise), lastSync, autoForecastRunning },
  };
}

function audit(kind, payload) {
  db.prepare("INSERT INTO events(kind, payload, created_at) VALUES (?, ?, ?)").run(kind, JSON.stringify(payload), now());
}

function forecastConfig() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'forecast_config'").get();
  if (row) try { return JSON.parse(row.value); } catch { /* use defaults */ }
  const snapshot = db.prepare("SELECT forecast_mode, opinion_weight FROM prediction_snapshots ORDER BY id DESC LIMIT 1").get();
  return { forecastMode: snapshot?.forecast_mode || "mixed", opinionWeight: Number(snapshot?.opinion_weight ?? 50) };
}

function currentForecast() {
  const answers = Object.fromEntries(db.prepare("SELECT pair_key, probability FROM answers").all().map((row) => [row.pair_key, row.probability]));
  const matches = db.prepare("SELECT * FROM matches ORDER BY round, id").all();
  const stats = JSON.parse(readFileSync(path.resolve("public/team-stats.json"), "utf8"));
  const config = forecastConfig();
  const probabilities = buildForecastSource({ answers, stats, matches, mode: config.forecastMode, opinionWeight: config.opinionWeight });
  return { answers, matches, stats, config, probabilities };
}

function saveAutomaticSnapshot(trigger) {
  if (autoForecastRunning) return null;
  autoForecastRunning = true;
  try {
    const { matches, stats, config, probabilities } = currentForecast();
    const completedMatchCount = matches.filter((match) => match.winner).length;
    const previous = trigger.startsWith("auto_")
      ? db.prepare("SELECT id FROM prediction_snapshots WHERE trigger LIKE 'auto_%' AND completed_match_count = ? ORDER BY id DESC LIMIT 1").get(completedMatchCount)
      : db.prepare("SELECT id FROM prediction_snapshots WHERE trigger = ? AND completed_match_count = ? ORDER BY id DESC LIMIT 1").get(trigger, completedMatchCount);
    if (previous) return Number(previous.id);
    const seed = Math.floor(Date.now() % 0xffffffff);
    const result = runForecast(probabilities, AUTO_SNAPSHOT_ITERATIONS, seed, { matches, stats });
    const stamp = now();
    const inserted = db.prepare(`INSERT INTO prediction_snapshots(trigger, forecast_mode, opinion_weight, iterations, seed, completed_match_count, model_generated_at, probabilities_json, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(trigger, config.forecastMode, Number(config.opinionWeight), result.iterations, result.seed, completedMatchCount, stats.generatedAt || null, JSON.stringify(probabilities), JSON.stringify(result), stamp);
    const id = Number(inserted.lastInsertRowid);
    audit("automatic_snapshot_saved", { id, trigger, completedMatchCount });
    return id;
  } finally { autoForecastRunning = false; }
}

function queueAutomaticSnapshot(trigger, delay = 100) {
  if (autoSnapshotTimer) clearTimeout(autoSnapshotTimer);
  autoSnapshotTimer = setTimeout(() => {
    autoSnapshotTimer = null;
    try { saveAutomaticSnapshot(trigger); } catch (error) { console.error("Automatic forecast failed:", error); audit("automatic_snapshot_failed", { trigger, error: error instanceof Error ? error.message : String(error) }); }
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

function persistLiveSeries(series) {
  const sourceMatchId = `opendota:${TI_LEAGUE_ID}:${series.seriesId}`;
  if (db.prepare("SELECT id FROM matches WHERE source_match_id = ?").get(sourceMatchId)) return "unchanged";
  const stage = series.startTime >= TI_PLAYOFF_START ? "playoff" : series.startTime >= TI_PLAYIN_START ? "playin" : "swiss";
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
      const response = await fetch(`${OPENDOTA_API_URL}/leagues/${TI_LEAGUE_ID}/matches`, {
        headers: { "user-agent": "ti-2026-predictor/1.0 (github.com/balance-loz/ti-2026)" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`OpenDota HTTP ${response.status}`);
      const maps = await response.json();
      if (!Array.isArray(maps)) throw new Error("OpenDota returned an invalid payload");
      const series = completedSeriesFromMaps(maps);
      const unknownTeamIds = [...new Set(maps.flatMap((map) => [Number(map.radiant_team_id), Number(map.dire_team_id)]).filter((id) => id && !OPENDOTA_TEAMS.has(id)))];
      const summary = { ok: true, trigger, startedAt, maps: maps.length, completedSeries: series.length, unknownTeamIds, inserted: 0, updated: 0, unchanged: 0 };
      db.exec("BEGIN");
      try {
        for (const item of series) summary[persistLiveSeries(item)] += 1;
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      db.prepare("INSERT INTO settings(key,value,updated_at) VALUES ('live_sync',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(JSON.stringify(summary), now());
      if (summary.inserted || summary.updated) { audit("live_sync_results", summary); queueAutomaticSnapshot("auto_live_result"); }
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
    if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ok: true });
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
        const stamp = now();
        const inserted = db.prepare(`INSERT INTO prediction_snapshots(trigger, forecast_mode, opinion_weight, iterations, seed, completed_match_count, model_generated_at, probabilities_json, result_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(data.trigger || "manual_run", data.forecastMode || "mixed", Number(data.opinionWeight || 0), data.iterations, data.seed, Number(data.completedMatchCount || 0), data.modelGeneratedAt || null, JSON.stringify(data.probabilities), JSON.stringify(data.result), stamp);
        db.prepare("INSERT INTO settings(key,value,updated_at) VALUES ('forecast_config',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
          .run(JSON.stringify({ forecastMode: data.forecastMode || "mixed", opinionWeight: Number(data.opinionWeight || 0) }), stamp);
        audit("snapshot_saved", { id: Number(inserted.lastInsertRowid), trigger: data.trigger || "manual_run" });
        return json(res, 201, { ok: true, id: Number(inserted.lastInsertRowid) });
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
        refreshProcess = spawn(process.execPath, ["scripts/update-stats.mjs"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
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
