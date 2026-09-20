#!/usr/bin/env node
// One-off import of the legacy draft archive (work/draft-training.sqlite) into
// the multi-tournament store. It carries two years of pro maps with full hero
// picks, which bootstraps the draft model and the ratings without spending a
// single API call.
//
//   node scripts/migrate-legacy-drafts.mjs [--source path] [--limit N]

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";
import { openDb, nowIso } from "../server/core/db.mjs";
import { rebuildSeries, refreshTournamentAggregates, upsertTournament } from "../server/core/tournaments.mjs";

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const SOURCE = path.resolve(argValue("--source", "work/draft-training.sqlite"));
const LIMIT = Number(argValue("--limit", "0")) || 0;

if (!existsSync(SOURCE)) {
  console.error(`source not found: ${SOURCE}`);
  process.exit(1);
}

const seriesTypeFromBestOf = (bestOf) => (bestOf === 5 ? 2 : bestOf === 3 ? 1 : bestOf === 1 ? 0 : null);

const source = new DatabaseSync(SOURCE, { readOnly: true });
const db = openDb();

const total = source.prepare("SELECT COUNT(*) AS n FROM matches").get().n;
console.log(`legacy archive: ${total} matches`);

const matchQuery = `SELECT match_id, league_id, series_id, series_best_of, radiant_team_id, dire_team_id,
                           radiant_win, start_time, duration, subpatch_id, patch_id
                    FROM matches
                    WHERE radiant_team_id > 0 AND dire_team_id > 0 AND radiant_win IS NOT NULL
                    ORDER BY start_time ASC${LIMIT ? ` LIMIT ${LIMIT}` : ""}`;

const playersFor = source.prepare("SELECT side, slot, hero_id FROM players WHERE match_id = ? ORDER BY slot ASC");
const insert = db.prepare(`INSERT INTO maps(match_id, league_id, series_id, series_type, radiant_team_id, dire_team_id,
    radiant_win, start_time, duration, patch, radiant_picks_json, dire_picks_json, detail_fetched, updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?)
  ON CONFLICT(match_id) DO UPDATE SET
    league_id = CASE WHEN excluded.league_id > 0 THEN excluded.league_id ELSE maps.league_id END,
    series_id = COALESCE(maps.series_id, excluded.series_id),
    series_type = COALESCE(maps.series_type, excluded.series_type),
    radiant_picks_json = COALESCE(maps.radiant_picks_json, excluded.radiant_picks_json),
    dire_picks_json = COALESCE(maps.dire_picks_json, excluded.dire_picks_json),
    patch = COALESCE(maps.patch, excluded.patch),
    detail_fetched = 1,
    updated_at = excluded.updated_at`);

const at = nowIso();
const leagues = new Set();
let imported = 0;
let skipped = 0;
let processed = 0;

db.exec("BEGIN");
for (const match of source.prepare(matchQuery).all()) {
  processed += 1;
  const players = playersFor.all(match.match_id);
  const radiant = players.filter((row) => Number(row.side) === 0).map((row) => Number(row.hero_id)).filter(Boolean);
  const dire = players.filter((row) => Number(row.side) === 1).map((row) => Number(row.hero_id)).filter(Boolean);
  if (radiant.length !== 5 || dire.length !== 5 || new Set([...radiant, ...dire]).size !== 10) {
    skipped += 1;
    continue;
  }
  const leagueId = Number(match.league_id || 0);
  insert.run(
    Number(match.match_id), leagueId,
    match.series_id ? String(match.series_id) : null,
    seriesTypeFromBestOf(Number(match.series_best_of)),
    Number(match.radiant_team_id), Number(match.dire_team_id),
    match.radiant_win ? 1 : 0,
    Number(match.start_time) || null, Number(match.duration) || null,
    match.subpatch_id ? String(match.subpatch_id) : (match.patch_id != null ? String(match.patch_id) : null),
    JSON.stringify(radiant), JSON.stringify(dire), at,
  );
  if (leagueId) leagues.add(leagueId);
  imported += 1;
  if (processed % 5000 === 0) {
    db.exec("COMMIT");
    db.exec("BEGIN");
    console.log(`  ${processed}/${total} processed, ${imported} imported`);
  }
}
db.exec("COMMIT");

console.log(`imported ${imported}, skipped ${skipped} (incomplete drafts), ${leagues.size} leagues touched`);

console.log("rebuilding series…");
let rebuilt = 0;
for (const leagueId of leagues) {
  upsertTournament(db, { leagueId, name: `League ${leagueId}` });
  rebuilt += rebuildSeries(db, leagueId).series;
  refreshTournamentAggregates(db, leagueId);
}
console.log(`series after rebuild: ${rebuilt}`);

const counts = db.prepare(`SELECT
  (SELECT COUNT(*) FROM maps) AS maps,
  (SELECT COUNT(*) FROM maps WHERE radiant_picks_json IS NOT NULL) AS with_picks,
  (SELECT COUNT(*) FROM series) AS series,
  (SELECT COUNT(*) FROM tournaments) AS tournaments`).get();
console.log("store now:", JSON.stringify(counts));

source.close();
