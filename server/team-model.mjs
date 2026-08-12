export const DEFAULT_TEAM_MODEL_CONFIG = Object.freeze({
  halfLifeDays: 45,
  ratingL2Penalty: 0.025,
  directMatchPriorSeries: 6,
  iterations: 700,
  learningRate: 0.018,
  seriesInformation: Object.freeze({ singleMap: 0.6, multiMapBase: 0.72, decisiveBonus: 0.28 }),
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const sigmoid = (value) => 1 / (1 + Math.exp(-value));

export function bestOfProbability(mapProbability, bestOf = 3) {
  const p = clamp(Number(mapProbability), 0.001, 0.999);
  const winsNeeded = Math.floor(Number(bestOf) / 2) + 1;
  let probability = 0;
  const choose = (n, k) => {
    let result = 1;
    for (let index = 1; index <= k; index += 1) result = result * (n - index + 1) / index;
    return result;
  };
  for (let wins = winsNeeded; wins <= bestOf; wins += 1) probability += choose(bestOf, wins) * p ** wins * (1 - p) ** (bestOf - wins);
  return probability;
}

export function impliedMapProbability(seriesProbability, bestOf = 3) {
  const target = clamp(Number(seriesProbability), 0.001, 0.999);
  let low = 0.001; let high = 0.999;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const middle = (low + high) / 2;
    if (bestOfProbability(middle, bestOf) < target) low = middle; else high = middle;
  }
  return (low + high) / 2;
}

export function convertSeriesProbability(probability, fromBestOf = 3, toBestOf = 5) {
  return bestOfProbability(impliedMapProbability(probability, fromBestOf), toBestOf);
}

export function seriesInformation(wins, losses, config = DEFAULT_TEAM_MODEL_CONFIG) {
  const maps = Number(wins) + Number(losses);
  const decisive = Math.abs(Number(wins) - Number(losses)) / Math.max(1, maps);
  return maps === 1 ? config.seriesInformation.singleMap : config.seriesInformation.multiMapBase + config.seriesInformation.decisiveBonus * decisive;
}

export function fitProductionTeamModel(seriesList, targetLineups = [], {
  nowSeconds = Date.now() / 1000,
  config = DEFAULT_TEAM_MODEL_CONFIG,
} = {}) {
  const nodes = new Set(targetLineups);
  for (const series of seriesList) { nodes.add(series.targetLineup); nodes.add(series.opponentLineup); }
  const ratings = Object.fromEntries([...nodes].map((node) => [node, 0]));
  const weighted = seriesList.map((series) => ({
    ...series,
    weight: (series.rosterWeight ?? 1) * (series.seriesInformation ?? seriesInformation(series.wins, series.losses, config))
      * 0.5 ** (((nowSeconds - series.startTime) / 86400) / config.halfLifeDays),
  }));
  for (let iteration = 0; iteration < config.iterations; iteration += 1) {
    const gradient = Object.fromEntries([...nodes].map((node) => [node, -config.ratingL2Penalty * ratings[node]]));
    for (const game of weighted) {
      const error = game.weight * (game.targetScore - sigmoid(ratings[game.targetLineup] - ratings[game.opponentLineup]));
      gradient[game.targetLineup] += error;
      gradient[game.opponentLineup] -= error;
    }
    const rate = config.learningRate / Math.sqrt(1 + iteration / 120);
    for (const node of nodes) ratings[node] += rate * gradient[node];
  }
  return { ratings, weighted };
}

export function productionPairPrediction({ ratings, weighted }, lineupA, lineupB, {
  rosterReliability = 1,
  config = DEFAULT_TEAM_MODEL_CONFIG,
} = {}) {
  const indirectMap = sigmoid((ratings[lineupA] ?? 0) - (ratings[lineupB] ?? 0));
  let directWins = 0; let directGames = 0;
  for (const game of weighted) {
    const forward = game.targetLineup === lineupA && game.opponentLineup === lineupB;
    const reverse = game.targetLineup === lineupB && game.opponentLineup === lineupA;
    if (!forward && !reverse) continue;
    directGames += game.weight;
    directWins += game.weight * (forward ? game.targetScore : 1 - game.targetScore);
  }
  const mapProbability = (indirectMap * config.directMatchPriorSeries + directWins) / (config.directMatchPriorSeries + directGames);
  const rawBo3 = bestOfProbability(mapProbability, 3);
  const rawBo5 = bestOfProbability(mapProbability, 5);
  const shrink = (probability) => 0.5 + (probability - 0.5) * clamp(rosterReliability, 0, 1);
  return {
    indirectMap,
    indirectBo3: bestOfProbability(indirectMap, 3),
    mapProbability,
    rawBo3Probability: rawBo3,
    rawBo5Probability: rawBo5,
    bo3Probability: shrink(rawBo3),
    bo5Probability: shrink(rawBo5),
    directGames,
    directWins,
  };
}

export function fitEloSeries(history, test, { initial = 1500, k = 24 } = {}) {
  const ratings = new Map();
  const value = (id) => ratings.get(id) ?? initial;
  for (const row of history) {
    const expected = 1 / (1 + 10 ** ((value(row.opponentLineup) - value(row.targetLineup)) / 400));
    const change = k * (row.rosterWeight ?? 1) * (row.targetScore - expected);
    ratings.set(row.targetLineup, value(row.targetLineup) + change);
    ratings.set(row.opponentLineup, value(row.opponentLineup) - change);
  }
  return 1 / (1 + 10 ** ((value(test.opponentLineup) - value(test.targetLineup)) / 400));
}

export function simpleRecencyProbability(history, test, { halfLifeDays = 90, priorGames = 8 } = {}) {
  let winsA = priorGames * 0.5; let gamesA = priorGames;
  let winsB = priorGames * 0.5; let gamesB = priorGames;
  for (const row of history) {
    const weight = (row.rosterWeight ?? 1) * 0.5 ** (((test.startTime - row.startTime) / 86400) / halfLifeDays);
    if (row.targetLineup === test.targetLineup) { winsA += weight * row.targetScore; gamesA += weight; }
    if (row.opponentLineup === test.targetLineup) { winsA += weight * (1 - row.targetScore); gamesA += weight; }
    if (row.targetLineup === test.opponentLineup) { winsB += weight * row.targetScore; gamesB += weight; }
    if (row.opponentLineup === test.opponentLineup) { winsB += weight * (1 - row.targetScore); gamesB += weight; }
  }
  const strengthA = winsA / gamesA; const strengthB = winsB / gamesB;
  return sigmoid(Math.log(strengthA / (1 - strengthA)) - Math.log(strengthB / (1 - strengthB)));
}

export const TEAM_MODEL_ARENA = Object.freeze([
  ...[16, 24, 32].map((k) => ({ id: `elo_k${k}`, family: "elo", k, initial: 1500 })),
  ...[0.12, 0.2, 0.32].flatMap((learningRate) => [60, 120].map((decayHalfLifeDays) => ({ id: `dynamic_lr${learningRate}_h${decayHalfLifeDays}`, family: "dynamic", learningRate, decayHalfLifeDays, l2: .002 }))),
  ...[45, 90, 180].flatMap((halfLifeDays) => [6, 12].map((priorGames) => ({ id: `recency_h${halfLifeDays}_p${priorGames}`, family: "recency_logistic", halfLifeDays, priorGames }))),
  ...[.08, .14, .22].flatMap((learningRate) => [45, 90].map((halfLifeDays) => ({ id: `bt_lr${learningRate}_h${halfLifeDays}`, family: "bradley_terry", learningRate, halfLifeDays, l2: .004 }))),
]);

export function createOnlineTeamModel(definition) {
  const ratings = new Map();
  const lastSeen = new Map();
  const recency = new Map();
  const games = new Map();
  const def = { ...definition };
  const rating = (id) => ratings.get(String(id)) ?? (def.family === "elo" ? Number(def.initial ?? 1500) : 0);
  const decayRating = (id, now) => {
    const key = String(id); const value = rating(key); const previous = lastSeen.get(key);
    if (!previous || !def.decayHalfLifeDays || def.family === "elo") return value;
    const decay = .5 ** (((now - previous) / 86400) / def.decayHalfLifeDays);
    ratings.set(key, value * decay); return value * decay;
  };
  const recencyRow = (id, now) => {
    const key = String(id); const current = recency.get(key) ?? { wins: 0, weight: 0, at: now };
    const decay = .5 ** (((now - current.at) / 86400) / Number(def.halfLifeDays ?? 90));
    return { wins: current.wins * decay, weight: current.weight * decay, at: now };
  };
  const predict = (a, b, now = Date.now() / 1000) => {
    if (!a || !b || a === b) return .5;
    if (def.family === "recency_logistic") {
      const prior = Number(def.priorGames ?? 8); const left = recencyRow(a, now); const right = recencyRow(b, now);
      const pa = (left.wins + prior * .5) / (left.weight + prior); const pb = (right.wins + prior * .5) / (right.weight + prior);
      return sigmoid(Math.log(pa / (1 - pa)) - Math.log(pb / (1 - pb)));
    }
    const left = decayRating(a, now); const right = decayRating(b, now);
    return def.family === "elo" ? 1 / (1 + 10 ** ((right - left) / 400)) : sigmoid(left - right);
  };
  const update = (series) => {
    const a = String(series.targetLineup); const b = String(series.opponentLineup); const now = Number(series.startTime);
    const expected = predict(a, b, now); const information = Number(series.rosterWeight ?? 1) * Number(series.seriesInformation ?? 1);
    const score = Number(series.targetScore); const countA = games.get(a) ?? 0; const countB = games.get(b) ?? 0;
    if (def.family === "recency_logistic") {
      const left = recencyRow(a, now); const right = recencyRow(b, now);
      left.wins += information * score; left.weight += information;
      right.wins += information * (1 - score); right.weight += information;
      recency.set(a, left); recency.set(b, right);
    } else {
      const left = decayRating(a, now); const right = decayRating(b, now);
      const adaptive = def.family === "dynamic" ? 1 / Math.sqrt(1 + Math.min(countA, countB) / 12) : 1;
      const step = def.family === "elo" ? Number(def.k ?? 24) : Number(def.learningRate ?? .14);
      const scale = step * information * adaptive * (score - expected);
      const l2 = Number(def.l2 ?? 0);
      ratings.set(a, left * (1 - l2) + scale); ratings.set(b, right * (1 - l2) - scale);
      lastSeen.set(a, now); lastSeen.set(b, now);
    }
    games.set(a, countA + 1); games.set(b, countB + 1);
  };
  return { definition: def, predict, update, evidence: (a, b) => (games.get(String(a)) ?? 0) + (games.get(String(b)) ?? 0) };
}
