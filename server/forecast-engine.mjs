import { convertSeriesProbability } from "./team-model.mjs";

import { updateProbabilitiesWithLiveSeries } from "./live-team-update.mjs";

export const TEAMS = [
  ["1w", "1w"], ["aurora", "Aurora"], ["betboom", "BETBOOM"], ["falcons", "Falcons"],
  ["gamerlegion", "GamerLegion"], ["l1ga", "L1ga"], ["lgd", "LGD"], ["liquid", "Liquid"],
  ["nigma", "Nigma"], ["og", "OG"], ["parivision", "PARIVISION"], ["resilience", "Resilience"],
  ["spirit", "Spirit"], ["vg", "VG"], ["xtreme", "Xtreme"], ["yandex", "Yandex"],
].map(([id, name]) => ({ id, name }));

export const ROUND_ONE = [
  ["1w", "nigma"], ["aurora", "gamerlegion"], ["betboom", "og"], ["falcons", "lgd"],
  ["l1ga", "yandex"], ["liquid", "vg"], ["parivision", "resilience"], ["spirit", "xtreme"],
];

export const SWISS_GROUPS = {
  A: ["parivision", "nigma", "falcons", "og", "betboom", "lgd", "1w", "resilience"],
  B: ["yandex", "xtreme", "liquid", "vg", "aurora", "gamerlegion", "spirit", "l1ga"],
};
export const SWISS_GROUP_BY_TEAM = Object.fromEntries(Object.entries(SWISS_GROUPS).flatMap(([group, ids]) => ids.map((id) => [id, group])));
export const swissBucketKey = (id, wins, losses, round) => `${round <= 3 ? SWISS_GROUP_BY_TEAM[id] : "ALL"}:${wins}-${losses}`;
const TEAM_CODE = Object.fromEntries(TEAMS.map((team, index) => [team.id, index.toString(16)]));
const TEAM_FROM_CODE = Object.fromEntries(TEAMS.map((team, index) => [index.toString(16), team.id]));
const encodeTeams = (ids) => ids.map((id) => TEAM_CODE[id]).join("");
const decodeTeams = (value) => [...value].map((code) => TEAM_FROM_CODE[code]);
const encodeGroupOutcome = ({ direct40, direct41, via }) => `${encodeTeams(direct40)}.${encodeTeams(direct41)}.${encodeTeams(via)}`;
const decodeGroupOutcome = (signature) => {
  if (signature.startsWith("{")) return JSON.parse(signature);
  const [direct40, direct41, via] = signature.split(".");
  return { direct40: decodeTeams(direct40), direct41: decodeTeams(direct41), via: decodeTeams(via) };
};
const encodePodium = ({ champion, runnerUp, third }) => `${TEAM_CODE[champion]}${TEAM_CODE[runnerUp]}${TEAM_CODE[third]}`;
const decodePodium = (signature) => signature.startsWith("{") ? JSON.parse(signature) : ({ champion: TEAM_FROM_CODE[signature[0]], runnerUp: TEAM_FROM_CODE[signature[1]], third: TEAM_FROM_CODE[signature[2]] });

const pairKey = (a, b) => [a, b].sort().join("|");
const PERSONAL_INFERENCE_SCALE = .78;
const DEFAULT_CALIBRATION = Object.freeze({ liveGlobal: 0, liveRematch: 0, probabilityTemperature: 1, formLogitSd: 0, seriesNoiseLogitSd: .04 });
const storedProbability = (a, b, answers) => {
  const key = pairKey(a, b); const value = answers[key];
  return value === undefined ? undefined : key.startsWith(`${a}|`) ? value : 100 - value;
};

function teamScores(answers) {
  const totals = Object.fromEntries(TEAMS.map((team) => [team.id, { sum: 0, count: 0 }]));
  for (const [key, probability] of Object.entries(answers)) {
    const [a, b] = key.split("|");
    if (!totals[a] || !totals[b]) continue;
    const safe = Math.min(.95, Math.max(.05, probability / 100));
    const centered = Math.log(safe / (1 - safe));
    totals[a].sum += centered; totals[a].count += 1;
    totals[b].sum -= centered; totals[b].count += 1;
  }
  return Object.fromEntries(TEAMS.map((team) => [team.id, totals[team.id].count ? totals[team.id].sum / totals[team.id].count : 0]));
}

