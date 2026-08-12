export const CLOSE_TEAM_PRIOR_WEIGHT = 0.45;
export const FAVORITE_TEAM_PRIOR_WEIGHT = 1;
export const CLOSE_DRAFT_SIGNAL_WEIGHT = 2.15;
export const FAVORITE_DRAFT_SIGNAL_WEIGHT = 1.15;
export const FULL_TEAM_GAP_LOGIT = 1.4;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const sigmoid = (value) => 1 / (1 + Math.exp(-value));
const logit = (value) => Math.log(clamp(value, 0.01, 0.99) / (1 - clamp(value, 0.01, 0.99)));
const mix = (from, to, amount) => from + (to - from) * amount;
const smoothstep = (value) => {
  const bounded = clamp(value, 0, 1);
  return bounded * bounded * (3 - 2 * bounded);
};

export function combineDraftSignals(baseProbability, rawDraftSignals, completeness = 1) {
  const boundedCompleteness = clamp(completeness, 0, 1);
  const sourceTeamLogit = logit(baseProbability);
  const teamGap = smoothstep(Math.abs(sourceTeamLogit) / FULL_TEAM_GAP_LOGIT);
  const teamPriorWeight = mix(CLOSE_TEAM_PRIOR_WEIGHT, FAVORITE_TEAM_PRIOR_WEIGHT, teamGap);
  const draftSignalWeight = mix(CLOSE_DRAFT_SIGNAL_WEIGHT, FAVORITE_DRAFT_SIGNAL_WEIGHT, teamGap);
  const teamLogit = sourceTeamLogit * teamPriorWeight;
  let finalLogit = teamLogit;
  let draftLogit = 0;
  const contributions = [];

  for (const signal of rawDraftSignals) {
    const applied = Number(signal || 0) * boundedCompleteness * draftSignalWeight;
    const before = sigmoid(finalLogit);
    finalLogit += applied;
    draftLogit += applied;
    contributions.push((sigmoid(finalLogit) - before) * 100);
  }

  return {
    sourceTeamProbability: clamp(baseProbability, 0.01, 0.99),
    teamPriorProbability: sigmoid(teamLogit),
    draftOnlyProbability: sigmoid(draftLogit),
    probability: clamp(sigmoid(finalLogit), 0.08, 0.92),
    teamPriorWeight,
    draftSignalWeight,
    contributions,
  };
}

export function combineLearnedDraftSignals(baseProbability, namedSignals, learnedCombiner, completeness = 1) {
  const boundedCompleteness = clamp(completeness, 0, 1);
  const weights = learnedCombiner?.weights ?? {};
  const teamLogit = logit(baseProbability) * Number(weights.teamPrior ?? 1);
  let finalLogit = teamLogit; let draftLogit = 0;
  const contributions = [];
  for (const signal of namedSignals) {
    const applied = Number(signal.value || 0) * Number(weights[signal.key] ?? 0) * (signal.key === "side" ? 1 : boundedCompleteness);
    const before = sigmoid(finalLogit);
    finalLogit += applied; draftLogit += applied;
    contributions.push((sigmoid(finalLogit) - before) * 100);
  }
  return {
    sourceTeamProbability: clamp(baseProbability, 0.01, 0.99), teamPriorProbability: sigmoid(teamLogit),
    draftOnlyProbability: sigmoid(draftLogit),
    probability: clamp(sigmoid(finalLogit), Number(learnedCombiner?.probabilityFloor ?? .08), Number(learnedCombiner?.probabilityCeiling ?? .92)),
    teamPriorWeight: Number(weights.teamPrior ?? 1), draftSignalWeight: 1, contributions,
  };
}
