import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { evaluateLiveSeriesChronologically } from "../server/live-team-update.mjs";

const [rowsBuffer, teamModelBuffer, teamStatsBuffer] = await Promise.all([
  readFile("work/team-model-oof.json"),
  readFile("public/team-model.json"),
  readFile("public/team-stats.json"),
]);
const rows = JSON.parse(rowsBuffer);
const teamModel = JSON.parse(teamModelBuffer);
const teamStats = JSON.parse(teamStatsBuffer);
const selectedModelId = teamModel.selected.id;
const clamp = (value) => Math.min(.999, Math.max(.001, Number(value)));
const logit = (value) => Math.log(clamp(value) / (1 - clamp(value)));
const sigmoid = (value) => 1 / (1 + Math.exp(-value));
const loss = (probability, outcome) => -(outcome * Math.log(clamp(probability)) + (1 - outcome) * Math.log(1 - clamp(probability)));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const SERIES_POLICY = teamStats.methodology?.seriesInformation ?? {};

const leagues = [...new Map(rows.map((row) => [row.leagueId, Number(row.startTime)])).entries()]
  .sort((left, right) => left[1] - right[1]);
const holdoutIds = new Set(leagues.slice(Math.max(1, Math.floor(leagues.length * .8))).map(([id]) => id));
const inner = rows.filter((row) => !holdoutIds.has(row.leagueId));
const holdout = rows.filter((row) => holdoutIds.has(row.leagueId));

function metrics(predictions) {
  const samples = predictions.length;
  const logLoss = predictions.reduce((sum, row) => sum + loss(row.probability, row.outcome), 0) / samples;
  const brier = predictions.reduce((sum, row) => sum + (row.probability - row.outcome) ** 2, 0) / samples;
  return { samples, logLoss, brier };
}

function evaluateOnline(data, liveGlobal) {
  return evaluateLiveSeriesChronologically(data, {
    liveGlobal,
    probabilityFor: (row) => row[selectedModelId],
    seriesInformation: SERIES_POLICY,
  });
}

function clusterBootstrap(candidate, baseline, clusterKey, clusterName, iterations = 5000) {
  const groups = new Map();
  for (let index = 0; index < candidate.length; index += 1) {
    const key = clusterKey(candidate[index]);
    groups.set(key, [...(groups.get(key) ?? []), { candidate: candidate[index], baseline: baseline[index] }]);
  }
  const ids = [...groups.keys()];
  let seed = 0x6173ac;
  const random = () => {
    seed |= 0; seed = seed + 0x6d2b79f5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
  const deltas = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let delta = 0; let samples = 0;
    for (let draw = 0; draw < ids.length; draw += 1) {
      for (const pair of groups.get(ids[Math.floor(random() * ids.length)])) {
        delta += loss(pair.candidate.probability, pair.candidate.outcome) - loss(pair.baseline.probability, pair.baseline.outcome);
        samples += 1;
      }
    }
    deltas.push(delta / samples);
  }
  deltas.sort((left, right) => left - right);
  return {
    lower95: deltas[Math.floor(iterations * .025)],
    upper95: deltas[Math.floor(iterations * .975)],
    iterations,
    cluster: clusterName,
    clusters: ids.length,
  };
}

function bootstrapBoth(candidate, baseline) {
  return {
    bySeries: clusterBootstrap(candidate, baseline, (row) => `${row.leagueId}:${row.seriesId}`, "series_id"),
    byTournament: clusterBootstrap(candidate, baseline, (row) => String(row.leagueId), "tournament_id"),
  };
}

// Nine-point Gauss-Hermite integration of two independent tournament-form
// shocks. This evaluates form in logit space without converting residuals.
const HERMITE_NODES = [-3.1909932018, -2.2665805845, -1.4685532892, -.7235510188, 0, .7235510188, 1.4685532892, 2.2665805845, 3.1909932018];
const HERMITE_WEIGHTS = [.00003960698, .00494362428, .0884745274, .432651559, .720235216, .432651559, .0884745274, .00494362428, .00003960698];
function probabilityWithForm(probability, formLogitSd) {
  if (!(formLogitSd > 0)) return clamp(probability);
  return HERMITE_NODES.reduce((sum, node, index) => (
    sum + HERMITE_WEIGHTS[index] * sigmoid(logit(probability) + 2 * formLogitSd * node)
  ), 0) / Math.sqrt(Math.PI);
}

function evaluateForm(basePredictions, formLogitSd) {
  return basePredictions.map((row) => ({ ...row, probability: probabilityWithForm(row.probability, formLogitSd) }));
}

const liveCandidates = [0, .05, .1, .2, .3, .4].map((liveGlobal) => {
  const predictions = evaluateOnline(inner, liveGlobal);
  return { liveGlobal, ...metrics(predictions) };
});
const liveCandidate = liveCandidates.sort((left, right) => left.logLoss - right.logLoss)[0];
const onlineBaselinePredictions = evaluateOnline(holdout, 0);
const onlineCandidatePredictions = evaluateOnline(holdout, liveCandidate.liveGlobal);
const onlineBaseline = metrics(onlineBaselinePredictions);
const onlineCandidate = metrics(onlineCandidatePredictions);
const onlineBootstrap = bootstrapBoth(onlineCandidatePredictions, onlineBaselinePredictions);
const onlinePassed = liveCandidate.liveGlobal > 0
  && onlineCandidate.logLoss < onlineBaseline.logLoss
  && onlineCandidate.brier < onlineBaseline.brier
  && onlineBootstrap.bySeries.upper95 < 0
  && onlineBootstrap.byTournament.upper95 < 0;
