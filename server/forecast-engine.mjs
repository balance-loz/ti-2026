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

const pairKey = (a, b) => [a, b].sort().join("|");
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
    const estimated = Math.min(.9, Math.max(.1, 1 / (1 + Math.exp(-(scores[a] - scores[b]) * .78))));
    const probability = exact ?? estimated * 100;
    result[key] = key.startsWith(`${a}|`) ? probability : 100 - probability;
  }
  return result;
}

export function buildForecastSource({ answers, stats, matches, mode = "mixed", opinionWeight = 50 }) {
  const personal = completePersonalAnswers(answers || {});
  const statistical = Object.fromEntries(Object.entries(stats?.pairwise || {}).map(([key, value]) => [key, value.probabilityA]));
  const weight = opinionWeight / 100;
  const base = mode === "stats" ? statistical : mode === "personal" ? personal : Object.fromEntries(Object.keys(personal).map((key) => [key, personal[key] * weight + (statistical[key] ?? personal[key]) * (1 - weight)]));
  const strength = Object.fromEntries(TEAMS.map((team) => [team.id, 0]));
  const direct = new Map();
  for (const match of (matches || []).filter((item) => item.winner)) {
    const p = storedProbability(match.team_a, match.team_b, base) ?? 50;
    const outcome = match.winner === match.team_a ? 1 : 0;
    const surprise = outcome - p / 100;
    strength[match.team_a] += surprise * .9; strength[match.team_b] -= surprise * .9;
    const key = pairKey(match.team_a, match.team_b);
    const oriented = key.startsWith(`${match.team_a}|`) ? surprise : -surprise;
    direct.set(key, (direct.get(key) || 0) + oriented * .45);
  }
  const result = {};
  for (const [key, value] of Object.entries(base)) {
    const [a, b] = key.split("|");
    result[key] = 100 / (1 + Math.exp(-(Math.log(Math.max(.03, value / 100) / Math.max(.03, 1 - value / 100)) + strength[a] - strength[b] + (direct.get(key) || 0))));
  }
  return result;
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

export function runForecast(answers, iterations = 100000, seed = Math.floor(Math.random() * 0xffffffff), { matches = [], stats = null } = {}) {
  const scores = teamScores(answers); const random = seededRandom(seed);
  const totals = Object.fromEntries(TEAMS.map((team) => [team.id, { direct: 0, playin: 0, viaPlayin: 0, out: 0, wins: 0, losses: 0 }]));
  const scenarioCounts = new Map(); const matchupCounts = new Map(); const bracketHashes = new Set();
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const path = []; let round = 1;
    const records = Object.fromEntries(TEAMS.map((team) => [team.id, { wins: 0, losses: 0, opponents: new Set() }]));
    const form = Object.fromEntries(TEAMS.map((team) => [team.id, normalRandom(random) * .16]));
    const winnerFor = (a, b) => {
      const base = (storedProbability(a, b, answers) ?? 50) / 100;
      const uncertainty = stats?.pairwise?.[pairKey(a, b)]?.uncertainty ?? .07;
      const probability = 1 / (1 + Math.exp(-(Math.log(Math.max(.03, base) / Math.max(.03, 1 - base)) + form[a] - form[b] + normalRandom(random) * uncertainty)));
      return random() < probability ? a : b;
    };
    const play = (a, b, fixed = null) => { const winner = fixed === a || fixed === b ? fixed : winnerFor(a, b); const loser = winner === a ? b : a; records[winner].wins++; records[loser].losses++; records[a].opponents.add(b); records[b].opponents.add(a); path.push(`${round}:${pairKey(a, b)}>${winner}`); };
    for (round = 1; round <= 5; round += 1) {
      const actual = matches.filter((match) => match.stage === "swiss" && match.winner && match.round === round); const occupied = new Set();
      for (const match of actual) if (records[match.team_a] && records[match.team_b]) { play(match.team_a, match.team_b, match.winner); occupied.add(match.team_a); occupied.add(match.team_b); }
      if (round === 1) ROUND_ONE.filter(([a, b]) => !occupied.has(a) && !occupied.has(b)).forEach(([a, b]) => play(a, b));
      else {
        const buckets = new Map();
        for (const team of TEAMS.filter((item) => records[item.id].wins < 4 && records[item.id].losses < 4 && !occupied.has(item.id))) { const key = `${records[team.id].wins}-${records[team.id].losses}`; buckets.set(key, [...(buckets.get(key) || []), team.id]); }
        for (const ids of buckets.values()) pairBucket(ids, records, random).forEach(([a, b]) => play(a, b));
      }
    }
    const direct = []; const via = [];
    for (const team of TEAMS) { const record = records[team.id]; const total = totals[team.id]; total.wins += record.wins; total.losses += record.losses; if (record.wins === 4) { total.direct++; direct.push(team.id); } else if (record.losses === 4) total.out++; else total.playin++; }
    const buchholz = (id) => [...records[id].opponents].reduce((sum, opponent) => sum + records[opponent].wins, 0);
    const upper = TEAMS.filter((team) => records[team.id].wins === 3).map((team) => team.id).sort((a, b) => buchholz(b) - buchholz(a) || scores[b] - scores[a]);
    const lower = TEAMS.filter((team) => records[team.id].wins === 2).map((team) => team.id).sort((a, b) => buchholz(a) - buchholz(b) || scores[a] - scores[b]);
    const completedPlayins = matches.filter((match) => match.stage === "playin" && match.winner);
    upper.forEach((a, index) => { const b = lower[index]; const actual = completedPlayins.find((match) => (match.team_a === a && match.team_b === b) || (match.team_a === b && match.team_b === a)); const winner = actual?.winner || winnerFor(a, b); const loser = winner === a ? b : a; totals[winner].viaPlayin++; totals[loser].out++; via.push(winner); const key = pairKey(a, b); const first = key.split("|")[0]; const item = matchupCounts.get(key) || { count: 0, firstWins: 0 }; item.count++; if (winner === first) item.firstWins++; matchupCounts.set(key, item); path.push(`P:${key}>${winner}`); });
    const signature = JSON.stringify({ direct: direct.sort(), via: via.sort() }); scenarioCounts.set(signature, (scenarioCounts.get(signature) || 0) + 1);
    let hash = 2166136261; for (const char of path.join(";")) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); } bracketHashes.add(hash >>> 0);
  }
  const teams = TEAMS.map((team) => ({ ...team, qualify: 100 * (totals[team.id].direct + totals[team.id].viaPlayin) / iterations, direct: 100 * totals[team.id].direct / iterations, playin: 100 * totals[team.id].playin / iterations, viaPlayin: 100 * totals[team.id].viaPlayin / iterations, out: 100 * totals[team.id].out / iterations, avgWins: totals[team.id].wins / iterations, avgLosses: totals[team.id].losses / iterations })).sort((a, b) => b.qualify - a.qualify || b.direct - a.direct);
  const scenarios = [...scenarioCounts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([signature, count]) => ({ ...JSON.parse(signature), probability: 100 * count / iterations }));
  const playinMatchups = [...matchupCounts].sort((a, b) => b[1].count - a[1].count).slice(0, 10).map(([key, value]) => { const [a, b] = key.split("|"); return { a, b, probability: 100 * value.count / iterations, aWinProbability: 100 * value.firstWins / value.count }; });
  return { teams, scenarios, playinMatchups, iterations, seed, uniqueBrackets: bracketHashes.size, duplicateRate: 100 * (1 - bracketHashes.size / iterations) };
}
