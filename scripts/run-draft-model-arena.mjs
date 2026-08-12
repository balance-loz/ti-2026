import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const DB_PATH = path.resolve(process.env.DRAFT_TRAINING_DB || path.join(ROOT, "work", "draft-training.sqlite"));
const OUTPUT = path.resolve(process.env.DRAFT_TEMPORAL_MODEL || path.join(ROOT, "public", "draft-temporal-model.json"));
const REPORT = path.resolve(process.env.DRAFT_ARENA_REPORT || path.join(ROOT, "work", "draft-model-arena-report.json"));
const COVERAGE_REPORT = path.resolve(process.env.DRAFT_COVERAGE_REPORT || path.join(ROOT, "work", "draft-coverage.json"));
const PATCH_FEATURES = path.resolve(process.env.DRAFT_PATCH_FEATURES || path.join(ROOT, "config", "patch-features.json"));
const DRAFT_STATS = path.join(ROOT, "public", "draft-stats.json");
const MIN_PAIR_GAMES = Math.max(3, Number(process.env.DRAFT_MIN_PAIR_GAMES || 200));
const DOMAIN_WEIGHT = { pro: 1, high_mmr: Number(process.env.DRAFT_HIGH_MMR_WEIGHT || .22) };

const LINEAR_CONFIGS = [
  { name: "hero_ridge", groups: ["hero"], rate: .025, l2: .003, epochs: 7, heroScale: .28, carry: .12 },
  { name: "hero_role", groups: ["hero", "role"], rate: .025, l2: .002, epochs: 7, heroScale: .25, roleScale: .12, carry: .13 },
  { name: "interactions_balanced", groups: ["hero", "role", "synergy", "counter"], rate: .022, l2: .0025, pairL2: .006, epochs: 8, heroScale: .22, roleScale: .09, synergyScale: .055, counterScale: .025, carry: .15, pairCarry: .24 },
  { name: "interactions_conservative", groups: ["hero", "role", "synergy", "counter"], rate: .018, l2: .006, pairL2: .018, epochs: 7, heroScale: .2, roleScale: .07, synergyScale: .04, counterScale: .018, carry: .2, pairCarry: .35 },
  { name: "fast_patch_adapter", groups: ["hero", "role", "synergy", "counter"], rate: .03, l2: .0035, pairL2: .012, epochs: 6, heroScale: .23, roleScale: .09, synergyScale: .045, counterScale: .02, carry: .34, pairCarry: .55 },
  { name: "long_memory", groups: ["hero", "role", "synergy", "counter"], rate: .016, l2: .002, pairL2: .008, epochs: 9, heroScale: .2, roleScale: .08, synergyScale: .05, counterScale: .022, carry: .07, pairCarry: .13 },
];
const FM_CONFIGS = [
  { name: "factorization_4", dimensions: 4, rate: .018, l2: .006, epochs: 7, heroScale: .18, roleScale: .07, carry: .18 },
  { name: "factorization_8", dimensions: 8, rate: .014, l2: .009, epochs: 7, heroScale: .17, roleScale: .06, carry: .24 },
];
const NAIVE_CONFIGS = [
  { name: "bayes_patch_decay", prior: 18, scale: .22, carry: .32 },
];
const PRODUCTION_MEMBER_NAMES = ["long_memory", "factorization_8", "factorization_4", "interactions_conservative"];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const sigmoid = (value) => 1 / (1 + Math.exp(-clamp(value, -14, 14)));
const safeLogLoss = (probability, outcome) => -(outcome * Math.log(clamp(probability, .001, .999)) + (1 - outcome) * Math.log(clamp(1 - probability, .001, .999)));
const pairKey = (a, b) => [Number(a), Number(b)].sort((left, right) => left - right).join("|");
const roleKey = (heroId, role) => `${heroId}@${role || 0}`;
const domainWeight = (match) => DOMAIN_WEIGHT[match.domain] ?? .15;

async function optionalJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

function seededValue(key, dimension) {
  let hash = 2166136261;
  for (const char of `${key}:${dimension}`) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return ((hash >>> 0) / 0xffffffff - .5) * .08;
}

function freshLinear(config) {
  return { type: "linear", config, bias: 0, team: new Map(), hero: new Map(), role: new Map(), synergy: new Map(), counter: new Map(), counts: { hero: new Map(), role: new Map(), synergy: new Map(), counter: new Map() } };
}

function freshFm(config) {
  return { type: "fm", config, bias: 0, team: new Map(), hero: new Map(), role: new Map(), embeddings: new Map(), counts: { hero: new Map(), role: new Map() } };
}

