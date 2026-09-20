// Exact-score distribution of a series, derived from one number: the chance
// team A wins a single map.
//
// Everything a series can produce follows from that — who wins, by what score,
// and in a Bo2 the chance nobody does. Deriving them instead of predicting them
// separately keeps the parts consistent: the exact scores always sum to the
// win probability, so a confident winner can never come with a contradictory
// score distribution.

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function binomial(n, k) {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let index = 1; index <= k; index += 1) result = (result * (n - index + 1)) / index;
  return result;
}

/**
 * Every possible final score of a best-of, with its probability.
 *
 * A best-of ends the moment someone reaches the needed wins, so a 2:1 is not
 * "any order of three maps" — the decider must come last. An even best-of can
 * also finish level, which is a real result in group stages and not a series
 * still in progress.
 */
export function exactScoreDistribution(mapProbabilityA, bestOf = 3) {
  const p = clamp(Number(mapProbabilityA), 0.001, 0.999);
  const maps = Math.max(1, Math.floor(Number(bestOf) || 1));
  const needed = Math.floor(maps / 2) + 1;
  const scores = [];

  for (const [winnerIsA, winProbability] of [[true, p], [false, 1 - p]]) {
    const loseProbability = winnerIsA ? 1 - p : p;
    for (let lost = 0; lost <= maps - needed; lost += 1) {
      // The winner takes the last map; the other wins are spread over the rest.
      const probability = binomial(needed - 1 + lost, lost)
        * winProbability ** needed * loseProbability ** lost;
      scores.push({
        a: winnerIsA ? needed : lost,
        b: winnerIsA ? lost : needed,
        winner: winnerIsA ? "a" : "b",
        probability,
      });
    }
  }

  // An even best-of can end level: every map is played and the wins split.
  if (maps % 2 === 0) {
    const half = maps / 2;
    scores.push({
      a: half, b: half, winner: null,
      probability: binomial(maps, half) * p ** half * (1 - p) ** half,
    });
  }

  const total = scores.reduce((sum, row) => sum + row.probability, 0);
  return scores
    .map((row) => ({ ...row, probability: row.probability / total, score: `${row.a}:${row.b}` }))
    .sort((left, right) => right.probability - left.probability);
}

/** Win, draw and loss probabilities for team A over a whole series. */
export function seriesOutcomeProbabilities(mapProbabilityA, bestOf = 3) {
  const distribution = exactScoreDistribution(mapProbabilityA, bestOf);
  const sum = (winner) => distribution
    .filter((row) => row.winner === winner)
    .reduce((total, row) => total + row.probability, 0);
  return {
    bestOf: Math.max(1, Math.floor(Number(bestOf) || 1)),
    winA: sum("a"),
    winB: sum("b"),
    draw: sum(null),
    distribution,
  };
}

/** The single most likely final score, and how likely it actually is. */
export function mostLikelyScore(mapProbabilityA, bestOf = 3) {
  const [best] = exactScoreDistribution(mapProbabilityA, bestOf);
  return best ? { score: best.score, probability: best.probability, winner: best.winner } : null;
}

/**
 * Score a prediction against what happened.
 *
 * Who advances and what the scoreline was are graded apart on purpose. Calling
 * 2:1 instead of 2:0 is a far smaller miss than backing the wrong team, and
 * folding the two into one number would hide how often the winner was right.
 */
export function scoreSeriesPrediction({ mapProbabilityA, bestOf, actualA, actualB }) {
  const outcome = seriesOutcomeProbabilities(mapProbabilityA, bestOf);
  const a = Number(actualA);
  const b = Number(actualB);
  const actualWinner = a > b ? "a" : b > a ? "b" : null;
  const actualScore = `${a}:${b}`;

  const predictedWinner = outcome.winA >= outcome.winB ? "a" : "b";
  const best = mostLikelyScore(mapProbabilityA, bestOf);

  // A drawn series has no winner to be right or wrong about, so the winner
  // metric simply does not apply to it rather than counting as a miss.
  const winnerApplicable = actualWinner !== null;
  const probabilityForActual = actualWinner === "a" ? outcome.winA
    : actualWinner === "b" ? outcome.winB : outcome.draw;

  const exact = outcome.distribution.find((row) => row.score === actualScore);
  return {
    predictedWinner,
    actualWinner,
    winnerApplicable,
    winnerCorrect: winnerApplicable ? predictedWinner === actualWinner : null,
    // Brier and log loss on the binary question, computed only when it applies.
    brier: winnerApplicable ? (outcome.winA - (actualWinner === "a" ? 1 : 0)) ** 2 : null,
    logLoss: winnerApplicable ? -Math.log(clamp(probabilityForActual, 1e-6, 1)) : null,
    drawProbability: outcome.draw,
    drawHappened: actualWinner === null,
    exactScore: {
      predicted: best?.score ?? null,
      predictedProbability: best?.probability ?? null,
      actual: actualScore,
      correct: best ? best.score === actualScore : null,
      // How much of the model's belief sat on what actually happened.
      probabilityOfActual: exact?.probability ?? 0,
    },
  };
}