function completePersonalAnswers(answers) {
  const scores = teamScores(answers);
  const result = {};
  for (let i = 0; i < TEAMS.length; i += 1) for (let j = i + 1; j < TEAMS.length; j += 1) {
    const a = TEAMS[i].id; const b = TEAMS[j].id; const key = pairKey(a, b);
    const exact = storedProbability(a, b, answers);
    const estimated = Math.min(.9, Math.max(.1, 1 / (1 + Math.exp(-(scores[a] - scores[b]) * PERSONAL_INFERENCE_SCALE))));
    const probability = exact ?? estimated * 100;
    result[key] = key.startsWith(`${a}|`) ? probability : 100 - probability;
  }
  return result;
}

export function buildForecastBase({ answers, stats, mode = "mixed", opinionWeight = 50 }) {
  const personal = completePersonalAnswers(answers || {});
  const statistical = Object.fromEntries(Object.entries(stats?.pairwise || {}).map(([key, value]) => [key, value.probabilityA]));
  const weight = opinionWeight / 100;
  return mode === "stats" ? statistical : mode === "personal" ? personal : Object.fromEntries(Object.keys(personal).map((key) => [key, personal[key] * weight + (statistical[key] ?? personal[key]) * (1 - weight)]));
}

export function buildForecastSource({ answers, stats, matches, mode = "mixed", opinionWeight = 50 }) {
  const base = buildForecastBase({ answers, stats, mode, opinionWeight });
  const calibration = { ...DEFAULT_CALIBRATION, ...(stats?.tournamentCalibration?.selected ?? {}) };
  return updateProbabilitiesWithLiveSeries(base, matches, { liveGlobal: calibration.liveGlobal, seriesInformation: stats?.methodology?.seriesInformation });
}

function seededRandom(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let value = Math.imul(seed ^ (seed >>> 15), 1 | seed); value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value; return ((value ^ (value >>> 14)) >>> 0) / 4294967296; };
}
function normalRandom(random) { const u = Math.max(1e-9, random()); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random()); }
function shuffle(items, random) { const result = [...items]; for (let i = result.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; } return result; }
function pairBucket(ids, records, random) {
  let best = []; let bestRematches = Infinity;
  for (let attempt = 0; attempt < 36; attempt += 1) {
    const order = shuffle(ids, random); const pairs = []; let rematches = 0;
    for (let i = 0; i < order.length; i += 2) { const pair = [order[i], order[i + 1]]; if (records[pair[0]].opponents.has(pair[1])) rematches += 1; pairs.push(pair); }
    if (rematches < bestRematches) { best = pairs; bestRematches = rematches; if (!rematches) break; }
  }
  return best;
}

export function topGroupScenarios(scenarioCounts, iterations, limit = 3) {
  return [...scenarioCounts]
    .sort(([signatureA, countA], [signatureB, countB]) => countB - countA || signatureA.localeCompare(signatureB))
    .slice(0, limit)
    .map(([signature, count], index) => ({
      ...decodeGroupOutcome(signature),
      rank: index + 1,
      probability: 100 * count / iterations,
      occurrences: count,
      representative: true,
      scope: "group_and_playin",
    }));
}