function freshNaive(config) {
  return { type: "naive", config, heroes: new Map(), counts: { hero: new Map() } };
}

function freshTeamBaseline() {
  return { bias: 0, team: new Map() };
}

function mapValue(map, key) { return map.get(String(key)) ?? 0; }
function addMap(map, key, delta, limit = 3) { map.set(String(key), clamp(mapValue(map, key) + delta, -limit, limit)); }
function countMap(map, key, amount = 1) { map.set(String(key), (map.get(String(key)) ?? 0) + amount); }

function linearDraftFeatures(match, config) {
  const features = [];
  const add = (group, key, value) => { if (config.groups.includes(group) && value) features.push({ group, key: String(key), value }); };
  for (const player of match.radiant) { add("hero", player.heroId, config.heroScale); add("role", roleKey(player.heroId, player.role), config.roleScale); }
  for (const player of match.dire) { add("hero", player.heroId, -config.heroScale); add("role", roleKey(player.heroId, player.role), -config.roleScale); }
  if (config.groups.includes("synergy")) for (const [players, sign] of [[match.radiant, 1], [match.dire, -1]]) {
    for (let i = 0; i < players.length; i += 1) for (let j = i + 1; j < players.length; j += 1) add("synergy", pairKey(players[i].heroId, players[j].heroId), config.synergyScale * sign);
  }
  if (config.groups.includes("counter")) for (const radiant of match.radiant) for (const dire of match.dire) {
    add("counter", `${radiant.heroId}>${dire.heroId}`, config.counterScale);
    add("counter", `${dire.heroId}>${radiant.heroId}`, -config.counterScale);
  }
  return features;
}

function linearDraftScore(state, match) {
  return linearDraftFeatures(match, state.config).reduce((sum, feature) => {
    if ((feature.group === "synergy" || feature.group === "counter") && (state.counts[feature.group].get(String(feature.key)) ?? 0) < MIN_PAIR_GAMES) return sum;
    return sum + mapValue(state[feature.group], feature.key) * feature.value;
  }, 0);
}

function nuisanceScore(state, match) {
  return state.bias + (match.radiantTeamId ? mapValue(state.team, match.radiantTeamId) : 0) - (match.direTeamId ? mapValue(state.team, match.direTeamId) : 0);
}

function transferMap(map, factor) { for (const [key, value] of map) map.set(key, value * factor); }

function transferCandidate(state, magnitude) {
  if (state.type === "linear") {
    const heroCarry = Math.exp(-state.config.carry * magnitude); const pairCarry = Math.exp(-(state.config.pairCarry ?? state.config.carry * 1.5) * magnitude);
    state.bias *= .9; transferMap(state.team, .78); transferMap(state.hero, heroCarry); transferMap(state.role, heroCarry * .92); transferMap(state.synergy, pairCarry); transferMap(state.counter, pairCarry);
  } else if (state.type === "fm") {
    const carry = Math.exp(-state.config.carry * magnitude);
    state.bias *= .9; transferMap(state.team, .78); transferMap(state.hero, carry); transferMap(state.role, carry * .92);
    for (const [key, values] of state.embeddings) state.embeddings.set(key, values.map((value) => value * Math.sqrt(carry)));
  } else {
    const carry = Math.exp(-state.config.carry * magnitude);
    for (const row of state.heroes.values()) { row.games *= carry; row.wins *= carry; }
  }
}

function fitLinear(state, matches) {
  for (const match of matches) for (const feature of linearDraftFeatures(match, state.config)) countMap(state.counts[feature.group], feature.key);
  for (let epoch = 0; epoch < state.config.epochs; epoch += 1) {
    const rate = state.config.rate / Math.sqrt(1 + epoch * .6);
    for (let step = 0; step < matches.length; step += 1) {
      const match = matches[(step + epoch) % matches.length]; const weight = domainWeight(match);
      const features = linearDraftFeatures(match, state.config); const probability = sigmoid(nuisanceScore(state, match) + linearDraftScore(state, match));
      const error = weight * (match.radiantWin - probability);
      state.bias = clamp(state.bias + rate * (error - state.config.l2 * state.bias), -2, 2);
      if (match.radiantTeamId) addMap(state.team, match.radiantTeamId, rate * (error - state.config.l2 * mapValue(state.team, match.radiantTeamId)));
      if (match.direTeamId) addMap(state.team, match.direTeamId, rate * (-error - state.config.l2 * mapValue(state.team, match.direTeamId)));
      for (const feature of features) {
        const l2 = feature.group === "synergy" || feature.group === "counter" ? state.config.pairL2 ?? state.config.l2 : state.config.l2;
        addMap(state[feature.group], feature.key, rate * (error * feature.value - l2 * mapValue(state[feature.group], feature.key)), 2.5);
      }
    }
  }
}

