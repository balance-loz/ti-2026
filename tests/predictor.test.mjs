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

test("settings round-trip json and survive a missing key", () => {
  assert.equal(getJsonSetting(db, "nope", null), null);
  setJsonSetting(db, "cursor", { at: 5, done: false });
  assert.deepEqual(getJsonSetting(db, "cursor", null), { at: 5, done: false });
  setJsonSetting(db, "cursor", { at: 9, done: true });
  assert.deepEqual(getJsonSetting(db, "cursor", null), { at: 9, done: true });
});
