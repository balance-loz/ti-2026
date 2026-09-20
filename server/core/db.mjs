// Multi-tournament store. The former schema was keyed to a single league, so
// every table here carries league_id and nothing is hardcoded to one event.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export const DATA_DIR = path.resolve(process.env.DATA_DIR || "data");
export const DB_PATH = path.join(DATA_DIR, process.env.DB_FILE || "dota-predictor.sqlite");

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=10000;

CREATE TABLE IF NOT EXISTS tournaments (
  league_id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tier TEXT,
  status TEXT NOT NULL DEFAULT 'upcoming',
  start_time INTEGER,
  end_time INTEGER,
  last_match_time INTEGER,
  prize_pool INTEGER,
  team_count INTEGER,
  map_count INTEGER NOT NULL DEFAULT 0,
  series_count INTEGER NOT NULL DEFAULT 0,
  format_json TEXT,
  tracked INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_synced_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tournaments_status ON tournaments(status, last_match_time DESC);
CREATE INDEX IF NOT EXISTS idx_tournaments_tracked ON tournaments(tracked, status);

CREATE TABLE IF NOT EXISTS teams (
  team_id INTEGER PRIMARY KEY,
  name TEXT,
  tag TEXT,
  logo_url TEXT,
  last_match_time INTEGER,
  updated_at TEXT NOT NULL
);

-- One Dota game. league_id 0 means an unaffiliated pro match kept for training.
CREATE TABLE IF NOT EXISTS maps (
  match_id INTEGER PRIMARY KEY,
  league_id INTEGER NOT NULL DEFAULT 0,
  series_id TEXT,
  series_type INTEGER,
  radiant_team_id INTEGER,
  dire_team_id INTEGER,
  radiant_name TEXT,
  dire_name TEXT,
  radiant_win INTEGER,
  start_time INTEGER,
  duration INTEGER,
  patch TEXT,
  radiant_score INTEGER,
  dire_score INTEGER,
  radiant_picks_json TEXT,
  dire_picks_json TEXT,
  picks_bans_json TEXT,
  players_json TEXT,
  detail_fetched INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_maps_league ON maps(league_id, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_maps_series ON maps(league_id, series_id, start_time);
CREATE INDEX IF NOT EXISTS idx_maps_start ON maps(start_time DESC);
CREATE INDEX IF NOT EXISTS idx_maps_detail ON maps(detail_fetched, start_time DESC);

-- Maps grouped into a best-of. OpenDota series_id is used when present,
-- otherwise same-day same-pair maps are folded into one synthetic series.
CREATE TABLE IF NOT EXISTS series (
  series_key TEXT PRIMARY KEY,
  league_id INTEGER NOT NULL,
  opendota_series_id TEXT,
  team_a_id INTEGER NOT NULL,
  team_b_id INTEGER NOT NULL,
  best_of INTEGER,
  stage TEXT,
  start_time INTEGER,
  end_time INTEGER,
  score_a INTEGER NOT NULL DEFAULT 0,
  score_b INTEGER NOT NULL DEFAULT 0,
  winner_id INTEGER,
  status TEXT NOT NULL DEFAULT 'scheduled',
  map_ids_json TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_series_league ON series(league_id, start_time);
CREATE INDEX IF NOT EXISTS idx_series_status ON series(status, start_time DESC);

-- Frozen prediction ledger. A row is written once, before the outcome is known,
-- and only ever gets its resolution columns filled in later.
CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK(scope IN ('series','map','tournament')),
  subject_key TEXT NOT NULL,
  league_id INTEGER,
  model_kind TEXT NOT NULL,
  model_id TEXT,
  side_a TEXT NOT NULL,
  side_b TEXT NOT NULL,
  probability_a REAL NOT NULL CHECK(probability_a > 0 AND probability_a < 1),
  best_of INTEGER,
  features_json TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  outcome INTEGER,
  brier REAL,
  log_loss REAL,
  UNIQUE(scope, subject_key, model_kind)
);
CREATE INDEX IF NOT EXISTS idx_predictions_open ON predictions(resolved_at, created_at);
CREATE INDEX IF NOT EXISTS idx_predictions_league ON predictions(league_id, scope, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_predictions_model ON predictions(model_kind, resolved_at);

-- Monte-Carlo tournament outlook, one current row per league.
CREATE TABLE IF NOT EXISTS tournament_forecasts (
  league_id INTEGER PRIMARY KEY,
  generated_at TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  format TEXT,
  confidence TEXT,
  input_hash TEXT,
  payload_json TEXT NOT NULL
);

-- Live snapshots of an in-progress game, keyed by the draft state hash so a
-- repeated poll of the same picks does not create a new row.
CREATE TABLE IF NOT EXISTS live_games (
  match_id INTEGER PRIMARY KEY,
  league_id INTEGER,
  series_id TEXT,
  radiant_team_id INTEGER,
  dire_team_id INTEGER,
  radiant_name TEXT,
  dire_name TEXT,
  phase TEXT,
  game_time INTEGER,
  radiant_lead INTEGER,
  radiant_score INTEGER,
  dire_score INTEGER,
  radiant_picks_json TEXT,
  dire_picks_json TEXT,
  payload_json TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_live_games_open ON live_games(closed_at, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS model_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  model_id TEXT NOT NULL,
  trained_at TEXT NOT NULL,
  samples INTEGER,
  metrics_json TEXT,
  artifact_path TEXT,
  active INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  UNIQUE(kind, model_id)
);
CREATE INDEX IF NOT EXISTS idx_model_versions_active ON model_versions(kind, active, trained_at DESC);

CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  detail_json TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_runs_job ON job_runs(job, started_at DESC);

-- Matches announced by the tournament organiser, with their official start
-- time. Kept apart from the series table, which only ever holds what was
-- played: a schedule changes, and a rescheduled match must not rewrite a result.
CREATE TABLE IF NOT EXISTS scheduled_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'liquipedia',
  external_key TEXT NOT NULL,
  slot TEXT,
  stage TEXT,
  lane TEXT,
  -- Which round of the group stage, as the organiser published it. Null for
  -- bracket matches, which are identified by their slot instead, and for pages
  -- that number nothing.
  round INTEGER,
  -- Nullable: a bracket slot exists, with its date, long before anyone knows
  -- who will play in it. Refusing to store it would mean no bracket until the
  -- playoffs had already begun.
  team_a_name TEXT,
  team_b_name TEXT,
  team_a_id INTEGER,
  team_b_id INTEGER,
  best_of INTEGER,
  start_time INTEGER,
  winner_slot INTEGER,
  series_key TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(league_id, source, external_key)
);
CREATE INDEX IF NOT EXISTS idx_scheduled_league ON scheduled_matches(league_id, start_time);
CREATE INDEX IF NOT EXISTS idx_scheduled_upcoming ON scheduled_matches(start_time) WHERE series_key IS NULL;

CREATE TABLE IF NOT EXISTS heroes (
  hero_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  localized_name TEXT NOT NULL,
  primary_attr TEXT,
  attack_type TEXT,
  updated_at TEXT NOT NULL
);

-- Player names. The results feed stores account ids on every map but a name on
-- almost none of them, and the archive import stored none at all, so the names
-- come separately from the pro-player list and are joined in when displaying.
CREATE TABLE IF NOT EXISTS players (
  account_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  team_id INTEGER,
  team_name TEXT,
  country_code TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

let handle = null;

// Columns introduced after a release. CREATE TABLE IF NOT EXISTS leaves an
// existing table untouched, so every later column has to be added explicitly or
// a server that has been running since before the change keeps the old shape.
const COLUMN_MIGRATIONS = {
  tournaments: {
    liquipedia_page: "TEXT",
    structure_synced_at: "TEXT",
    structure_source: "TEXT",
  },
  series: {
    // An even best-of can finish level. Without this a drawn Bo2 sits forever
    // as an unfinished Bo3 and never reaches training or scoring.
    is_draw: "INTEGER NOT NULL DEFAULT 0",
  },
  scheduled_matches: {
    // The round the organiser published. Counting a team's matches cannot
    // replace it: a Swiss bye leaves that team a round short, and every later
    // result would then be shown under the wrong round.
    round: "INTEGER",
  },
  predictions: {
    // The scoreline is graded apart from the winner: calling 2:1 instead of 2:0
    // is a much smaller miss than backing the wrong team, and mixing the two
    // would hide how often the winner itself was right.
    predicted_score: "TEXT",
    predicted_score_probability: "REAL",
    actual_score: "TEXT",
    score_correct: "INTEGER",
    outcome_kind: "TEXT",
    draw_probability: "REAL",
  },
};

// scheduled_matches originally required both team names. The table is only
// ever rebuilt from the source, so an empty one can safely be recreated; a
// populated one is left alone and simply keeps the stricter shape.
function migrateScheduledMatches(db) {
  const columns = db.prepare("PRAGMA table_info(scheduled_matches)").all();
  if (!columns.length) return;
  const strict = columns.some((row) => row.name === "team_a_name" && row.notnull === 1);
  if (!strict) return;
  const count = db.prepare("SELECT COUNT(*) AS n FROM scheduled_matches").get().n;
  if (count > 0) return;
  db.exec("DROP TABLE scheduled_matches");
  db.exec(SCHEMA);
}

function migrateColumns(db) {
  for (const [table, columns] of Object.entries(COLUMN_MIGRATIONS)) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
    for (const [name, definition] of Object.entries(columns)) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }
}

export function openDb() {
  if (handle) return handle;
  mkdirSync(DATA_DIR, { recursive: true });
  handle = new DatabaseSync(DB_PATH);
  handle.exec(SCHEMA);
  migrateColumns(handle);
  migrateScheduledMatches(handle);
  return handle;
}

export function closeDb() {
  if (!handle) return;
  handle.close();
  handle = null;
}

export const nowIso = () => new Date().toISOString();

export function getSetting(db, key, fallback = null) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

export function setSetting(db, key, value) {
  db.prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
    .run(key, String(value), nowIso());
}

export function getJsonSetting(db, key, fallback = null) {
  const raw = getSetting(db, key, null);
  if (raw === null) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export function setJsonSetting(db, key, value) {
  setSetting(db, key, JSON.stringify(value));
}

export function startJobRun(db, job) {
  const info = db.prepare("INSERT INTO job_runs(job,started_at,status) VALUES(?,?,'running')").run(job, nowIso());
  return Number(info.lastInsertRowid);
}

export function finishJobRun(db, id, status, detail = null, error = null) {
  db.prepare("UPDATE job_runs SET finished_at=?, status=?, detail_json=?, error=? WHERE id=?")
    .run(nowIso(), status, detail ? JSON.stringify(detail) : null, error ? String(error).slice(0, 2000) : null, id);
}