function fmEmbedding(state, heroId, initialize = false) {
  const key = String(heroId);
  if (!state.embeddings.has(key) && initialize) state.embeddings.set(key, Array.from({ length: state.config.dimensions }, (_, dimension) => seededValue(key, dimension)));
  return state.embeddings.get(key) ?? Array(state.config.dimensions).fill(0);
}

function fmParts(state, match, initialize = false) {
  const signed = [...match.radiant.map((player) => ({ ...player, sign: 1 })), ...match.dire.map((player) => ({ ...player, sign: -1 }))];
  let linear = 0;
  for (const player of signed) linear += player.sign * (state.config.heroScale * mapValue(state.hero, player.heroId) + state.config.roleScale * mapValue(state.role, roleKey(player.heroId, player.role)));
  let interaction = 0;
  for (let dimension = 0; dimension < state.config.dimensions; dimension += 1) {
    let radiantSum = 0; let radiantSquares = 0; let direSum = 0; let direSquares = 0;
    for (const player of signed) {
      const value = fmEmbedding(state, player.heroId, initialize)[dimension];
      if (player.sign > 0) { radiantSum += value; radiantSquares += value * value; }
      else { direSum += value; direSquares += value * value; }
    }
    interaction += .5 * ((radiantSum * radiantSum - radiantSquares) - (direSum * direSum - direSquares));
  }
  return { score: linear + interaction, signed };
}

function fitFm(state, matches) {
  for (const match of matches) for (const player of [...match.radiant, ...match.dire]) { countMap(state.counts.hero, player.heroId); countMap(state.counts.role, roleKey(player.heroId, player.role)); }
  for (let epoch = 0; epoch < state.config.epochs; epoch += 1) {
    const rate = state.config.rate / Math.sqrt(1 + epoch * .7);
    for (let step = 0; step < matches.length; step += 1) {
      const match = matches[(step + epoch * 3) % matches.length]; const weight = domainWeight(match);
      const parts = fmParts(state, match, true); const probability = sigmoid(nuisanceScore(state, match) + parts.score); const error = weight * (match.radiantWin - probability);
      state.bias = clamp(state.bias + rate * (error - state.config.l2 * state.bias), -2, 2);
      if (match.radiantTeamId) addMap(state.team, match.radiantTeamId, rate * (error - state.config.l2 * mapValue(state.team, match.radiantTeamId)));
      if (match.direTeamId) addMap(state.team, match.direTeamId, rate * (-error - state.config.l2 * mapValue(state.team, match.direTeamId)));
      for (const player of parts.signed) {
        addMap(state.hero, player.heroId, rate * (error * player.sign * state.config.heroScale - state.config.l2 * mapValue(state.hero, player.heroId)), 2.5);
        const rKey = roleKey(player.heroId, player.role);
        addMap(state.role, rKey, rate * (error * player.sign * state.config.roleScale - state.config.l2 * mapValue(state.role, rKey)), 2.5);
      }
      for (let dimension = 0; dimension < state.config.dimensions; dimension += 1) {
        const radiantSum = parts.signed.filter((player) => player.sign > 0).reduce((total, player) => total + fmEmbedding(state, player.heroId, true)[dimension], 0);
        const direSum = parts.signed.filter((player) => player.sign < 0).reduce((total, player) => total + fmEmbedding(state, player.heroId, true)[dimension], 0);
        for (const player of parts.signed) {
          const embedding = fmEmbedding(state, player.heroId, true); const current = embedding[dimension];
          const sameSideSum = player.sign > 0 ? radiantSum : direSum;
          embedding[dimension] = clamp(current + rate * (error * player.sign * (sameSideSum - current) - state.config.l2 * current), -.8, .8);
        }
      }
    }
  }
}

function fitNaive(state, matches) {
  for (const match of matches) {
    const weight = domainWeight(match);
    for (const player of match.radiant) {
      const row = state.heroes.get(String(player.heroId)) ?? { games: 0, wins: 0 }; row.games += weight; row.wins += weight * match.radiantWin; state.heroes.set(String(player.heroId), row); countMap(state.counts.hero, player.heroId);
    }
    for (const player of match.dire) {
      const row = state.heroes.get(String(player.heroId)) ?? { games: 0, wins: 0 }; row.games += weight; row.wins += weight * (1 - match.radiantWin); state.heroes.set(String(player.heroId), row); countMap(state.counts.hero, player.heroId);
    }
  }
}

