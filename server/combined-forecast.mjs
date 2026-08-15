import { impliedMapProbability } from "./team-model.mjs";

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, Number(value)));
const suppliedProbability = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));

export function orientedProbability(teamA, teamB, probabilities) {
  const key = [teamA, teamB].sort().join("|");
  const stored = Number(probabilities?.[key]);
  if (!Number.isFinite(stored)) return null;
  return (key.startsWith(`${teamA}|`) ? stored : 100 - stored) / 100;
}

/**
 * Exact terminal-score distribution from the current score.  Only the first
 * unresolved map may use a draft/live override; later maps retain the frozen
 * pre-series map prior, so in-game telemetry cannot leak into future maps.
 */
export function exactSeriesScores({
  bestOf = 3,
  winsA = 0,
  winsB = 0,
  baseMapProbabilityA = 0.5,
  currentMapProbabilityA = null,
} = {}) {
  const needed = Math.floor(Number(bestOf) / 2) + 1;
  const startA = clamp(Math.trunc(winsA), 0, needed);
  const startB = clamp(Math.trunc(winsB), 0, needed);
  const base = clamp(baseMapProbabilityA, 0.01, 0.99);
  const current = suppliedProbability(currentMapProbabilityA) ? clamp(currentMapProbabilityA, 0.01, 0.99) : base;
  const terminal = new Map();
  const visit = (a, b, probability, firstUnresolved) => {
    if (a >= needed || b >= needed) {
      const key = `${a}:${b}`;
      terminal.set(key, (terminal.get(key) ?? 0) + probability);
      return;
    }
    const mapProbability = firstUnresolved ? current : base;
    visit(a + 1, b, probability * mapProbability, false);
    visit(a, b + 1, probability * (1 - mapProbability), false);
  };
  visit(startA, startB, 1, true);
  return [...terminal.entries()].map(([score, probability]) => ({ score, probability }))
    .sort((left, right) => right.probability - left.probability || left.score.localeCompare(right.score));
}

export function combinedSeriesForecast({
  teamA,
  teamB,
  seriesProbabilityA,
  sourceBestOf = 3,
  bestOf = 3,
  winsA = 0,
  winsB = 0,
  currentMapProbabilityA = null,
} = {}) {
  const frozenSeries = clamp(seriesProbabilityA, 0.01, 0.99);
  const normalizedSourceBestOf = Math.max(1, Math.trunc(Number(sourceBestOf) || 3));
  const normalizedBestOf = Math.max(1, Math.trunc(Number(bestOf) || 3));
  const baseMapProbabilityA = impliedMapProbability(frozenSeries, normalizedSourceBestOf);
  const exactScores = exactSeriesScores({ bestOf: normalizedBestOf, winsA, winsB, baseMapProbabilityA, currentMapProbabilityA });
  const probabilityA = exactScores.filter((row) => Number(row.score.split(":")[0]) > Number(row.score.split(":")[1]))
    .reduce((sum, row) => sum + row.probability, 0);
  const topExactScores = exactScores.slice(0, 5);
  return {
    teamA,
    teamB,
    bestOf: normalizedBestOf,
    winsA,
    winsB,
    frozenSeriesProbabilityA: frozenSeries,
    sourceBestOf: normalizedSourceBestOf,
    baseMapProbabilityA,
    targetSeriesProbabilityA: exactSeriesScores({ bestOf: normalizedBestOf, baseMapProbabilityA })
      .filter((row) => Number(row.score.split(":")[0]) > Number(row.score.split(":")[1]))
      .reduce((sum, row) => sum + row.probability, 0),
    currentMapProbabilityA: suppliedProbability(currentMapProbabilityA) ? clamp(currentMapProbabilityA, 0.01, 0.99) : null,
    probabilityA,
    exactScores,
    topExactScores,
    exactScoresScope: winsA || winsB ? "conditional_current_score" : "pre_series",
  };
}
