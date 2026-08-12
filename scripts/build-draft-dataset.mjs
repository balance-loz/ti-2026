import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const DEFAULT_MATCH_DIR = path.join(ROOT, "work", "opendota-cache", "matches");
const DEFAULT_HIGH_MMR_DIR = path.join(ROOT, "work", "high-mmr-cache", "matches");
const DEFAULT_BULK_DIR = path.join(ROOT, "work", "opendota-bulk", "shards");
const DB_PATH = path.resolve(process.env.DRAFT_TRAINING_DB || path.join(ROOT, "work", "draft-training.sqlite"));
const MANIFEST_PATH = path.resolve(process.env.DRAFT_DATASET_MANIFEST || path.join(ROOT, "work", "draft-dataset-manifest.json"));
const TIMELINE_PATH = path.resolve(process.env.DRAFT_PATCH_TIMELINE || path.join(ROOT, "work", "patch-timeline.json"));
const EXTRA_DIRS = String(process.env.DRAFT_MATCH_DIRS || "").split(path.delimiter).filter(Boolean).map((item) => path.resolve(item));
// Bulk rows provide coverage; richer per-match details are processed afterward and win INSERT OR REPLACE.
const MATCH_DIRS = [...new Set([DEFAULT_BULK_DIR, DEFAULT_MATCH_DIR, DEFAULT_HIGH_MMR_DIR, ...EXTRA_DIRS])];

function normalizedRole(player) {
  const estimated = Math.round(Number(player.position_est || 0));
  if (estimated >= 1 && estimated <= 5) return estimated;
  const laneRole = Number(player.lane_role || 0);
  if (laneRole === 1) return 1;
  if (laneRole === 2) return 2;
  if (laneRole === 3) return player.is_roaming ? 4 : 3;
  return 0;
}

function sidePlayers(match, radiant) {
  return (match.players ?? []).filter((player) => Boolean(Number(player.player_slot) < 128) === radiant).sort((a, b) => Number(a.player_slot) - Number(b.player_slot));
}

function usableMatch(match) {
  if (!Number.isInteger(Number(match.match_id)) || !Number.isInteger(Number(match.patch))) return false;
  if (!Array.isArray(match.players) || match.players.length < 10) return false;
  const heroes = match.players.map((player) => Number(player.hero_id)).filter(Boolean);
  return heroes.length >= 10 && new Set(heroes).size === 10;
}

async function inputFiles() {
  const found = [];
  for (const directory of MATCH_DIRS) {
    try {
      for (const file of await readdir(directory)) if (file.endsWith(".json") || file.endsWith(".jsonl")) found.push(path.join(directory, file));
    } catch {
      // Optional source directories are allowed to be absent.
    }
  }
  return [...new Set(found)];
}

async function records(file) {
  const raw = await readFile(file, "utf8");
  if (file.endsWith(".jsonl")) return raw.split(/\r?\n/).filter(Boolean).map((line) => ({ raw: line, match: JSON.parse(line) }));
  return [{ raw, match: JSON.parse(raw) }];
}

