const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value)));
const pairKey = (a, b) => [a, b].sort().join("|");
const sigmoid = (value) => 1 / (1 + Math.exp(-value));
const logit = (probability) => {
  const safe = clamp(probability, .03, .97);
  return Math.log(safe / (1 - safe));
};

function storedProbability(a, b, probabilities) {
  const key = pairKey(a, b);
  const value = probabilities?.[key];
  if (!Number.isFinite(value)) return null;
  return key.startsWith(`${a}|`) ? Number(value) : 100 - Number(value);
}

export function seriesEvidenceWeight(match, policy = {}) {
  const base = clamp(policy.multiMapBase ?? .72, .1, 2);
  const decisiveBonus = clamp(policy.decisiveBonus ?? .28, 0, 1);
  const scoreA = Number(match?.score_a);
  const scoreB = Number(match?.score_b);
  if (!Number.isFinite(scoreA) || !Number.isFinite(scoreB) || scoreA < 0 || scoreB < 0 || scoreA === scoreB) return base;
  const winnerScore = match.winner === match.team_a ? scoreA : scoreB;
  const loserScore = match.winner === match.team_a ? scoreB : scoreA;
  if (winnerScore <= loserScore) return base;
  if (loserScore === 0) return base + decisiveBonus;
  const marginShare = (winnerScore - loserScore - 1) / Math.max(1, winnerScore - 1);
  return base + decisiveBonus * clamp(marginShare, 0, 1);
}

/**
 * Fits one regularized online Bradley-Terry layer over the frozen baseline.
 * The TI league is excluded from baseline training, so each completed series
 * enters exactly once here. Joint fitting makes opponent strength transitive.
 */
export function updateProbabilitiesWithLiveSeries(probabilities, matches, options = {}) {
  const result = { ...(probabilities || {}) };
  const teamIds = [...new Set(Object.keys(result).flatMap((key) => key.split("|")))];
  const teamSet = new Set(teamIds);
  const completed = (matches || []).filter((match) => match?.winner && teamSet.has(match.team_a) && teamSet.has(match.team_b) && match.team_a !== match.team_b);
  const liveGlobal = clamp(options.liveGlobal ?? 0, 0, 2);
  if (!completed.length || liveGlobal <= 0 || teamIds.length < 2) return result;

  const deltas = Object.fromEntries(teamIds.map((id) => [id, 0]));
  const priorPrecision = 1 / Math.max(.05, liveGlobal);
  const seriesPolicy = options.seriesInformation || {};
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const gradient = Object.fromEntries(teamIds.map((id) => [id, -priorPrecision * deltas[id]]));
    const curvature = Object.fromEntries(teamIds.map((id) => [id, priorPrecision]));
    for (const match of completed) {
      const base = (storedProbability(match.team_a, match.team_b, result) ?? 50) / 100;
      const probability = sigmoid(logit(base) + deltas[match.team_a] - deltas[match.team_b]);
      const outcome = match.winner === match.team_a ? 1 : 0;
      const weight = seriesEvidenceWeight(match, seriesPolicy);
      const residual = weight * (outcome - probability);
      const information = weight * probability * (1 - probability);
      gradient[match.team_a] += residual;
      gradient[match.team_b] -= residual;
      curvature[match.team_a] += information;
      curvature[match.team_b] += information;
    }
    let largestStep = 0;
    for (const id of teamIds) {
      const step = clamp(.65 * gradient[id] / curvature[id], -.12, .12);
      deltas[id] += step;
      largestStep = Math.max(largestStep, Math.abs(step));
    }
    const mean = teamIds.reduce((sum, id) => sum + deltas[id], 0) / teamIds.length;
    for (const id of teamIds) deltas[id] -= mean;
    if (largestStep < 1e-7) break;
  }

  for (const [key, value] of Object.entries(result)) {
    const [a, b] = key.split("|");
    if (!teamSet.has(a) || !teamSet.has(b) || !Number.isFinite(value)) continue;
    result[key] = 100 * sigmoid(logit(Number(value) / 100) + deltas[a] - deltas[b]);
  }
  return result;
}

/**
 * Replays historical tournaments with the exact production updater. Every
 * probability is emitted before the corresponding series is added to history.
 */
export function evaluateLiveSeriesChronologically(rows, {
  liveGlobal = 0,
  probabilityFor = (row) => row.probability,
  seriesInformation: policy = {},
} = {}) {
  const tournaments = new Map();
  return [...(rows || [])]
    .sort((left, right) => Number(left.startTime) - Number(right.startTime)
      || String(left.seriesId).localeCompare(String(right.seriesId)))
    .map((row) => {
      const tournamentId = String(row.leagueId);
      const state = tournaments.get(tournamentId) ?? { probabilities: {}, matches: [] };
      const key = pairKey(row.targetLineup, row.opponentLineup);
      const baseProbability = clamp(probabilityFor(row), .001, .999);
      state.probabilities[key] = 100 * (key.startsWith(`${row.targetLineup}|`) ? baseProbability : 1 - baseProbability);
      const updated = updateProbabilitiesWithLiveSeries(state.probabilities, state.matches, {
        liveGlobal,
        seriesInformation: policy,
      });
      const adjusted = clamp((storedProbability(row.targetLineup, row.opponentLineup, updated) ?? 50) / 100, .001, .999);
      const targetWon = Number(row.outcome) === 1;
      state.matches.push({
        team_a: row.targetLineup,
        team_b: row.opponentLineup,
        winner: targetWon ? row.targetLineup : row.opponentLineup,
        score_a: Number(row.wins),
        score_b: Number(row.losses),
      });
      tournaments.set(tournamentId, state);
      return {
        seriesId: String(row.seriesId),
        leagueId: row.leagueId,
        startTime: Number(row.startTime),
        outcome: Number(row.outcome),
        baseProbability,
        probability: adjusted,
      };
    });
}