const activeLiveGlobal = onlinePassed ? liveCandidate.liveGlobal : 0;

const innerActivePredictions = evaluateOnline(inner, activeLiveGlobal);
const formCandidates = [0, .04, .08, .12, .16, .2, .28, .36].map((formLogitSd) => {
  const predictions = evaluateForm(innerActivePredictions, formLogitSd);
  return { formLogitSd, ...metrics(predictions) };
});
const formCandidate = formCandidates.sort((left, right) => left.logLoss - right.logLoss)[0];
const holdoutActivePredictions = evaluateOnline(holdout, activeLiveGlobal);
const formBaselinePredictions = evaluateForm(holdoutActivePredictions, 0);
const formCandidatePredictions = evaluateForm(holdoutActivePredictions, formCandidate.formLogitSd);
const formBaseline = metrics(formBaselinePredictions);
const formAdjusted = metrics(formCandidatePredictions);
const formBootstrap = bootstrapBoth(formCandidatePredictions, formBaselinePredictions);
const formPassed = formCandidate.formLogitSd > 0
  && formAdjusted.logLoss < formBaseline.logLoss
  && formAdjusted.brier < formBaseline.brier
  && formBootstrap.bySeries.upper95 < 0
  && formBootstrap.byTournament.upper95 < 0;

const generatedAt = new Date().toISOString();
const artifact = {
  schemaVersion: 3,
  generatedAt,
  sourceTeamModelId: selectedModelId,
  provenance: {
    evaluator: "server/live-team-update.mjs#evaluateLiveSeriesChronologically",
    teamModelOofSha256: hash(rowsBuffer),
    teamModelArtifactSha256: hash(teamModelBuffer),
    predictionsStrictlyBeforeUpdate: true,
  },
  methodology: "chronological tournament split; production-identical regularized online Bradley-Terry replay; form uncertainty selected and evaluated as a tournament-level Gaussian logit shock by quadrature; series- and tournament-cluster bootstrap gates",
  selected: {
    liveGlobal: activeLiveGlobal,
    probabilityTemperature: 1,
    formLogitSd: formPassed ? formCandidate.formLogitSd : 0,
    seriesNoiseLogitSd: 0,
  },
  shadow: {
    liveGlobal: liveCandidate.liveGlobal,
    formLogitSd: formCandidate.formLogitSd,
    sensitivityGrid: { onlineUpdate: liveCandidates, formUncertainty: formCandidates },
  },
  dataset: {
    series: rows.length,
    leagues: leagues.length,
    innerSeries: inner.length,
    holdoutSeries: holdout.length,
    innerLeagues: new Set(inner.map((row) => row.leagueId)).size,
    holdoutLeagues: new Set(holdout.map((row) => row.leagueId)).size,
    split: "first 80% tournaments by chronology for selection; final 20% untouched tournaments for gates",
  },
  onlineUpdate: {
    baseline: onlineBaseline,
    candidate: onlineCandidate,
    logLossDelta: onlineCandidate.logLoss - onlineBaseline.logLoss,
    brierDelta: onlineCandidate.brier - onlineBaseline.brier,
    bootstrap: onlineBootstrap,
  },
  formUncertainty: {
    baseline: formBaseline,
    candidate: formAdjusted,
    logLossDelta: formAdjusted.logLoss - formBaseline.logLoss,
    brierDelta: formAdjusted.brier - formBaseline.brier,
    bootstrap: formBootstrap,
    interpretation: "marginal proper-score sensitivity to one latent team shock per tournament; not posterior uncertainty and not inferred from probability residuals",
  },
  holdout: {
    baseline: onlineBaseline,
    calibrated: onlineCandidate,
    logLossDelta: onlineCandidate.logLoss - onlineBaseline.logLoss,
    bootstrap: onlineBootstrap.byTournament,
  },
  validation: {
    status: onlinePassed || formPassed ? "candidate" : "shadow",
    validated: onlinePassed || formPassed,
    gates: {
      onlineUpdate: { passed: onlinePassed, requires: "lower log loss and Brier; series and tournament bootstrap upper95 < 0" },
      formUncertainty: { passed: formPassed, requires: "selected positive SD lowers log loss and Brier; series and tournament bootstrap upper95 < 0" },
    },
    inactiveResearch: { temporal: true, nextgen: true },
  },
};

teamStats.tournamentCalibration = artifact;
for (const pair of Object.values(teamStats.pairwise ?? {})) pair.uncertainty = 0;
await Promise.all([
  writeFile("public/tournament-calibration.json", `${JSON.stringify(artifact, null, 2)}\n`),
  writeFile("work/tournament-calibration.json", `${JSON.stringify(artifact, null, 2)}\n`),
  writeFile("public/team-stats.json", `${JSON.stringify(teamStats, null, 2)}\n`),
]);
console.log(`Tournament gates: online=${onlinePassed ? "ACTIVE" : "SHADOW"} (candidate ${liveCandidate.liveGlobal}, ΔLL ${(onlineCandidate.logLoss - onlineBaseline.logLoss).toFixed(6)}), form=${formPassed ? "ACTIVE" : "SHADOW"} (candidate ${formCandidate.formLogitSd}, ΔLL ${(formAdjusted.logLoss - formBaseline.logLoss).toFixed(6)})`);