function naiveCoefficient(state, heroId) {
  const row = state.heroes.get(String(heroId)); if (!row) return 0;
  const rate = (row.wins + state.config.prior * .5) / (row.games + state.config.prior);
  return Math.log(clamp(rate, .08, .92) / (1 - clamp(rate, .08, .92)));
}

function candidateDraftScore(state, match) {
  if (state.type === "linear") return linearDraftScore(state, match);
  if (state.type === "fm") return fmParts(state, match).score;
  return state.config.scale * (match.radiant.reduce((sum, player) => sum + naiveCoefficient(state, player.heroId), 0) - match.dire.reduce((sum, player) => sum + naiveCoefficient(state, player.heroId), 0));
}

function fitCandidate(state, matches) {
  if (state.type === "linear") fitLinear(state, matches);
  else if (state.type === "fm") fitFm(state, matches);
  else fitNaive(state, matches);
}

function transferTeamBaseline(state, magnitude) {
  state.bias *= .9; transferMap(state.team, Math.exp(-.12 * magnitude));
}

function teamBaselineScore(state, match) {
  return state.bias + (match.radiantTeamId ? mapValue(state.team, match.radiantTeamId) : 0) - (match.direTeamId ? mapValue(state.team, match.direTeamId) : 0);
}

function fitTeamBaseline(state, matches) {
  for (let epoch = 0; epoch < 8; epoch += 1) {
    const rate = .028 / Math.sqrt(1 + epoch * .6);
    for (const match of matches) {
      const error = domainWeight(match) * (match.radiantWin - sigmoid(teamBaselineScore(state, match)));
      state.bias = clamp(state.bias + rate * (error - .004 * state.bias), -2, 2);
      if (match.radiantTeamId) addMap(state.team, match.radiantTeamId, rate * (error - .004 * mapValue(state.team, match.radiantTeamId)));
      if (match.direTeamId) addMap(state.team, match.direTeamId, rate * (-error - .004 * mapValue(state.team, match.direTeamId)));
    }
  }
}

function metricsFromLogits(logits, outcomes) {
  let logLoss = 0; let brier = 0; let correct = 0; let predicted = 0; let actual = 0;
  for (let index = 0; index < logits.length; index += 1) {
    const probability = sigmoid(logits[index]); const outcome = outcomes[index];
    logLoss += safeLogLoss(probability, outcome); brier += (probability - outcome) ** 2;
    correct += Number((probability >= .5) === Boolean(outcome)); predicted += probability; actual += outcome;
  }
  const count = Math.max(1, logits.length);
  return { matches: logits.length, logLoss: logLoss / count, brier: brier / count, accuracy: correct / count, predictedRadiantRate: predicted / count, actualRadiantRate: actual / count };
}

function seriesClusterBootstrap(rows, iterations = 1000) {
  const clusters = new Map();
  for (const row of rows) clusters.set(row.seriesId, [...(clusters.get(row.seriesId) ?? []), row]);
  const ids = [...clusters.keys()]; let seed = 0x4f1bbcdc;
  const random = () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let value = Math.imul(seed ^ seed >>> 15, 1 | seed); value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value; return ((value ^ value >>> 14) >>> 0) / 4294967296; };
  const deltas = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let modelLoss = 0; let baselineLoss = 0; let maps = 0;
    for (let draw = 0; draw < ids.length; draw += 1) for (const row of clusters.get(ids[Math.floor(random() * ids.length)])) {
      modelLoss += safeLogLoss(row.productionProbability, row.outcome);
      baselineLoss += safeLogLoss(row.baselineProbability, row.outcome); maps += 1;
    }
    deltas.push((modelLoss - baselineLoss) / maps);
  }
  deltas.sort((a, b) => a - b);
  return { cluster: "series_id", clusters: ids.length, iterations, lower95: deltas[Math.floor(iterations * .025)], upper95: deltas[Math.floor(iterations * .975)] };
}

function optimizeTemperature(rows, candidateIndex) {
  if (rows.length < 40) return 1;
  let best = { temperature: 1, loss: Infinity };
  for (let step = 0; step <= 80; step += 1) {
    const temperature = Math.exp(Math.log(.55) + step / 80 * (Math.log(4) - Math.log(.55)));
    const loss = rows.reduce((sum, row) => sum + safeLogLoss(sigmoid(row.baseLogit + row.draftLogits[candidateIndex] / temperature), row.outcome), 0) / rows.length;
    if (loss < best.loss) best = { temperature, loss };
  }
  return best.temperature;
}