async function main() {
  const timeline = await readFile(TIMELINE_PATH, "utf8").then(JSON.parse).catch(() => null);
  const officialVersions = (timeline?.versions ?? []).filter((patch) => patch.overlapsWindow !== false).sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  const officialVersionAt = (timestamp) => {
    let found = null;
    for (const patch of officialVersions) {
      if (Number(patch.timestamp) > timestamp) break;
      found = patch.version;
    }
    return found;
  };
  await mkdir(path.dirname(DB_PATH), { recursive: true });
  const files = await inputFiles();
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS matches (
      match_id INTEGER PRIMARY KEY, patch_id INTEGER NOT NULL, start_time INTEGER NOT NULL,
      domain TEXT NOT NULL, league_id INTEGER NOT NULL, radiant_team_id INTEGER NOT NULL,
      dire_team_id INTEGER NOT NULL, radiant_win INTEGER NOT NULL, duration INTEGER NOT NULL,
      source_file TEXT NOT NULL, series_id INTEGER, series_id_source TEXT, subpatch_id TEXT, provider_patch TEXT, source TEXT,
      parse_quality REAL, content_checksum TEXT, series_best_of INTEGER
    );
    CREATE TABLE IF NOT EXISTS players (
      match_id INTEGER NOT NULL, side INTEGER NOT NULL, slot INTEGER NOT NULL,
      account_id INTEGER NOT NULL, hero_id INTEGER NOT NULL, role INTEGER NOT NULL,
      PRIMARY KEY(match_id, side, slot)
    );
    CREATE TABLE IF NOT EXISTS draft_events (
      match_id INTEGER NOT NULL, event_order INTEGER NOT NULL, side INTEGER NOT NULL,
      hero_id INTEGER NOT NULL, is_pick INTEGER NOT NULL, active_team INTEGER,
      PRIMARY KEY(match_id, event_order)
    );
    CREATE INDEX IF NOT EXISTS idx_training_matches_patch_time ON matches(patch_id, start_time);
    CREATE INDEX IF NOT EXISTS idx_training_matches_subpatch ON matches(subpatch_id, start_time);
    CREATE INDEX IF NOT EXISTS idx_training_players_hero_role ON players(hero_id, role);
    CREATE INDEX IF NOT EXISTS idx_training_players_match_hero ON players(match_id, hero_id);
    CREATE INDEX IF NOT EXISTS idx_training_events_hero ON draft_events(hero_id, is_pick);
  `);
  const columns = new Set(db.prepare("PRAGMA table_info(matches)").all().map((row) => row.name));
  for (const [name, definition] of Object.entries({ series_id: "INTEGER", series_id_source: "TEXT", subpatch_id: "TEXT", provider_patch: "TEXT", source: "TEXT", parse_quality: "REAL", content_checksum: "TEXT", series_best_of: "INTEGER" })) {
    if (!columns.has(name)) db.exec(`ALTER TABLE matches ADD COLUMN ${name} ${definition}`);
  }
  // Earlier builds accidentally treated OpenDota's replay parser `version` as a Dota subpatch.
  db.exec("UPDATE matches SET subpatch_id=NULL WHERE subpatch_id IS NOT NULL AND subpatch_id NOT GLOB '[0-9].[0-9]*'");
  db.exec("UPDATE matches SET series_id=-match_id,series_id_source='synthetic_match' WHERE series_id IS NULL; UPDATE matches SET series_id_source='provider' WHERE series_id_source IS NULL");
  const insertMatch = db.prepare("INSERT OR REPLACE INTO matches(match_id,patch_id,start_time,domain,league_id,radiant_team_id,dire_team_id,radiant_win,duration,source_file,series_id,series_id_source,subpatch_id,provider_patch,source,parse_quality,content_checksum,series_best_of) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const deletePlayers = db.prepare("DELETE FROM players WHERE match_id = ?");
  const insertPlayer = db.prepare("INSERT INTO players VALUES (?,?,?,?,?,?)");
  const deleteEvents = db.prepare("DELETE FROM draft_events WHERE match_id = ?");
  const insertEvent = db.prepare("INSERT INTO draft_events VALUES (?,?,?,?,?,?)");
  let accepted = 0; let rejected = 0; let parseFailures = 0;
  db.exec("BEGIN");
  try {
    for (let index = 0; index < files.length; index += 1) {
      let fileRecords;
      try { fileRecords = await records(files[index]); } catch { parseFailures++; continue; }
      for (const { raw, match } of fileRecords) {
      if (!usableMatch(match)) { rejected++; continue; }
      const matchId = Number(match.match_id);
      const leagueId = Number(match.leagueid || 0);
      const domain = leagueId > 0 ? "pro" : "high_mmr";
      const suppliedSubpatch = match.subpatch_id || match.patch_name || null;
      const providerPatch = /^\d+\.\d+[a-z]?$/i.test(String(suppliedSubpatch ?? "")) ? String(suppliedSubpatch) : null;
      const exactSubpatch = officialVersionAt(Number(match.start_time || 0)) || providerPatch;
      const qualityChecks = [match.players?.length === 10, new Set((match.players ?? []).map((player) => Number(player.hero_id)).filter(Boolean)).size === 10, Boolean(match.picks_bans?.length), Boolean(match.series_id), Boolean(match.radiant_team_id && match.dire_team_id), Boolean(exactSubpatch)];
      const parseQuality = qualityChecks.filter(Boolean).length / qualityChecks.length;
      const subpatchId = exactSubpatch ? String(exactSubpatch) : null;
      const source = match.data_source || (domain === "pro" ? "opendota_pro_match_detail" : "opendota_public_match");
      const checksum = createHash("sha256").update(raw).digest("hex");
      const providerSeriesId = Number(match.series_id || 0);
      const seriesBestOf = Number(match.series_type) === 2 ? 5 : Number(match.series_type) === 1 ? 3 : 1;
      insertMatch.run(matchId, Number(match.patch), Number(match.start_time || 0), domain, leagueId, Number(match.radiant_team_id || 0), Number(match.dire_team_id || 0), match.radiant_win ? 1 : 0, Number(match.duration || 0), path.relative(ROOT, files[index]), providerSeriesId || -matchId, providerSeriesId ? "provider" : "synthetic_match", subpatchId, providerPatch, source, parseQuality, checksum, seriesBestOf);
      deletePlayers.run(matchId);
      for (const [side, players] of [[0, sidePlayers(match, true)], [1, sidePlayers(match, false)]]) players.forEach((player, slot) => {
        insertPlayer.run(matchId, side, slot, Number(player.account_id || 0), Number(player.hero_id), normalizedRole(player));
      });
      deleteEvents.run(matchId);
      for (const [eventOrder, event] of (match.picks_bans ?? []).entries()) {
        const heroId = Number(event.hero_id || 0); if (!heroId) continue;
        insertEvent.run(matchId, Number(event.order ?? eventOrder), Number(event.team ?? -1), heroId, event.is_pick ? 1 : 0, Number.isFinite(Number(event.active_team)) ? Number(event.active_team) : null);
      }
      accepted++;
      }
      if ((index + 1) % 500 === 0) process.stdout.write(`Dataset: ${index + 1}/${files.length}\n`);
    }
    const generatedAt = new Date().toISOString();
    const metadata = db.prepare("INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    for (const [key, value] of Object.entries({ generatedAt, sourceDirectories: JSON.stringify(MATCH_DIRS), inputFiles: files.length, accepted, rejected, parseFailures, schemaVersion: 2, patchTimelineChecksum: timeline?.checksum ?? "missing" })) metadata.run(key, String(value));
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  const patches = db.prepare("SELECT patch_id AS patchId, COUNT(*) AS matches, MIN(start_time) AS firstMatch, MAX(start_time) AS lastMatch, SUM(CASE WHEN domain='pro' THEN 1 ELSE 0 END) AS proMatches, SUM(CASE WHEN domain='high_mmr' THEN 1 ELSE 0 END) AS highMmrMatches FROM matches GROUP BY patch_id ORDER BY firstMatch").all();
  const manifest = {
    generatedAt: new Date().toISOString(), schemaVersion: 2, database: path.relative(ROOT, DB_PATH), patchTimeline: timeline ? { file: path.relative(ROOT, TIMELINE_PATH), source: timeline.source, checksum: timeline.checksum, versions: officialVersions.length } : null,
    sources: MATCH_DIRS.map((directory) => ({ directory, kind: directory === DEFAULT_BULK_DIR ? "opendota-explorer-pro-bulk" : directory === DEFAULT_MATCH_DIR ? "opendota-pro-cache" : directory === DEFAULT_HIGH_MMR_DIR ? "opendota-high-mmr-sample" : "adapter" })),
    totals: { inputFiles: files.length, matches: Number(db.prepare("SELECT COUNT(*) AS n FROM matches").get().n), players: Number(db.prepare("SELECT COUNT(*) AS n FROM players").get().n), draftEvents: Number(db.prepare("SELECT COUNT(*) AS n FROM draft_events").get().n), rejected, parseFailures },
    quality: db.prepare("SELECT source, COUNT(*) AS matches, ROUND(AVG(parse_quality),4) AS averageParseQuality, SUM(CASE WHEN subpatch_id IS NOT NULL THEN 1 ELSE 0 END) AS exactSubpatchMatches, SUM(CASE WHEN series_id_source='provider' THEN 1 ELSE 0 END) AS providerSeriesMatches, SUM(CASE WHEN series_id_source='synthetic_match' THEN 1 ELSE 0 END) AS syntheticSeriesMatches FROM matches GROUP BY source ORDER BY matches DESC").all(),
    patches,
    exactVersions: db.prepare("SELECT subpatch_id AS version, COUNT(*) AS matches, MIN(start_time) AS firstMatch, MAX(start_time) AS lastMatch FROM matches WHERE subpatch_id IS NOT NULL GROUP BY subpatch_id ORDER BY firstMatch").all(),
  };
  db.close();
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Draft dataset ready: ${manifest.totals.matches} matches across ${patches.length} patches; ${DB_PATH}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
