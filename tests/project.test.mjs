import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { completedSeriesFromMaps } from "../server/live-series.mjs";
import { liveDraftsFromOpenDota } from "../server/live-drafts.mjs";
import { scheduledSeriesFromCybersportHtml } from "../server/schedule-source.mjs";
import { buildForecastSource, ROUND_ONE, runForecast, SWISS_GROUPS, SWISS_GROUP_BY_TEAM, swissBucketKey, topGroupScenarios } from "../server/forecast-engine.mjs";
import { combineDraftSignals } from "../server/draft-combiner.mjs";
import { predictTemporalDraft } from "../server/draft-inference.mjs";
import { bestOfProbability, convertSeriesProbability } from "../server/team-model.mjs";
import { assessPredictionConfidence } from "../server/prediction-confidence.mjs";
import { externalFeatureDecision, pearsonCorrelation } from "../server/external-feature-gate.mjs";
import { normalizeDatdotaPayload } from "../scripts/sync-datdota-source.mjs";
import { predictionDecision, sharpenProbability } from "../server/prediction-decision.mjs";
import { latestOfficialBaseline, latestSnapshotForHistoryRow, visibleSnapshotHistory } from "../server/snapshot-history.mjs";
import { seriesEvidenceWeight, updateProbabilitiesWithLiveSeries } from "../server/live-team-update.mjs";
import { buildSnapshotCalculationTrace } from "../server/forecast-diagnostics.mjs";
import { assessLiveMap, estimateLiveMap } from "../server/live-map-prediction.mjs";
import { combinedSeriesForecast, exactSeriesScores, orientedProbability } from "../server/combined-forecast.mjs";
import { predictionTimeliness, projectPlayoffBracket } from "../server/projected-bracket.mjs";
import { selectProductionVariant } from "../server/model-gate.mjs";

test("combined series forecast exposes exact map scores without leaking live state into future maps", () => {
  const even = exactSeriesScores({ bestOf: 3, baseMapProbabilityA: .5 });
  assert.deepEqual(Object.fromEntries(even.map((row) => [row.score, row.probability])), { "0:2": .25, "1:2": .25, "2:0": .25, "2:1": .25 });
  const live = combinedSeriesForecast({ teamA: "spirit", teamB: "liquid", seriesProbabilityA: .5, winsA: 1, winsB: 0, currentMapProbabilityA: .8 });
  assert.ok(Math.abs(live.probabilityA - .9) < 1e-12);
  const liveScores = Object.fromEntries(live.exactScores.map((row) => [row.score, row.probability]));
  assert.ok(Math.abs(liveScores["2:0"] - .8) < 1e-12);
  assert.ok(Math.abs(liveScores["2:1"] - .1) < 1e-12);
  assert.ok(Math.abs(liveScores["1:2"] - .1) < 1e-12);
  assert.equal(orientedProbability("liquid", "spirit", { "liquid|spirit": 62 }), .62);
  assert.equal(orientedProbability("spirit", "liquid", { "liquid|spirit": 62 }), .38);
});

test("decision ledger separates actionable predictions from late revisions", () => {
  assert.deepEqual(predictionTimeliness("2026-08-14T09:00:00Z", "2026-08-14T10:00:00Z", 15), { status: "actionable", leadMinutes: 60, eligible: true });
  assert.deepEqual(predictionTimeliness("2026-08-14T09:55:00Z", "2026-08-14T10:00:00Z", 15), { status: "late", leadMinutes: 5, eligible: false });
  assert.equal(predictionTimeliness("2026-08-14T10:01:00Z", "2026-08-14T10:00:00Z", 0).status, "after_start");
});

test("projected playoff bracket propagates actual winners and keeps frozen prediction grading", () => {
  const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const probabilities = Object.fromEntries(ids.flatMap((a, index) => ids.slice(index + 1).map((b) => [`${a}|${b}`, a === "a" ? 80 : 60])));
  const simulationResult = { scenarios: [{ direct40: ["a"], direct41: ["b", "c"], via: ["d", "e", "f", "g", "h"] }] };
  const matches = [{ id: 1, stage: "playoff", round: 1, team_a: "a", team_b: "h", winner: "h", score_a: 1, score_b: 2, predicted_probability: 80 }];
  const bracket = projectPlayoffBracket({ simulationResult, probabilities, matches });
  const opening = bracket.nodes.find((node) => node.label === "UB QF 1");
  assert.equal(opening.predictedWinner, "a");
  assert.equal(opening.actualWinner, "h");
  assert.equal(opening.winner, "h");
  assert.equal(opening.predictionCorrect, false);
  assert.ok(bracket.nodes.some((node) => node.column > 1 && [node.a, node.b].includes("h")));
});

test("production gate keeps adaptive forecasts in shadow when proper scores get worse", () => {
  const staticScore = { count: 24, correct: 18, brier: 0.21748, logLoss: 0.62717 };
  const worseAdaptive = { count: 24, correct: 18, brier: 0.24349, logLoss: 0.68657 };
  const betterAdaptive = { count: 24, correct: 19, brier: 0.201, logLoss: 0.59 };
  assert.deepEqual(selectProductionVariant(staticScore, worseAdaptive), { selected: "static", reason: "adaptive_failed_production_gate" });
  assert.deepEqual(selectProductionVariant(staticScore, betterAdaptive), { selected: "adaptive", reason: "adaptive_improves_accuracy_and_proper_scores" });
});

