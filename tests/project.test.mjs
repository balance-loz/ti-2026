import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { completedSeriesFromMaps } from "../server/live-series.mjs";
import { scheduledSeriesFromCybersportHtml } from "../server/schedule-source.mjs";
import { buildForecastSource, ROUND_ONE, runForecast, SWISS_GROUPS, SWISS_GROUP_BY_TEAM, swissBucketKey, topGroupScenarios } from "../server/forecast-engine.mjs";
import { combineDraftSignals } from "../server/draft-combiner.mjs";
import { predictTemporalDraft } from "../server/draft-inference.mjs";
import { bestOfProbability, convertSeriesProbability } from "../server/team-model.mjs";
import { assessPredictionConfidence } from "../server/prediction-confidence.mjs";
import { externalFeatureDecision, pearsonCorrelation } from "../server/external-feature-gate.mjs";
import { normalizeDatdotaPayload } from "../scripts/sync-datdota-source.mjs";
import { predictionDecision, sharpenProbability } from "../server/prediction-decision.mjs";

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
  assert.equal(report.combiner.version, 2);
  assert.ok(report.dataset.frozenHoldoutMaps >= 10_000);
  assert.ok(report.metrics.frozenHoldout.model.logLoss < report.metrics.frozenHoldout.teamSide.logLoss);
  assert.ok(report.metrics.frozenHoldout.model.brier < report.metrics.frozenHoldout.teamSide.brier);
  assert.ok(report.bootstrap.frozenHoldoutVersusTeamSide.upper95 < 0);
  assert.equal(report.deployment.frozenHoldoutGatePassed, true);
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
  assert.deepEqual(stats.activeSnapshot.featureContract, ["teamPrior", "side", "hero", "synergy", "counter", "teamPool", "playerPool", "roles"]);
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

test("Cybersport schedule becomes official pre-match series", () => {
  const html = `<div class="tab_x isActive_y"><span>Раунд 2</span></div>
    <div>14.08.26 в 08:00<img alt="PARIVISION"><img alt="Nigma Galaxy"><span class="vs_pcDDl">vs</span><img alt="BetBoom"></div>
    <div>14.08.26 в 11:00<img alt="Team Spirit"><img alt="Xtreme Gaming"><span class="vs_pcDDl">vs</span></div>`;
  assert.deepEqual(scheduledSeriesFromCybersportHtml(html), [
    { teamA: "parivision", teamB: "nigma", round: 2, scheduledAt: "2026-08-14T05:00:00.000Z", source: "cybersport" },
    { teamA: "spirit", teamB: "xtreme", round: 2, scheduledAt: "2026-08-14T08:00:00.000Z", source: "cybersport" },
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
  assert.match(page, /setAdaptiveRun\(true\)/);
  assert.match(page, /500000, 1000000/);
  assert.match(page, /forecast-client-worker\.ts\?worker/);
});

test("conditional branches freeze ratings and compare probabilistic outcomes", async () => {
  const page = await readFile("app/page.tsx", "utf8");
  assert.doesNotMatch(page, /чемпион ветки/);
  assert.match(page, /КАК РЕЗУЛЬТАТ ИЗМЕНИТ ТУРНИРНЫЕ ШАНСЫ/);
  assert.match(page, /runSimulationInWorker\(forecastSource, iterations, seed/);
  assert.match(page, /Рейтинг команд заморожен/);
  assert.match(page, /Существенного влияния на чемпионство не обнаружено/);
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
  for (const file of ["all-pro-team-model.json", "draft-nextgen-model.json", "nextgen-series-calibration.json"]) assert.match(dockerfile, new RegExp(file.replaceAll(".", "\\.")));
  assert.match(compose, /ALL_PRO_TEAM_MODEL: \/app\/model\/all-pro-team-model\.json/);
  assert.match(api, /\/api\/models\/nextgen/);
  assert.match(api, /activeForecastUnchanged: true/);
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
  assert.equal(assessPredictionConfidence(null, 50, { fixed: true }).roulette, false);
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
