// Tests for the multi-tournament predictor core. Everything here runs against
// a throwaway database and never touches the network.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
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
  rebuildSeries, refreshTournamentAggregates, tournamentBySlug, isExcludedTournamentName,
  applyTournamentExclusions,
} = await import("../server/core/tournaments.mjs");
const { analyzeTournament, simulateTournament } = await import("../server/core/format.mjs");
const { freezePrediction, getPrediction, resolvePredictions, accuracySummary, freezeUpcomingSeries } = await import("../server/core/predictions.mjs");
const { ratingPairProbability, loadTrainingSeries } = await import("../server/core/ratings.mjs");
const { loadDraftRows } = await import("../server/core/draft-model.mjs");
const { normalizeLiveRow, livePollIntervalSeconds } = await import("../server/core/live.mjs");
const { explainSeries, explainDraft, heroContributions, teamLineup } = await import("../server/core/explain.mjs");
const { matchDetail } = await import("../server/core/detail.mjs");

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

test("streamer show tournaments are excluded from every model data pool", () => {
  for (const name of [
    "BETBOOM Streamers Battle Dota 15",
    "BetBoom Streamer Battle 8",
    "Стримерский батл",
  ]) assert.equal(isExcludedTournamentName(name), true, name);
  assert.equal(isExcludedTournamentName("Battle of the Champions"), false);

  const leagueId = 900000;
  upsertTournament(db, { leagueId, name: "BETBOOM Streamers Battle Dota 15", tier: "professional" });
  const tournament = db.prepare("SELECT tracked, slug FROM tournaments WHERE league_id = ?").get(leagueId);
  assert.equal(tournament.tracked, 0);
  assert.equal(tournamentBySlug(db, tournament.slug), undefined, "excluded tournaments must not have public pages");

  seedMap({ matchId: 9000001, leagueId, seriesId: "show-1", radiant: 901, dire: 902, radiantWin: 1, startTime: NOW - HOUR });
  seedMap({ matchId: 9000002, leagueId, seriesId: "show-1", radiant: 901, dire: 902, radiantWin: 1, startTime: NOW - 30 * 60 });
  db.prepare(`UPDATE maps SET radiant_picks_json='[1,2,3,4,5]', dire_picks_json='[6,7,8,9,10]'
              WHERE league_id=?`).run(leagueId);
  rebuildSeries(db, leagueId);

  assert.equal(loadTrainingSeries(db, { nowSeconds: NOW, windowDays: 30 }).some((row) => row.leagueId === leagueId), false);
  assert.equal(loadDraftRows(db, { nowSeconds: NOW, windowDays: 30 }).some((row) => row.matchId === 9000001), false);
  assert.deepEqual(freezePrediction(db, {
    scope: "series", subjectKey: "show-prediction", leagueId, modelKind: "team_ratings",
    modelId: "should-not-run", sideA: 901, sideB: 902, probabilityA: 0.8,
  }), { inserted: false, skipped: "tournament_excluded" });

  db.prepare("UPDATE tournaments SET tracked=1 WHERE league_id=?").run(leagueId);
  const reapplied = applyTournamentExclusions(db);
  assert.ok(reapplied.leagueIds.includes(leagueId));
  assert.equal(db.prepare("SELECT tracked FROM tournaments WHERE league_id=?").get(leagueId).tracked, 0);
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

test("late fallback predictions are resolved for audit but excluded from quality metrics", () => {
  freezePrediction(db, {
    scope: "series", subjectKey: "900001:s:5001", leagueId: 900001,
    modelKind: "late_fallback", modelId: "late-1", sideA: 11, sideB: 22,
    probabilityA: 0.99, bestOf: 3, evaluationEligible: false, timingClass: "in_play_fallback",
  });
  resolvePredictions(db);
  const stored = getPrediction(db, "series", "900001:s:5001", "late_fallback");
  assert.ok(stored.resolved_at, "late calls remain auditable");
  assert.equal(stored.evaluation_eligible, 0);
  assert.deepEqual(accuracySummary(db, { modelKind: "late_fallback" }), []);
  assert.equal(accuracySummary(db, { modelKind: "late_fallback", includeIneligible: true })[0].count, 1);
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

test("an announced match card fills the playoff slot at the same official time", async () => {
  const { storeSchedule } = await import("../server/jobs/sync-structure.mjs");
  const leagueId = 900031;
  upsertTournament(db, { leagueId, name: "Published Bracket Cup", tier: "professional" });
  const teams = [
    { team_id: 511, name: "Announced Alpha", tag: "AAA" },
    { team_id: 512, name: "Announced Beta", tag: "BBB" },
  ];
  teams.forEach((team) => upsertTeam(db, { teamId: team.team_id, name: team.name }));
  const startTime = new Date((NOW + HOUR) * 1000).toISOString();
  const parsed = {
    bracket: { sections: [{ name: "Upper Bracket Quarterfinals", lane: "upper", matches: [{
      slot: "R1M1", teamA: null, teamB: null, bestOf: 3, startTime, winner: null,
    }] }] },
    schedule: [{ teamA: "Announced Alpha", teamB: "Announced Beta", bestOf: 3, startTime }],
  };

  storeSchedule(db, leagueId, parsed, teams);
  const rows = db.prepare("SELECT * FROM scheduled_matches WHERE league_id=?").all(leagueId);
  assert.equal(rows.length, 1, "the match card must not become a duplicate group fixture");
  assert.equal(rows[0].slot, "R1M1");
  assert.equal(rows[0].lane, "upper");
  assert.equal(rows[0].team_a_id, 511);
  assert.equal(rows[0].team_b_id, 512);

  db.prepare("UPDATE scheduled_matches SET updated_at='unchanged-sentinel' WHERE id=?").run(rows[0].id);
  storeSchedule(db, leagueId, parsed, teams);
  assert.equal(db.prepare("SELECT updated_at FROM scheduled_matches WHERE id=?").get(rows[0].id).updated_at,
    "unchanged-sentinel", "an unchanged source must not invalidate the forecast cache");
});

test("a started series fills a still-TBD playoff slot before the bracket source catches up", async () => {
  const { inferStartedBracketSlots, linkScheduledToSeries } = await import("../server/jobs/freeze-scheduled.mjs");
  const leagueId = 900032;
  upsertTournament(db, { leagueId, name: "Live Bracket Cup", tier: "professional" });
  upsertTeam(db, { teamId: 521, name: "Live Alpha" });
  upsertTeam(db, { teamId: 522, name: "Live Beta" });
  db.prepare(`INSERT INTO scheduled_matches(league_id, source, external_key, slot, stage, lane,
      best_of, start_time, updated_at)
    VALUES(?, 'liquipedia', 'bracket:R1M1', 'R1M1', 'Upper Bracket Quarterfinals', 'upper', 3, ?, ?)`)
    .run(leagueId, NOW - 60, new Date().toISOString());
  seedMap({ matchId: 950101, leagueId, seriesId: "live-playoff", radiant: 521, dire: 522,
    radiantWin: true, startTime: NOW });
  rebuildSeries(db, leagueId);

  const inferred = inferStartedBracketSlots(db, { nowSeconds: NOW + 120 });
  assert.equal(inferred.inferred, 1);
  const filled = db.prepare("SELECT * FROM scheduled_matches WHERE league_id=? AND slot='R1M1'").get(leagueId);
  assert.equal(filled.team_a_id, 521);
  assert.equal(filled.team_b_id, 522);

  const linked = linkScheduledToSeries(db, { nowSeconds: NOW + 120 });
  assert.equal(linked.linked, 1);
  assert.ok(db.prepare("SELECT series_key FROM scheduled_matches WHERE id=?").get(filled.id).series_key);
  assert.equal(db.prepare("SELECT stage FROM series WHERE league_id=?").get(leagueId).stage, "playoff");
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

  const constrained = playBracket(topology, seeds, (a, b) => (rank(a) <= rank(b) ? a : b), {
    entrantsBySlot: new Map([["R1M1", ["s8", "s7"]]]),
  });
  assert.deepEqual(constrained.entrants.get("R1M1"), ["s8", "s7"], "an official pair replaces projected seeds");
  assert.equal(constrained.winners.get("R1M1"), "s7");

  // A shape that is not double elimination is refused rather than mis-drawn.
  assert.equal(buildTopology({ sections: [section("Odd", "upper", ["A1", "A2", "A3"]), section("Next", "upper", ["B1", "B2"])] }), null);
  assert.equal(buildTopology(null), null);
});

// --- explanations -----------------------------------------------------------

// Injected rather than trained: these tests are about how a forecast is taken
// apart, not about what the numbers happen to be today.
const RATINGS_FIXTURE = {
  modelId: "ratings-test",
  ratings: {
    "501": { rating: 1.2, series: 40, name: "Strong" },
    "502": { rating: 0.1, series: 40, name: "Weak" },
    "503": { rating: 0.9, series: 2, name: "Newcomer" },
  },
  validation: {
    holdoutDays: 45,
    coinflipLogLoss: 0.6931,
    champion: { family: "elo", logLoss: 0.63, accuracy: 0.65, samples: 200 },
    rosterWeighting: {
      applied: true,
      withoutRosters: { logLoss: 0.64, accuracy: 0.62 },
      withRosters: { logLoss: 0.63, accuracy: 0.65 },
    },
  },
};

const DRAFT_FIXTURE = {
  schemaVersion: 1,
  modelId: "draft-test",
  dataset: { matches: 1000 },
  inference: { heroScale: 1, roleScale: 0, radiantBias: 0.04, temperature: 1, dimensions: 0 },
  heroes: {
    "1": { coefficient: 0.5, games: 100 },
    "2": { coefficient: -0.3, games: 90 },
    "3": { coefficient: 0.1, games: 80 },
    "4": { coefficient: 0, games: 70 },
    "5": { coefficient: 0.2, games: 60 },
    "6": { coefficient: -0.1, games: 50 },
    "7": { coefficient: 0.05, games: 40 },
    "8": { coefficient: -0.2, games: 30 },
    "9": { coefficient: 0.3, games: 20 },
  },
  synergy: {},
  counters: {},
  validation: {
    radiantBaseRate: 0.51,
    holdout: { logLoss: 0.671, accuracy: 0.578, samples: 8000 },
    baselineLogLoss: 0.676,
    baselineDescription: "pre-match team strength only, no hero information",
    improvementNats: 0.0044,
    search: [
      { validation: { logLoss: 0.6768 }, features: { heroes: 126, synergies: 0, counters: 0 } },
      { validation: { logLoss: 0.6786 }, features: { heroes: 126, synergies: 112, counters: 233 } },
    ],
  },
};

test("an explanation adds up to exactly the prediction it explains", () => {
  const explained = explainSeries(db, { teamAId: 501, teamBId: 502, bestOf: 3, ratings: RATINGS_FIXTURE });
  // Every step is measured against the state it actually saw, so the deltas
  // reconstruct the final number rather than approximating it.
  const rebuilt = explained.factors.reduce((total, factor) => total + factor.delta, 0.5);
  assert.ok(Math.abs(rebuilt - explained.probabilityA) < 0.001, `${rebuilt} vs ${explained.probabilityA}`);
  // The stronger team is favoured, and the series format sharpens that.
  assert.ok(explained.probabilityA > 0.5);
  assert.equal(explained.factors[0].key, "rating");
  assert.equal(explained.factors.at(-1).key, "format");
});

test("thin evidence appears as its own visible correction, not a silent one", () => {
  const explained = explainSeries(db, { teamAId: 503, teamBId: 502, bestOf: 1, ratings: RATINGS_FIXTURE });
  const reliability = explained.factors.find((factor) => factor.key === "reliability");
  assert.ok(reliability, "a shrunk probability must say that it was shrunk");
  // Shrinking pulls toward even, so it must undo part of the rating gap.
  assert.ok(Math.sign(reliability.delta) !== Math.sign(explained.factors[0].delta));
  assert.ok(explained.notes.some((note) => note.key === "thin_evidence"));
});

test("a frozen prediction is explained with the ratings it was made with", () => {
  const explained = explainSeries(db, {
    teamAId: 501, teamBId: 502, bestOf: 3, ratings: RATINGS_FIXTURE,
    // What the model believed then: the sides were the other way round.
    snapshot: { ratingA: 0.1, ratingB: 1.2, seriesA: 40, seriesB: 40, modelId: "ratings-old" },
  });
  assert.equal(explained.basis, "frozen");
  assert.equal(explained.modelId, "ratings-old");
  assert.ok(explained.probabilityA < 0.5, "the frozen call favoured the other side");
  assert.ok(explained.notes.some((note) => note.key === "frozen_basis"));
  // Quality still describes the model that is published now.
  assert.equal(explained.quality.logLoss, 0.63);
});

test("context is reported beside the forecast, never counted as an influence", () => {
  const explained = explainSeries(db, { teamAId: 501, teamBId: 502, bestOf: 3, ratings: RATINGS_FIXTURE });
  const keys = explained.factors.map((factor) => factor.key);
  for (const absent of ["headToHead", "h2h", "roster", "form"]) {
    assert.ok(!keys.includes(absent), `${absent} is not an input and must not be drawn as one`);
  }
  assert.ok(explained.context.headToHead);
  assert.ok(Array.isArray(explained.context.formA));
  assert.ok(explained.notes.some((note) => note.key === "h2h_not_an_input"));
});

test("every pick carries its own signed contribution", () => {
  const rows = heroContributions(DRAFT_FIXTURE, [1, 3, 5, 7, 9], [2, 4, 6, 8]);
  const byHero = new Map(rows.map((row) => [row.heroId, row]));
  // A positive coefficient helps whoever picked it, which flips with the side.
  assert.ok(byHero.get(1).logit > 0);
  assert.ok(byHero.get(2).logit > 0, "a weak hero on Dire helps Radiant");
  assert.ok(byHero.get(6).logit > 0);
  assert.ok(byHero.get(9).logit > 0);
  // A hero the model never learned moves nothing rather than guessing.
  assert.equal(byHero.get(4).logit, 0);
  const unknown = heroContributions(DRAFT_FIXTURE, [999], []);
  assert.equal(unknown[0].known, false);
  assert.equal(unknown[0].logit, 0);
});

test("a draft explanation decomposes the map and states what the model lacks", () => {
  db.prepare("INSERT OR REPLACE INTO heroes(hero_id, name, localized_name, updated_at) VALUES (?,?,?,?)")
    .run(1, "npc_dota_hero_antimage", "Anti-Mage", new Date().toISOString());

  const explained = explainDraft(db, {
    radiantTeamId: 501, direTeamId: 502,
    radiantPicks: [1, 3, 5, 7, 9], direPicks: [2, 4, 6, 8, 10],
    ratings: RATINGS_FIXTURE, draftModel: DRAFT_FIXTURE,
  });
  assert.equal(explained.available, true);
  assert.equal(explained.heroes.length, 10);
  assert.equal(explained.heroes[0].name, "Anti-Mage", "the strongest pick leads and is named");

  // The chain starts at the rating prior, not at even odds.
  assert.equal(explained.factors[0].from, explained.priorProbabilityRadiant);
  const rebuilt = explained.factors.reduce((total, factor) => total + factor.delta, explained.priorProbabilityRadiant);
  assert.ok(Math.abs(rebuilt - explained.probabilityRadiant) < 0.001);

  // Synergies and counters were measured and rejected; that has to be said.
  const note = explained.notes.find((entry) => entry.key === "pairs_rejected");
  assert.ok(note);
  assert.match(note.text, /112/);
  assert.match(note.text, /0\.6786/);
});

test("an incomplete draft is declined rather than half-answered", () => {
  const explained = explainDraft(db, {
    radiantTeamId: 501, direTeamId: 502,
    radiantPicks: [1, 3], direPicks: [2],
    ratings: RATINGS_FIXTURE, draftModel: DRAFT_FIXTURE,
  });
  assert.equal(explained.available, false);
  assert.equal(explained.reason, "incomplete_picks");
  assert.equal(explained.probabilityRadiant, explained.priorProbabilityRadiant);
  assert.deepEqual(explained.heroes, []);
});

test("a lineup is read from the maps a team actually played", () => {
  upsertTeam(db, { teamId: 611, name: "Steady" });
  upsertTeam(db, { teamId: 612, name: "Opponents" });
  const players = (ids, radiant) => ids.map((account_id, index) => ({
    account_id, hero_id: index + 1, player_slot: radiant ? index : index + 128, name: `p${account_id}`,
  }));
  const five = [11, 12, 13, 14, 15];
  for (let index = 0; index < 6; index += 1) {
    // The newest map fields a stand-in; four of five is still the same team.
    const fielded = index === 0 ? [11, 12, 13, 14, 99] : five;
    upsertMap(db, {
      match_id: 900_100 + index,
      radiant_team_id: 611,
      dire_team_id: 612,
      radiant_win: true,
      start_time: NOW - index * DAY,
      duration: 2000,
      players: [...players(fielded, true), ...players([21, 22, 23, 24, 25], false)],
    }, { leagueId: 4242 });
  }

  const lineup = teamLineup(db, 611);
  assert.equal(lineup.players.length, 5);
  assert.deepEqual(lineup.players.map((player) => player.accountId).sort((a, b) => a - b), five);
  assert.equal(lineup.stableMaps, 6, "a single stand-in does not count as a new lineup");
});

// --- bracket geometry -------------------------------------------------------

const { layoutBracket, BRACKET_LAYOUT } = await import("../server/core/bracket-layout.mjs");
const { buildTopology: topologyOf } = await import("../server/core/bracket-topology.mjs");

/** The same standard double-elimination shape the topology test uses. */
function standardTopology() {
  const section = (name, lane, slots) => ({ name, lane, matches: slots.map((slot) => ({ slot, bestOf: 3 })) });
  return topologyOf({
    type: "8U4L2DSL1D",
    sections: [
      section("Upper Bracket Quarterfinals", "upper", ["R1M1", "R1M2", "R1M3", "R1M4"]),
      section("Lower Bracket Round 1", "lower", ["R1M5", "R1M6"]),
      section("Upper Bracket Semifinals", "upper", ["R2M1", "R2M2"]),
      section("Lower Bracket Quarterfinals", "lower", ["R2M3", "R2M4"]),
      section("Upper Bracket Final", "upper", ["R4M1"]),
      section("Lower Bracket Semifinal", "lower", ["R3M1"]),
      section("Lower Bracket Final", "lower", ["R4M2"]),
      section("Grand Final", "final", ["R5M1"]),
    ],
  });
}

test("a bracket is placed with every match level with the two that feed it", () => {
  const topology = standardTopology();
  const layout = layoutBracket(topology.nodes);
  assert.ok(layout);

  const box = new Map(layout.boxes.map((entry) => [entry.slot, entry]));
  const centre = (slot) => box.get(slot).y + box.get(slot).h / 2;

  // The first round is simply stacked, one match pitch apart.
  assert.equal(centre("R1M2") - centre("R1M1"), BRACKET_LAYOUT.boxHeight + BRACKET_LAYOUT.rowGap);
  // Every later round sits midway between its two feeders — that is what makes
  // the picture readable as a bracket rather than as columns.
  assert.equal(centre("R2M1"), (centre("R1M1") + centre("R1M2")) / 2);
  assert.equal(centre("R4M1"), (centre("R2M1") + centre("R2M2")) / 2);
  assert.equal(centre("R3M1"), (centre("R2M3") + centre("R2M4")) / 2);
  // A lower round that takes a loser from above has one same-lane feeder and
  // follows it, which is how a real lower bracket runs. Asserted against the
  // wiring rather than against named slots, because which match feeds which
  // depends on the order the organiser listed them in.
  let dropRounds = 0;
  for (const node of topology.nodes) {
    const sameLane = node.sources.filter((source) => source.from === "winner"
      && topology.bySlot.get(source.slot)?.lane === node.lane);
    if (node.lane !== "lower" || sameLane.length !== 1) continue;
    dropRounds += 1;
    assert.equal(centre(node.slot), centre(sameLane[0].slot), `${node.slot} should follow ${sameLane[0].slot}`);
  }
  assert.ok(dropRounds >= 2, "a double-elimination lower bracket has drop rounds");
  // The grand final belongs to neither lane and sits between the two finals.
  assert.equal(centre("R5M1"), (centre("R4M1") + centre("R4M2")) / 2);

  // The lanes never overlap, and the divider falls between them.
  const upperBottom = Math.max(...layout.boxes.filter((entry) => entry.lane === "upper").map((entry) => entry.y + entry.h));
  const lowerTop = Math.min(...layout.boxes.filter((entry) => entry.lane === "lower").map((entry) => entry.y));
  assert.ok(lowerTop >= upperBottom);
  assert.equal(layout.dividers.length, 1);
  assert.ok(layout.dividers[0] > upperBottom && layout.dividers[0] < lowerTop);

  // Nothing is drawn outside the canvas it declares.
  for (const entry of layout.boxes) {
    assert.ok(entry.x >= 0 && entry.x + entry.w <= layout.width, `${entry.slot} outside horizontally`);
    assert.ok(entry.y >= 0 && entry.y + entry.h <= layout.height, `${entry.slot} outside vertically`);
  }
});

test("only the winner's path is drawn, and it is drawn as an elbow", () => {
  const topology = standardTopology();
  const layout = layoutBracket(topology.nodes);
  const box = new Map(layout.boxes.map((entry) => [entry.slot, entry]));

  // A loser drop is real but is not a line: drawing it would put an edge on
  // nearly every match and turn the bracket into a mesh.
  assert.equal(layout.edges.filter((edge) => edge.to === "R1M5").length, 0);
  assert.equal(layout.edges.filter((edge) => edge.to === "R1M1").length, 0, "seeded matches have no incoming line");
  const winnerSources = topology.nodes
    .flatMap((node) => node.sources.filter((source) => source.from === "winner"));
  assert.equal(layout.edges.length, winnerSources.length);

  for (const edge of layout.edges) {
    const from = box.get(edge.from);
    const to = box.get(edge.to);
    assert.equal(edge.points.length, 4);
    assert.equal(edge.points[0][0], from.x + from.w, "leaves the right edge of its source");
    assert.equal(edge.points[3][0], to.x, "arrives at the left edge of its target");
    assert.equal(edge.points[1][0], edge.points[2][0], "the middle segment is vertical");
    // Anchored to the target, so an edge that skips a column runs straight at
    // its own height and turns only just before it arrives.
    assert.equal(edge.points[1][0], to.x - BRACKET_LAYOUT.columnGap / 2);
    assert.equal(edge.points[0][1], from.y + from.h / 2);
    assert.equal(edge.points[3][1], to.y + to.h / 2);
  }

  // The upper final reaches the grand final across a skipped column.
  const long = layout.edges.find((edge) => edge.from === "R4M1" && edge.to === "R5M1");
  assert.ok(long);
  assert.ok(box.get("R5M1").column - box.get("R4M1").column > 1);
});

test("an unusable bracket is declined rather than drawn wrong", () => {
  assert.equal(layoutBracket([]), null);
  assert.equal(layoutBracket(null), null);
  // A stored projection written before rows carried their wiring.
  const stripped = standardTopology().nodes.map((node) => {
    const copy = { ...node };
    delete copy.sources;
    return copy;
  });
  assert.equal(layoutBracket(stripped), null);
  // A lane the picture has no place for.
  assert.equal(layoutBracket([{ slot: "X", lane: "group", column: 0, sources: [] }]), null);
});

// --- the group table --------------------------------------------------------

const { groupTable, seriesStages } = await import("../server/core/group-table.mjs");
const { linkScheduledToSeries } = await import("../server/jobs/freeze-scheduled.mjs");

const GROUP_RATINGS = {
  modelId: "ratings-group-test",
  ratings: {
    "701": { rating: 1.4, series: 30, name: "Team 701" },
    "702": { rating: 0.2, series: 30, name: "Team 702" },
    "703": { rating: 0.8, series: 30, name: "Team 703" },
    "704": { rating: -0.4, series: 30, name: "Team 704" },
  },
  validation: {},
};

/** A 2:0 series between two teams, as two maps sharing one series id. */
function playSeries(leagueId, seriesId, winner, loser, startTime) {
  seedMap({ matchId: seriesId * 10 + 1, leagueId, seriesId: String(seriesId), radiant: winner, dire: loser, radiantWin: 1, startTime });
  seedMap({ matchId: seriesId * 10 + 2, leagueId, seriesId: String(seriesId), radiant: loser, dire: winner, radiantWin: 0, startTime: startTime + 1800 });
}

const addFixture = (leagueId, { key, lane = "group", round = null, a, b, startTime, seriesKey = null, slot = null }) =>
  db.prepare(`INSERT INTO scheduled_matches(league_id, source, external_key, slot, stage, lane, round,
      team_a_name, team_b_name, team_a_id, team_b_id, best_of, start_time, winner_slot, series_key, updated_at)
    VALUES(?, 'liquipedia', ?,?,?,?,?,?,?,?,?,3,?,NULL,?,?)`)
    .run(leagueId, key, slot, lane === "group" ? "Group Stage" : "Playoffs", lane, round,
      `Team ${a}`, `Team ${b}`, a, b, startTime, seriesKey, new Date().toISOString());

function seedSwissLeague(leagueId) {
  upsertTournament(db, { leagueId, name: `Swiss ${leagueId}`, tier: "professional" });
  for (const id of [701, 702, 703, 704]) upsertTeam(db, { teamId: id, name: `Team ${id}` });

  // Rounds one and two are played; round three is only scheduled.
  playSeries(leagueId, leagueId + 1, 701, 702, NOW - 5 * DAY);
  playSeries(leagueId, leagueId + 2, 703, 704, NOW - 5 * DAY + HOUR);
  playSeries(leagueId, leagueId + 3, 701, 703, NOW - 4 * DAY);
  playSeries(leagueId, leagueId + 4, 702, 704, NOW - 4 * DAY + HOUR);
  rebuildSeries(db, leagueId);

  const keyOf = (a, b) => db.prepare(`SELECT series_key FROM series WHERE league_id = ?
      AND ((team_a_id = ? AND team_b_id = ?) OR (team_a_id = ? AND team_b_id = ?))`)
    .get(leagueId, a, b, b, a)?.series_key ?? null;

  return { keyOf };
}

test("a Swiss table is built from the published rounds and links every played cell", () => {
  const leagueId = 900060;
  const { keyOf } = seedSwissLeague(leagueId);

  addFixture(leagueId, { key: "r1a", round: 1, a: 701, b: 702, startTime: NOW - 5 * DAY, seriesKey: keyOf(701, 702) });
  addFixture(leagueId, { key: "r1b", round: 1, a: 703, b: 704, startTime: NOW - 5 * DAY + HOUR, seriesKey: keyOf(703, 704) });
  addFixture(leagueId, { key: "r2a", round: 2, a: 701, b: 703, startTime: NOW - 4 * DAY, seriesKey: keyOf(701, 703) });
  addFixture(leagueId, { key: "r2b", round: 2, a: 702, b: 704, startTime: NOW - 4 * DAY + HOUR, seriesKey: keyOf(702, 704) });
  // Round three exists on the page but has not been played.
  addFixture(leagueId, { key: "r3a", round: 3, a: 701, b: 704, startTime: NOW + DAY });
  addFixture(leagueId, { key: "r3b", round: 3, a: 702, b: 703, startTime: NOW + DAY + HOUR });

  const table = groupTable(db, leagueId, { ratings: GROUP_RATINGS, playoffSlots: 2 });
  assert.equal(table.source, "published_rounds");
  assert.equal(table.rounds.length, 3);
  assert.deepEqual(table.rounds.map((round) => round.label), ["Раунд 1", "Раунд 2", "Раунд 3"]);
  assert.equal(table.rows.length, 4);

  // Two wins puts 701 first, and the table is ordered by what happened.
  const leader = table.rows[0];
  assert.equal(leader.team.id, "701");
  assert.equal(leader.seriesWins, 2);
  assert.equal(leader.mapWins, 4);
  assert.equal(leader.qualifying, true);
  assert.equal(table.rows.at(-1).qualifying, false);

  const first = leader.cells[0];
  assert.equal(first.result, "win");
  assert.equal(first.scoreFor, 2);
  assert.equal(first.scoreAgainst, 0);
  assert.equal(first.opponent.id, "702");
  assert.match(first.href, /^\/match\//, "a played cell opens its own explanation");

  // The loser of the same match sees it from its own side.
  const beaten = table.rows.find((row) => row.team.id === "702");
  assert.equal(beaten.cells[0].result, "loss");
  assert.equal(beaten.cells[0].scoreFor, 0);
  assert.equal(beaten.cells[0].seriesKey, first.seriesKey);

  // An unplayed round has no score but opens the pre-match explanation.
  const upcoming = leader.cells[2];
  assert.equal(upcoming.status, "scheduled");
  assert.equal(upcoming.scoreFor, null);
  assert.match(upcoming.href, /^\/match\/sched/, "a scheduled match opens both the series and model explanation");
});

test("missing Swiss pairings are projected from the current record and clearly marked", () => {
  const leagueId = 900066;
  const { keyOf } = seedSwissLeague(leagueId);
  db.prepare("UPDATE tournaments SET format_json=? WHERE league_id=?").run(JSON.stringify({
    stages: [{ name: "Swiss Stage", rules: ["After 2 series wins teams advance", "After 2 series losses teams are eliminated"] }],
  }), leagueId);
  addFixture(leagueId, { key: "q1", round: 1, a: 701, b: 702, startTime: NOW - 5 * DAY, seriesKey: keyOf(701, 702) });
  addFixture(leagueId, { key: "q2", round: 1, a: 703, b: 704, startTime: NOW - 5 * DAY + HOUR, seriesKey: keyOf(703, 704) });
  addFixture(leagueId, { key: "q3", round: 2, a: 701, b: 703, startTime: NOW - 4 * DAY, seriesKey: keyOf(701, 703) });
  addFixture(leagueId, { key: "q4", round: 2, a: 702, b: 704, startTime: NOW - 4 * DAY + HOUR, seriesKey: keyOf(702, 704) });
  // Only one of the two round-three pairings has been revealed.
  addFixture(leagueId, { key: "q5", round: 3, a: 701, b: 704, startTime: NOW + DAY });

  const table = groupTable(db, leagueId, { ratings: GROUP_RATINGS, playoffSlots: 2 });
  assert.equal(table.projectedPairings, 1);
  const projected = table.rows.find((row) => row.team.id === "702").cells[2];
  assert.equal(projected.opponent.id, "703");
  assert.equal(projected.projected, true);
  assert.equal(projected.probabilitySource, "projected");
  assert.match(projected.href, /^\/match\/projected/);
  const key = decodeURIComponent(projected.href.slice("/match/".length));
  const detail = matchDetail(db, key);
  assert.equal(detail.detailKind, "projected");
  assert.equal(detail.prediction.provisional, true);
  assert.equal(detail.maps.length, 0);
});

test("an official Bo3 at 1-1 is never rewritten as a draw", () => {
  const leagueId = 900067;
  upsertTournament(db, { leagueId, name: "Official Bo3", tier: "professional" });
  for (const id of [701, 702, 703, 704]) upsertTeam(db, { teamId: id, name: `Team ${id}` });
  addFixture(leagueId, { key: "bo3", round: 1, a: 701, b: 702, startTime: NOW - 3 * DAY });
  seedMap({ matchId: 9000671, leagueId, seriesId: "bo3", seriesType: null, radiant: 701, dire: 702, radiantWin: 1, startTime: NOW - 3 * DAY });
  seedMap({ matchId: 9000672, leagueId, seriesId: "bo3", seriesType: null, radiant: 701, dire: 702, radiantWin: 0, startTime: NOW - 3 * DAY + HOUR });
  // A later match makes the 1:1 series stale, reproducing the old bug.
  seedMap({ matchId: 9000673, leagueId, seriesId: "later", seriesType: 1, radiant: 703, dire: 704, radiantWin: 1, startTime: NOW });
  rebuildSeries(db, leagueId);
  const series = db.prepare("SELECT * FROM series WHERE league_id=? AND opendota_series_id='bo3'").get(leagueId);
  assert.equal(series.best_of, 3);
  assert.equal(series.is_draw, 0);
  assert.notEqual(series.status, "finished");
});

test("an unplayed cell carries the model's number, from that row's own side", () => {
  const leagueId = 900061;
  const { keyOf } = seedSwissLeague(leagueId);
  addFixture(leagueId, { key: "p1", round: 1, a: 701, b: 702, startTime: NOW - 5 * DAY, seriesKey: keyOf(701, 702) });
  addFixture(leagueId, { key: "p2", round: 2, a: 701, b: 704, startTime: NOW + DAY });

  const table = groupTable(db, leagueId, { ratings: GROUP_RATINGS, playoffSlots: 2 });
  const strong = table.rows.find((row) => row.team.id === "701").cells[1];
  const weak = table.rows.find((row) => row.team.id === "704").cells[1];
  assert.equal(strong.probabilitySource, "model");
  // The two sides of one match are two views of the same number.
  assert.ok(Math.abs(strong.probability + weak.probability - 1) < 1e-9);
  assert.ok(strong.probability > 0.5, "the higher-rated team is favoured");

  // A played cell never gets a fresh probability: that would be hindsight.
  const played = table.rows.find((row) => row.team.id === "701").cells[0];
  assert.equal(played.probabilitySource, null);
  assert.equal(played.probability, null);
});

test("without published rounds the table falls back to each team's own order and says so", () => {
  const leagueId = 900062;
  seedSwissLeague(leagueId);
  const table = groupTable(db, leagueId, { ratings: GROUP_RATINGS, playoffSlots: 2 });

  assert.equal(table.source, "match_ordinal");
  assert.deepEqual(table.rounds.map((round) => round.label), ["Матч 1", "Матч 2"]);
  // The caption has to admit the numbering is ours, not the organiser's.
  assert.match(table.caveat, /по порядку/i);
  for (const row of table.rows) {
    assert.equal(row.cells.filter(Boolean).length, 2, "every team played twice, so no gaps");
  }
});

test("a playoff series never appears in the group table", () => {
  const leagueId = 900063;
  const { keyOf } = seedSwissLeague(leagueId);
  // A bracket slot dated after the group stage, and a series played under it.
  playSeries(leagueId, leagueId + 5, 701, 703, NOW + 2 * DAY);
  rebuildSeries(db, leagueId);
  addFixture(leagueId, { key: "bracket:R1M1", lane: "upper", slot: "R1M1", a: 701, b: 703, startTime: NOW + 2 * DAY });

  const stages = seriesStages(db, leagueId);
  assert.equal(stages.source, "bracket_start_time");
  const playoffKey = db.prepare(`SELECT series_key FROM series WHERE league_id = ? ORDER BY start_time DESC LIMIT 1`)
    .get(leagueId).series_key;
  assert.equal(stages.byKey.get(playoffKey), "playoff");
  assert.equal(stages.byKey.get(keyOf(701, 702)), "group");

  const table = groupTable(db, leagueId, { ratings: GROUP_RATINGS });
  const keys = table.rows.flatMap((row) => row.cells.filter(Boolean).map((cell) => cell.seriesKey));
  assert.ok(!keys.includes(playoffKey), "a playoff result must not sit in the group table");
});

test("linking a scheduled match records which stage its series belonged to", () => {
  const leagueId = 900064;
  const { keyOf } = seedSwissLeague(leagueId);
  addFixture(leagueId, { key: "link-1", round: 1, a: 701, b: 702, startTime: NOW - 5 * DAY });

  linkScheduledToSeries(db, { nowSeconds: NOW + 10 * DAY });
  const key = keyOf(701, 702);
  assert.equal(db.prepare("SELECT stage FROM series WHERE series_key = ?").get(key).stage, "group");

  // A later resync of the results must not wipe what the schedule told us.
  rebuildSeries(db, leagueId);
  assert.equal(db.prepare("SELECT stage FROM series WHERE series_key = ?").get(key).stage, "group");
});

test("a rescheduled fixture is shown once, as the row that produced a result", () => {
  const leagueId = 900065;
  const { keyOf } = seedSwissLeague(leagueId);
  // The organiser's key carries the start time, so moving a match leaves the
  // old row behind. Both describe the same match and must collapse into one.
  addFixture(leagueId, { key: "moved-old", round: 1, a: 701, b: 702, startTime: NOW - 6 * DAY });
  addFixture(leagueId, { key: "moved-new", round: 1, a: 701, b: 702, startTime: NOW - 5 * DAY, seriesKey: keyOf(701, 702) });

  const table = groupTable(db, leagueId, { ratings: GROUP_RATINGS });
  const leader = table.rows.find((row) => row.team.id === "701");
  const firstRound = leader.cells.filter((cell) => cell && cell.opponent.id === "702");
  assert.equal(firstRound.length, 1);
  assert.equal(firstRound[0].seriesKey, keyOf(701, 702), "the row that reached a result is the one kept");
});

// --- strength: players and teams together -----------------------------------

const { trainRatings, invalidateRatingsCache, moderate } = await import("../server/core/ratings.mjs");
const { fitStrengthModel } = await import("../server/core/player-ratings.mjs");
const { bestOfProbability } = await import("../server/team-model.mjs");

/** A played map with a named five on each side. */
function seedMapWithPlayers({ matchId, leagueId, seriesId, radiant, dire, radiantWin, startTime, five, opposingFive }) {
  const side = (ids, isRadiant) => ids.map((accountId, index) => ({
    account_id: accountId, hero_id: index + 1, player_slot: isRadiant ? index : index + 128,
  }));
  upsertMap(db, {
    match_id: matchId,
    series_id: String(seriesId),
    series_type: 1,
    radiant_team_id: radiant,
    dire_team_id: dire,
    radiant_win: radiantWin,
    start_time: startTime,
    duration: 2000,
    players: [...side(five, true), ...side(opposingFive, false)],
  }, { leagueId });
}

/** A 2:0 series, two maps, one lineup a side. */
function seedSeries({ leagueId, seriesId, winner, loser, winnerFive, loserFive, startTime }) {
  seedMapWithPlayers({
    matchId: seriesId * 10 + 1, leagueId, seriesId, radiant: winner, dire: loser,
    radiantWin: 1, startTime, five: winnerFive, opposingFive: loserFive,
  });
  seedMapWithPlayers({
    matchId: seriesId * 10 + 2, leagueId, seriesId, radiant: winner, dire: loser,
    radiantWin: 1, startTime: startTime + 1800, five: winnerFive, opposingFive: loserFive,
  });
}

test("a thin team beating unknowns in a pub league does not out-rate an established one", () => {
  const junk = 900200;
  const pro = 900201;
  upsertTournament(db, { leagueId: junk, name: "Pub Bracket", tier: "excluded" });
  upsertTournament(db, { leagueId: pro, name: "Real Circuit", tier: "professional" });

  // The streak: one side wins everything it plays, against opponents whose five
  // appear nowhere else in the world.
  const streak = 8101;
  const streakFive = [81001, 81002, 81003, 81004, 81005];
  upsertTeam(db, { teamId: streak, name: "Streak" });
  let seriesId = 92000;
  let matchDay = 0;
  for (let round = 0; round < 12; round += 1) {
    const victim = 8110 + round;
    upsertTeam(db, { teamId: victim, name: `Victim ${round}` });
    seedSeries({
      leagueId: junk, seriesId: seriesId++, winner: streak, loser: victim,
      winnerFive: streakFive,
      loserFive: [82000 + round * 5, 82001 + round * 5, 82002 + round * 5, 82003 + round * 5, 82004 + round * 5],
      startTime: NOW - (60 - matchDay++) * DAY,
    });
  }

  // The circuit: six teams of settled rosters playing each other repeatedly, so
  // their ratings are anchored against one another rather than against nobody.
  const circuit = [8201, 8202, 8203, 8204, 8205, 8206];
  circuit.forEach((teamId, index) => upsertTeam(db, { teamId, name: `Circuit ${index}` }));
  const fiveFor = (teamId) => [1, 2, 3, 4, 5].map((slot) => teamId * 10 + slot);
  for (let pass = 0; pass < 16; pass += 1) {
    for (let left = 0; left < circuit.length; left += 1) {
      for (let right = left + 1; right < circuit.length; right += 1) {
        // The lower index is the stronger team, and it wins most of the time.
        const upsetPass = pass % 4 === 3;
        const winner = upsetPass ? circuit[right] : circuit[left];
        const loser = upsetPass ? circuit[left] : circuit[right];
        seedSeries({
          leagueId: pro, seriesId: seriesId++, winner, loser,
          winnerFive: fiveFor(winner), loserFive: fiveFor(loser),
          startTime: NOW - (600 - matchDay++) * HOUR,
        });
      }
    }
  }

  // One bridge, so the two clusters are on the same scale at all.
  seedSeries({
    leagueId: pro, seriesId: seriesId++, winner: circuit[0], loser: streak,
    winnerFive: fiveFor(circuit[0]), loserFive: streakFive,
    startTime: NOW - 2 * DAY,
  });

  rebuildSeries(db, junk);
  rebuildSeries(db, pro);

  const result = trainRatings(db, { nowSeconds: NOW, forcePromotion: true });
  assert.equal(result.ok, true, result.reason);
  invalidateRatingsCache();

  const artifact = JSON.parse(readFileSync(process.env.TEAM_RATINGS_MODEL, "utf8"));
  assert.equal(artifact.schemaVersion, 2);
  const streakRating = artifact.ratings[String(streak)];
  const establishedRating = artifact.ratings[String(circuit[0])];
  assert.ok(streakRating, "the streak team is rated at all");
  assert.ok(establishedRating, "the established team is rated");

  // The actual failure: twelve wins over nobody outranking a real record.
  assert.ok(streakRating.rating < establishedRating.rating,
    `streak ${streakRating.rating} must not out-rate established ${establishedRating.rating}`);
  // And less evidence stands behind it, in the units the model uses.
  assert.ok(streakRating.evidence < establishedRating.evidence);

  const pair = ratingPairProbability(artifact, streak, circuit[0]);
  assert.ok(pair.mapProbabilityA < 0.5, "the streak team is not the favourite");
  // The product failure was publishing a near-certainty. A best-of only sharpens
  // whatever the map probability says, so that is where it has to be caught.
  assert.ok(bestOfProbability(pair.mapProbabilityA, 3) < 0.6);

  // The fix must not be "flatten everything": two well-connected teams whose
  // records genuinely differ still have to separate.
  const known = ratingPairProbability(artifact, circuit[0], circuit[5]);
  assert.ok(known.mapProbabilityA > 0.55, `well-observed teams stay separated, got ${known.mapProbabilityA}`);
  assert.equal(known.shrinkMethod, "moderated");
});

test("a player carries his rating between teams", () => {
  const rows = [];
  const five = (base) => [base, base + 1, base + 2, base + 3, base + 4];
  // One player, 90001, is on the winning side of every series, under two
  // different team ids. Nothing else is shared between the two halves.
  for (let index = 0; index < 60; index += 1) {
    const early = index < 30;
    rows.push({
      seriesKey: `carry-${index}`,
      targetLineup: early ? "9301" : "9302",
      opponentLineup: `94${String(index % 6).padStart(2, "0")}`,
      targetScore: 1,
      startTime: NOW - (200 - index) * DAY,
      wins: 2, losses: 0, bestOf: 3, isDraw: false,
      seriesInformation: 1,
      tierWeight: 1,
      playerTierWeight: 1,
      lineupA: early ? [90001, 90002, 90003, 90004, 90005] : [90001, 90011, 90012, 90013, 90014],
      lineupB: five(95000 + index * 5),
    });
  }

  const fit = fitStrengthModel(rows, { nowSeconds: NOW });
  // The one constant across both halves ends up rated above his team-mates.
  assert.ok(fit.playerRating(90001) > fit.playerRating(90002));
  assert.ok(fit.playerRating(90001) > fit.playerRating(90011));
  // And the brand-new team id is not an unknown quantity, because four of its
  // five and all of its history are already in the model.
  assert.ok(fit.strength("9302", [90001, 90011, 90012, 90013, 90014]) > 0);
});

test("the tier discount moves the organisation but leaves the players alone", () => {
  const build = (tierWeight) => Array.from({ length: 40 }, (unused, index) => ({
    seriesKey: `tier-${index}`,
    targetLineup: "9401",
    opponentLineup: `95${String(index % 5).padStart(2, "0")}`,
    targetScore: 1,
    startTime: NOW - (100 - index) * DAY,
    wins: 2, losses: 0, bestOf: 3, isDraw: false,
    seriesInformation: 1,
    tierWeight,
    // The user's requirement, made mechanical: a low-tier result barely moves
    // the badge but still says who the players are.
    playerTierWeight: 1,
    lineupA: [96001, 96002, 96003, 96004, 96005],
    lineupB: [97000 + index * 5, 97001 + index * 5, 97002 + index * 5, 97003 + index * 5, 97004 + index * 5],
  }));

  const full = fitStrengthModel(build(1), { nowSeconds: NOW });
  const discounted = fitStrengthModel(build(0.08), { nowSeconds: NOW });

  assert.ok(Math.abs(discounted.teamRating("9401")) < Math.abs(full.teamRating("9401")) * 0.5,
    "the organisation term shrinks with the tier weight");
  const player = (fit) => fit.playerRating(96001);
  assert.ok(player(discounted) > player(full) * 0.8,
    "the player keeps his rating: that is the whole reason the data is kept");
});

test("a rating gap is damped by how little stands behind it", () => {
  // Same gap, less evidence, closer to even — monotonically.
  const wide = moderate(2, 500, 500, 4);
  const middling = moderate(2, 20, 20, 4);
  const thin = moderate(2, 0.5, 0.5, 4);
  assert.ok(wide > middling && middling > thin);
  assert.ok(thin > 0.5, "damped toward even, never past it");
  // Symmetric, and an even matchup stays even whatever the evidence.
  assert.ok(Math.abs(moderate(2, 10, 3, 4) + moderate(-2, 10, 3, 4) - 1) < 1e-12);
  assert.equal(moderate(0, 0, 0, 4), 0.5);
  // With no evidence term at all it is the plain logistic.
  assert.ok(Math.abs(moderate(1, 1e9, 1e9, 4) - 1 / (1 + Math.exp(-1))) < 1e-6);
});