test("combined page and API persist map truth and explain the no-double-count policy", async () => {
  const [api, page, checkpoint, modelGate] = await Promise.all([
    readFile("server/api.mjs", "utf8"), readFile("app/combined/page.tsx", "utf8"), readFile("scripts/checkpoint-production.mjs", "utf8"), readFile("server/model-gate.mjs", "utf8"),
  ]);
  assert.match(api, /CREATE TABLE IF NOT EXISTS tournament_maps/);
  assert.match(api, /CREATE TABLE IF NOT EXISTS bet_locks/);
  assert.match(api, /UNIQUE\(scope,subject_id\)/);
  assert.match(api, /bet_already_locked/);
  assert.match(api, /\/api\/combined/);
  assert.match(api, /\/api\/admin\/bet-locks/);
  assert.match(api, /hydrateTournamentMapDetails/);
  assert.match(api, /decisionHistory/);
  assert.match(page, /Я поставил по рекомендации/);
  assert.match(page, /СТАВКА ЗАФИКСИРОВАНА/);
  assert.match(page, /Таблица по матчам/);
  assert.match(page, /MAIN \/ СТАВКА/);
  assert.match(page, /buildMatchStandings/);
  assert.match(page, /function seriesPresentation/);
  assert.match(page, /const source = betLock \? "bet" : hasHistorical \? "historical" : "main"/);
  assert.match(page, /row\.decision\.historicalProbabilityA/);
  assert.match(page, /ИСТОРИЧЕСКИЙ SNAPSHOT/);
  assert.match(page, /snapshotId/);
  assert.match(api, /baselineProbabilities/);
  assert.match(api, /url\.searchParams\.get\("run"\)/);
  assert.match(api, /snapshotDecisionEvaluation/);
  assert.match(modelGate, /adaptive_failed_production_gate/);
  assert.match(page, /MAIN = \{comparison\.selected\.toUpperCase\(\)\}/);
  assert.match(page, /const teamProbability = standing\.teamId === row\.match\.team_a/);
  assert.match(page, /expandedMatches/);
  assert.match(page, /fusion-round-match/);
  assert.match(page, /UPPER_PLACEMENT/);
  assert.match(page, /LOWER_PLACEMENT/);
  assert.match(page, /Точный счёт/);
  assert.match(page, /Нет draft-прогноза/);
  assert.match(checkpoint, /Checkpoint refused/);
  assert.match(checkpoint, /backup\(source/);
});

test("draft decides a matchup between equally strong teams", () => {
  const betterDraft = combineDraftSignals(0.5, [0.25]);
  const worseDraft = combineDraftSignals(0.5, [-0.25]);
  assert.ok(betterDraft.probability >= 0.62);
  assert.ok(worseDraft.probability <= 0.38);
  assert.ok(betterDraft.draftSignalWeight > betterDraft.teamPriorWeight * 4);
});

test("a clearly stronger team survives a slightly worse draft", () => {
  const closeMatchup = combineDraftSignals(0.5, [-0.12]);
  const clearFavorite = combineDraftSignals(0.8, [-0.12]);
  assert.ok(closeMatchup.probability < 0.5);
  assert.ok(clearFavorite.probability > 0.7);
  assert.ok(clearFavorite.teamPriorWeight > closeMatchup.teamPriorWeight);
  assert.ok(clearFavorite.draftSignalWeight < closeMatchup.draftSignalWeight);
});

test("temporal draft inference exposes hero, synergy and counter components", () => {
  const model = {
    schemaVersion: 1,
    modelId: "fixture",
    dataset: { matches: 100, patches: 4, currentPatchId: 60 },
    inference: { heroScale: 1, roleScale: 1, synergyScale: 1, counterScale: 1, temperature: 1, radiantBias: 0.1 },
    heroes: { 1: { coefficient: 0.3 }, 2: { coefficient: -0.2 } },
    synergy: {},
    counters: { "1>2": { coefficient: 0.4 }, "2>1": { coefficient: -0.1 } },
  };
  const prediction = predictTemporalDraft(model, { picksA: [1], picksB: [2], radiant: "a" });
  assert.ok(prediction.probabilityA > 0.7);
  assert.equal(prediction.components.heroes, 0.5);
  assert.equal(prediction.components.counters, 0.5);
  assert.equal(prediction.evidence.trainingMatches, 100);
  assert.throws(() => predictTemporalDraft(model, { picksA: [1], picksB: [1] }), /invalid_picks/);
});

test("production inference combines calibrated linear and factorization members", () => {
  const model = {
    schemaVersion: 1, modelId: "ensemble-fixture", dataset: { matches: 200, patches: 5, currentPatchId: 60 },
    ensemble: { neutralWeight: 0.2, members: [
      { name: "linear", weight: 0.5, temperature: 1, model: { type: "linear", inference: { heroScale: 1 }, heroes: { 1: { coefficient: 0.4 }, 2: { coefficient: -0.2 } } } },
      { name: "fm", weight: 0.3, temperature: 1, model: { type: "fm", inference: { heroScale: 0, roleScale: 0, dimensions: 2 }, heroes: { 1: { coefficient: 0, embedding: [0.3, 0.1] }, 2: { coefficient: 0, embedding: [-0.2, 0.2] } } } },
    ] },
  };
  const prediction = predictTemporalDraft(model, { picksA: [1], picksB: [2], radiant: "a" });
  assert.ok(prediction.probabilityA > 0.55);
  assert.ok(prediction.components.heroes > 0);
  assert.ok(Number.isFinite(prediction.components.synergy));
  assert.equal(prediction.evidence.patches, 5);
});

test("factorization draft signal is invariant to Radiant side assignment", () => {
  const model = {
    schemaVersion: 1, modelId: "fm-side-invariant", dataset: { matches: 20, patches: 2 },
    ensemble: { neutralWeight: 0, members: [{ name: "fm", weight: 1, temperature: 1, model: {
      type: "fm", inference: { heroScale: 0, roleScale: 0, dimensions: 2 },
      heroes: {
        1: { coefficient: 0, embedding: [.4, -.1] }, 2: { coefficient: 0, embedding: [.2, .3] },
        3: { coefficient: 0, embedding: [-.3, .2] }, 4: { coefficient: 0, embedding: [.1, -.4] },
      },
    } }] },
  };
  const radiantA = predictTemporalDraft(model, { picksA: [1, 2], picksB: [3, 4], radiant: "a" });
  const radiantB = predictTemporalDraft(model, { picksA: [1, 2], picksB: [3, 4], radiant: "b" });
  assert.ok(Math.abs(radiantA.probabilityA - radiantB.probabilityA) < 1e-12);
});

test("map probabilities convert separately to BO3 and BO5", () => {
  assert.ok(bestOfProbability(.6, 5) > bestOfProbability(.6, 3));
  assert.ok(Math.abs(convertSeriesProbability(bestOfProbability(.6, 3), 3, 5) - bestOfProbability(.6, 5)) < 1e-10);
  assert.equal(bestOfProbability(.5, 3), .5);
  assert.equal(bestOfProbability(.5, 5), .5);
});

test("online TI layer values 2-0 above 2-1 and propagates opponent strength", () => {
  const base = { "a|b": 50, "a|c": 50, "a|d": 50, "b|c": 50, "b|d": 50, "c|d": 50 };
  const close = { id: 1, stage: "swiss", round: 1, team_a: "a", team_b: "b", winner: "a", score_a: 2, score_b: 1 };
  const sweep = { ...close, score_b: 0 };
  assert.equal(seriesEvidenceWeight(close), .72);
  assert.equal(seriesEvidenceWeight(sweep), 1);
  const closeUpdate = updateProbabilitiesWithLiveSeries(base, [close], { liveGlobal: .3 });
  const sweepUpdate = updateProbabilitiesWithLiveSeries(base, [sweep], { liveGlobal: .3 });
  assert.ok(sweepUpdate["a|d"] > closeUpdate["a|d"]);
  const network = updateProbabilitiesWithLiveSeries(base, [sweep, { id: 2, stage: "swiss", round: 2, team_a: "b", team_b: "c", winner: "b", score_a: 2, score_b: 0 }], { liveGlobal: .3 });
  assert.ok(network["a|c"] > 50);
  assert.ok(network["a|c"] > sweepUpdate["a|c"]);
  assert.ok(network["c|d"] < 50);
});

test("current TI results have one shared update path and appear in team history", async () => {
  const page = await readFile("app/page.tsx", "utf8");
  const engine = await readFile("server/forecast-engine.mjs", "utf8");
  const stats = JSON.parse(await readFile("public/team-stats.json", "utf8"));
  assert.equal(stats.methodology.liveLeagueExcludedFromBaseline, 19719);
  assert.match(page, /updateProbabilitiesWithLiveSeries\(source, matches/);
  assert.match(engine, /updateProbabilitiesWithLiveSeries\(base, matches/);
  assert.match(page, /TI 2026 · ONLINE-СЛОЙ/);
  assert.match(page, /в baseline не дублируются/);
  assert.doesNotMatch(engine, /strength\[match\.team_a\].*surprise/);
});

test("saved forecast diagnostics freeze coefficients, pair decomposition and live-series influence", () => {
  const stats = {
    generatedAt: "2026-08-10T00:00:00.000Z",
    periodStart: "2025-08-10T00:00:00.000Z",
    totals: { uniqueAcceptedGames: 500 },
    methodology: { recencyHalfLifeDays: 45, seriesInformation: { multiMapBase: .72, decisiveBonus: .28 } },
    tournamentCalibration: { selected: { liveGlobal: .3 } },
    pairwise: { "aurora|gamerlegion": { probabilityA: 61, directEffectiveGames: 2, modelEffectiveGames: 18, source: "head_to_head_and_indirect", confidence: "medium", uncertainty: .2, featureContributions: { commonOpponentsPp: 7, headToHeadPp: 3, rosterPp: 1 } } },
  };
  const matches = [{ id: 7, stage: "swiss", round: 1, team_a: "aurora", team_b: "gamerlegion", winner: "aurora", score_a: 2, score_b: 0, created_at: "2026-08-13T00:00:00.000Z", updated_at: "2026-08-13T01:00:00.000Z" }];
  const probabilities = buildForecastSource({ answers: {}, stats, matches, mode: "stats", opinionWeight: 0 });
  const trace = buildSnapshotCalculationTrace({ snapshotId: 12, createdAt: "2026-08-13T01:01:00.000Z", trigger: "manual_run", config: { forecastMode: "stats", opinionWeight: 0, iterations: 1000 }, answers: {}, probabilities, result: { iterations: 1000, seed: 42 }, stats, matches });
  assert.equal(trace.exactAtSave, true);
  assert.equal(trace.model.methodology.seriesInformation.decisiveBonus, .28);
  assert.equal(trace.pairs[0].probabilities.statisticalA, 61);
  assert.equal(trace.pairs[0].statisticalFeatures.headToHeadPp, 3);
  assert.equal(trace.pairs[0].liveSeriesMarginal[0].evidenceWeight, 1);
  assert.ok(Math.abs(trace.pairs[0].probabilities.traceResidualPp) < 1e-8);
});

test("snapshot history offers a detailed diagnostic export endpoint", async () => {
  const [page, api] = await Promise.all([readFile("app/page.tsx", "utf8"), readFile("server/api.mjs", "utf8")]);
  assert.match(page, /\/api\/snapshots\/\$\{snapshot\.id\}\/export/);
  assert.match(page, /snapshot-download-button/);
  assert.match(api, /ti2026\.forecast-diagnostic-export/);
  assert.match(api, /diagnostics_json/);
  assert.match(api, /buildSnapshotCalculationTrace/);
});

test("temporal artifact is compact and gated by future-patch evaluation", async () => {
  const raw = await readFile("public/draft-temporal-model.json", "utf8");
  const model = JSON.parse(raw);
  assert.equal(model.schemaVersion, 1);
  assert.equal(model.modelFamily, "walk-forward-draft-ensemble-v1");
  assert.ok(model.dataset.matches >= 1000);
  assert.ok(model.dataset.patches >= 5);
  assert.equal(model.arena.leaderboard.length, 9);
  assert.ok(model.ensemble.members.length >= 1 && model.ensemble.members.length <= 4);
  assert.equal(model.backtest.validatedObject, "fixed four-member production stack");
  assert.equal(model.deployment.incrementalToActiveValidated, false);
  assert.ok(["candidate", "shadow", "insufficient_data"].includes(model.deployment.status));
  assert.ok(Number.isFinite(model.backtest.aggregate.model.logLoss));
  assert.ok(Number.isFinite(model.backtest.aggregate.neutral.logLoss));
  assert.equal(model.backtest.aggregate.seriesClusterBootstrap.cluster, "series_id");
  assert.ok(Number.isFinite(model.backtest.aggregate.seriesClusterBootstrap.upper95));
  assert.ok(Buffer.byteLength(raw) < 1_000_000);
  const heroIds = Object.keys(model.ensemble.members[0].model.heroes).slice(0, 10).map(Number);
  const sideA = predictTemporalDraft(model, { picksA: heroIds.slice(0, 5), picksB: heroIds.slice(5, 10), radiant: "a" });
  const sideB = predictTemporalDraft(model, { picksA: heroIds.slice(0, 5), picksB: heroIds.slice(5, 10), radiant: "b" });
  assert.ok(Math.abs(sideA.probabilityA - sideB.probabilityA) < 1e-12);
  if (model.backtest.aggregate.logLossDelta >= 0) assert.equal(model.deployment.recommendedWeight, 0);
});

test("two-year patch research uses exact versions and honest patch-note ablation", async () => {
  const [coverage, transition, artifact] = await Promise.all([
    readFile("work/draft-coverage.json", "utf8").then(JSON.parse),
    readFile("work/patch-transition-backtest.json", "utf8").then(JSON.parse),
    readFile("public/patch-transition-model.json", "utf8").then(JSON.parse),
  ]);
  assert.equal(coverage.window.years, 2);
  assert.ok(coverage.totals.maps >= 50_000);
  assert.equal(coverage.totals.viableCompleteVersions, coverage.totals.completeVersions);
  assert.ok(transition.dataset.exactVersions >= 20);
  assert.ok(transition.dataset.transitions >= 19);
  assert.ok(transition.metrics.all.ensemble.weightedRmse < transition.metrics.all.baseline.weightedRmse);
  assert.equal(artifact.validation.comparedWithCarryAndNoNotesAblation, true);
  assert.equal(artifact.validation.targetOutcomesExcludedFromArtifact, true);
  assert.equal(artifact.validation.teamOpponentAdjustedTarget, true);
  assert.equal(artifact.pairForecastRule.status, "disabled_until_direct_residual_transition_is_trained");
  assert.ok(Object.values(artifact.heroForecasts).every((row) => !("actualStrength" in row) && !("currentGames" in row)));
  if (transition.metrics.all.ensemble.weightedRmse >= transition.metrics.all.noNotes.weightedRmse) {
    assert.equal(artifact.deploymentStatus, "experimental");
    assert.equal(artifact.validation.notesAddValue, false);
  }
});

test("active draft candidate beats a separately fitted team-plus-side frozen holdout", async () => {
  const report = JSON.parse(await readFile("work/active-draft-walkforward.json", "utf8"));
  const teamModel = JSON.parse(await readFile("public/team-model.json", "utf8"));
  assert.equal(report.combiner.version, 3);
  assert.ok(report.dataset.frozenHoldoutMaps >= 10_000);
  assert.ok(report.metrics.frozenHoldout.model.logLoss < report.metrics.frozenHoldout.teamSide.logLoss);
  assert.ok(report.metrics.frozenHoldout.model.brier < report.metrics.frozenHoldout.teamSide.brier);
  assert.ok(report.bootstrap.frozenHoldoutVersusTeamSide.upper95 < 0);
  assert.equal(report.deployment.frozenHoldoutGatePassed, true);
  assert.equal(report.draftPriority.incrementalGatePassed, report.bootstrap.draftPriorityIncremental.upper95 < 0 && report.metrics.frozenHoldout.draftPriorityLogLossDelta < 0 && report.metrics.frozenHoldout.model.brier < report.metrics.frozenHoldout.withoutDraftPriority.brier);
  assert.equal(report.combiner.weights.draftPriority, report.draftPriority.incrementalGatePassed ? report.draftPriority.productionWeight : 0);
  assert.equal(report.teamPrior.modelId, teamModel.selected.id);
});

test("first three Swiss rounds are restricted to the revealed groups", () => {
  const participants = [...SWISS_GROUPS.A, ...SWISS_GROUPS.B];
  assert.equal(SWISS_GROUPS.A.length, 8);
  assert.equal(SWISS_GROUPS.B.length, 8);
  assert.equal(new Set(participants).size, 16);
  for (const [teamA, teamB] of ROUND_ONE) assert.equal(SWISS_GROUP_BY_TEAM[teamA], SWISS_GROUP_BY_TEAM[teamB]);
  assert.notEqual(swissBucketKey("1w", 1, 0, 2), swissBucketKey("aurora", 1, 0, 2));
  assert.equal(swissBucketKey("1w", 2, 1, 4), swissBucketKey("aurora", 2, 1, 4));
});

test("statistics contain every TI matchup and calibrated methodology", async () => {
  const stats = JSON.parse(await readFile("public/team-stats.json", "utf8"));
  assert.equal(Object.keys(stats.teams).length, 16);
  assert.equal(Object.keys(stats.pairwise).length, 120);
  assert.equal(stats.methodology.recencyHalfLifeDays, 45);
  assert.equal(stats.methodology.claim.includes("experimental"), true);
  assert.equal(stats.validation.status, "experimental");
  assert.ok(stats.validation.selected.logLoss < stats.validation.neutral.logLoss);
  assert.equal(stats.methodology.teamPrior.artifact, "/team-model.json");
  assert.equal(stats.tournamentCalibration.validation.validated, stats.tournamentCalibration.holdout.bootstrap.upper95 < 0);
  assert.equal(stats.tournamentCalibration.selected.seriesNoiseLogitSd, 0);
  assert.deepEqual(stats.methodology.rosterWeights, { 3: 0.07, 4: 0.25, 5: 1 });
  assert.equal(stats.methodology.directMatchPriorSeries, 6);
  assert.equal(stats.methodology.ratingL2Penalty, 0.025);
  assert.ok(stats.teams["1w"].openDotaIds.includes(8291895));
  assert.ok(stats.teams["1w"].aliases.includes("TUNDRA ESPORTS"));
  assert.ok(stats.teams["1w"].exactRosterGames >= 200);
  for (const pair of Object.values(stats.pairwise)) {
    assert.ok(pair.probabilityA >= 7 && pair.probabilityA <= 93);
    assert.ok(pair.probabilityBo3A >= 7 && pair.probabilityBo3A <= 93);
    assert.ok(pair.probabilityBo5A >= 3 && pair.probabilityBo5A <= 97);
    assert.ok(pair.uncertainty >= 0);
  }
});

test("draft lab contains current-patch heroes and regularized matchup evidence", async () => {
  const stats = JSON.parse(await readFile("public/draft-stats.json", "utf8"));
  const page = await readFile("app/drafts/page.tsx", "utf8");
  const server = await readFile("server/api.mjs", "utf8");
  assert.ok(stats.heroes.length >= 120);
  assert.ok(stats.methodology.cachedPatchMaps >= 100);
  assert.equal(stats.methodology.patchName, "7.41e");
  assert.ok(stats.methodology.cachedPatchMaps >= stats.methodology.tiTeamPatchMaps);
  assert.equal(stats.methodology.cachedPatchMaps, stats.methodology.globalProPatchMaps);
  assert.equal(stats.methodology.missingPatchMaps, 0);
  assert.ok(stats.methodology.proPriorGames > 0);
  assert.ok(stats.methodology.patchPriorGames > 0);
  assert.ok(stats.methodology.pairPriorGames > 0);
  assert.ok(stats.radiantWinRate > 40 && stats.radiantWinRate < 60);
  assert.ok(Object.keys(stats.synergy).length > 0);
  assert.ok(Object.keys(stats.counters).length > 0);
  assert.ok(Object.keys(stats.lineups).length > 0);
  assert.deepEqual(stats.activeSnapshot.featureContract, ["teamPrior", "side", "hero", "draftPriority", "synergy", "counter", "teamPool", "playerPool", "roles"]);
  assert.ok(Object.keys(stats.activeSnapshot.heroPriority).length >= 120);
  assert.ok(Object.values(stats.activeSnapshot.heroPriority).every((row) => row.pickRate >= 0 && row.banRate >= 0 && row.contestedRate >= row.pickRate && row.contestedRate >= row.banRate && row.flex >= 0 && row.flex <= 1));
  assert.equal(stats.combiner.weights.draftPriority, stats.validation.activeFormula.draftPriority.incrementalGatePassed ? stats.validation.activeFormula.draftPriority.productionWeight : 0);
  assert.deepEqual(stats.activeSnapshot.teamPairwise, Object.fromEntries(Object.entries((await readFile("public/team-stats.json", "utf8").then(JSON.parse)).pairwise).map(([key, pair]) => [key, { probabilityA: pair.mapProbabilityA, modelId: pair.modelId }])));
  assert.ok(Object.values(stats.activeSnapshot.synergy).every((row) => Number.isFinite(row.coefficient)));
  assert.ok(Object.values(stats.activeSnapshot.counter).every((row) => Number.isFinite(row.coefficient)));
  assert.ok(Object.keys(stats.activeSnapshot.heroRole).length > 0);
  assert.ok(Object.values(stats.activeSnapshot.playerPositions).every((row) => row.role >= 1 && row.role <= 5));
  assert.equal(stats.validation.activeFormula.bootstrap.frozenHoldoutVersusTeamSide.cluster, "series_id");
  assert.ok(Object.values(stats.teams).every((team) => team.players.length === 5));
  assert.ok(Object.values(stats.teams).some((team) => team.players.some((player) => Object.keys(player.heroes).length > 0)));
  assert.match(page, /Почему получилась эта вероятность/);
  assert.match(page, /Контрпики/);
  assert.match(page, /Игроки на героях/);
  assert.match(server, /scripts\/update-all-stats\.mjs/);
  assert.match(server, /\/api\/draft\/predict/);
  assert.match(page, /Межпатчевая модель/);
  assert.match(page, /MODEL ARENA/);
});

test("draft refresh discovers live TI league maps before training", async () => {
  const updater = await readFile("scripts/update-draft-stats.mjs", "utf8");
  assert.match(updater, /TI_LEAGUE_ID/);
  assert.match(updater, /leagues\/\$\{TI_LEAGUE_ID\}\/matches/);
  assert.match(updater, /addLiveTournamentMaps/);
  assert.match(updater, /liveTournamentMapsAdded/);
});

test("deployment files do not contain the administrator password", async () => {
  const compose = await readFile("docker-compose.yml", "utf8");
  const example = await readFile(".env.example", "utf8");
  assert.match(compose, /ADMIN_PASSWORD/);
  assert.match(example, /replace-with-a-long-random-password/);
  assert.doesNotMatch(compose, /test-password/);
});

test("OpenDota maps become a completed series only after two wins", () => {
  const maps = [
    { match_id: 1, series_id: 99, start_time: 100, radiant_team_id: 10182357, dire_team_id: 10136357, radiant_win: true },
    { match_id: 2, series_id: 99, start_time: 200, radiant_team_id: 10136357, dire_team_id: 10182357, radiant_win: false },
    { match_id: 3, series_id: 100, start_time: 300, radiant_team_id: 9467224, dire_team_id: 9964962, radiant_win: true },
  ];
  const series = completedSeriesFromMaps(maps);
  assert.equal(series.length, 1);
  assert.deepEqual(series[0], { seriesId: "99", teamA: "1w", teamB: "nigma", winsA: 2, winsB: 0, startTime: 100, seriesType: 1, mapIds: [1, 2] });
});

test("OpenDota live feed becomes a partial TI draft and rejects stale games", () => {
  const rows = [{ league_id: 19719, match_id: 42, series_id: 7, team_id_radiant: 9247354, team_id_dire: 9572001, game_time: -30, delay: 10, last_update_time: 1_000, radiant_lead: 2400, spectators: 1234,
    players: [{ team: 0, team_slot: 2, account_id: 20, hero_id: 59, name: "Second" }, { team: 0, team_slot: 1, account_id: 10, hero_id: 80, name: "First" }, { team: 1, team_slot: 1, account_id: 30, hero_id: 55 }] }];
  const leagueMaps = [
    { series_id: 7, series_type: 1, radiant_team_id: 9247354, dire_team_id: 9572001, radiant_win: true },
    { series_id: 7, series_type: 1, radiant_team_id: 9572001, dire_team_id: 9247354, radiant_win: true },
  ];
  assert.deepEqual(liveDraftsFromOpenDota(rows, { nowSeconds: 1_030, leagueMaps }), [{
    matchId: "42", seriesId: "7", radiantTeam: "falcons", direTeam: "parivision", radiantPicks: [80, 59], direPicks: [55], gameTime: -30, delay: 10,
    radiantPlayers: [{ accountId: 10, heroId: 80, name: "First" }, { accountId: 20, heroId: 59, name: "Second" }],
    direPlayers: [{ accountId: 30, heroId: 55, name: null }],
    radiantScore: 0, direScore: 0, radiantLead: 2400, spectators: 1234, seriesScoreRadiant: 1, seriesScoreDire: 1, seriesBestOf: 3,
    lastUpdateAt: "1970-01-01T00:16:40.000Z", phase: "draft",
  }]);
  assert.deepEqual(liveDraftsFromOpenDota(rows, { nowSeconds: 1_301 }), []);
});

test("live map model is side-symmetric, waits for 10:00 and raises the leading side", async () => {
  const model = JSON.parse(await readFile("public/live-map-model.json", "utf8"));
  const baseGame = { phase: "game", gameTime: 15 * 60, radiantLead: 5_000, radiantScore: 14, direScore: 8, radiantTeam: "falcons", direTeam: "parivision", lastUpdateAt: new Date().toISOString() };
  const radiant = estimateLiveMap(model, { draftProbabilityRadiant: 0.55, game: baseGame });
  const flipped = estimateLiveMap(model, { draftProbabilityRadiant: 0.45, game: { ...baseGame, radiantLead: -5_000, radiantScore: 8, direScore: 14, radiantTeam: "parivision", direTeam: "falcons" } });
  assert.ok(radiant.liveProbabilityRadiant > 0.55);
  assert.ok(Math.abs(radiant.liveProbabilityRadiant + flipped.liveProbabilityRadiant - 1) < 1e-12);
  assert.equal(estimateLiveMap(model, { draftProbabilityRadiant: 0.55, game: { ...baseGame, gameTime: 599 } }).liveProbabilityRadiant, null);
  assert.equal(assessLiveMap({ ...baseGame, gameTime: 20 * 60, radiantLead: 16_000 }).guard, "state_already_decided");
  assert.ok(model.test.model.logLoss < model.test.frozenPrior.logLoss);
});

test("Draft Lab polls and binds the selected live draft", async () => {
  const page = await readFile("app/drafts/page.tsx", "utf8");
  const api = await readFile("server/api.mjs", "utf8");
  assert.match(page, /fetch\("\/api\/draft\/live"/);
  assert.match(page, /window\.setInterval\(load, 5_000\)/);
  assert.match(page, /selectedLiveDraft\.radiantPicks/);
  assert.match(page, /liveDraft\.radiantPlayers/);
  assert.match(page, /calculateDraft\(.*boundLiveDraft\)/);
  assert.match(page, /setLastSelectedLiveDraft\(selectedLiveDraft\)/);
  assert.match(page, /точное распределение из live-feed/);
  assert.match(page, /гипотеза модели · не подтверждено/);
  assert.match(page, /result\.assignmentA\?\.rows\.length/);
  assert.match(page, /assessLiveMap/);
  assert.match(page, /NO BET · ИСХОД СЛОЖИЛСЯ/);
  assert.match(page, /ЗАМОРОЖЕННЫЙ ПРОГНОЗ ПО ДРАФТУ/);
  assert.match(api, /OPENDOTA_API_URL}\/live/);
  assert.match(api, /OPENDOTA_API_URL}\/leagues\/\$\{TI_LEAGUE_ID\}\/matches/);
  assert.match(api, /liveDraftsFromOpenDota/);
  assert.match(api, /live_draft_snapshots/);
  assert.match(api, /live_draft_predictions/);
  assert.match(page, /estimateLiveMap/);
  assert.match(page, /live-probability-timeline/);
});

test("OpenDota BO5 is not completed at 2-0", () => {
  const maps = [1, 2].map((matchId) => ({ match_id: matchId, series_id: 7, series_type: 2, start_time: matchId, radiant_team_id: 10182357, dire_team_id: 10136357, radiant_win: true }));
  assert.equal(completedSeriesFromMaps(maps).length, 0);
  maps.push({ match_id: 3, series_id: 7, series_type: 2, start_time: 3, radiant_team_id: 10136357, dire_team_id: 10182357, radiant_win: false });
  assert.equal(completedSeriesFromMaps(maps).length, 1);
});

test("former Tundra OpenDota team ID resolves to current 1w roster", () => {
  const maps = [
    { match_id: 11, series_id: 199, start_time: 100, radiant_team_id: 8291895, dire_team_id: 10136357, radiant_win: true },
    { match_id: 12, series_id: 199, start_time: 200, radiant_team_id: 10136357, dire_team_id: 8291895, radiant_win: false },
  ];
  assert.deepEqual(completedSeriesFromMaps(maps)[0], { seriesId: "199", teamA: "1w", teamB: "nigma", winsA: 2, winsB: 0, startTime: 100, seriesType: 1, mapIds: [11, 12] });
});

test("Iron Wing OpenDota team ID resolves to current 1w roster", () => {
  const maps = [
    { match_id: 21, series_id: 299, start_time: 100, radiant_team_id: 10150413, dire_team_id: 10136357, radiant_win: true },
    { match_id: 22, series_id: 299, start_time: 200, radiant_team_id: 10136357, dire_team_id: 10150413, radiant_win: false },
  ];
  assert.deepEqual(completedSeriesFromMaps(maps)[0], { seriesId: "299", teamA: "1w", teamB: "nigma", winsA: 2, winsB: 0, startTime: 100, seriesType: 1, mapIds: [21, 22] });
});

test("snapshot history keeps one visible row while internal revisions advance", () => {
  const snapshots = [
    { id: 8, trigger: "auto_live_result", forecast_mode: "stats", opinion_weight: 0, completed_match_count: 2, snapshot_kind: "original", root_snapshot_id: 8, profile_key: "official" },
    { id: 7, trigger: "revision_auto_live_result", forecast_mode: "mixed", opinion_weight: 20, completed_match_count: 2, snapshot_kind: "revision", root_snapshot_id: 3, profile_key: "personal" },
    { id: 6, trigger: "auto_live_result", forecast_mode: "stats", opinion_weight: 0, completed_match_count: 1, snapshot_kind: "original", root_snapshot_id: 6, profile_key: "official" },
    { id: 5, trigger: "revision_auto_live_result", forecast_mode: "mixed", opinion_weight: 20, completed_match_count: 1, snapshot_kind: "revision", root_snapshot_id: 3, profile_key: "personal" },
    { id: 3, trigger: "manual_run", forecast_mode: "mixed", opinion_weight: 20, completed_match_count: 0, snapshot_kind: "original", root_snapshot_id: 3, profile_key: "personal" },
    { id: 1, trigger: "pre_round_1", forecast_mode: "stats", opinion_weight: 0, completed_match_count: 0, snapshot_kind: "original", root_snapshot_id: 1, profile_key: "official" },
  ];
  const rows = visibleSnapshotHistory(snapshots);
  assert.deepEqual(rows.map((snapshot) => snapshot.id), [3, 1]);
  assert.equal(latestSnapshotForHistoryRow(rows[0], snapshots).id, 7);
  assert.equal(latestSnapshotForHistoryRow(rows[1], snapshots).id, 8);
  assert.equal(latestOfficialBaseline(snapshots).id, 8);
});

test("Cybersport schedule becomes official pre-match series", () => {
  const html = `<div class="tab_x isActive_y"><span>Раунд 2</span></div>
    <div>14.08.26 в 08:00<img alt="PARIVISION"><img alt="Nigma Galaxy"><span class="vs_pcDDl">vs</span><img alt="BetBoom"></div>
    <div>14.08.26 в 11:00<img alt="Team Spirit"><img alt="Xtreme Gaming"><span class="vs_pcDDl">vs</span></div>`;
  assert.deepEqual(scheduledSeriesFromCybersportHtml(html), [
    { teamA: "parivision", teamB: "nigma", round: 2, scheduledAt: "2026-08-14T05:00:00.000Z", source: "cybersport" },
    { teamA: "spirit", teamB: "xtreme", round: 2, scheduledAt: "2026-08-14T08:00:00.000Z", source: "cybersport" },
  ]);
});

test("current Cybersport round parses UTF-8 today, LIVE and time-less official pairings", () => {
  const html = `<h2>Расписание</h2>
    <div class="tab_x isActive_y"><span>Раунд 2</span></div>
    <div class="item_a"><div class="date_x">Сегодня в 13:00</div><div class="participant_a"><img alt="Falcons"></div><div class="participant_b"><img alt="PARIVISION"></div><span class="vs_x">vs</span><img alt="BetBoom"></div>
    <div class="item_b"><div class="date_x"><span>LIVE</span></div><div class="participant_a"><img alt="OG"></div><div class="participant_b"><img alt="Nigma"></div><span>0:0</span></div>
    <div class="item_c"><div class="date_x"></div><div class="participant_a"><img alt="Liquid"></div><div class="participant_b"><img alt="Yandex"></div><span class="vs_x">vs</span></div>
    <div id="stage-participants"></div>`;
  assert.deepEqual(scheduledSeriesFromCybersportHtml(html, { now: new Date("2026-08-13T10:15:00.000Z") }), [
    { teamA: "falcons", teamB: "parivision", round: 2, scheduledAt: "2026-08-13T10:00:00.000Z", source: "cybersport" },
    { teamA: "og", teamB: "nigma", round: 2, scheduledAt: "2026-08-13T10:15:00.000Z", source: "cybersport" },
    { teamA: "liquid", teamB: "yandex", round: 2, scheduledAt: "2026-08-13T10:15:00.000Z", source: "cybersport" },
  ]);
});

test("L1 TEAM sponsorship-safe name resolves to L1ga", () => {
  const html = `<div class="tab_x isActive_y"><span>Раунд 3</span></div>
    <div>15.08.26 в 14:00<img alt="L1 TEAM"><img alt="Team Liquid"><span class="vs_pcDDl">vs</span></div>`;
  assert.deepEqual(scheduledSeriesFromCybersportHtml(html), [
    { teamA: "l1ga", teamB: "liquid", round: 3, scheduledAt: "2026-08-15T11:00:00.000Z", source: "cybersport" },
  ]);
});

test("Tundra schedule name resolves to transferred 1w roster", () => {
  const html = `<div class="tab_x isActive_y"><span>Раунд 2</span></div>
    <div>14.08.26 в 14:00<img alt="Tundra Esports"><img alt="Team Spirit"><span class="vs_pcDDl">vs</span></div>`;
  assert.deepEqual(scheduledSeriesFromCybersportHtml(html), [
    { teamA: "1w", teamB: "spirit", round: 2, scheduledAt: "2026-08-14T11:00:00.000Z", source: "cybersport" },
  ]);
});

test("Ubuntu deployment documents automatic live sync", async () => {
  const guide = await readFile("docs/UBUNTU_DEPLOY.md", "utf8");
  const compose = await readFile("docker-compose.yml", "utf8");
  assert.match(guide, /TI_LEAGUE_ID=19719/);
  assert.match(guide, /ssh -L 8080/);
  assert.match(compose, /LIVE_SYNC_INTERVAL_MINUTES/);
});

test("all sixteen local team logos are present", async () => {
  const names = ["1w", "aurora", "betboom", "gamerlegion", "l1ga", "lgd", "liquid", "nigma", "og", "parivision", "resilience", "spirit", "vg", "xtreme", "yandex"];
  for (const name of names) assert.equal((await readFile(`public/team-logos/${name}.webp`)).subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal((await readFile("public/team-logos/falcons.jpg")).subarray(0, 2).toString("hex"), "ffd8");
});

test("server forecast can create an automatic snapshot payload", async () => {
  const stats = JSON.parse(await readFile("public/team-stats.json", "utf8"));
  const probabilities = buildForecastSource({ answers: {}, stats, matches: [], mode: "stats", opinionWeight: 0 });
  assert.equal(Object.keys(probabilities).length, 120);
  const result = runForecast(probabilities, 100, 123, { stats, matches: [] });
  assert.equal(result.teams.length, 16);
  assert.equal(result.iterations, 100);
  assert.equal(result.formatVersion, "hidden-groups-r1-r3-playoff-v5-adaptive");
  assert.equal(result.convergence.stopReason, "fixed_budget");
  assert.equal(result.convergence.checkpoints.at(-1).iterations, 100);
  assert.deepEqual(result.calibration, stats.tournamentCalibration.selected);
  assert.ok(Math.abs(result.teams.reduce((sum, team) => sum + team.champion, 0) - 100) < 1e-9);
  assert.ok(Math.abs(result.teams.reduce((sum, team) => sum + team.final, 0) - 200) < 1e-9);
  assert.ok(Math.abs(result.teams.reduce((sum, team) => sum + team.top3, 0) - 300) < 1e-9);
  assert.equal(result.teams.filter((team) => team.qualify > 0).length > 0, true);
  assert.equal(result.scenarios[0].direct40.length, 1);
  assert.equal(result.scenarios[0].direct41.length, 2);
  assert.equal(result.scenarios[0].via.length, 5);
  assert.ok(result.scenarios.every((scenario) => scenario.occurrences >= 1 && scenario.probability > 0));
  assert.ok(result.scenarios.every((scenario) => Math.abs(scenario.probability - 100 * scenario.occurrences / result.iterations) < 1e-12));
  assert.deepEqual(result.scenarios.map((scenario) => scenario.occurrences), [...result.scenarios.map((scenario) => scenario.occurrences)].sort((a, b) => b - a));
  assert.ok(result.scenarios.every((scenario) => scenario.scope === "group_and_playin"));
  assert.equal(result.playoffScenarios.length, 3);
  assert.ok(result.playoffScenarios.every((scenario) => scenario.occurrences >= 1));
  assert.ok(result.playoffScenarios.every((scenario) => new Set([scenario.champion, scenario.runnerUp, scenario.third]).size === 3));
  assert.ok(result.uniqueTournamentPaths <= result.iterations);
  assert.ok(result.uniqueSwissPaths <= result.iterations);
  assert.ok(result.uniqueSwissOutcomes <= result.iterations);
  assert.ok(result.uniquePlayoffPodiums <= result.iterations);
  assert.ok(result.uniqueFinalOutcomes <= result.iterations);
  const total = (field) => Math.round(result.teams.reduce((sum, team) => sum + team[field], 0));
  assert.deepEqual({ direct: total("direct"), playinWin: total("viaPlayin"), playinLoss: total("playinLoss"), swissOut: total("swissOut") }, { direct: 300, playinWin: 500, playinLoss: 500, swissOut: 300 });
  for (const team of result.teams) assert.ok(Math.abs(team.direct + team.viaPlayin + team.playinLoss + team.swissOut - 100) < 0.001);
});

test("completed Swiss results make impossible perfect records disappear from scenarios", async () => {
  const stats = JSON.parse(await readFile("public/team-stats.json", "utf8"));
  const probabilities = buildForecastSource({ answers: {}, stats, matches: [], mode: "stats", opinionWeight: 0 });
  const result = runForecast(probabilities, 200, 2468, { stats, matches: [{ id: 1, stage: "swiss", round: 1, team_a: "yandex", team_b: "l1ga", winner: "l1ga" }] });
  assert.ok(result.scenarios.every((scenario) => !scenario.direct40.includes("yandex")));
});

test("scenario UI never renders outcomes contradicted by known Swiss records", async () => {
  const page = await readFile("app/page.tsx", "utf8");
  assert.match(page, /function scenarioMatchesKnownSwissResults/);
  assert.match(page, /direct40\.has\(team\.id\) && record\.losses > 0/);
  assert.match(page, /compatibleGroupScenarios\.map/);
  assert.doesNotMatch(page, /result\.scenarios\.map/);
  assert.match(page, /старых вариантов отброшено как невозможные/);
});

test("official pairing changes are part of automatic snapshot deduplication", async () => {
  const api = await readFile("server/api.mjs", "utf8");
  assert.match(api, /snapshot_kind=\? AND trigger=\?/);
  assert.match(api, /queueAutomaticSnapshot\(officialPairingTrigger\(\)\)/);
  assert.match(api, /auto_pairing_/);
  assert.match(api, /pendingAutomaticSnapshotTrigger/);
  assert.match(api, /if \(autoForecastRunning\) \{[\s\S]*queueAutomaticSnapshot/);
  assert.match(api, /liveConstraintSignature: liveConstraintSignature\(matches\)/);
  assert.match(api, /officialSnapshotNeedsRefresh\(persistedMatches\)/);
  assert.match(api, /auto_reconcile/);
});

test("group scenarios rank raw counts before percentage conversion and exclude playoff identity", () => {
  const make = (id) => JSON.stringify({ direct40: [id], direct41: ["b", "c"], via: ["d", "e", "f", "g", "h"] });
  const ranked = topGroupScenarios(new Map([[make("third"), 11], [make("first"), 13], [make("second"), 12]]), 1_000_000);
  assert.deepEqual(ranked.map((scenario) => scenario.occurrences), [13, 12, 11]);
  assert.deepEqual(ranked.map((scenario) => scenario.rank), [1, 2, 3]);
  assert.deepEqual(ranked.map((scenario) => scenario.probability), [.0013, .0012, .0011]);
  assert.ok(ranked.every((scenario) => !("champion" in scenario)));
});

test("adaptive forecast respects its minimum, checkpoints and maximum budget", async () => {
  const stats = JSON.parse(await readFile("public/team-stats.json", "utf8"));
  const probabilities = buildForecastSource({ answers: {}, stats, matches: [], mode: "stats", opinionWeight: 0 });
  const result = runForecast(probabilities, 100, 321, { stats, matches: [], adaptive: { enabled: true, minIterations: 100, maxIterations: 400, batchSize: 100, tolerancePp: 100, stableChecksRequired: 2 } });
  assert.equal(result.iterations, 300);
  assert.equal(result.requestedIterations, 100);
  assert.equal(result.convergence.adaptive, true);
  assert.equal(result.convergence.converged, true);
  assert.equal(result.convergence.stopReason, "stable");
  assert.deepEqual(result.convergence.checkpoints.map((item) => item.iterations), [100, 200, 300]);
  assert.ok(result.convergence.maxSamplingMarginPp > 0);
  assert.equal(result.pathSampleIterations, 300);
  const championTotal = result.teams.reduce((sum, team) => sum + team.champion, 0);
  const finalTotal = result.teams.reduce((sum, team) => sum + team.final, 0);
  assert.ok(Math.abs(championTotal - 100) < 1e-9);
  assert.ok(Math.abs(finalTotal - 200) < 1e-9);
});

test("forecast worker returns the same deterministic result as the engine", async () => {
  const { Worker } = await import("node:worker_threads");
  const stats = JSON.parse(await readFile("public/team-stats.json", "utf8"));
  const probabilities = buildForecastSource({ answers: {}, stats, matches: [], mode: "stats", opinionWeight: 0 });
  const expected = runForecast(probabilities, 100, 987, { stats, matches: [] });
  const actual = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../server/forecast-worker.mjs", import.meta.url), { workerData: { probabilities, minimum: 100, seed: 987, matches: [], stats, adaptive: null } });
    worker.once("message", (message) => message.ok ? resolve(message.result) : reject(new Error(message.error)));
    worker.once("error", reject);
  });
  assert.deepEqual(actual.teams, expected.teams);
  assert.deepEqual(actual.convergence, expected.convergence);
});

test("manual Monte Carlo UI exposes adaptive, 500K and 1M budgets", async () => {
  const page = await readFile("app/page.tsx", "utf8");
  const styles = await readFile("app/globals.css", "utf8");
  assert.match(page, /setAdaptiveRun\(true\)/);
  assert.match(page, /500000, 1000000/);
  assert.match(page, /forecast-client-worker\.ts\?worker/);
  assert.match(page, /Прогон не выполнен:/);
  assert.match(page, /Готово:.*simulation\.iterations/s);
  assert.match(page, /simulation-status--\$\{simulationStatus\.kind\}/);
  assert.match(page, /predictionCorrect/);
  assert.match(page, /round-cell--correct/);
  assert.match(page, /round-cell--wrong/);
  assert.match(styles, /td\.round-cell--correct/);
  assert.match(styles, /td\.round-cell--wrong/);
  assert.match(page, /const scenarioSource = selectedRoot\?\.probabilities \?\? activeBaselineSnapshot\?\.probabilities \?\? forecastSource/);
  assert.match(page, /buildLikelyBracket\(scenarioSource, liveMatches, stats, scenarioSnapshotCreatedAt, scenarioUsesOfficialPrematch\)/);
  assert.match(page, /displayedResult = selectedRoot[\s\S]*selectedLatestSnapshotIsCurrent \? selectedLatest!\.result/);
  assert.match(page, /resultHappenedAfter\(match, snapshotCreatedAt, useOfficialPrematch\)/);
  assert.match(page, /useOfficialPrematch && Number\.isFinite\(match\.predicted_probability\)/);
  assert.match(page, /selectedRoot\?\.forecast_mode === "stats" && selectedRoot\.trigger !== "manual_run"/);
  assert.match(page, /ИСТОРИЧЕСКИЙ ПРОГНОЗ/);
  assert.match(page, /ti26-official-baseline/);
  assert.match(page, /latestOfficialBaseline\(snapshots\)/);
  assert.match(page, /повторный прогон не нужен/);
  assert.doesNotMatch(page, /setResult\(runSimulation\(parsed, 4000\)\)/);
  assert.match(page, /latestOfficialSnapshotIsCurrent/);
  assert.match(page, /selectedLatestSnapshotIsCurrent/);
  assert.match(page, /selectedRoot\?\.probabilities \?\?/);
  assert.match(page, /runSimulationInWorker\(source, Math\.min\(iterationCount, 250_000\)/);
  assert.match(page, /Сыгранные исходы зафиксированы/);
});

test("conditional branches freeze ratings and compare probabilistic outcomes", async () => {
  const page = await readFile("app/page.tsx", "utf8");
  assert.doesNotMatch(page, /чемпион ветки/);
  assert.match(page, /КАК РЕЗУЛЬТАТ ИЗМЕНИТ ТУРНИРНЫЕ ШАНСЫ/);
  assert.match(page, /runSimulationInWorker\(forecastSource, iterations, seed/);
  assert.match(page, /Рейтинг команд заморожен/);
  assert.match(page, /Существенного влияния на чемпионство не обнаружено/);
});

test("prediction audit keeps frozen and adaptive evaluations separate", async () => {
  const page = await readFile("app/page.tsx", "utf8");
  const styles = await readFile("app/globals.css", "utf8");
  assert.match(page, /function initialGroupSnapshot/);
  assert.match(page, /snapshot\.forecast_mode === "stats" && snapshot\.completed_match_count === 0/);
  assert.match(page, /function adaptiveSnapshotProbability/);
  assert.match(page, /function dualSnapshotEvaluation/);
  assert.match(page, /variant\("STATIC", staticScore\)/);
  assert.match(page, /variant\("ADAPTIVE", adaptiveScore\)/);
  assert.match(page, /static: matchEvaluation/);
  assert.match(page, /adaptive: matchEvaluation/);
  assert.match(page, /staticGroupSnapshot\?\.probabilities \?\? statisticalAnswers\(stats\)/);
  assert.match(page, /live-results-disclosure/);
  assert.match(page, /СЫГРАННЫЕ МАТЧИ · STATIC \/ ADAPTIVE/);
  assert.match(styles, /\.live-results-disclosure > summary/);
  assert.match(styles, /prediction-variant--static/);
  assert.match(styles, /history-chart__adaptive/);
});

test("intel artifact covers every team and complete tournament outcomes", async () => {
  const intel = JSON.parse(await readFile(new URL("../public/intel-stats.json", import.meta.url), "utf8"));
  assert.equal(Object.keys(intel.teams).length, 16);
  assert.ok(intel.methodology.parsedReplayFiles >= 1000);
  assert.equal(intel.sources.some((source) => source.id === "opendota-replays"), true);
  for (const team of Object.values(intel.teams)) {
    assert.equal(team.contexts.length, 5);
    assert.ok(team.style.metrics.length >= 8);
    assert.equal(team.players.length, 5);
    assert.equal(team.storylines.length, 3);
    assert.ok(team.identity.openDotaIds.length >= 1);
  }
  const outcomes = Object.values(intel.tournament.teams);
  assert.ok(Math.abs(outcomes.reduce((sum, team) => sum + team.champion, 0) - 100) < 0.2);
  assert.ok(Math.abs(outcomes.reduce((sum, team) => sum + team.final, 0) - 200) < 0.2);
  assert.ok(Math.abs(outcomes.reduce((sum, team) => sum + team.top3, 0) - 300) < 0.2);
});

test("next-generation artifacts enforce chronological gates and keep weak challengers out", async () => {
  const team = JSON.parse(await readFile("public/all-pro-team-model.json", "utf8"));
  const draft = JSON.parse(await readFile("public/draft-nextgen-model.json", "utf8"));
  const series = JSON.parse(await readFile("public/nextgen-series-calibration.json", "utf8"));
  assert.equal(team.training.series, 29599);
  assert.equal(team.selected.id, "stack");
  assert.equal(team.validation.modelSelection.selected, "stack");
  assert.equal(team.validation.frozenHoldout.stackBeatsBestBase, false);
  assert.ok(team.validation.frozenHoldout.selectedBootstrapVs50.upper95 < 0);
  assert.equal(draft.fullPickBanSequence, true);
  assert.equal(draft.status, "shadow");
  assert.ok(draft.training.test >= 350);
  assert.equal(series.sourceModel, "stack");
  assert.equal(series.status, "experimental");
  assert.equal(series.monteCarlo.seriesShockLogitSd, 0);
  assert.ok(series.holdout.calibratedLogLoss >= series.holdout.rawLogLoss);
});

test("production image exposes next-generation artifacts without activating shadows", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");
  const compose = await readFile("docker-compose.yml", "utf8");
  const api = await readFile("server/api.mjs", "utf8");
  for (const file of ["all-pro-team-model.json", "draft-nextgen-model.json", "nextgen-series-calibration.json", "live-map-model.json"]) assert.match(dockerfile, new RegExp(file.replaceAll(".", "\\.")));
  assert.match(compose, /ALL_PRO_TEAM_MODEL: \/app\/model\/all-pro-team-model\.json/);
  assert.match(compose, /LIVE_MAP_MODEL: \/app\/model\/live-map-model\.json/);
  assert.match(api, /\/api\/models\/nextgen/);
  assert.match(api, /\/api\/draft\/live\/model/);
  assert.match(api, /activeForecastUnchanged: true/);
});

test("docker build keeps research data out of context and shares one app image", async () => {
  const dockerignore = await readFile(".dockerignore", "utf8");
  const dockerfile = await readFile("Dockerfile", "utf8");
  const compose = await readFile("docker-compose.yml", "utf8");
  const ignoredLines = new Set(dockerignore.split(/\r?\n/));
  for (const directory of ["node_modules*", "work", "data", ".git", "dist", ".vinext"]) assert.ok(ignoredLines.has(directory));
  assert.match(dockerfile, /--mount=type=cache,target=\/root\/\.npm/);
  assert.match(dockerfile, /npm ci --no-audit --no-fund/);
  assert.match(compose, /image: ti2026-app:\$\{IMAGE_TAG:-local\}/);
  assert.equal((compose.match(/<<: \*app-image/g) ?? []).length, 2);
  assert.equal((compose.match(/^\s+build:/gm) ?? []).length, 1);
});

test("cross-page navigation does not depend on broken Vinext Link prefetch", async () => {
  for (const file of ["app/drafts/page.tsx", "app/intel/page.tsx"]) {
    const page = await readFile(file, "utf8");
    assert.doesNotMatch(page, /from ["']next\/link["']/);
    assert.match(page, /<a[^>]+href="\/"[^>]*>.*Турнир/s);
  }
});

test("prediction confidence separates probability from evidence and flags roulette matches", () => {
  const weak = assessPredictionConfidence({ modelEffectiveGames: 2.3, directEffectiveGames: 0, rosterReliability: .65 }, 61);
  const strong = assessPredictionConfidence({ modelEffectiveGames: 18, directEffectiveGames: 2.5, rosterReliability: 1 }, 61);
  const tossup = assessPredictionConfidence({ modelEffectiveGames: 3, directEffectiveGames: .2, rosterReliability: 1 }, 51);
  assert.equal(weak.roulette, true);
  assert.ok(weak.score < strong.score);
  assert.equal(strong.roulette, false);
  assert.equal(tossup.roulette, true);
  assert.equal(assessPredictionConfidence(null, 70).roulette, true);
  assert.equal(assessPredictionConfidence(null, 50).roulette, true);
});

test("known results preserve the original pre-match confidence warning", async () => {
  const page = await readFile("app/page.tsx", "utf8");
  const confidence = await readFile("server/prediction-confidence.mjs", "utf8");
  assert.doesNotMatch(page, /pairConfidence\([^\n]+Boolean\((?:fixedWinner|actual\?\.winner)\)/);
  assert.doesNotMatch(confidence, /if \(fixed\).*roulette: false/);
});

test("external provider features stay shadow until they add temporally safe OOF value", () => {
  assert.ok(pearsonCorrelation([1, 2, 3, 4], [2, 4, 6, 8]) > .99);
  assert.equal(externalFeatureDecision({ correlations: [.4], logLossDelta: -.002, brierDelta: -.001, bootstrapUpper95: -.0002, temporalSafe: true, deduplicated: true, coverage: .9 }).activate, true);
  const leaked = externalFeatureDecision({ correlations: [.3], logLossDelta: -.01, brierDelta: -.01, bootstrapUpper95: -.005, temporalSafe: false, deduplicated: true, coverage: 1 });
  assert.equal(leaked.activate, false);
  assert.match(leaked.reasons.join(" "), /утечка/);
  assert.equal(externalFeatureDecision({ correlations: [.995], logLossDelta: -.001, brierDelta: -.001, bootstrapUpper95: -.0001, temporalSafe: true, deduplicated: true, coverage: 1 }).activate, false);
});

test("DatDota adapter preserves provenance and never activates imported aggregates", () => {
  const normalized = normalizeDatdotaPayload(JSON.stringify({ data: [{ heroId: 1, position: 2, games: 10 }] }), { asOf: "2026-08-12T00:00:00Z" });
  assert.equal(normalized.rows.length, 1);
  assert.match(normalized.artifact.source.checksum, /^sha256:[a-f0-9]{64}$/);
  assert.equal(normalized.artifact.modelPolicy.status, "shadow");
  assert.equal(normalized.artifact.modelPolicy.aggregateRowsAreNotTrainingMatches, true);
});

test("decision layer can sharpen probabilities but refuses unreliable matches", () => {
  assert.ok(sharpenProbability(60, .8) > 60);
  assert.equal(sharpenProbability(50, .7), 50);
  assert.equal(predictionDecision({ modelEffectiveGames: 2, directEffectiveGames: 0, rosterReliability: .6 }, 70, { temperature: .8 }).status, "roulette");
  assert.equal(predictionDecision({ modelEffectiveGames: 30, directEffectiveGames: 4, rosterReliability: 1 }, 51).status, "even");
  assert.equal(predictionDecision({ modelEffectiveGames: 30, directEffectiveGames: 4, rosterReliability: 1 }, 70).status, "pick");
});
