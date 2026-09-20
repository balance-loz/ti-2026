// Tests for the multi-tournament predictor core. Everything here runs against
// a throwaway database and never touches the network.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Everything this suite writes must land in the temp directory. Without the
// model overrides the tests would overwrite the real trained artifacts in
// public/, which are what the running site serves.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "predictor-test-"));
process.env.TEAM_RATINGS_MODEL = path.join(process.env.DATA_DIR, "team-ratings.json");
process.env.DRAFT_TEMPORAL_MODEL = path.join(process.env.DATA_DIR, "draft-temporal-model.json");
process.env.LIVE_MAP_MODEL = path.join(process.env.DATA_DIR, "live-map-model.json");
// Look only inside the temp import directory; the working copy may hold a real
// archive and the suite must not read it.
process.env.IMPORT_EXTRA_PATHS = "";

const { openDb, closeDb, getJsonSetting, setJsonSetting } = await import("../server/core/db.mjs");
const {
  slugify, tournamentStatus, isPlayingNow, upsertTournament, upsertMap, upsertTeam,
  rebuildSeries, refreshTournamentAggregates, tournamentBySlug,
} = await import("../server/core/tournaments.mjs");
const { analyzeTournament, simulateTournament } = await import("../server/core/format.mjs");
const { freezePrediction, getPrediction, resolvePredictions, accuracySummary, freezeUpcomingSeries } = await import("../server/core/predictions.mjs");
const { ratingPairProbability } = await import("../server/core/ratings.mjs");
const { normalizeLiveRow, livePollIntervalSeconds } = await import("../server/core/live.mjs");

const db = openDb();