function projectSimplex(values) {
  const sorted = [...values].sort((a, b) => b - a); let sum = 0; let rho = 0;
  for (let index = 0; index < sorted.length; index += 1) { sum += sorted[index]; if (sorted[index] - (sum - 1) / (index + 1) > 0) rho = index + 1; }
  const theta = (sorted.slice(0, rho).reduce((total, value) => total + value, 0) - 1) / Math.max(1, rho);
  return values.map((value) => Math.max(0, value - theta));
}

function optimizeWeights(rows, temperatures, candidateCount) {
  if (rows.length < 80) return { memberWeights: Array(candidateCount).fill(.8 / candidateCount), neutralWeight: .2 };
  let weights = Array(candidateCount + 1).fill(1 / (candidateCount + 1));
  for (let iteration = 0; iteration < 700; iteration += 1) {
    const gradient = Array(weights.length).fill(0);
    for (const row of rows) {
      const features = row.draftLogits.map((value, index) => value / temperatures[index]).concat(0);
      const combined = row.baseLogit + features.reduce((sum, value, index) => sum + value * weights[index], 0);
      const error = sigmoid(combined) - row.outcome;
      for (let index = 0; index < gradient.length; index += 1) gradient[index] += error * features[index] / rows.length;
    }
    const rate = .35 / Math.sqrt(1 + iteration / 30);
    weights = projectSimplex(weights.map((weight, index) => weight - rate * gradient[index]));
  }
  return { memberWeights: weights.slice(0, candidateCount), neutralWeight: weights.at(-1) };
}

function ensembleLogit(row, temperatures, weights) {
  return row.baseLogit + row.draftLogits.reduce((sum, value, index) => sum + weights.memberWeights[index] * value / temperatures[index], 0);
}

function rounded(value) { return typeof value === "number" ? Number(value.toFixed(6)) : value; }
function roundedMetrics(metrics) { return Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, rounded(value)])); }

function compactMap(values, counts, minimum) {
  return Object.fromEntries([...values.entries()].filter(([key]) => (counts.get(String(key)) ?? 0) >= minimum).sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([key, coefficient]) => [key, { coefficient: Number(coefficient.toFixed(5)), games: counts.get(String(key)) ?? 0 }]));
}

function exportLinear(state, names) {
  const heroIds = new Set([...state.hero.keys(), ...state.counts.hero.keys()]); const heroes = {};
  for (const heroId of [...heroIds].sort((a, b) => Number(a) - Number(b))) {
    const roles = {};
    for (let role = 1; role <= 5; role += 1) { const key = roleKey(heroId, role); if (state.counts.role.get(key)) roles[role] = { coefficient: Number(mapValue(state.role, key).toFixed(5)), games: state.counts.role.get(key) }; }
    heroes[heroId] = { name: names.get(Number(heroId)) ?? `Hero ${heroId}`, coefficient: Number(mapValue(state.hero, heroId).toFixed(5)), games: state.counts.hero.get(String(heroId)) ?? 0, roles };
  }
  return { type: "linear", inference: { heroScale: state.config.heroScale ?? 0, roleScale: state.config.roleScale ?? 0, synergyScale: state.config.synergyScale ?? 0, counterScale: state.config.counterScale ?? 0 }, heroes, synergy: compactMap(state.synergy, state.counts.synergy, MIN_PAIR_GAMES), counters: compactMap(state.counter, state.counts.counter, MIN_PAIR_GAMES) };
}

function exportFm(state, names) {
  const heroes = {};
  for (const heroId of [...state.counts.hero.keys()].sort((a, b) => Number(a) - Number(b))) {
    const roles = {};
    for (let role = 1; role <= 5; role += 1) { const key = roleKey(heroId, role); if (state.counts.role.get(key)) roles[role] = { coefficient: Number(mapValue(state.role, key).toFixed(5)), games: state.counts.role.get(key) }; }
    heroes[heroId] = { name: names.get(Number(heroId)) ?? `Hero ${heroId}`, coefficient: Number(mapValue(state.hero, heroId).toFixed(5)), games: state.counts.hero.get(String(heroId)) ?? 0, roles, embedding: fmEmbedding(state, heroId, true).map((value) => Number(value.toFixed(5))) };
  }
  return { type: "fm", inference: { heroScale: state.config.heroScale, roleScale: state.config.roleScale, dimensions: state.config.dimensions }, heroes };
}

