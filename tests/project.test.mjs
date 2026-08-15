import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { completedSeriesFromMaps } from "../server/live-series.mjs";
import { liveDraftsFromOpenDota, mergeLiveDraftGames } from "../server/live-drafts.mjs";
import { scheduledSeriesFromCybersportHtml } from "../server/schedule-source.mjs";
import { buildForecastSource, resolveTournamentCalibration, ROUND_ONE, runForecast, SWISS_GROUPS, SWISS_GROUP_BY_TEAM, swissBucketKey, topGroupScenarios } from "../server/forecast-engine.mjs";
import { calculateActiveDraftPrediction } from "../server/active-draft-service.mjs";
import { combineDraftSignals } from "../server/draft-combiner.mjs";
import { predictTemporalDraft } from "../server/draft-inference.mjs";
import { bestOfProbability, convertSeriesProbability } from "../server/team-model.mjs";
import { assessPredictionConfidence } from "../server/prediction-confidence.mjs";
import { externalFeatureDecision, pearsonCorrelation } from "../server/external-feature-gate.mjs";
import { normalizeDatdotaPayload } from "../scripts/sync-datdota-source.mjs";
import { predictionDecision, sharpenProbability } from "../server/prediction-decision.mjs";
import { latestOfficialBaseline, latestSnapshotForHistoryRow, visibleSnapshotHistory } from "../server/snapshot-history.mjs";
import { evaluateLiveSeriesChronologically, seriesEvidenceWeight, updateProbabilitiesWithLiveSeries } from "../server/live-team-update.mjs";
import { buildSnapshotCalculationTrace } from "../server/forecast-diagnostics.mjs";
import { assessLiveMap, estimateLiveMap } from "../server/live-map-prediction.mjs";
import { combinedSeriesForecast, exactSeriesScores, orientedProbability } from "../server/combined-forecast.mjs";
import { predictionTimeliness, projectPlayoffBracket } from "../server/projected-bracket.mjs";
import { selectProductionVariant } from "../server/model-gate.mjs";