export function runForecast(answers, iterations = 100000, seed = Math.floor(Math.random() * 0xffffffff), { matches = [], stats = null, adaptive = null } = {}) {
  const requestedIterations = Math.max(1, Math.floor(iterations));
  const adaptiveConfig = adaptive?.enabled ? {
    enabled: true,
    minIterations: Math.max(1, Math.floor(adaptive.minIterations ?? requestedIterations)),
    maxIterations: Math.max(requestedIterations, Math.floor(adaptive.maxIterations ?? requestedIterations * 4)),
    batchSize: Math.max(1, Math.floor(adaptive.batchSize ?? Math.max(10_000, requestedIterations / 2))),
    tolerancePp: Math.max(.001, Number(adaptive.tolerancePp ?? .1)),
    stableChecksRequired: Math.max(1, Math.floor(adaptive.stableChecksRequired ?? 2)),
  } : { enabled: false, minIterations: requestedIterations, maxIterations: requestedIterations, batchSize: requestedIterations, tolerancePp: 0, stableChecksRequired: 0 };
  adaptiveConfig.maxIterations = Math.max(adaptiveConfig.minIterations, adaptiveConfig.maxIterations);
  const scores = teamScores(answers); const random = seededRandom(seed);
  const calibration = { ...DEFAULT_CALIBRATION, ...(stats?.tournamentCalibration?.selected ?? {}) };
  const totals = Object.fromEntries(TEAMS.map((team) => [team.id, { direct: 0, playin: 0, viaPlayin: 0, playinLoss: 0, swissOut: 0, out: 0, wins: 0, losses: 0, champion: 0, final: 0, top3: 0 }]));
  const scenarioCounts = new Map(); const playoffScenarioCounts = new Map(); const matchupCounts = new Map(); const swissPathHashes = new Set(); const tournamentPathHashes = new Set(); const finalOutcomeSignatures = new Set();
  const pathSampleLimit = Math.min(adaptiveConfig.maxIterations, 250_000);
  const convergenceHistory = []; let previousCheckpoint = null; let stableChecks = 0; let completedIterations = 0; let converged = false;
  const checkpointValues = (denominator) => TEAMS.flatMap((team) => {
    const total = totals[team.id];
    return [total.direct + total.viaPlayin, total.direct, total.viaPlayin, total.champion, total.final, total.top3].map((value) => 100 * value / denominator);
  });
  for (let iteration = 0; iteration < adaptiveConfig.maxIterations; iteration += 1) {
    const path = []; let round = 1;
    const records = Object.fromEntries(TEAMS.map((team) => [team.id, { wins: 0, losses: 0, opponents: new Set() }]));
    const form = Object.fromEntries(TEAMS.map((team) => [team.id, normalRandom(random) * calibration.formLogitSd]));
    const winnerFor = (a, b, bestOf = 3) => {
      const bo3Base = (storedProbability(a, b, answers) ?? 50) / 100;
      const base = bestOf === 3 ? bo3Base : convertSeriesProbability(bo3Base, 3, bestOf);
      const uncertainty = Number(stats?.pairwise?.[pairKey(a, b)]?.uncertainty ?? calibration.seriesNoiseLogitSd);
      const noisyLogit = (Math.log(Math.max(.03, base) / Math.max(.03, 1 - base)) + form[a] - form[b] + normalRandom(random) * uncertainty) / calibration.probabilityTemperature;
      const probability = 1 / (1 + Math.exp(-noisyLogit));
      return random() < probability ? a : b;
    };
    const play = (a, b, fixed = null) => { const winner = fixed === a || fixed === b ? fixed : winnerFor(a, b); const loser = winner === a ? b : a; records[winner].wins++; records[loser].losses++; records[a].opponents.add(b); records[b].opponents.add(a); path.push(`${round}:${pairKey(a, b)}>${winner}`); };
    for (round = 1; round <= 5; round += 1) {
      const actual = matches.filter((match) => match.stage === "swiss" && match.round === round); const occupied = new Set();
      for (const match of actual) if (records[match.team_a] && records[match.team_b]) { play(match.team_a, match.team_b, match.winner); occupied.add(match.team_a); occupied.add(match.team_b); }
      if (round === 1) ROUND_ONE.filter(([a, b]) => !occupied.has(a) && !occupied.has(b)).forEach(([a, b]) => play(a, b));
      else {
        const buckets = new Map();
        for (const team of TEAMS.filter((item) => records[item.id].wins < 4 && records[item.id].losses < 4 && !occupied.has(item.id))) { const key = swissBucketKey(team.id, records[team.id].wins, records[team.id].losses, round); buckets.set(key, [...(buckets.get(key) || []), team.id]); }
        for (const ids of buckets.values()) pairBucket(ids, records, random).forEach(([a, b]) => play(a, b));
      }
    }
    const direct40 = []; const direct41 = []; const via = [];
    for (const team of TEAMS) { const record = records[team.id]; const total = totals[team.id]; total.wins += record.wins; total.losses += record.losses; if (record.wins === 4) { total.direct++; (record.losses === 0 ? direct40 : direct41).push(team.id); } else if (record.losses === 4) { total.out++; total.swissOut++; } else total.playin++; }
    const buchholz = (id) => [...records[id].opponents].reduce((sum, opponent) => sum + records[opponent].wins, 0);
    const upper = TEAMS.filter((team) => records[team.id].wins === 3).map((team) => team.id).sort((a, b) => buchholz(b) - buchholz(a) || scores[b] - scores[a]);
    const lower = TEAMS.filter((team) => records[team.id].wins === 2).map((team) => team.id).sort((a, b) => buchholz(a) - buchholz(b) || scores[a] - scores[b]);
    const knownPlayins = matches.filter((match) => match.stage === "playin");
    const playinPairs = knownPlayins.length === 5 ? knownPlayins.map((match) => [match.team_a, match.team_b]) : upper.map((a, index) => [a, lower[index]]);
    playinPairs.forEach(([a, b]) => { const actual = knownPlayins.find((match) => (match.team_a === a && match.team_b === b) || (match.team_a === b && match.team_b === a)); const winner = actual?.winner || winnerFor(a, b); const loser = winner === a ? b : a; totals[winner].viaPlayin++; totals[loser].playinLoss++; totals[loser].out++; via.push(winner); const key = pairKey(a, b); const first = key.split("|")[0]; const item = matchupCounts.get(key) || { count: 0, firstWins: 0 }; item.count++; if (winner === first) item.firstWins++; matchupCounts.set(key, item); path.push(`P:${key}>${winner}`); });
    const signature = encodeGroupOutcome({ direct40: direct40.sort(), direct41: direct41.sort(), via: via.sort() }); scenarioCounts.set(signature, (scenarioCounts.get(signature) || 0) + 1);
    const compactHash = (value) => { let first = 2166136261; let second = 2246822519; for (const char of value) { const code = char.charCodeAt(0); first = Math.imul(first ^ code, 16777619); second = Math.imul(second ^ code, 3266489917); } return `${first >>> 0}:${second >>> 0}`; };
    if (iteration < pathSampleLimit) swissPathHashes.add(compactHash(path.join(";")));
    const directSeeds = [...direct40, ...direct41.sort((a, b) => scores[b] - scores[a])];
    const viaSeeds = [...via].sort((a, b) => scores[b] - scores[a]);
    const qualifiers = [...directSeeds, ...viaSeeds];
    const knownPlayoff = matches.filter((match) => match.stage === "playoff");
    const knownOpening = knownPlayoff.filter((match) => match.round === 1).slice(0, 4);
    const openingPairs = knownOpening.length === 4 ? knownOpening.map((match) => [match.team_a, match.team_b]) : [[qualifiers[0], qualifiers[7]], [qualifiers[3], qualifiers[4]], [qualifiers[1], qualifiers[6]], [qualifiers[2], qualifiers[5]]];
    const playoffSeries = (label, a, b, bestOf = 3) => { const actual = knownPlayoff.find((match) => match.winner && ((match.team_a === a && match.team_b === b) || (match.team_a === b && match.team_b === a))); const winner = actual?.winner || winnerFor(a, b, bestOf); const loser = winner === a ? b : a; path.push(`PO:${label}:${pairKey(a, b)}>${winner}`); return { a, b, winner, loser }; };
    const uq = openingPairs.map(([a, b], index) => playoffSeries(`UQ${index + 1}`, a, b));
    const us1 = playoffSeries("US1", uq[0].winner, uq[1].winner); const us2 = playoffSeries("US2", uq[2].winner, uq[3].winner);
    const lr11 = playoffSeries("LR11", uq[0].loser, uq[1].loser); const lr12 = playoffSeries("LR12", uq[2].loser, uq[3].loser);
    const lr21 = playoffSeries("LR21", lr11.winner, us2.loser); const lr22 = playoffSeries("LR22", lr12.winner, us1.loser);
    const uf = playoffSeries("UF", us1.winner, us2.winner); const ls = playoffSeries("LS", lr21.winner, lr22.winner);
    const lf = playoffSeries("LF", ls.winner, uf.loser); const gf = playoffSeries("GF", uf.winner, lf.winner, 5);
    totals[gf.winner].champion++; totals[gf.winner].final++; totals[gf.winner].top3++;
    totals[gf.loser].final++; totals[gf.loser].top3++; totals[lf.loser].top3++;
    const playoffSignature = encodePodium({ champion: gf.winner, runnerUp: gf.loser, third: lf.loser }); playoffScenarioCounts.set(playoffSignature, (playoffScenarioCounts.get(playoffSignature) || 0) + 1); if (iteration < pathSampleLimit) finalOutcomeSignatures.add(`${signature}|${playoffSignature}`);
    if (iteration < pathSampleLimit) tournamentPathHashes.add(compactHash(path.join(";")));
    completedIterations = iteration + 1;
    const atCheckpoint = completedIterations % adaptiveConfig.batchSize === 0 || completedIterations === adaptiveConfig.maxIterations;
    if (atCheckpoint) {
      const values = checkpointValues(completedIterations);
      const maxDeltaPp = previousCheckpoint ? Math.max(...values.map((value, index) => Math.abs(value - previousCheckpoint[index]))) : null;
      if (maxDeltaPp !== null && maxDeltaPp <= adaptiveConfig.tolerancePp) stableChecks += 1; else stableChecks = 0;
      convergenceHistory.push({ iterations: completedIterations, maxDeltaPp, maxSamplingMarginPp: 98 / Math.sqrt(completedIterations), stable: maxDeltaPp !== null && maxDeltaPp <= adaptiveConfig.tolerancePp });
      previousCheckpoint = values;
      if (adaptiveConfig.enabled && completedIterations >= adaptiveConfig.minIterations && stableChecks >= adaptiveConfig.stableChecksRequired) { converged = true; break; }
    }
  }
  const teams = TEAMS.map((team) => ({ ...team, qualify: 100 * (totals[team.id].direct + totals[team.id].viaPlayin) / completedIterations, direct: 100 * totals[team.id].direct / completedIterations, playin: 100 * totals[team.id].playin / completedIterations, viaPlayin: 100 * totals[team.id].viaPlayin / completedIterations, playinLoss: 100 * totals[team.id].playinLoss / completedIterations, swissOut: 100 * totals[team.id].swissOut / completedIterations, out: 100 * totals[team.id].out / completedIterations, champion: 100 * totals[team.id].champion / completedIterations, final: 100 * totals[team.id].final / completedIterations, top3: 100 * totals[team.id].top3 / completedIterations, avgWins: totals[team.id].wins / completedIterations, avgLosses: totals[team.id].losses / completedIterations })).sort((a, b) => b.qualify - a.qualify || b.direct - a.direct);
  // Rank exact group/play-in outcomes by their raw occurrence counts before any percentage conversion or UI rounding.
  // Playoff results are deliberately absent from `signature`, so every downstream playoff branch is aggregated here.
  const scenarios = topGroupScenarios(scenarioCounts, completedIterations);
  const playoffScenarios = [...playoffScenarioCounts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([signature, count]) => ({ ...decodePodium(signature), probability: 100 * count / completedIterations, occurrences: count, representative: true }));
  const playinMatchups = [...matchupCounts].sort((a, b) => b[1].count - a[1].count).slice(0, 10).map(([key, value]) => { const [a, b] = key.split("|"); return { a, b, probability: 100 * value.count / completedIterations, aWinProbability: 100 * value.firstWins / value.count }; });
  const sampledIterations = Math.min(completedIterations, pathSampleLimit);
  const swissDuplicateRate = 100 * (1 - swissPathHashes.size / sampledIterations); const tournamentDuplicateRate = 100 * (1 - tournamentPathHashes.size / sampledIterations);
  const lastCheckpoint = convergenceHistory.at(-1);
  return { teams, scenarios, playoffScenarios, playinMatchups, iterations: completedIterations, requestedIterations, seed, uniqueBrackets: tournamentPathHashes.size, duplicateRate: tournamentDuplicateRate, uniqueSwissPaths: swissPathHashes.size, swissDuplicateRate, uniqueTournamentPaths: tournamentPathHashes.size, tournamentDuplicateRate, pathSampleIterations: sampledIterations, uniqueSwissOutcomes: scenarioCounts.size, uniquePlayoffPodiums: playoffScenarioCounts.size, uniqueFinalOutcomes: finalOutcomeSignatures.size, calibration, convergence: { adaptive: adaptiveConfig.enabled, converged, stopReason: converged ? "stable" : adaptiveConfig.enabled ? "max_iterations" : "fixed_budget", minIterations: adaptiveConfig.minIterations, maxIterations: adaptiveConfig.maxIterations, batchSize: adaptiveConfig.batchSize, tolerancePp: adaptiveConfig.tolerancePp, stableChecksRequired: adaptiveConfig.stableChecksRequired, stableChecks, maxDeltaPp: lastCheckpoint?.maxDeltaPp ?? null, maxSamplingMarginPp: lastCheckpoint?.maxSamplingMarginPp ?? 98 / Math.sqrt(completedIterations), checkpoints: convergenceHistory }, uncertaintyPolicy: stats?.tournamentCalibration?.validation?.validated ? "historical tournament holdout calibration" : "experimental latent logit shocks; calibration gate not passed", formatVersion: "hidden-groups-r1-r3-playoff-v5-adaptive" };
}