function exportNaive(state, names) {
  const heroes = {};
  for (const heroId of [...state.counts.hero.keys()].sort((a, b) => Number(a) - Number(b))) heroes[heroId] = { name: names.get(Number(heroId)) ?? `Hero ${heroId}`, coefficient: Number(naiveCoefficient(state, heroId).toFixed(5)), games: state.counts.hero.get(String(heroId)) ?? 0, roles: {} };
  return { type: "linear", inference: { heroScale: state.config.scale, roleScale: 0, synergyScale: 0, counterScale: 0 }, heroes, synergy: {}, counters: {} };
}

async function loadDataset() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const matchRows = db.prepare("SELECT * FROM matches ORDER BY start_time, match_id").all();
  const playerRows = db.prepare("SELECT * FROM players ORDER BY match_id, side, slot").all();
  const playersByMatch = new Map();
  for (const row of playerRows) {
    const id = Number(row.match_id); const players = playersByMatch.get(id) ?? { radiant: [], dire: [] };
    players[row.side === 0 ? "radiant" : "dire"].push({ heroId: Number(row.hero_id), role: Number(row.role || 0), accountId: Number(row.account_id || 0) }); playersByMatch.set(id, players);
  }
  const matches = matchRows.flatMap((row) => {
    const players = playersByMatch.get(Number(row.match_id)); if (!players || players.radiant.length !== 5 || players.dire.length !== 5) return [];
    return [{ matchId: Number(row.match_id), seriesId: String(row.series_id || `match:${row.match_id}`), patchId: Number(row.patch_id), subpatchId: String(row.subpatch_id || row.patch_id), startTime: Number(row.start_time), domain: row.domain, leagueId: Number(row.league_id || 0), radiantTeamId: Number(row.radiant_team_id || 0), direTeamId: Number(row.dire_team_id || 0), radiantWin: Number(row.radiant_win), ...players }];
  });
  db.close(); return matches;
}