process.on("exit", () => {
  closeDb();
  try { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

const HOUR = 3600;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000;

function seedMap({ matchId, leagueId, seriesId, seriesType = 1, radiant, dire, radiantWin, startTime }) {
  upsertMap(db, {
    match_id: matchId,
    series_id: seriesId,
    series_type: seriesType,
    radiant_team_id: radiant,
    dire_team_id: dire,
    radiant_win: radiantWin,
    start_time: startTime,
    duration: 2000,
  }, { leagueId });
}

test("slug is stable, url-safe and never collapses to nothing", () => {
  assert.equal(slugify("PGL Wallachia 2026 Season 9", 20279), "pgl-wallachia-2026-season-9-20279");
  assert.equal(slugify("  ESL One — Birmingham  ", 42), "esl-one-birmingham-42");
  // A name with no latin characters must still produce a usable slug.
  assert.equal(slugify("肛宝联赛", 19066), "league-19066");
  assert.equal(slugify("", 7), "league-7");
  assert.match(slugify("Anything!!", 1), /^[a-z0-9-]+$/);
});

test("a tournament is live while maps keep landing and finished once they stop", () => {
  assert.equal(tournamentStatus({ lastMatchTime: NOW - HOUR, nowSeconds: NOW }), "live");
  assert.equal(tournamentStatus({ lastMatchTime: NOW - 3 * DAY, nowSeconds: NOW }), "live", "rest days must not end a tournament");
  assert.equal(tournamentStatus({ lastMatchTime: NOW - 30 * DAY, nowSeconds: NOW }), "finished");
  assert.equal(tournamentStatus({ lastMatchTime: null, nowSeconds: NOW, hasMaps: false }), "upcoming");
  assert.equal(isPlayingNow(NOW - HOUR, NOW), true);
  assert.equal(isPlayingNow(NOW - 12 * HOUR, NOW), false);
});

test("maps fold into a best-of by series id and the score follows the maps", () => {
  const leagueId = 900001;
  upsertTournament(db, { leagueId, name: "Fold Test Cup", tier: "professional" });
  upsertTeam(db, { teamId: 11, name: "Alpha" });
  upsertTeam(db, { teamId: 22, name: "Beta" });
  seedMap({ matchId: 1001, leagueId, seriesId: "5001", radiant: 11, dire: 22, radiantWin: 1, startTime: NOW - 3 * HOUR });
  seedMap({ matchId: 1002, leagueId, seriesId: "5001", radiant: 22, dire: 11, radiantWin: 0, startTime: NOW - 2 * HOUR });

  rebuildSeries(db, leagueId);
  const series = db.prepare("SELECT * FROM series WHERE league_id = ?").all(leagueId);
  assert.equal(series.length, 1, "two maps of one series must not become two series");
  assert.equal(series[0].best_of, 3);
  assert.equal(series[0].score_a, 2);
  assert.equal(series[0].score_b, 0);
  assert.equal(Number(series[0].winner_id), 11);
  assert.equal(series[0].status, "finished");
});

test("a best-of is only decided once a team reaches the winning map count", () => {
  const leagueId = 900002;
  upsertTournament(db, { leagueId, name: "Undecided Cup", tier: "professional" });
  seedMap({ matchId: 2001, leagueId, seriesId: "6001", radiant: 11, dire: 22, radiantWin: 1, startTime: NOW - 2 * HOUR });
  rebuildSeries(db, leagueId);
  const series = db.prepare("SELECT * FROM series WHERE league_id = ?").get(leagueId);
  assert.equal(series.status, "live", "1-0 in a Bo3 is not a result");
  assert.equal(series.winner_id, null);
});

test("maps without a series id are grouped by pair inside one block, not across days", () => {
  const leagueId = 900003;
  upsertTournament(db, { leagueId, name: "No Series Id Cup", tier: "professional" });
  seedMap({ matchId: 3001, leagueId, seriesId: null, seriesType: null, radiant: 11, dire: 22, radiantWin: 1, startTime: NOW - 2 * HOUR });
  seedMap({ matchId: 3002, leagueId, seriesId: null, seriesType: null, radiant: 11, dire: 22, radiantWin: 1, startTime: NOW - HOUR });
  // Same pair, but three days later: a different series.
  seedMap({ matchId: 3003, leagueId, seriesId: null, seriesType: null, radiant: 22, dire: 11, radiantWin: 1, startTime: NOW + 3 * DAY });
  rebuildSeries(db, leagueId);
  const series = db.prepare("SELECT * FROM series WHERE league_id = ? ORDER BY start_time").all(leagueId);
  assert.equal(series.length, 2);
  assert.equal(series[0].score_a + series[0].score_b, 2);
  assert.equal(series[1].score_a + series[1].score_b, 1);
});

test("a stale synthetic series is removed when the maps behind it change", () => {
  const leagueId = 900004;
  upsertTournament(db, { leagueId, name: "Resync Cup", tier: "professional" });
  seedMap({ matchId: 4001, leagueId, seriesId: null, seriesType: null, radiant: 11, dire: 22, radiantWin: 1, startTime: NOW });
  rebuildSeries(db, leagueId);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM series WHERE league_id = ?").get(leagueId).n, 1);
  db.prepare("DELETE FROM maps WHERE match_id = 4001").run();
  const result = rebuildSeries(db, leagueId);
  assert.equal(result.removed, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM series WHERE league_id = ?").get(leagueId).n, 0);
});

test("aggregates count distinct teams and pick up the latest map time", () => {
  const leagueId = 900005;
  upsertTournament(db, { leagueId, name: "Aggregate Cup", tier: "professional" });
  seedMap({ matchId: 5001, leagueId, seriesId: "7001", radiant: 11, dire: 22, radiantWin: 1, startTime: NOW - DAY });
  seedMap({ matchId: 5002, leagueId, seriesId: "7002", radiant: 33, dire: 22, radiantWin: 0, startTime: NOW - HOUR });
  rebuildSeries(db, leagueId);
  refreshTournamentAggregates(db, leagueId, { nowSeconds: NOW });
  const row = db.prepare("SELECT * FROM tournaments WHERE league_id = ?").get(leagueId);
  assert.equal(row.map_count, 2);
  assert.equal(row.team_count, 3);
  assert.equal(row.last_match_time, NOW - HOUR);
  assert.equal(row.status, "live");
  assert.ok(tournamentBySlug(db, row.slug));
  assert.ok(tournamentBySlug(db, String(leagueId)), "a league id must also resolve a tournament");
});

test("ratings shrink toward even when a team is barely observed", () => {
  const artifact = {
    ratings: {
      100: { rating: 2.0, series: 60 },
      200: { rating: -2.0, series: 60 },
      300: { rating: 2.0, series: 1 },
      400: { rating: -2.0, series: 1 },
    },
  };
  const confident = ratingPairProbability(artifact, 100, 200);
  const thin = ratingPairProbability(artifact, 300, 400);
  assert.equal(confident.confidence, "high");
  assert.equal(thin.confidence, "low");
  assert.ok(confident.mapProbabilityA > 0.9);
  assert.ok(thin.mapProbabilityA < confident.mapProbabilityA, "thin evidence must not produce a confident number");
  assert.ok(thin.mapProbabilityA > 0.5);
  // Unknown teams give an honest coin flip rather than a fabricated edge.
  const unknown = ratingPairProbability(artifact, 999, 998);
  assert.equal(unknown.mapProbabilityA, 0.5);
  assert.equal(unknown.confidence, "none");
});

test("a frozen prediction is written once and never rewritten", () => {
  const first = freezePrediction(db, {
    scope: "series", subjectKey: "900001:s:5001", leagueId: 900001,
    modelKind: "team_ratings", modelId: "m1", sideA: 11, sideB: 22, probabilityA: 0.7, bestOf: 3,
  });
  assert.equal(first.inserted, true);
  const second = freezePrediction(db, {
    scope: "series", subjectKey: "900001:s:5001", leagueId: 900001,
    modelKind: "team_ratings", modelId: "m2", sideA: 11, sideB: 22, probabilityA: 0.99, bestOf: 3,
  });
  assert.equal(second.inserted, false, "a second freeze must be refused");
  const stored = getPrediction(db, "series", "900001:s:5001", "team_ratings");
  assert.equal(stored.probability_a, 0.7);
  assert.equal(stored.model_id, "m1");
});

test("resolving scores a prediction against the real winner", () => {
  resolvePredictions(db);
  const row = getPrediction(db, "series", "900001:s:5001", "team_ratings");
  assert.ok(row.resolved_at, "a finished series must close its prediction");
  assert.equal(row.outcome, 1, "team 11 won the series so the side_a outcome is 1");
  assert.ok(Math.abs(row.brier - 0.09) < 1e-9);
  assert.ok(Math.abs(row.log_loss + Math.log(0.7)) < 1e-9);

  const summary = accuracySummary(db, { leagueId: 900001 });
  const series = summary.find((entry) => entry.scope === "series");
  assert.equal(series.count, 1);
  assert.equal(series.accuracy, 1);
});

test("an undecided series leaves its prediction open", () => {
  freezePrediction(db, {
    scope: "series", subjectKey: "900002:s:6001", leagueId: 900002,
    modelKind: "team_ratings", modelId: "m1", sideA: 11, sideB: 22, probabilityA: 0.6, bestOf: 3,
  });
  resolvePredictions(db);
  const row = getPrediction(db, "series", "900002:s:6001", "team_ratings");
  assert.equal(row.resolved_at, null);
});

test("a finished series never gets a prediction written after the fact", async () => {
  const leagueId = 900020;
  upsertTournament(db, { leagueId, name: "Hindsight Cup", tier: "professional" });
  upsertTeam(db, { teamId: 81, name: "Done A" });
  upsertTeam(db, { teamId: 82, name: "Done B" });
  // One decided series and one still in progress.
  seedMap({ matchId: 7001, leagueId, seriesId: "9001", radiant: 81, dire: 82, radiantWin: true, startTime: NOW - 3 * HOUR });
  seedMap({ matchId: 7002, leagueId, seriesId: "9001", radiant: 81, dire: 82, radiantWin: true, startTime: NOW - 2 * HOUR });
  seedMap({ matchId: 7003, leagueId, seriesId: "9002", radiant: 81, dire: 82, radiantWin: true, startTime: NOW - HOUR });
  rebuildSeries(db, leagueId);

  // Ratings good enough for the pair to clear the "unknown teams" guard.
  const { RATINGS_PATH } = await import("../server/core/ratings.mjs");
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const nodePath = await import("node:path");
  mkdirSync(nodePath.dirname(RATINGS_PATH), { recursive: true });
  writeFileSync(RATINGS_PATH, JSON.stringify({
    modelId: "test-ratings",
    ratings: { 81: { rating: 1.2, series: 40 }, 82: { rating: -0.4, series: 40 } },
  }));
  const { invalidateRatingsCache } = await import("../server/core/ratings.mjs");
  invalidateRatingsCache();

  const result = freezeUpcomingSeries(db, leagueId);
  assert.equal(result.frozen, 1, "only the undecided series may be frozen");

  const decided = db.prepare("SELECT series_key FROM series WHERE league_id = ? AND status = 'finished'").get(leagueId);
  assert.equal(getPrediction(db, "series", decided.series_key, "team_ratings"), undefined,
    "a decided series must never receive a prediction");

  const open = db.prepare("SELECT series_key FROM series WHERE league_id = ? AND status != 'finished'").get(leagueId);
  const stored = getPrediction(db, "series", open.series_key, "team_ratings");
  assert.ok(stored);
  const features = JSON.parse(stored.features_json);
  assert.equal(features.scoreAtFreeze, "1-0", "the score at freeze time must be auditable");
  assert.equal(features.mapsPlayedAtFreeze, 1);
});

test("a team still playing is never pre-eliminated by an inferred loss budget", () => {
  const leagueId = 900010;
  upsertTournament(db, { leagueId, name: "Bracket Cup", tier: "professional" });
  for (const id of [61, 62, 63, 64]) upsertTeam(db, { teamId: id, name: `Team ${id}` });
  // Every team has already lost once, and all are still playing.
  seedMap({ matchId: 6101, leagueId, seriesId: "8001", radiant: 61, dire: 62, radiantWin: 1, startTime: NOW - 2 * HOUR });
  seedMap({ matchId: 6102, leagueId, seriesId: "8001", radiant: 61, dire: 62, radiantWin: 1, startTime: NOW - HOUR });
  seedMap({ matchId: 6103, leagueId, seriesId: "8002", radiant: 63, dire: 64, radiantWin: 1, startTime: NOW - 2 * HOUR });
  seedMap({ matchId: 6104, leagueId, seriesId: "8002", radiant: 63, dire: 64, radiantWin: 1, startTime: NOW - HOUR });
  seedMap({ matchId: 6105, leagueId, seriesId: "8003", radiant: 62, dire: 64, radiantWin: 1, startTime: NOW - 30 * 60 });
  rebuildSeries(db, leagueId);

  const analysis = analyzeTournament(db, leagueId, { nowSeconds: NOW });
  const simulation = simulateTournament(analysis, { ratings: {} }, { iterations: 4000, seed: 7 });
  const total = simulation.teams.reduce((sum, team) => sum + team.champion, 0);
  assert.ok(Math.abs(total - 100) < 0.01, "champion probabilities must sum to 100%");
  const withChance = simulation.teams.filter((team) => team.champion > 0);
  assert.ok(withChance.length >= 2, "more than one team must be able to win");
  for (const team of simulation.teams) {
    assert.ok(team.champion <= team.final + 1e-9, "champion cannot exceed reaching the final");
    assert.ok(team.final <= team.top4 + 1e-9, "final cannot exceed reaching the top four");
  }
});

test("an unreadable format falls back to a stated double-elimination budget", () => {
  const leagueId = 900011;
  upsertTournament(db, { leagueId, name: "Opaque Cup", tier: "professional" });
  seedMap({ matchId: 6201, leagueId, seriesId: "8101", radiant: 71, dire: 72, radiantWin: 1, startTime: NOW - HOUR });
  seedMap({ matchId: 6202, leagueId, seriesId: "8101", radiant: 71, dire: 72, radiantWin: 1, startTime: NOW - 30 * 60 });
  rebuildSeries(db, leagueId);
  const analysis = analyzeTournament(db, leagueId, { nowSeconds: NOW });
  const simulation = simulateTournament(analysis, { ratings: {} }, { iterations: 1000, seed: 3 });
  assert.equal(simulation.format.eliminationThresholdUsed, 2);
  assert.equal(simulation.format.thresholdInferred, false);
  assert.match(simulation.caveat, /double elimination/i, "an assumed format must be stated on the page");
});

test("a live row is usable only with both teams and a fresh feed timestamp", () => {
  const base = {
    match_id: "123", league_id: 555, team_id_radiant: 1, team_id_dire: 2,
    team_name_radiant: "A", team_name_dire: "B", game_time: 600,
    last_update_time: NOW, radiant_lead: 1200, radiant_score: 5, dire_score: 3,
    players: [
      ...[1, 2, 3, 4, 5].map((hero, index) => ({ team: 0, team_slot: index, hero_id: hero })),
      ...[6, 7, 8, 9, 10].map((hero, index) => ({ team: 1, team_slot: index, hero_id: hero })),
    ],
  };
  const game = normalizeLiveRow(base, { nowSeconds: NOW });
  assert.equal(game.picksComplete, true);
  assert.equal(game.phase, "game");
  assert.deepEqual(game.radiantPicks, [1, 2, 3, 4, 5]);

  assert.equal(normalizeLiveRow({ ...base, team_id_dire: 0 }, { nowSeconds: NOW }), null, "a missing team id is unusable");
  assert.equal(normalizeLiveRow({ ...base, team_id_dire: 1 }, { nowSeconds: NOW }), null, "a team cannot play itself");
  assert.equal(normalizeLiveRow(base, { nowSeconds: NOW + 3600 }), null, "a stale feed row must be dropped");

  const drafting = normalizeLiveRow({ ...base, game_time: 0, players: base.players.slice(0, 7) }, { nowSeconds: NOW });
  assert.equal(drafting.phase, "draft");
  assert.equal(drafting.picksComplete, false);
});

test("live polling speeds up for drafts and backs off when the budget runs low", () => {
  assert.equal(livePollIntervalSeconds([]), 300, "nothing running means a slow poll");
  const drafting = livePollIntervalSeconds([{ phase: "draft" }]);
  const playing = livePollIntervalSeconds([{ phase: "game" }]);
  assert.ok(drafting < playing, "a draft in progress is the moment that matters");
  assert.ok(livePollIntervalSeconds([{ phase: "draft" }], { remainingBudget: 100 }) >= 600, "a nearly spent budget must stretch the interval");
  assert.ok(livePollIntervalSeconds([{ phase: "draft" }], { remainingBudget: 300 }) >= 300);
});

test("a dropped archive is imported once, whatever path it is found through", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { writeFileSync, mkdirSync: makeDir, copyFileSync } = await import("node:fs");
  const { IMPORT_DIR, findArchives, alreadyImported, importArchive, importPendingArchives } = await import("../server/jobs/import-archive.mjs");

  makeDir(IMPORT_DIR, { recursive: true });
  const archivePath = path.join(IMPORT_DIR, "legacy.sqlite");
  writeFileSync(archivePath, "");
  const archive = new DatabaseSync(archivePath);
  archive.exec(`
    CREATE TABLE matches (match_id INTEGER, league_id INTEGER, series_id INTEGER, series_best_of INTEGER,
      radiant_team_id INTEGER, dire_team_id INTEGER, radiant_win INTEGER, start_time INTEGER,
      duration INTEGER, subpatch_id TEXT, patch_id INTEGER);
    CREATE TABLE players (match_id INTEGER, side INTEGER, slot INTEGER, hero_id INTEGER, account_id INTEGER);`);
  // Two complete maps of one Bo3, plus one map whose draft is incomplete.
  for (const [matchId, win] of [[990001, 1], [990002, 1]]) {
    archive.prepare("INSERT INTO matches VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(matchId, 777, 4242, 3, 91, 92, win, NOW - HOUR, 2000, "7.41e", 60);
    for (let slot = 0; slot < 5; slot += 1) {
      archive.prepare("INSERT INTO players VALUES(?,?,?,?,?)").run(matchId, 0, slot, slot + 1, 7000 + slot);
      archive.prepare("INSERT INTO players VALUES(?,?,?,?,?)").run(matchId, 1, slot, slot + 20, 8000 + slot);
    }
  }
  archive.prepare("INSERT INTO matches VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(990003, 777, 4243, 3, 91, 92, 1, NOW, 2000, "7.41e", 60);
  archive.prepare("INSERT INTO players VALUES(?,?,?,?,?)").run(990003, 0, 0, 1, 7001);
  archive.close();

  const first = await importArchive(db, archivePath);
  assert.equal(first.imported, 2);
  assert.equal(first.skipped, 1, "a map without ten locked heroes is not training data");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM maps WHERE league_id = 777").get().n, 2);
  const series = db.prepare("SELECT * FROM series WHERE league_id = 777").get();
  assert.equal(series.score_a, 2, "the imported maps must fold into one finished series");
  assert.equal(series.status, "finished");

  // The marker follows the file's content, so a second pass does nothing.
  assert.equal(alreadyImported(db, archivePath), true);
  const rerun = await importPendingArchives(db);
  assert.equal(rerun.imported, 0);
  assert.equal(rerun.skipped, "nothing_new");

  // The same archive reachable through a second path must not import twice.
  const duplicate = path.join(IMPORT_DIR, "legacy-copy.sqlite");
  copyFileSync(archivePath, duplicate);
  const found = findArchives();
  assert.equal(found.length, 1, "one archive in two places is still one archive");

  // Lineups come across, which is what lets ratings tell one squad from another.
  const stored = db.prepare("SELECT players_json FROM maps WHERE match_id = 990001").get();
  const lineup = JSON.parse(stored.players_json);
  assert.equal(lineup.length, 10);
  assert.ok(lineup.every((player) => Number(player.accountId) > 0));
});

test("an archive written before account ids existed still imports", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { writeFileSync } = await import("node:fs");
  const { importArchive, IMPORT_DIR } = await import("../server/jobs/import-archive.mjs");

  const legacyPath = path.join(IMPORT_DIR, "ancient.sqlite");
  writeFileSync(legacyPath, "");
  const archive = new DatabaseSync(legacyPath);
  archive.exec(`
    CREATE TABLE matches (match_id INTEGER, league_id INTEGER, series_id INTEGER, series_best_of INTEGER,
      radiant_team_id INTEGER, dire_team_id INTEGER, radiant_win INTEGER, start_time INTEGER,
      duration INTEGER, subpatch_id TEXT, patch_id INTEGER);
    CREATE TABLE players (match_id INTEGER, side INTEGER, slot INTEGER, hero_id INTEGER);`);
  archive.prepare("INSERT INTO matches VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(991001, 778, 4444, 3, 93, 94, 1, NOW - HOUR, 2000, "7.30", 50);
  for (let slot = 0; slot < 5; slot += 1) {
    archive.prepare("INSERT INTO players VALUES(?,?,?,?)").run(991001, 0, slot, slot + 1);
    archive.prepare("INSERT INTO players VALUES(?,?,?,?)").run(991001, 1, slot, slot + 20);
  }
  archive.close();

  // A missing column must not cost us the maps, only the lineups.
  const result = await importArchive(db, legacyPath);
  assert.equal(result.imported, 1);
  const stored = db.prepare("SELECT players_json, radiant_picks_json FROM maps WHERE match_id = 991001").get();
  assert.ok(stored.radiant_picks_json, "picks still import");
  assert.equal(stored.players_json, null, "there were simply no lineups to take");
});

test("an archive with an unknown schema is refused rather than half-imported", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { writeFileSync } = await import("node:fs");
  const { importArchive } = await import("../server/jobs/import-archive.mjs");

  const strangePath = path.join(process.env.DATA_DIR, "strange.sqlite");
  writeFileSync(strangePath, "");
  const strange = new DatabaseSync(strangePath);
  strange.exec("CREATE TABLE something_else (id INTEGER)");
  strange.close();

  const result = await importArchive(db, strangePath);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "unrecognised_schema");
});

test("settings round-trip json and survive a missing key", () => {
  assert.equal(getJsonSetting(db, "nope", null), null);
  setJsonSetting(db, "cursor", { at: 5, done: false });
  assert.deepEqual(getJsonSetting(db, "cursor", null), { at: 5, done: false });
  setJsonSetting(db, "cursor", { at: 9, done: true });
  assert.deepEqual(getJsonSetting(db, "cursor", null), { at: 9, done: true });
});

test("background work is described in words, with the right plural form", async () => {
  const { describeJobRun, JOB_TITLES } = await import("../server/core/activity.mjs");

  // Russian needs three forms, and the counts here land on all of them.
  assert.match(describeJobRun("collectRecent", { stored: 1, leagues: 1 }), /1 карта из 1 лиги/);
  assert.match(describeJobRun("collectRecent", { stored: 3, leagues: 2 }), /3 карты/);
  assert.match(describeJobRun("collectRecent", { stored: 25, leagues: 9 }), /25 карт/);
  assert.match(describeJobRun("collectRecent", { stored: 21, leagues: 1 }), /21 карта/, "21 takes the singular form");
  assert.match(describeJobRun("collectRecent", { stored: 11, leagues: 1 }), /11 карт/, "11 is an exception to that");

  assert.equal(describeJobRun("collectRecent", { stored: 0 }), "новых матчей нет");
  assert.match(describeJobRun("live", { openGames: 1, predicted: 1 }), /1 матч идёт/);
  assert.match(describeJobRun("live", { openGames: 2, predicted: 0 }), /2 матча идут/);
  assert.match(describeJobRun("backfill", { stored: 500, oldestSeen: 1_760_000_000, done: true }), /окно закрыто полностью/);
  assert.match(describeJobRun("retrain", { ratings: { ok: true, series: 17_000, teams: 1_300 } }), /рейтинги/);

  // A failure must say so rather than look like a quiet success.
  assert.match(describeJobRun("live", { error: "opendota_throttled" }), /^ошибка: /);
  assert.match(describeJobRun("structure", { skipped: true, reason: "fresh" }), /пропущено/);
  assert.equal(describeJobRun("live", null), null);

  for (const job of ["live", "retrain", "backfill", "structure"]) {
    assert.ok(JOB_TITLES[job], `${job} must have a readable title`);
  }
});

test("a scheduled match is predicted before it starts, then follows its series", async () => {
  const { freezeScheduledMatches, linkScheduledToSeries, scheduledSubjectKey } =
    await import("../server/jobs/freeze-scheduled.mjs");
  const { writeFileSync, mkdirSync: makeDir } = await import("node:fs");
  const nodePath = await import("node:path");
  const { RATINGS_PATH, invalidateRatingsCache } = await import("../server/core/ratings.mjs");

  makeDir(nodePath.dirname(RATINGS_PATH), { recursive: true });
  writeFileSync(RATINGS_PATH, JSON.stringify({
    modelId: "test-ratings",
    ratings: { 501: { rating: 1.4, series: 50 }, 502: { rating: -0.3, series: 50 } },
  }));
  invalidateRatingsCache();

  const leagueId = 900030;
  upsertTournament(db, { leagueId, name: "Scheduled Cup", tier: "professional" });
  upsertTeam(db, { teamId: 501, name: "Alpha" });
  upsertTeam(db, { teamId: 502, name: "Beta" });

  const startTime = NOW + 30 * 60;
  db.prepare(`INSERT INTO scheduled_matches(league_id, source, external_key, slot, stage, lane,
      team_a_name, team_b_name, team_a_id, team_b_id, best_of, start_time, updated_at)
    VALUES(?, 'liquipedia', 'bracket:R1M1', 'R1M1', 'Upper Bracket', 'upper', 'Alpha', 'Beta', 501, 502, 3, ?, ?)`)
    .run(leagueId, startTime, new Date().toISOString());

  // Too early: nothing is written until the match is close enough to start.
  assert.equal(freezeScheduledMatches(db, { nowSeconds: NOW - 10 * 3600 }).frozen, 0);

  const result = freezeScheduledMatches(db, { nowSeconds: NOW });
  assert.equal(result.frozen, 1);

  const key = scheduledSubjectKey(leagueId, "bracket:R1M1");
  const frozen = getPrediction(db, "series", key, "team_ratings");
  assert.ok(frozen, "the prediction must exist before a single map is played");
  const features = JSON.parse(frozen.features_json);
  assert.equal(features.frozenBeforeStart, true);
  assert.ok(features.minutesBeforeStart > 0, "it must be recorded as ahead of the start");
  assert.ok(frozen.predicted_score, "a scoreline is published alongside the winner");
  assert.ok(Number(frozen.probability_a) > 0.5, "the stronger side must be favoured");

  // Running again must not write a second one.
  assert.equal(freezeScheduledMatches(db, { nowSeconds: NOW }).frozen, 0);

  // The series then happens and the prediction follows it, keeping its number.
  seedMap({ matchId: 950001, leagueId, seriesId: "9500", radiant: 501, dire: 502, radiantWin: true, startTime: startTime + 120 });
  seedMap({ matchId: 950002, leagueId, seriesId: "9500", radiant: 501, dire: 502, radiantWin: true, startTime: startTime + 3600 });
  rebuildSeries(db, leagueId);

  const linked = linkScheduledToSeries(db, { nowSeconds: startTime + 7200 });
  assert.equal(linked.linked, 1);
  assert.equal(getPrediction(db, "series", key, "team_ratings"), undefined, "it must no longer sit on the schedule key");

  const series = db.prepare("SELECT series_key FROM series WHERE league_id = ?").get(leagueId);
  const moved = getPrediction(db, "series", series.series_key, "team_ratings");
  assert.ok(moved, "the same prediction now belongs to the series that happened");
  assert.equal(moved.probability_a, frozen.probability_a, "its number must not change on the way");

  resolvePredictions(db);
  const scored = getPrediction(db, "series", series.series_key, "team_ratings");
  assert.equal(scored.outcome, 1);
  assert.equal(scored.actual_score, "2:0");
});

test("patch distance weights maps by how far the balance has moved", async () => {
  const { attachPatchWeights } = await import("../server/core/draft-model.mjs");
  const rows = [
    { patch: "7.39", startTime: 1000, win: 1 },
    { patch: "7.40", startTime: 2000, win: 1 },
    { patch: "7.41", startTime: 3000, win: 1 },
    { patch: "7.41", startTime: 3500, win: 0 },
  ];
  const info = attachPatchWeights(rows, { halfLifePatches: 1 });
  assert.equal(info.patches, 3);
  assert.equal(info.newest, "7.41");
  assert.equal(rows[2].patchWeight, 1, "the current patch is worth full weight");
  assert.equal(rows[3].patchWeight, 1);
  assert.ok(Math.abs(rows[1].patchWeight - 0.5) < 1e-9, "one patch back halves at a half-life of one");
  assert.ok(Math.abs(rows[0].patchWeight - 0.25) < 1e-9);

  // Patches are ordered by when they appear, not by parsing version strings:
  // the feed mixes "7.41e" with bare numeric ids.
  const mixed = [
    { patch: "60", startTime: 9000 },
    { patch: "7.41e", startTime: 8000 },
  ];
  attachPatchWeights(mixed, { halfLifePatches: 1 });
  assert.equal(mixed[0].patchWeight, 1, "the most recent patch wins whatever it is called");
  assert.ok(mixed[1].patchWeight < 1);

  // Zero means no decay at all, which has to stay available: on this data the
  // holdout prefers it, because losing sample size costs more than staleness.
  attachPatchWeights(rows, { halfLifePatches: 0 });
  for (const row of rows) assert.equal(row.patchWeight, 1);
});

test("a series played by a different five counts for less", async () => {
  const { attachRosterWeights, DEFAULT_OVERLAP_WEIGHTS } = await import("../server/core/rosters.mjs");

  const leagueId = 900040;
  upsertTournament(db, { leagueId, name: "Roster Cup", tier: "professional" });
  upsertTeam(db, { teamId: 601, name: "Keepers" });
  upsertTeam(db, { teamId: 602, name: "Rebuilders" });

  const roster = (accounts, isRadiant) => accounts.map((accountId) => ({ accountId, isRadiant }));
  const seedWithRoster = (matchId, startTime, radiantAccounts, direAccounts) => {
    upsertMap(db, {
      match_id: matchId, series_id: `r${matchId}`, series_type: 1,
      radiant_team_id: 601, dire_team_id: 602, radiant_win: true,
      start_time: startTime, duration: 2000,
    }, { leagueId });
    db.prepare("UPDATE maps SET players_json = ? WHERE match_id = ?")
      .run(JSON.stringify([...roster(radiantAccounts, true), ...roster(direAccounts, false)]), matchId);
  };

  const current = [1, 2, 3, 4, 5];
  const old = [1, 2, 91, 92, 93];
  const stable = [11, 12, 13, 14, 15];
  // Recent maps define the current lineup; the older one shares two players.
  seedWithRoster(970001, NOW - 2 * DAY, current, stable);
  seedWithRoster(970002, NOW - 3 * DAY, current, stable);
  seedWithRoster(970003, NOW - 60 * DAY, old, stable);
  rebuildSeries(db, leagueId);

  const series = db.prepare("SELECT series_key, start_time FROM series WHERE league_id = ? ORDER BY start_time").all(leagueId)
    .map((row) => ({
      seriesKey: row.series_key, targetLineup: "601", opponentLineup: "602",
      startTime: row.start_time, targetScore: 1, rosterWeight: 1,
    }));
  const info = attachRosterWeights(series, db, { nowSeconds: NOW });
  assert.ok(info.covered >= 3);

  const older = series[0];
  const recent = series.at(-1);
  assert.equal(recent.rosterWeight, 1, "a series played by the current five is full evidence");
  assert.ok(older.rosterWeight < recent.rosterWeight, "a lineup that shares two of five must count for less");
  assert.ok(older.rosterWeight <= DEFAULT_OVERLAP_WEIGHTS[2]);
  // Never zero: an organisation keeps its coaching and draft habits.
  assert.ok(older.rosterWeight > 0);
});

test("a double-elimination bracket's wiring is derived from its rounds", async () => {
  const { buildTopology, playBracket } = await import("../server/core/bracket-topology.mjs");
  const { bracketSeedOrder } = await import("../server/jobs/project-bracket.mjs");

  const section = (name, lane, slots) => ({ name, lane, matches: slots.map((slot) => ({ slot, bestOf: 3 })) });
  const bracket = {
    type: "8U4L2DSL1D",
    sections: [
      section("Upper Quarterfinals", "upper", ["R1M1", "R1M2", "R1M3", "R1M4"]),
      section("Lower Round 1", "lower", ["R1M5", "R1M6"]),
      section("Upper Semifinals", "upper", ["R2M1", "R2M2"]),
      section("Lower Quarterfinals", "lower", ["R2M3", "R2M4"]),
      section("Upper Final", "upper", ["R4M1"]),
      section("Lower Semifinal", "lower", ["R3M1"]),
      section("Lower Final", "lower", ["R4M2"]),
      section("Grand Final", "final", ["R5M1"]),
    ],
  };

  const topology = buildTopology(bracket);
  assert.ok(topology, "a standard double-elimination shape must be recognised");
  assert.equal(topology.seeds, 8);
  const bySlot = topology.bySlot;

  // The first upper round takes the qualifiers; its losers open the lower one.
  assert.deepEqual(bySlot.get("R1M1").sources.map((s) => s.from), ["seed", "seed"]);
  assert.deepEqual(bySlot.get("R1M5").sources, [{ from: "loser", slot: "R1M1" }, { from: "loser", slot: "R1M2" }]);
  // A lower drop round takes the previous lower winner and an upper loser.
  assert.deepEqual(bySlot.get("R2M3").sources, [{ from: "winner", slot: "R1M5" }, { from: "loser", slot: "R2M1" }]);
  // The lower final takes the upper final's loser; the grand final joins both.
  assert.deepEqual(bySlot.get("R4M2").sources, [{ from: "winner", slot: "R3M1" }, { from: "loser", slot: "R4M1" }]);
  assert.deepEqual(bySlot.get("R5M1").sources, [{ from: "winner", slot: "R4M1" }, { from: "winner", slot: "R4M2" }]);
  // Columns advance rightwards so the grand final is last.
  assert.equal(bySlot.get("R5M1").column, Math.max(...topology.nodes.map((n) => n.column)));

  // Seeding keeps the top two apart until the final.
  assert.deepEqual(bracketSeedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);

  // The stronger seed always winning must produce seed 1 as champion.
  const seeds = ["s1", "s8", "s4", "s5", "s2", "s7", "s3", "s6"];
  const rank = (team) => Number(team.slice(1));
  const played = playBracket(topology, seeds, (a, b) => (rank(a) <= rank(b) ? a : b));
  assert.equal(played.champion, "s1");
  assert.equal(played.winners.get("R4M1"), "s1", "the top seed reaches the upper final");
  assert.equal(played.winners.get("R4M2"), "s2", "the second seed comes back through the lower bracket");

  // A shape that is not double elimination is refused rather than mis-drawn.
  assert.equal(buildTopology({ sections: [section("Odd", "upper", ["A1", "A2", "A3"]), section("Next", "upper", ["B1", "B2"])] }), null);
  assert.equal(buildTopology(null), null);
});
