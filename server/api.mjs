import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const PORT = Number(process.env.API_PORT || 3001);
const DATA_DIR = path.resolve(process.env.DATA_DIR || "data");
const DB_PATH = path.join(DATA_DIR, "ti-predictor.sqlite");
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";
const SESSION_DAYS = 30;

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
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);
db.exec("PRAGMA optimize");

let refreshProcess = null;
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
  return { answers, matches, snapshots, refresh, refreshRunning: Boolean(refreshProcess) };
}

function audit(kind, payload) {
  db.prepare("INSERT INTO events(kind, payload, created_at) VALUES (?, ?, ?)").run(kind, JSON.stringify(payload), now());
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
        if (!validTeams.test(data.teamA) || !validTeams.test(data.teamB) || data.teamA === data.teamB || !(data.round >= 1 && data.round <= 20)) return json(res, 400, { error: "invalid_match" });
        const winner = data.winner || null;
        if (winner && winner !== data.teamA && winner !== data.teamB) return json(res, 400, { error: "invalid_winner" });
        const stamp = now();
        const result = db.prepare(`INSERT INTO matches(stage, round, team_a, team_b, winner, score_a, score_b, scheduled_at, source_match_id, predicted_probability, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(data.stage || "swiss", data.round, data.teamA, data.teamB, winner, data.scoreA ?? null, data.scoreB ?? null, data.scheduledAt || null, data.sourceMatchId || null, data.predictedProbability ?? null, stamp, stamp);
        audit("match_added", { id: Number(result.lastInsertRowid), ...data });
        return json(res, 201, { ok: true, id: Number(result.lastInsertRowid) });
      }
      if (req.method === "POST" && url.pathname === "/api/admin/snapshots") {
        const data = await body(req);
        if (!data.probabilities || !data.result || !Number.isInteger(data.iterations) || !Number.isInteger(data.seed)) return json(res, 400, { error: "invalid_snapshot" });
        const stamp = now();
        const inserted = db.prepare(`INSERT INTO prediction_snapshots(trigger, forecast_mode, opinion_weight, iterations, seed, completed_match_count, model_generated_at, probabilities_json, result_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(data.trigger || "manual_run", data.forecastMode || "mixed", Number(data.opinionWeight || 0), data.iterations, data.seed, Number(data.completedMatchCount || 0), data.modelGeneratedAt || null, JSON.stringify(data.probabilities), JSON.stringify(data.result), stamp);
        audit("snapshot_saved", { id: Number(inserted.lastInsertRowid), trigger: data.trigger || "manual_run" });
        return json(res, 201, { ok: true, id: Number(inserted.lastInsertRowid) });
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
    }
    return json(res, 404, { error: "not_found" });
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: "internal_error" });
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`TI Predictor API listening on ${PORT}; database ${DB_PATH}`));