async function main() {
  const [matches, patchFeatures, draftStats, coverage] = await Promise.all([loadDataset(), optionalJson(PATCH_FEATURES, { patches: {} }), optionalJson(DRAFT_STATS, { heroes: [] }), optionalJson(COVERAGE_REPORT, { deployment: { sufficient: false, status: "missing_coverage_audit" } })]);
  if (!matches.length) throw new Error("Training dataset is empty. Run npm run draft:data first.");
  const names = new Map((draftStats.heroes ?? []).map((hero) => [Number(hero.id), hero.name]));
  const grouped = new Map(); for (const match of matches) grouped.set(match.subpatchId, [...(grouped.get(match.subpatchId) ?? []), match]);
  const patches = [...grouped.entries()].sort((a, b) => a[1][0].startTime - b[1][0].startTime);
  const candidates = [...LINEAR_CONFIGS.map(freshLinear), ...FM_CONFIGS.map(freshFm), ...NAIVE_CONFIGS.map(freshNaive)];
  const candidateNames = candidates.map((state) => state.config.name); const baseline = freshTeamBaseline(); const historyRows = []; const folds = []; const productionOofRows = [];
  const productionIndices = PRODUCTION_MEMBER_NAMES.map((name) => candidateNames.indexOf(name));

  for (let patchIndex = 0; patchIndex < patches.length; patchIndex += 1) {
    const [patchId, patchMatches] = patches[patchIndex]; const testMatches = patchMatches.filter((match) => match.domain === "pro"); const configured = patchFeatures.patches?.[String(patchId)] ?? {};
    const isLetterPatch = /[a-z]$/i.test(String(patchId));
    const magnitude = Number(configured.magnitude ?? (configured.kind === "major" ? 2.4 : configured.kind === "letter" || isLetterPatch ? .55 : 2.2));
    if (patchIndex > 0) { transferTeamBaseline(baseline, magnitude); for (const candidate of candidates) transferCandidate(candidate, magnitude); }
    const rows = testMatches.map((match) => ({ matchId: match.matchId, seriesId: match.seriesId, patchId, outcome: match.radiantWin, baseLogit: teamBaselineScore(baseline, match), draftLogits: candidates.map((candidate) => candidateDraftScore(candidate, match)) }));
    const outcomes = rows.map((row) => row.outcome); const temperatures = candidates.map((_, index) => optimizeTemperature(historyRows, index)); const weights = optimizeWeights(historyRows, temperatures, candidates.length);
    const baselineMetrics = metricsFromLogits(rows.map((row) => row.baseLogit), outcomes);
    const candidateMetrics = Object.fromEntries(candidateNames.map((name, index) => [name, roundedMetrics(metricsFromLogits(rows.map((row) => row.baseLogit + row.draftLogits[index] / temperatures[index]), outcomes))]));
    const ensembleMetrics = metricsFromLogits(rows.map((row) => ensembleLogit(row, temperatures, weights)), outcomes);
    const productionHistory = historyRows.map((row) => ({ ...row, draftLogits: productionIndices.map((index) => row.draftLogits[index]) }));
    const productionRows = rows.map((row) => ({ ...row, draftLogits: productionIndices.map((index) => row.draftLogits[index]) }));
    const productionTemperatures = productionIndices.map((index) => temperatures[index]);
    const productionWeights = optimizeWeights(productionHistory, productionTemperatures, productionIndices.length);
    const productionLogits = productionRows.map((row) => ensembleLogit(row, productionTemperatures, productionWeights));
    const productionMetrics = metricsFromLogits(productionLogits, outcomes);
    if (patchIndex > 0) productionOofRows.push(...productionRows.map((row, index) => ({ seriesId: row.seriesId, outcome: row.outcome, productionProbability: sigmoid(productionLogits[index]), baselineProbability: sigmoid(row.baseLogit) })));
    folds.push({ patchId, firstMatch: new Date(patchMatches[0].startTime * 1000).toISOString(), matches: testMatches.length, trainingMatches: patchMatches.length, highMmrTrainingMatches: patchMatches.length - testMatches.length, coldStart: patchIndex === 0, transitionMagnitude: magnitude, baseline: roundedMetrics(baselineMetrics), candidates: candidateMetrics, ensemble: roundedMetrics(ensembleMetrics), production: roundedMetrics(productionMetrics), onlineStack: { temperatures: temperatures.map(rounded), weights: Object.fromEntries(candidateNames.map((name, index) => [name, rounded(weights.memberWeights[index])])), neutralWeight: rounded(weights.neutralWeight) } });
    if (patchIndex > 0) historyRows.push(...rows);
    fitTeamBaseline(baseline, patchMatches); for (const candidate of candidates) fitCandidate(candidate, patchMatches);
    process.stdout.write(`Arena: patch ${patchId}, ${testMatches.length} pro test / ${patchMatches.length} train matches, ensemble log loss ${ensembleMetrics.logLoss.toFixed(5)} vs baseline ${baselineMetrics.logLoss.toFixed(5)}\n`);
  }

  const eligibleFolds = folds.filter((fold) => !fold.coldStart); const eligibleMatches = eligibleFolds.reduce((sum, fold) => sum + fold.matches, 0);
  const aggregate = (source, key) => eligibleMatches ? eligibleFolds.reduce((sum, fold) => sum + fold[source][key] * fold.matches, 0) / eligibleMatches : null;
  const leaderboard = candidateNames.map((name) => {
    const logLoss = eligibleMatches ? eligibleFolds.reduce((sum, fold) => sum + fold.candidates[name].logLoss * fold.matches, 0) / eligibleMatches : null;
    const brier = eligibleMatches ? eligibleFolds.reduce((sum, fold) => sum + fold.candidates[name].brier * fold.matches, 0) / eligibleMatches : null;
    const accuracy = eligibleMatches ? eligibleFolds.reduce((sum, fold) => sum + fold.candidates[name].accuracy * fold.matches, 0) / eligibleMatches : null;
    return { name, logLoss, brier, accuracy };
  }).sort((a, b) => a.logLoss - b.logLoss);
  const finalTemperatures = candidates.map((_, index) => optimizeTemperature(historyRows, index)); const finalWeights = optimizeWeights(historyRows, finalTemperatures, candidates.length);
  const productionHistory = historyRows.map((row) => ({ ...row, draftLogits: productionIndices.map((index) => row.draftLogits[index]) }));
  const finalProductionTemperatures = productionIndices.map((index) => finalTemperatures[index]);
  const finalProductionWeights = optimizeWeights(productionHistory, finalProductionTemperatures, productionIndices.length);
  const ensembleLogLoss = aggregate("production", "logLoss"); const baselineLogLoss = aggregate("baseline", "logLoss"); const logLossDelta = ensembleLogLoss - baselineLogLoss;
  const bootstrap = seriesClusterBootstrap(productionOofRows);
  const foldsWon = eligibleFolds.filter((fold) => fold.production.logLoss < fold.baseline.logLoss).length;
  const statisticalGatePassed = eligibleFolds.length >= 3 && logLossDelta < -.002 && foldsWon / eligibleFolds.length >= .6 && bootstrap.upper95 < 0;
  const gatePassed = statisticalGatePassed && coverage.deployment?.sufficient === true;
  const recommendedWeight = gatePassed ? clamp(-logLossDelta / .02, .15, .8) : 0;
  const rankedMembers = productionIndices.map((index, productionIndex) => ({ state: candidates[index], index, name: candidateNames[index], weight: finalProductionWeights.memberWeights[productionIndex], temperature: finalProductionTemperatures[productionIndex] }));
  const keptTotal = rankedMembers.reduce((sum, row) => sum + row.weight, 0) + finalProductionWeights.neutralWeight;
  const members = rankedMembers.map(({ state, name, weight, temperature }) => ({ name, weight: Number((weight / keptTotal).toFixed(6)), temperature: Number(temperature.toFixed(5)), model: state.type === "linear" ? exportLinear(state, names) : state.type === "fm" ? exportFm(state, names) : exportNaive(state, names) }));
  const domains = Object.fromEntries([...new Set(matches.map((match) => match.domain))].map((domain) => [domain, matches.filter((match) => match.domain === domain).length]));
  const [currentPatchId, currentMatches] = patches.at(-1);
  const artifact = {
    schemaVersion: 1, modelFamily: "walk-forward-draft-ensemble-v1", trainedAt: new Date().toISOString(), trainingPolicy: "local-only; production receives compact ensemble members, never the training database",
    dataset: { matches: matches.length, patches: patches.length, exactVersions: patches.length, firstPatchId: patches[0][0], currentPatchId, currentPatchMatches: currentMatches.length, domains },
    methodology: { split: "strict exact-subpatch walk-forward; stacking weights and temperatures use past out-of-fold predictions only", baseline: "historical team strength + Radiant learned without target-subpatch outcomes", candidates: candidateNames, domainWeights: DOMAIN_WEIGHT, minimumExportedPairGames: MIN_PAIR_GAMES, productionMembers: members.map((member) => member.name) },
    coverage: { status: coverage.deployment?.status, sufficient: coverage.deployment?.sufficient === true, window: coverage.window, totals: coverage.totals, failedVersions: coverage.deployment?.failedVersions ?? [] },
    backtest: { eligiblePatches: eligibleFolds.length, validatedObject: "fixed four-member production stack", aggregate: { model: { logLoss: ensembleLogLoss, brier: aggregate("production", "brier"), accuracy: aggregate("production", "accuracy") }, neutral: { logLoss: baselineLogLoss, brier: aggregate("baseline", "brier"), accuracy: aggregate("baseline", "accuracy") }, logLossDelta, foldsWon, seriesClusterBootstrap: bootstrap }, folds },
    arena: { leaderboard: leaderboard.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, rounded(value)]))), finalStack: { weights: Object.fromEntries(candidateNames.map((name, index) => [name, rounded(finalWeights.memberWeights[index])])), temperatures: Object.fromEntries(candidateNames.map((name, index) => [name, rounded(finalTemperatures[index])])), neutralWeight: rounded(finalWeights.neutralWeight) } },
    deployment: { status: gatePassed ? "candidate" : coverage.deployment?.sufficient ? "shadow" : "insufficient_data", recommendedWeight: Number(recommendedWeight.toFixed(3)), statisticalGatePassed, incrementalToActiveValidated: false, gate: "Sufficient coverage on every exact version, at least 3 future-patch folds, >60% folds won, aggregate incremental log loss improvement above 0.002, and series-cluster bootstrap upper 95% delta below zero. This gate is versus team-only, not incremental to the active formula." },
    inference: { radiantBias: 0, temperature: 1 },
    ensemble: { neutralWeight: Number((finalProductionWeights.neutralWeight / keptTotal).toFixed(6)), members },
  };
  const stableArtifact = { ...artifact }; delete stableArtifact.trainedAt;
  artifact.modelId = createHash("sha256").update(JSON.stringify(stableArtifact)).digest("hex").slice(0, 16);
  const report = { generatedAt: artifact.trainedAt, modelId: artifact.modelId, dataset: artifact.dataset, methodology: artifact.methodology, coverage: artifact.coverage, backtest: artifact.backtest, arena: artifact.arena, deployment: artifact.deployment };
  await Promise.all([writeFile(OUTPUT, `${JSON.stringify(artifact)}\n`), writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`)]);
  console.log(`Model Arena ${artifact.modelId}: ${candidates.length} candidates, ${members.length} production members, ${matches.length} matches; ${artifact.deployment.status.toUpperCase()}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