async function availablePort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitForHealth(baseUrl, child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`API exited before health check with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The listener may not be bound yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("API health check timed out");
}

async function waitForForecastJob(baseUrl, jobId, { cookie = "", timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/forecast/jobs/${encodeURIComponent(jobId)}`, {
      headers: cookie ? { cookie } : {},
    });
    assert.equal(response.status, 200);
    const { job } = await response.json();
    if (["ready", "error", "canceled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`forecast job ${jobId} did not finish within ${timeoutMs}ms`);
}

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

test("combined forecast converts its declared BO3 or BO5 source before target-series scoring", () => {
  const fromBo3 = combinedSeriesForecast({ teamA: "a", teamB: "b", seriesProbabilityA: .65, sourceBestOf: 3, bestOf: 5 });
  assert.equal(fromBo3.sourceBestOf, 3);
  assert.equal(fromBo3.bestOf, 5);
  assert.ok(Math.abs(fromBo3.probabilityA - convertSeriesProbability(.65, 3, 5)) < 1e-12);
  assert.ok(Math.abs(fromBo3.targetSeriesProbabilityA - fromBo3.probabilityA) < 1e-12);

  const fromBo5 = combinedSeriesForecast({ teamA: "a", teamB: "b", seriesProbabilityA: .72, sourceBestOf: 5, bestOf: 3 });
  assert.equal(fromBo5.sourceBestOf, 5);
  assert.equal(fromBo5.bestOf, 3);
  assert.ok(Math.abs(fromBo5.probabilityA - convertSeriesProbability(.72, 5, 3)) < 1e-12);
});

test("exact score distribution is normalized, ranked and excludes impossible conditional outcomes", () => {
  const preSeries = combinedSeriesForecast({ teamA: "a", teamB: "b", seriesProbabilityA: .63, bestOf: 5 });
  assert.equal(preSeries.exactScores.length, 6);
  assert.ok(Math.abs(preSeries.exactScores.reduce((sum, row) => sum + row.probability, 0) - 1) < 1e-12);
  assert.deepEqual(preSeries.topExactScores, preSeries.exactScores.slice(0, 5));
  assert.ok(preSeries.exactScores.every((row, index, rows) => index === 0 || rows[index - 1].probability >= row.probability));

  const conditional = exactSeriesScores({ bestOf: 5, winsA: 2, winsB: 1, baseMapProbabilityA: .6 });
  assert.deepEqual(new Set(conditional.map((row) => row.score)), new Set(["3:1", "3:2", "2:3"]));
  assert.ok(Math.abs(conditional.reduce((sum, row) => sum + row.probability, 0) - 1) < 1e-12);
  assert.deepEqual(exactSeriesScores({ bestOf: 5, winsA: 3, winsB: 1, baseMapProbabilityA: .6 }), [{ score: "3:1", probability: 1 }]);
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
  const [api, page, tournamentPage, styles, checkpoint, modelGate] = await Promise.all([
    readFile("server/api.mjs", "utf8"), readFile("app/combined/page.tsx", "utf8"), readFile("app/page.tsx", "utf8"), readFile("app/globals.css", "utf8"), readFile("scripts/checkpoint-production.mjs", "utf8"), readFile("server/model-gate.mjs", "utf8"),
  ]);
  assert.match(api, /CREATE TABLE IF NOT EXISTS tournament_maps/);
  assert.match(api, /CREATE TABLE IF NOT EXISTS bet_locks/);
  assert.match(api, /UNIQUE\(scope,subject_id\)/);
  assert.match(api, /bet_already_locked/);
  assert.match(api, /\/api\/combined/);
  assert.match(api, /ready\.readModel\?\.inputHash !== combinedInputHash\(opinionWeight\)/);
  assert.match(api, /\/api\/admin\/bet-locks/);
  assert.match(api, /hydrateTournamentMapDetails/);
  assert.match(api, /decisionHistory/);
  assert.match(page, /Я поставил по рекомендации/);
  assert.match(page, /СТАВКА ЗАФИКСИРОВАНА/);
  assert.match(page, /История команд и матчи по раундам/);
  assert.match(page, /setViewMode\("teams"\)/);
  assert.match(page, /setViewMode\("rounds"\)/);
  assert.match(page, /ПРОГНОЗ СБЫЛСЯ/);
  assert.match(page, /ПРОГНОЗ НЕ СБЫЛСЯ/);
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
  assert.match(api, /match\.winner && historicalProbabilityA !== null/);
  assert.match(api, /projectedMatchupState/);
  assert.match(api, /combined_matchup_distribution/);
  assert.match(api, /simulation,/);
  assert.match(page, /function TournamentProjection/);
  assert.match(page, /MONTE CARLO · SWISS → СТЫКИ → PLAYOFF/);
  assert.match(page, /simulation\.iterations\.toLocaleString/);
  assert.match(page, /БУДУЩИЕ ПАРЫ SWISS/);
  assert.match(page, /ELIMINATION ROUND · 5 СЛОТОВ/);
  assert.match(page, /Строится новая миллионная ревизия/);
  assert.match(modelGate, /adaptive_failed_production_gate/);
  assert.match(page, /MAIN = \{comparison\.selected\.toUpperCase\(\)\}/);
  assert.match(page, /const \[expandedMatches, setExpandedMatches\]/);
  assert.match(page, /fusion-series-row/);
  assert.match(page, /ДВА ПОНЯТНЫХ СРЕЗА/);
  assert.match(page, /const isOpen = Boolean\(expanded\[String\(row\.match\.id\)\]\)/);
  assert.match(page, /fusion-matrix-progress/);
  assert.match(page, /из \{rows\.length\} матчей/);
  assert.match(styles, /@media\(min-width:1100px\)/);
  assert.match(styles, /\.fusion-swiss-layout\{/);
  assert.match(page, /function RouletteRisk/);
  assert.match(page, /const isLowConfidence = .* < \.58/);
  assert.match(tournamentPage, /export \{ default \} from "\.\/combined\/page"/);
  assert.match(page, /UPPER_PLACEMENT/);
  assert.match(page, /LOWER_PLACEMENT/);
  assert.match(page, /Точный счёт/);
  assert.match(page, /ТЕКУЩАЯ КАРТА/);
  assert.match(page, /Number\.POSITIVE_INFINITY/);
  assert.match(page, /row\.forecast\.winsA \+ row\.forecast\.winsB \+ 1/);
  assert.match(page, /Draft-прогноз ещё не сохранён/);
  assert.match(page, /ПО ПИКАМ/);
  assert.match(page, /онлайн-состояние карты/);
  assert.match(checkpoint, /Checkpoint refused/);
  assert.match(checkpoint, /backup\(source/);
});

test("active draft prediction is server-calculated, validates picks and preserves partial completeness", async () => {
  const draftStats = {
    heroes: [1, 2, 3, 4].map((id) => ({ id, modelWinRate: id <= 2 ? 55 : 45 })),
    radiantWinRate: 52,
    teams: {},
    synergy: {},
    counters: {},
  };
  const teamStats = { pairwise: { "falcons|parivision": { mapProbabilityA: 60 } } };
  const game = { radiantTeam: "falcons", direTeam: "parivision", radiantPicks: [1, 2], direPicks: [3, 4], radiantPlayers: [], direPlayers: [] };
  const prediction = calculateActiveDraftPrediction({ draftStats, teamStats, game });
  assert.equal(prediction.modelId, "active-draft-combiner-v1");
  assert.equal(prediction.completeness, .4);
  assert.equal(prediction.temporalWeight, 0);
  assert.equal(prediction.nextgenWeight, 0);
  assert.deepEqual(prediction.signals.map((signal) => signal.key), ["side", "hero", "draftPriority", "synergy", "counter", "teamPool", "playerPool", "roles"]);
  assert.ok(prediction.probabilityRadiant > .5 && prediction.probabilityRadiant < 1);
  assert.throws(() => calculateActiveDraftPrediction({ draftStats, teamStats, game: { ...game, direPicks: [2, 4] } }), /invalid_picks/);

  const api = await readFile("server/api.mjs", "utf8");
  assert.match(api, /calculateActiveDraftPrediction\(\{ draftStats: loadJson\("public\/draft-stats\.json"\), teamStats: loadJson\("public\/team-stats\.json"\), game \}\)/);
  assert.match(api, /INSERT OR IGNORE INTO live_draft_predictions/);
  assert.match(api, /existing && existing\.picksHash !== picksHash/);
  assert.match(api, /function sameCompleteDraft/);
  assert.match(api, /storedDraftMatchesGame/);
  assert.match(api, /canonicalPicks\(game\.radiantPicks\)/);
  assert.match(api, /game\.phase === "game" \? 1 : 2/);
  assert.match(api, /liveEstimate,/);
  assert.match(api, /liveDraftHistoryMatch/);
  assert.match(api, /draftPredictionCorrect/);
  assert.match(api, /livePredictionCorrect/);
});

test("combined API publishes explicit STATIC/MAIN and shadow-model policy metadata", async () => {
  const api = await readFile("server/api.mjs", "utf8");
  assert.match(api, /modelComparison\?\.selected === "static" \? mainSnapshot\?\.baselineProbabilities/);
  assert.match(api, /modelComparison\?\.selected === "static" \? mainSnapshot\?\.baselineResult/);
  assert.match(api, /activeDraft: "published_main_weight_1"/);
  assert.match(api, /temporalDraft: "shadow_weight_0"/);
  assert.match(api, /nextgen: "shadow_weight_0"/);
  assert.match(api, /probabilitySet: modelComparison\?\.selected \?\? "adaptive"/);
});

test("combined UI keeps unique match rows, live rail, unique elimination slots and mobile hooks", async () => {
  const [page, styles, layout] = await Promise.all([readFile("app/combined/page.tsx", "utf8"), readFile("app/globals.css", "utf8"), readFile("app/layout.tsx", "utf8")]);
  assert.match(page, /rows\.filter\(\(row\) => row\.match\.round === round\)\.map/);
  assert.match(page, /<article key=\{row\.match\.id\} className=\{`fusion-series-row/);
  assert.match(page, /const liveRows = rows\.filter\(\(row\) => row\.live && !row\.match\.winner\)/);
  assert.match(page, /POST-DRAFT · FROZEN/);
  assert.match(page, /подтверждение пиков/);
  assert.match(page, /const usedTeams = new Set<string>\(\)/);
  assert.match(page, /usedTeams\.has\(row\.match\.team_a\) \|\| usedTeams\.has\(row\.match\.team_b\)/);
  assert.match(page, /usedTeams\.has\(match\.teamA\) \|\| usedTeams\.has\(match\.teamB\)/);
  assert.match(page, /Array\.from\(\{ length: 5 \}/);
  assert.match(page, /fusion-scroll-hint/);
  assert.match(styles, /@media\(max-width:900px\)/);
  assert.match(styles, /@media\(max-width:560px\)/);
  assert.match(styles, /\.fusion-live-grid\{/);
  assert.match(styles, /\.fusion-elimination/);
  assert.match(page, /function ThemeToggle/);
  assert.match(page, /fusion-mobile-team-history/);
  assert.match(page, /pathname === "\/combined"/);
  assert.match(styles, /:root\[data-theme=dark\]/);
  assert.match(styles, /--fusion-canvas:#f3f1ea/);
  assert.match(layout, /data-theme="light"/);
  assert.match(layout, /ti26-theme/);
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

test("online evaluator emits production-identical predictions before update", () => {
  const rows = [
    { seriesId: "1", leagueId: 9, startTime: 1, targetLineup: "a", opponentLineup: "b", wins: 2, losses: 0, outcome: 1, frozen: .5 },
    { seriesId: "2", leagueId: 9, startTime: 2, targetLineup: "a", opponentLineup: "c", wins: 1, losses: 2, outcome: 0, frozen: .5 },
  ];
  const evaluated = evaluateLiveSeriesChronologically(rows, { liveGlobal: .3, probabilityFor: (row) => row.frozen });
  const production = updateProbabilitiesWithLiveSeries(
    { "a|b": 50, "a|c": 50 },
    [{ team_a: "a", team_b: "b", winner: "a", score_a: 2, score_b: 0 }],
    { liveGlobal: .3 },
  );
  assert.equal(evaluated[0].probability, .5);
  assert.ok(Math.abs(evaluated[1].probability - production["a|c"] / 100) < 1e-12);
});

test("tournament runtime activates only individually passed gates", () => {
  const stats = {
    tournamentCalibration: {
      selected: { liveGlobal: .2, probabilityTemperature: 1, formLogitSd: .16, seriesNoiseLogitSd: 0 },
      shadow: { liveGlobal: .3, formLogitSd: .28 },
      validation: { gates: { onlineUpdate: { passed: false }, formUncertainty: { passed: false } } },
    },
  };
  assert.deepEqual(resolveTournamentCalibration(stats), {
    liveGlobal: 0,
    probabilityTemperature: 1,
    formLogitSd: 0,
    seriesNoiseLogitSd: 0,
    shadowLiveGlobal: .3,
    shadowFormLogitSd: .28,
  });
});

test("tournament calibration replays the production updater before every outcome", async () => {
  const calibration = await readFile("scripts/calibrate-tournament-variance.mjs", "utf8");
  assert.match(calibration, /import \{ evaluateLiveSeriesChronologically \} from "\.\.\/server\/live-team-update\.mjs"/);
  assert.match(calibration, /evaluateLiveSeriesChronologically\(data,\s*\{[\s\S]*probabilityFor: \(row\) => row\[selectedModelId\]/);
  assert.match(calibration, /predictionsStrictlyBeforeUpdate: true/);
  assert.match(calibration, /evaluator: "server\/live-team-update\.mjs#evaluateLiveSeriesChronologically"/);
});

test("current TI results have one shared update path and appear in team history", async () => {
  const [page, api] = await Promise.all([readFile("app/page.tsx", "utf8"), readFile("server/api.mjs", "utf8")]);
  const engine = await readFile("server/forecast-engine.mjs", "utf8");
  const stats = JSON.parse(await readFile("public/team-stats.json", "utf8"));
  assert.equal(stats.methodology.liveLeagueExcludedFromBaseline, 19719);
  assert.match(page, /combined\/page/);
  assert.match(engine, /updateProbabilitiesWithLiveSeries\(base, matches/);
  assert.match(api, /currentForecast/);
  assert.match(api, /onlineSeriesCount/);
  assert.doesNotMatch(engine, /strength\[match\.team_a\].*surprise/);
});

test("saved forecast diagnostics freeze coefficients, pair decomposition and live-series influence", () => {
  const stats = {
    generatedAt: "2026-08-10T00:00:00.000Z",
    periodStart: "2025-08-10T00:00:00.000Z",
    totals: { uniqueAcceptedGames: 500 },
    methodology: { recencyHalfLifeDays: 45, seriesInformation: { multiMapBase: .72, decisiveBonus: .28 } },
    tournamentCalibration: {
      selected: { liveGlobal: .3, probabilityTemperature: 1, formLogitSd: 0, seriesNoiseLogitSd: 0 },
      shadow: { liveGlobal: .3, formLogitSd: 0 },
      validation: { gates: { onlineUpdate: { passed: true }, formUncertainty: { passed: false } } },
    },
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
  const [page, api] = await Promise.all([readFile("app/admin/page.tsx", "utf8"), readFile("server/api.mjs", "utf8")]);
  assert.match(page, /\/api\/snapshots\/\$\{snapshot\.id\}\/export/);
  assert.match(page, /Snapshots и diagnostics/);
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
  assert.equal(stats.tournamentCalibration.schemaVersion, 3);
  assert.equal(stats.tournamentCalibration.selected.liveGlobal > 0, stats.tournamentCalibration.validation.gates.onlineUpdate.passed);
  assert.equal(stats.tournamentCalibration.selected.formLogitSd > 0, stats.tournamentCalibration.validation.gates.formUncertainty.passed);
  assert.equal("liveRematch" in stats.tournamentCalibration.selected, false);
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
  const [page, service] = await Promise.all([readFile("app/components/live_map_story.tsx", "utf8"), readFile("server/active-draft-service.mjs", "utf8")]);
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
  assert.match(page, /Что изменило прогноз после пиков/);
  assert.match(page, /Контрпики и синергии/);
  assert.match(page, /Игроки на героях/);
  assert.match(server, /scripts\/update-all-stats\.mjs/);
  assert.match(server, /\/api\/draft\/predict/);
  assert.match(service, /score\(exact, "observed"\)/);
  assert.match(service, /score\(best\.rows, "inferred"\)/);
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
  assert.deepEqual(series[0], { seriesId: "99", teamA: "1w", teamB: "nigma", winsA: 2, winsB: 0, startTime: 100, seriesType: 1, mapIds: [1, 2], bestOf: 3 });
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

test("temporary empty live responses retain the active map but completed maps disappear immediately", () => {
  const game = { matchId: "42", serverSeenAt: "2026-08-15T12:00:00.000Z", radiantTeam: "falcons", direTeam: "parivision" };
  const retained = mergeLiveDraftGames([], [game], [], {
    fetchedAt: "2026-08-15T12:01:00.000Z",
    previousFetchedAt: "2026-08-15T12:00:00.000Z",
    graceSeconds: 120,
  });
  assert.equal(retained.length, 1);
  assert.equal(retained[0].retained, true);
  assert.equal(retained[0].stale, true);
  assert.deepEqual(mergeLiveDraftGames([], [game], [{ match_id: 42, radiant_win: true }], {
    fetchedAt: "2026-08-15T12:01:00.000Z",
    graceSeconds: 120,
  }), []);
  assert.deepEqual(mergeLiveDraftGames([], [game], [], {
    fetchedAt: "2026-08-15T12:03:00.001Z",
    graceSeconds: 120,
  }), []);
});

test("live map model distinguishes validated checkpoints from interpolation and never extrapolates after 20", async () => {
  const model = JSON.parse(await readFile("public/live-map-model.json", "utf8"));
  const baseGame = { phase: "game", gameTime: 15 * 60, radiantLead: 5_000, radiantScore: 14, direScore: 8, radiantTeam: "falcons", direTeam: "parivision", lastUpdateAt: new Date().toISOString() };
  const radiant = estimateLiveMap(model, { draftProbabilityRadiant: 0.55, game: baseGame });
  const flipped = estimateLiveMap(model, { draftProbabilityRadiant: 0.45, game: { ...baseGame, radiantLead: -5_000, radiantScore: 8, direScore: 14, radiantTeam: "parivision", direTeam: "falcons" } });
  assert.ok(radiant.liveProbabilityRadiant > 0.55);
  assert.ok(Math.abs(radiant.liveProbabilityRadiant + flipped.liveProbabilityRadiant - 1) < 1e-12);
  assert.equal(estimateLiveMap(model, { draftProbabilityRadiant: 0.55, game: { ...baseGame, gameTime: 599 } }).liveProbabilityRadiant, null);
  assert.deepEqual(Object.keys(model.validation.minuteGates).map(Number), [10, 15, 20]);
  for (const minute of [10, 15, 20]) {
    const estimate = estimateLiveMap(model, { draftProbabilityRadiant: 0.55, game: { ...baseGame, gameTime: minute * 60 } });
    assert.equal(model.validation.minuteGates[String(minute)], true);
    assert.equal(estimate.availability, "validated_fixed_window");
    assert.ok(Number.isFinite(estimate.liveProbabilityRadiant));
  }
  const interpolatedMinute = estimateLiveMap(model, { draftProbabilityRadiant: 0.55, game: { ...baseGame, gameTime: 12 * 60 } });
  assert.equal(interpolatedMinute.availability, "validated_window_interpolation");
  assert.ok(Number.isFinite(interpolatedMinute.liveProbabilityRadiant));
  const afterValidatedRange = estimateLiveMap(model, { draftProbabilityRadiant: 0.55, game: { ...baseGame, gameTime: 21 * 60 } });
  assert.equal(afterValidatedRange.availability, "outside_validated_range_after_20");
  assert.equal(afterValidatedRange.liveProbabilityRadiant, null);
  assert.equal(assessLiveMap({ ...baseGame, gameTime: 20 * 60, radiantLead: 16_000 }).guard, "state_already_decided");
  assert.ok(model.test.model.logLoss < model.test.frozenPrior.logLoss);
  assert.equal(model.validation.gatePassed, true);
  assert.equal(model.provenance.servingPriorParity, true);
});

test("unified home loads server-owned live history and draft evidence", async () => {
  const [page, story, redirect] = await Promise.all([readFile("app/combined/page.tsx", "utf8"), readFile("app/components/live_map_story.tsx", "utf8"), readFile("app/drafts/page.tsx", "utf8")]);
  const api = await readFile("server/api.mjs", "utf8");
  assert.match(page, /LiveMapStory/);
  assert.match(story, /\/api\/draft\/live\/history\//);
  assert.match(story, /SERVER-FROZEN EVIDENCE/);
  assert.match(story, /fusion-chart-live/);
  assert.match(redirect, /window\.location\.replace\("\/#live"\)/);
  assert.match(api, /OPENDOTA_API_URL}\/live/);
  assert.match(api, /OPENDOTA_API_URL}\/leagues\/\$\{TI_LEAGUE_ID\}\/matches/);
  assert.match(api, /liveDraftsFromOpenDota/);
  assert.match(api, /live_draft_snapshots/);
  assert.match(api, /live_draft_predictions/);
  assert.match(api, /evidence_json/);
  assert.match(api, /overlayCombinedLive/);
  assert.match(api, /overlayCombinedLive\(ready\)/);
  assert.match(api, /overlayCombinedLive\(fallback\)/);
  assert.match(api, /SELECT match_id,picks_hash,captured_at FROM live_draft_predictions/);
  assert.doesNotMatch(api, /JSON\.stringify\(\{ opinionWeight: Number\(opinionWeight\), latestSnapshot, matches, locks, drafts, liveFetchedAt \}\)/);
  assert.match(api, /setInterval\(refreshLiveDraftCache/);
  assert.doesNotMatch(api, /refreshLiveDraftCache[\s\S]{0,120}materializeCombinedForecast/);
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
  assert.deepEqual(completedSeriesFromMaps(maps)[0], { seriesId: "199", teamA: "1w", teamB: "nigma", winsA: 2, winsB: 0, startTime: 100, seriesType: 1, mapIds: [11, 12], bestOf: 3 });
});

test("Iron Wing OpenDota team ID resolves to current 1w roster", () => {
  const maps = [
    { match_id: 21, series_id: 299, start_time: 100, radiant_team_id: 10150413, dire_team_id: 10136357, radiant_win: true },
    { match_id: 22, series_id: 299, start_time: 200, radiant_team_id: 10136357, dire_team_id: 10150413, radiant_win: false },
  ];
  assert.deepEqual(completedSeriesFromMaps(maps)[0], { seriesId: "299", teamA: "1w", teamB: "nigma", winsA: 2, winsB: 0, startTime: 100, seriesType: 1, mapIds: [21, 22], bestOf: 3 });
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
    { teamA: "parivision", teamB: "nigma", round: 2, scheduledAt: "2026-08-14T05:00:00.000Z", scheduledDate: "2026-08-14", stage: "swiss", source: "cybersport" },
    { teamA: "spirit", teamB: "xtreme", round: 2, scheduledAt: "2026-08-14T08:00:00.000Z", scheduledDate: "2026-08-14", stage: "swiss", source: "cybersport" },
  ]);
});

test("time-less Swiss card keeps its semantic round stage", () => {
  const html = `<h2>Расписание</h2>
    <div class="tab_x isActive_y"><span>Раунд 5</span></div>
    <div class="item_a"><div class="date_x"><span>LIVE</span></div><div class="participant_a"><img alt="LGD"></div><div class="participant_b"><img alt="Vici Gaming"></div><span>0:0</span></div>
    <div id="stage-participants"></div>`;
  assert.deepEqual(scheduledSeriesFromCybersportHtml(html), [
    { teamA: "lgd", teamB: "vg", round: 5, scheduledAt: null, scheduledDate: null, stage: "swiss", source: "cybersport" },
  ]);
});

test("semantic Elimination Round parsing preserves nullable LIVE and time-less timestamps", () => {
  const html = `<h2>Расписание</h2>
    <div class="tab_x isActive_y"><span>Elimination Round</span></div>
    <div class="item_a"><div class="date_x">Сегодня в 13:00</div><div class="participant_a"><img alt="Falcons"></div><div class="participant_b"><img alt="PARIVISION"></div><span class="vs_x">vs</span><img alt="BetBoom"></div>
    <div class="item_b"><div class="date_x"><span>LIVE</span></div><div class="participant_a"><img alt="OG"></div><div class="participant_b"><img alt="Nigma"></div><span>0:0</span></div>
    <div class="item_c"><div class="date_x"></div><div class="participant_a"><img alt="Liquid"></div><div class="participant_b"><img alt="Yandex"></div><span class="vs_x">vs</span></div>
    <div id="stage-participants"></div>`;
  assert.deepEqual(scheduledSeriesFromCybersportHtml(html, { now: new Date("2026-08-13T10:15:00.000Z") }), [
    { teamA: "falcons", teamB: "parivision", round: 1, scheduledAt: "2026-08-13T10:00:00.000Z", scheduledDate: "2026-08-13", stage: "playin", source: "cybersport" },
    { teamA: "og", teamB: "nigma", round: 1, scheduledAt: null, scheduledDate: null, stage: "playin", source: "cybersport" },
    { teamA: "liquid", teamB: "yandex", round: 1, scheduledAt: null, scheduledDate: null, stage: "playin", source: "cybersport" },
  ]);
});

test("L1 TEAM sponsorship-safe name resolves to L1ga", () => {
  const html = `<div class="tab_x isActive_y"><span>Раунд 3</span></div>
    <div>15.08.26 в 14:00<img alt="L1 TEAM"><img alt="Team Liquid"><span class="vs_pcDDl">vs</span></div>`;
  assert.deepEqual(scheduledSeriesFromCybersportHtml(html), [
    { teamA: "l1ga", teamB: "liquid", round: 3, scheduledAt: "2026-08-15T11:00:00.000Z", scheduledDate: "2026-08-15", stage: "swiss", source: "cybersport" },
  ]);
});

test("Tundra schedule name resolves to transferred 1w roster", () => {
  const html = `<div class="tab_x isActive_y"><span>Раунд 2</span></div>
    <div>14.08.26 в 14:00<img alt="Tundra Esports"><img alt="Team Spirit"><span class="vs_pcDDl">vs</span></div>`;
  assert.deepEqual(scheduledSeriesFromCybersportHtml(html), [
    { teamA: "1w", teamB: "spirit", round: 2, scheduledAt: "2026-08-14T11:00:00.000Z", scheduledDate: "2026-08-14", stage: "swiss", source: "cybersport" },
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
  assert.equal(result.formatVersion, "hidden-groups-r1-r3-playoff-v7-partial-official-playins");
  assert.equal(result.convergence.stopReason, "fixed_budget");
  assert.equal(result.convergence.checkpoints.at(-1).iterations, 100);
  assert.deepEqual(result.calibration, resolveTournamentCalibration(stats));
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
  assert.ok(result.swissMatchups.length > 0);
  assert.ok(result.swissMatchups.some((matchup) => matchup.round === 4 && matchup.probability > 0));
  assert.ok(result.swissMatchups.every((matchup) => matchup.a !== matchup.b && matchup.aWinProbability >= 0 && matchup.aWinProbability <= 100));
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

test("partial official play-ins constrain their known result without duplicating a slot", async () => {
  const stats = JSON.parse(await readFile("public/team-stats.json", "utf8"));
  const probabilities = buildForecastSource({ answers: {}, stats, matches: [], mode: "stats", opinionWeight: 0 });
  const official = { id: 901, stage: "playin", round: 1, team_a: "aurora", team_b: "gamerlegion", winner: "aurora" };
  const result = runForecast(probabilities, 2_000, 13579, { stats, matches: [official] });
  const matchup = result.playinMatchups.find((item) => item.a === "aurora" && item.b === "gamerlegion");
  assert.ok(matchup, "the official pair should occur when both teams reach play-ins");
  assert.equal(matchup.aWinProbability, 100);
  assert.ok(matchup.probability > 0 && matchup.probability <= 100);
  assert.equal(result.playinProjectionScope, "marginal_matchups_with_official_constraints");
  assert.ok(result.scenarios.every((scenario) => new Set([...scenario.direct40, ...scenario.direct41, ...scenario.via]).size === 8));
});

test("scenario UI never renders outcomes contradicted by known Swiss records", async () => {
  const [page, engine] = await Promise.all([readFile("app/combined/page.tsx", "utf8"), readFile("server/forecast-engine.mjs", "utf8")]);
  assert.match(page, /simulation\.scenarios\.slice\(0, 3\)/);
  assert.doesNotMatch(page, /runForecast/);
  assert.match(engine, /play\(match\.team_a, match\.team_b, match\.winner\)/);
});

test("official pairing changes enqueue canonical scenario refresh jobs with deterministic live inputs", async () => {
  const api = await readFile("server/api.mjs", "utf8");
  assert.match(api, /queueAutomaticSnapshot\(officialPairingTrigger\(\)\)/);
  assert.match(api, /auto_pairing_/);
  assert.match(api, /pendingAutomaticSnapshotTrigger/);
  assert.match(api, /for \(const weight of FORECAST_CANONICAL_WEIGHTS\) \{[\s\S]*enqueueForecastJob\(\{[\s\S]*kind: "scenario_refresh"/);
  assert.match(api, /profile: \{ forecastMode: weight \? "mixed" : "stats", opinionWeight: weight, answers: weight \? canonicalAnswers : \{\} \}/);
  assert.match(api, /matchesLiveSignature: liveConstraintSignature\(matches\)/);
  assert.match(api, /const inputHash = createHash\("sha256"\)\.update\(stableJson\(seedMaterial\)\)\.digest\("hex"\)/);
  assert.match(api, /const jobKey = `forecast:\$\{kind\}:\$\{input\.inputHash\}`/);
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
  const { actual, progress } = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../server/forecast-worker.mjs", import.meta.url), { workerData: { probabilities, minimum: 100, seed: 987, matches: [], stats, adaptive: null } });
    const progress = [];
    worker.on("message", (message) => {
      if (message?.progress) {
        progress.push(message.progress);
        return;
      }
      if (message?.ok === true) resolve({ actual: message.result, progress });
      else reject(new Error(message?.error || "forecast_worker_failed"));
    });
    worker.once("error", reject);
  });
  assert.deepEqual(progress, [{ current: 0, total: 100 }, { current: 100, total: 100 }]);
  assert.deepEqual(actual.teams, expected.teams);
  assert.deepEqual(actual.convergence, expected.convergence);
});

test("unified forecast UI reads authoritative snapshots without browser-triggered scenario jobs", async () => {
  const [page, admin, api] = await Promise.all([readFile("app/combined/page.tsx", "utf8"), readFile("app/admin/page.tsx", "utf8"), readFile("server/api.mjs", "utf8")]);
  const styles = await readFile("app/globals.css", "utf8");
  assert.doesNotMatch(page, /forecast-client-worker/);
  assert.doesNotMatch(page, /import\s+\{?\s*runForecast/);
  assert.match(page, /fetch\(`\/api\/combined/);
  assert.match(page, /document\.visibilityState === "visible"/);
  assert.doesNotMatch(page, /browser_scenario_refresh/);
  assert.match(admin, /kind: "manual"/);
  assert.match(api, /queueAutomaticSnapshot/);
  assert.match(api, /materializeCombinedForecast/);
  assert.match(page, /predictionCorrect/);
  assert.match(styles, /\.fusion-result-square\.is-correct/);
  assert.match(styles, /\.fusion-result-square\.is-wrong/);
});

test("conditional branches remain server-authoritative and admin-gated", async () => {
  const [page, api] = await Promise.all([readFile("app/combined/page.tsx", "utf8"), readFile("server/api.mjs", "utf8")]);
  assert.doesNotMatch(page, /kind: "conditional"/);
  assert.match(api, /\(kind === "manual" \|\| kind === "conditional"\) && !isAdmin\(req\)/);
  assert.match(api, /conditionalMatchId/);
  assert.match(api, /FORECAST_CONDITIONAL_ITERATIONS/);
});

test("prediction audit keeps frozen and adaptive evaluations separate", async () => {
  const [page, api] = await Promise.all([readFile("app/combined/page.tsx", "utf8"), readFile("server/api.mjs", "utf8")]);
  const styles = await readFile("app/globals.css", "utf8");
  assert.match(api, /function snapshotDecisionEvaluation/);
  assert.match(api, /static: scoreDiagnosticMatch/);
  assert.match(api, /adaptive: scoreDiagnosticMatch/);
  assert.match(api, /timeline/);
  assert.match(api, /stages/);
  assert.match(page, /function AccuracyPanel/);
  assert.match(page, /ЧЕСТНАЯ ИСТОРИЯ · STATIC \/ ADAPTIVE/);
  assert.match(styles, /\.fusion-accuracy-chart/);
  assert.match(styles, /polyline\.is-adaptive/);
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
  for (const file of ["app/drafts/page.tsx", "app/intel/page.tsx", "app/admin/page.tsx", "app/combined/page.tsx"]) {
    const page = await readFile(file, "utf8");
    assert.doesNotMatch(page, /from ["']next\/link["']/);
    assert.match(page, /<a[^>]+href="\/(?:#live)?"[^>]*>/s);
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
  const page = await readFile("app/combined/page.tsx", "utf8");
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

test("admin API rejects a series bet lock after its scheduled start", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "ti2026-bet-lock-"));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server/api.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      API_PORT: String(port),
      DATA_DIR: dataDirectory,
      ADMIN_USERNAME: "regression-admin",
      ADMIN_PASSWORD: "regression-password",
      LIVE_SYNC_ENABLED: "false",
      LIVE_DRAFT_SYNC_ENABLED: "false",
      SCHEDULE_SYNC_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  try {
    await waitForHealth(baseUrl, child);
    const login = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "regression-admin", password: "regression-password" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);

    const createMatch = await fetch(`${baseUrl}/api/admin/matches`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        stage: "playin",
        round: 1,
        teamA: "aurora",
        teamB: "gamerlegion",
        scheduledAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    });
    assert.equal(createMatch.status, 201);
    const { id } = await createMatch.json();

    const lock = await fetch(`${baseUrl}/api/admin/bet-locks`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ scope: "series", subjectId: String(id), probabilityA: .6, recommendedWinner: "aurora" }),
    });
    assert.equal(lock.status, 409);
    assert.deepEqual(await lock.json(), { error: "bet_subject_started" });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nAPI output:\n${output}`);
  } finally {
    child.kill();
    if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
    await rm(dataDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("forecast jobs enforce authorization, idempotency, read models, cancellation and server authority", { timeout: 45_000 }, async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "ti2026-forecast-jobs-"));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server/api.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      API_PORT: String(port),
      DATA_DIR: dataDirectory,
      ADMIN_USERNAME: "forecast-admin",
      ADMIN_PASSWORD: "forecast-password",
      LIVE_SYNC_ENABLED: "false",
      LIVE_DRAFT_SYNC_ENABLED: "false",
      SCHEDULE_SYNC_ENABLED: "false",
      AUTO_SNAPSHOT_ITERATIONS: "10000",
      AUTO_SNAPSHOT_MAX_ITERATIONS: "10000",
      AUTO_SNAPSHOT_BATCH_SIZE: "10000",
      FORECAST_JOB_MIN_ITERATIONS: "10000",
      FORECAST_JOB_MAX_ITERATIONS: "10000",
      FORECAST_JOB_POLL_MS: "100",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  const postJob = (payload, cookie = "") => fetch(`${baseUrl}/api/forecast/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(payload),
  });

  try {
    await waitForHealth(baseUrl, child);

    for (const kind of ["manual", "conditional"]) {
      const response = await postJob({ kind, conditionalMatchId: 1, simulation: { iterations: 10_000 } });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "admin_required" });
    }

    const login = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "forecast-admin", password: "forecast-password" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);

    const scenarioPayload = {
      kind: "scenario_refresh",
      profile: { forecastMode: "stats", opinionWeight: 0, answers: {} },
      simulation: { iterations: 10_000, adaptive: false },
      trigger: "integration_scenario_refresh",
    };
    const firstScenarioResponse = await postJob(scenarioPayload, cookie);
    assert.ok([200, 202].includes(firstScenarioResponse.status));
    const { job: firstScenario } = await firstScenarioResponse.json();
    const duplicateScenarioResponse = await postJob(scenarioPayload, cookie);
    assert.ok([200, 202].includes(duplicateScenarioResponse.status));
    const { job: duplicateScenario } = await duplicateScenarioResponse.json();
    assert.equal(duplicateScenario.id, firstScenario.id);
    assert.equal(duplicateScenario.inputHash, firstScenario.inputHash);
    assert.match(firstScenario.id, /^forecast:scenario_refresh:[a-f0-9]{64}$/);
    assert.match(firstScenario.inputHash, /^[a-f0-9]{64}$/);

    const scenarioStatusResponse = await fetch(`${baseUrl}/api/forecast/jobs/${encodeURIComponent(firstScenario.id)}`);
    assert.equal(scenarioStatusResponse.status, 200);
    const { job: scenarioStatus } = await scenarioStatusResponse.json();
    assert.equal(scenarioStatus.kind, "scenario_refresh");
    assert.ok(["queued", "running", "ready"].includes(scenarioStatus.status));
    assert.deepEqual(Object.keys(scenarioStatus.progress).sort(), ["current", "total"]);

    const buildingReadModelResponse = await fetch(`${baseUrl}/api/forecast/read-model?opinionWeight=0`);
    assert.equal(buildingReadModelResponse.status, 200);
    const { readModel: buildingReadModel } = await buildingReadModelResponse.json();
    assert.equal(buildingReadModel.jobId, firstScenario.id);
    assert.equal(buildingReadModel.buildingInputHash ?? buildingReadModel.inputHash, firstScenario.inputHash);
    assert.ok(["running", "ready"].includes(buildingReadModel.status));

    const completedScenario = await waitForForecastJob(baseUrl, firstScenario.id);
    assert.equal(completedScenario.status, "ready");
    assert.equal(completedScenario.progress.current, completedScenario.progress.total);
    assert.equal(completedScenario.result.kind, "scenario_refresh");
    assert.equal(completedScenario.result.result.iterations, 10_000);

    const readyReadModelResponse = await fetch(`${baseUrl}/api/forecast/read-model?opinionWeight=0`);
    assert.equal(readyReadModelResponse.status, 200);
    const { readModel: readyReadModel } = await readyReadModelResponse.json();
    assert.equal(readyReadModel.status, "ready");
    assert.equal(readyReadModel.stale, false);
    assert.equal(readyReadModel.inputHash, firstScenario.inputHash);
    assert.equal(readyReadModel.payload.kind, "scenario_refresh");
    assert.equal(readyReadModel.payload.result.iterations, 10_000);

    const forgedClientResult = { forged: true, teams: [{ id: "client-owned" }] };
    const manualResponse = await postJob({
      kind: "manual",
      profile: { forecastMode: "mixed", opinionWeight: 10, answers: {} },
      simulation: { iterations: 10_000, adaptive: false },
      result: forgedClientResult,
      trigger: "integration_manual",
    }, cookie);
    assert.equal(manualResponse.status, 202);
    const { job: manualJob } = await manualResponse.json();
    const completedManual = await waitForForecastJob(baseUrl, manualJob.id, { cookie });
    assert.equal(completedManual.status, "ready");
    assert.equal(completedManual.result.kind, "manual");
    assert.equal(completedManual.result.result.teams.length, 16);
    assert.notDeepEqual(completedManual.result.result, forgedClientResult);
    assert.equal("forged" in completedManual.result.result, false);

    const cancelResponse = await postJob({
      kind: "manual",
      profile: { forecastMode: "personal", opinionWeight: 100, answers: { "1w|aurora": 61 } },
      simulation: { iterations: 10_000, adaptive: false },
      trigger: "integration_cancel",
    }, cookie);
    assert.equal(cancelResponse.status, 202);
    const { job: cancelJob } = await cancelResponse.json();
    const deleteResponse = await fetch(`${baseUrl}/api/forecast/jobs/${encodeURIComponent(cancelJob.id)}`, {
      method: "DELETE",
      headers: { cookie },
    });
    assert.equal(deleteResponse.status, 202);
    const canceledJob = await waitForForecastJob(baseUrl, cancelJob.id, { cookie });
    assert.equal(canceledJob.status, "canceled");
    assert.equal(canceledJob.error, "canceled");
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nAPI output:\n${output}`);
  } finally {
    child.kill();
    if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
    await rm(dataDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
