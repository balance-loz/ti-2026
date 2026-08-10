"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Team = {
  id: string;
  name: string;
  short: string;
  color: string;
  logo: string;
};

type AnswerMap = Record<string, number>;

type StatisticalPair = {
  probabilityA: number;
  mapProbabilityA: number;
  directEffectiveGames: number;
  modelEffectiveGames: number;
  source: "head_to_head_and_indirect" | "indirect" | "roster_proxy";
  confidence: "low" | "medium" | "high";
  rosterReliability?: number;
  uncertainty?: number;
  featureContributions?: { commonOpponentsPp: number; headToHeadPp: number; rosterPp: number };
};

type StatisticalSeries = {
  opponentOpenDotaId: number;
  opponentName: string;
  reportedName: string;
  opponentTiId: string | null;
  opponentRosterStatus: "current" | "different" | "unverified" | "proxy";
  startTime: number;
  wins: number;
  losses: number;
  maps: { matchId: number; startTime: number; won: boolean }[];
};

type StatisticalTournament = {
  leagueId: number;
  name: string;
  rosterStatus: "current" | "different" | "proxy";
  sampleMatchId: number | null;
  expectedRoster: number[];
  sampledRoster: number[];
  reason: string | null;
  series: StatisticalSeries[];
};

type StatisticalTeam = {
  exactRosterGames: number;
  proxyRosterGames: number;
  matchesInPeriod: number;
  includedTournaments: unknown[];
  excludedTournaments: unknown[];
  tournaments: StatisticalTournament[];
  rosterProjection: null | {
    kind: "four_of_five_proxy";
    reliability: number;
    replacementOut: { accountId: number; name: string };
    replacementIn: { accountId: number; name: string };
    officialGames: number;
    note: string;
  };
};

type StatisticalModel = {
  generatedAt: string;
  periodStart: string;
  totals: { uniqueAcceptedGames: number };
  methodology: { recencyHalfLifeDays: number };
  teams: Record<string, StatisticalTeam>;
  pairwise: Record<string, StatisticalPair>;
};

type TeamForecast = Team & {
  qualify: number;
  direct: number;
  playin: number;
  viaPlayin: number;
  out: number;
  avgWins: number;
  avgLosses: number;
};

type Scenario = {
  probability: number;
  direct: string[];
  via: string[];
};

type PlayinMatchup = {
  a: string;
  b: string;
  probability: number;
  aWinProbability: number;
};

type SimulationResult = {
  teams: TeamForecast[];
  scenarios: Scenario[];
  playinMatchups: PlayinMatchup[];
  iterations: number;
  seed: number;
  uniqueBrackets: number;
  duplicateRate: number;
  formatVersion?: string;
};

type LikelyRound = { opponent: string; won: boolean; fixed: boolean; probability: number } | null;
type LikelyBracket = {
  rows: { id: string; wins: number; losses: number; status: "direct" | "playin" | "out"; rounds: LikelyRound[] }[];
  playins: { a: string; b: string; winner: string; probabilityA: number }[];
};
type LikelyPlayoffMatch = { label: string; a: string; b: string; winner: string; probabilityA: number; format: "BO3" | "BO5" };
type LikelyPlayoff = { qualifiers: string[]; stages: { name: string; matches: LikelyPlayoffMatch[] }[] };

type LiveMatch = {
  id: number;
  stage: string;
  round: number;
  team_a: string;
  team_b: string;
  winner: string | null;
  score_a: number | null;
  score_b: number | null;
  predicted_probability: number | null;
  scheduled_at: string | null;
  created_at: string;
  updated_at: string;
};

type LiveSyncState = {
  enabled: boolean;
  leagueId: number;
  intervalMinutes: number;
  running: boolean;
  autoForecastRunning: boolean;
  lastSync: null | {
    ok: boolean;
    maps?: number;
    completedSeries?: number;
    inserted?: number;
    updated?: number;
    unknownTeamIds?: number[];
    error?: string;
    updatedAt: string;
  };
};

type PredictionSnapshot = {
  id: number;
  trigger: string;
  forecast_mode: "personal" | "mixed" | "stats";
  opinion_weight: number;
  iterations: number;
  seed: number;
  completed_match_count: number;
  model_generated_at: string | null;
  probabilities: AnswerMap;
  result: SimulationResult;
  created_at: string;
};

type ServerState = {
  answers: AnswerMap;
  matches: LiveMatch[];
  snapshots: PredictionSnapshot[];
  isAdmin: boolean;
  refreshRunning: boolean;
  refresh: { value: string; updated_at: string } | null;
  liveSync: LiveSyncState;
};

const TEAMS: Team[] = [
  { id: "1w", name: "1w", short: "1W", color: "#f1f4f7", logo: "/team-logos/1w.webp" },
  { id: "aurora", name: "Aurora", short: "AU", color: "#19d3cb", logo: "/team-logos/aurora.webp" },
  { id: "betboom", name: "BETBOOM", short: "BB", color: "#ff384f", logo: "/team-logos/betboom.webp" },
  { id: "falcons", name: "Falcons", short: "FL", color: "#6bd263", logo: "/team-logos/falcons.jpg" },
  { id: "gamerlegion", name: "GamerLegion", short: "GL", color: "#94b9c7", logo: "/team-logos/gamerlegion.webp" },
  { id: "l1ga", name: "L1ga", short: "L1", color: "#4bfa6d", logo: "/team-logos/l1ga.webp" },
  { id: "lgd", name: "LGD", short: "LG", color: "#e32a4d", logo: "/team-logos/lgd.webp" },
  { id: "liquid", name: "Liquid", short: "TL", color: "#5f83d8", logo: "/team-logos/liquid.webp" },
  { id: "nigma", name: "Nigma", short: "NG", color: "#939aa7", logo: "/team-logos/nigma.webp" },
  { id: "og", name: "OG", short: "OG", color: "#a2c974", logo: "/team-logos/og.webp" },
  { id: "parivision", name: "PARIVISION", short: "PV", color: "#20d8c3", logo: "/team-logos/parivision.webp" },
  { id: "resilience", name: "Resilience", short: "RS", color: "#ec4a52", logo: "/team-logos/resilience.webp" },
  { id: "spirit", name: "Spirit", short: "SP", color: "#d8dee7", logo: "/team-logos/spirit.webp" },
  { id: "vg", name: "VG", short: "VG", color: "#c9b78d", logo: "/team-logos/vg.webp" },
  { id: "xtreme", name: "Xtreme", short: "XT", color: "#dce3ea", logo: "/team-logos/xtreme.webp" },
  { id: "yandex", name: "Yandex", short: "YX", color: "#ff514f", logo: "/team-logos/yandex.webp" },
];

const ROUND_ONE: [string, string][] = [
  ["1w", "nigma"],
  ["aurora", "gamerlegion"],
  ["betboom", "og"],
  ["falcons", "lgd"],
  ["l1ga", "yandex"],
  ["liquid", "vg"],
  ["parivision", "resilience"],
  ["spirit", "xtreme"],
];

const SWISS_GROUPS = {
  A: ["parivision", "nigma", "falcons", "og", "betboom", "lgd", "1w", "resilience"],
  B: ["yandex", "xtreme", "liquid", "vg", "aurora", "gamerlegion", "spirit", "l1ga"],
} as const;
const SWISS_GROUP_BY_TEAM = Object.fromEntries(Object.entries(SWISS_GROUPS).flatMap(([group, ids]) => ids.map((id) => [id, group]))) as Record<string, "A" | "B">;
const swissBucketKey = (id: string, wins: number, losses: number, round: number) => `${round <= 3 ? SWISS_GROUP_BY_TEAM[id] : "ALL"}:${wins}-${losses}`;

const ALL_PAIRS: [string, string][] = (() => {
  const firstRoundKeys = new Set(ROUND_ONE.map(([a, b]) => pairKey(a, b)));
  const rest: [string, string][] = [];

  for (let i = 0; i < TEAMS.length; i += 1) {
    for (let j = i + 1; j < TEAMS.length; j += 1) {
      const pair: [string, string] = [TEAMS[i].id, TEAMS[j].id];
      if (!firstRoundKeys.has(pairKey(...pair))) rest.push(pair);
    }
  }

  return [...ROUND_ONE, ...rest];
})();

function pairKey(a: string, b: string) {
  return [a, b].sort().join("|");
}

function csvCell(value: string | number) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function parseCsvLine(line: string) {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

function getTeam(id: string) {
  return TEAMS.find((team) => team.id === id) ?? TEAMS[0];
}

function nextUnansweredIndex(current: number, answers: AnswerMap) {
  for (let offset = 1; offset < ALL_PAIRS.length; offset += 1) {
    const index = (current + offset) % ALL_PAIRS.length;
    const [a, b] = ALL_PAIRS[index];
    if (answers[pairKey(a, b)] === undefined) return index;
  }
  return null;
}

function storedProbability(a: string, b: string, answers: AnswerMap) {
  const key = pairKey(a, b);
  const value = answers[key];
  if (value === undefined) return undefined;
  return key.startsWith(`${a}|`) ? value : 100 - value;
}

function statisticalAnswers(model: StatisticalModel | null): AnswerMap {
  if (!model) return {};
  return Object.fromEntries(Object.entries(model.pairwise).map(([key, pair]) => [key, pair.probabilityA]));
}

function completePersonalAnswers(answers: AnswerMap): AnswerMap {
  const scores = teamScores(answers);
  return Object.fromEntries(ALL_PAIRS.map(([a, b]) => {
    const key = pairKey(a, b);
    const probabilityForA = matchupProbability(a, b, answers, scores) * 100;
    return [key, key.startsWith(`${a}|`) ? probabilityForA : 100 - probabilityForA];
  }));
}

function mixedAnswers(answers: AnswerMap, model: StatisticalModel | null, opinionWeight: number) {
  const personal = completePersonalAnswers(answers);
  const statistical = statisticalAnswers(model);
  const weight = opinionWeight / 100;
  return Object.fromEntries(Object.keys(personal).map((key) => [
    key,
    personal[key] * weight + (statistical[key] ?? personal[key]) * (1 - weight),
  ]));
}

function applyLiveEvidence(source: AnswerMap, matches: LiveMatch[]) {
  const strength = Object.fromEntries(TEAMS.map((team) => [team.id, 0])) as Record<string, number>;
  const direct = new Map<string, number>();
  for (const match of matches.filter((item) => item.winner)) {
    const p = storedProbability(match.team_a, match.team_b, source) ?? 50;
    const outcome = match.winner === match.team_a ? 1 : 0;
    const surprise = outcome - p / 100;
    // One TI series is deliberately worth roughly several ordinary historical
    // series: it measures the current lineup, patch and tournament conditions.
    strength[match.team_a] += surprise * 0.9;
    strength[match.team_b] -= surprise * 0.9;
    const key = pairKey(match.team_a, match.team_b);
    const oriented = key.startsWith(`${match.team_a}|`) ? surprise : -surprise;
    direct.set(key, (direct.get(key) ?? 0) + oriented * 0.45);
  }
  return Object.fromEntries(ALL_PAIRS.map(([a, b]) => {
    const key = pairKey(a, b);
    const base = (storedProbability(a, b, source) ?? 50) / 100;
    const orientedResidual = key.startsWith(`${a}|`) ? (direct.get(key) ?? 0) : -(direct.get(key) ?? 0);
    const adjusted = 1 / (1 + Math.exp(-(logit(base) + strength[a] - strength[b] + orientedResidual)));
    return [key, key.startsWith(`${a}|`) ? adjusted * 100 : (1 - adjusted) * 100];
  }));
}

function predictionExplanation(
  a: string,
  b: string,
  personalAnswers: AnswerMap,
  model: StatisticalModel | null,
  mode: "personal" | "mixed" | "stats",
  opinionWeight: number,
  liveMatches: LiveMatch[],
) {
  const stat = storedProbability(a, b, statisticalAnswers(model));
  const personal = storedProbability(a, b, completePersonalAnswers(personalAnswers));
  const base = mode === "stats" ? statisticalAnswers(model) : mode === "mixed" ? mixedAnswers(personalAnswers, model, opinionWeight) : completePersonalAnswers(personalAnswers);
  const beforeLive = storedProbability(a, b, base) ?? 50;
  const afterLive = storedProbability(a, b, applyLiveEvidence(base, liveMatches)) ?? beforeLive;
  const pair = model?.pairwise[pairKey(a, b)];
  const orientation = pairKey(a, b).startsWith(`${a}|`) ? 1 : -1;
  const items = [];
  if (stat !== undefined) items.push({ label: "Общие соперники + свежесть", value: orientation * (pair?.featureContributions?.commonOpponentsPp ?? (stat - 50)), text: `${getTeam(a).short} ${stat.toFixed(1)}% по рейтингу свежих серий` });
  if (pair) items.push({ label: "Личные встречи", value: orientation * (pair.featureContributions?.headToHeadPp ?? 0), text: pair.directEffectiveGames >= 0.75 ? `учтён вес ${pair.directEffectiveGames.toFixed(1)} свежих серий` : "данных мало — H2H почти не двигает прогноз" });
  if (pair) items.push({ label: "Состав и надёжность", value: orientation * (pair.featureContributions?.rosterPp ?? 0), text: `${pair.modelEffectiveGames.toFixed(1)} эффективных серий · доверие ${pair.confidence === "high" ? "высокое" : pair.confidence === "medium" ? "среднее" : "низкое"}` });
  if (mode === "mixed" && personal !== undefined && stat !== undefined) items.push({ label: "Твоё мнение", value: (personal - stat) * opinionWeight / 100, text: `${opinionWeight}% смеси: сдвиг ${((personal - stat) * opinionWeight / 100).toFixed(1)} п.п.` });
  if (liveMatches.length) items.push({ label: "Матчи текущего TI", value: afterLive - beforeLive, text: `${liveMatches.length} сыгранных серий: сдвиг ${(afterLive - beforeLive).toFixed(1)} п.п.` });
  return { beforeLive, afterLive, items };
}

function snapshotEvaluation(snapshot: PredictionSnapshot, matches: LiveMatch[]) {
  const future = matches.filter((match) => match.winner && Date.parse(match.updated_at || match.created_at) > Date.parse(snapshot.created_at));
  let correct = 0; let brier = 0; let logLoss = 0;
  for (const match of future) {
    const pA = (storedProbability(match.team_a, match.team_b, snapshot.probabilities) ?? 50) / 100;
    const outcome = match.winner === match.team_a ? 1 : 0;
    correct += (pA >= 0.5 ? match.team_a : match.team_b) === match.winner ? 1 : 0;
    brier += (pA - outcome) ** 2;
    const safe = Math.min(0.999, Math.max(0.001, pA));
    logLoss += -(outcome * Math.log(safe) + (1 - outcome) * Math.log(1 - safe));
  }
  return { count: future.length, correct, brier: future.length ? brier / future.length : null, logLoss: future.length ? logLoss / future.length : null };
}

function samplingMargin(iterations: number) {
  return 98 / Math.sqrt(iterations);
}

function teamScores(answers: AnswerMap) {
  const totals: Record<string, { sum: number; count: number }> = Object.fromEntries(
    TEAMS.map((team) => [team.id, { sum: 0, count: 0 }]),
  );

  Object.entries(answers).forEach(([key, percent]) => {
    const [a, b] = key.split("|");
    const safeP = Math.min(0.95, Math.max(0.05, percent / 100));
    const signal = Math.log(safeP / (1 - safeP));
    totals[a].sum += signal;
    totals[a].count += 1;
    totals[b].sum -= signal;
    totals[b].count += 1;
  });

  return Object.fromEntries(
    TEAMS.map((team) => {
      const value = totals[team.id];
      return [team.id, value.count ? value.sum / value.count : 0];
    }),
  );
}

function matchupProbability(
  a: string,
  b: string,
  answers: AnswerMap,
  scores: Record<string, number>,
) {
  const exact = storedProbability(a, b, answers);
  if (exact !== undefined) return exact / 100;
  const estimated = 1 / (1 + Math.exp(-(scores[a] - scores[b]) * 0.78));
  return Math.min(0.9, Math.max(0.1, estimated));
}

function seededRandom(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function normalRandom(random: () => number) {
  const u = Math.max(1e-9, random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

function logit(p: number) {
  const safe = Math.min(0.97, Math.max(0.03, p));
  return Math.log(safe / (1 - safe));
}

function shuffle<T>(items: T[], random: () => number) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function pairBucket(
  ids: string[],
  records: Record<string, { wins: number; losses: number; opponents: Set<string> }>,
  random: () => number,
) {
  let best: [string, string][] = [];
  let bestRematches = Number.POSITIVE_INFINITY;

  for (let attempt = 0; attempt < 36; attempt += 1) {
    const order = shuffle(ids, random);
    const pairs: [string, string][] = [];
    let rematches = 0;
    for (let i = 0; i < order.length; i += 2) {
      const pair: [string, string] = [order[i], order[i + 1]];
      if (records[pair[0]].opponents.has(pair[1])) rematches += 1;
      pairs.push(pair);
    }
    if (rematches < bestRematches) {
      best = pairs;
      bestRematches = rematches;
      if (rematches === 0) break;
    }
  }

  return best;
}

function deterministicPairs(ids: string[], records: Record<string, { wins: number; losses: number; opponents: Set<string> }>, scores: Record<string, number>) {
  const ordered = [...ids].sort((a, b) => scores[b] - scores[a] || a.localeCompare(b));
  const solve = (remaining: string[]): { pairs: [string, string][]; cost: number } => {
    if (!remaining.length) return { pairs: [], cost: 0 };
    const first = remaining[0]; let best: { pairs: [string, string][]; cost: number } | null = null;
    for (let index = 1; index < remaining.length; index += 1) {
      const second = remaining[index];
      const rest = remaining.filter((_, position) => position !== 0 && position !== index);
      const tail = solve(rest);
      const cost = tail.cost + (records[first].opponents.has(second) ? 1000 : 0) + Math.abs(scores[first] - scores[second]);
      if (!best || cost < best.cost) best = { pairs: [[first, second], ...tail.pairs], cost };
    }
    return best ?? { pairs: [], cost: 0 };
  };
  return solve(ordered).pairs;
}

function buildLikelyBracket(answers: AnswerMap, liveMatches: LiveMatch[]): LikelyBracket {
  const scores = teamScores(answers);
  const records = Object.fromEntries(TEAMS.map((team) => [team.id, { wins: 0, losses: 0, opponents: new Set<string>(), rounds: Array<LikelyRound>(5).fill(null) }])) as Record<string, { wins: number; losses: number; opponents: Set<string>; rounds: LikelyRound[] }>;
  const play = (round: number, a: string, b: string, fixedWinner?: string | null, savedProbabilityA?: number | null) => {
    const probabilityA = savedProbabilityA ?? storedProbability(a, b, answers) ?? 50;
    const winner = fixedWinner === a || fixedWinner === b ? fixedWinner : probabilityA >= 50 ? a : b;
    const loser = winner === a ? b : a;
    records[winner].wins += 1; records[loser].losses += 1;
    records[a].opponents.add(b); records[b].opponents.add(a);
    records[a].rounds[round - 1] = { opponent: b, won: winner === a, fixed: Boolean(fixedWinner), probability: probabilityA };
    records[b].rounds[round - 1] = { opponent: a, won: winner === b, fixed: Boolean(fixedWinner), probability: 100 - probabilityA };
  };
  for (let round = 1; round <= 5; round += 1) {
    const known = liveMatches.filter((match) => match.stage === "swiss" && match.round === round);
    const occupied = new Set<string>();
    for (const match of known) if (records[match.team_a] && records[match.team_b]) { play(round, match.team_a, match.team_b, match.winner, match.predicted_probability); occupied.add(match.team_a); occupied.add(match.team_b); }
    if (round === 1) ROUND_ONE.filter(([a, b]) => !occupied.has(a) && !occupied.has(b)).forEach(([a, b]) => play(round, a, b));
    else {
      const buckets = new Map<string, string[]>();
      TEAMS.filter((team) => records[team.id].wins < 4 && records[team.id].losses < 4 && !occupied.has(team.id)).forEach((team) => {
        const key = swissBucketKey(team.id, records[team.id].wins, records[team.id].losses, round);
        buckets.set(key, [...(buckets.get(key) ?? []), team.id]);
      });
      [...buckets.values()].forEach((ids) => deterministicPairs(ids, records, scores).forEach(([a, b]) => play(round, a, b)));
    }
  }
  const buchholz = (id: string) => [...records[id].opponents].reduce((sum, opponent) => sum + records[opponent].wins, 0);
  const upper = TEAMS.filter((team) => records[team.id].wins === 3).map((team) => team.id).sort((a, b) => buchholz(b) - buchholz(a) || scores[b] - scores[a]);
  const lower = TEAMS.filter((team) => records[team.id].wins === 2).map((team) => team.id).sort((a, b) => buchholz(a) - buchholz(b) || scores[a] - scores[b]);
  const playins = upper.map((a, index) => { const b = lower[index]; const actual = liveMatches.find((match) => match.stage === "playin" && match.winner && ((match.team_a === a && match.team_b === b) || (match.team_a === b && match.team_b === a))); const probabilityA = actual ? (actual.team_a === a ? actual.predicted_probability : actual.predicted_probability === null ? null : 100 - actual.predicted_probability) ?? (storedProbability(a, b, answers) ?? 50) : storedProbability(a, b, answers) ?? 50; return { a, b, winner: actual?.winner ?? (probabilityA >= 50 ? a : b), probabilityA }; });
  const rows = TEAMS.map((team) => ({ id: team.id, wins: records[team.id].wins, losses: records[team.id].losses, status: (records[team.id].wins === 4 ? "direct" : records[team.id].losses === 4 ? "out" : "playin") as "direct" | "playin" | "out", rounds: records[team.id].rounds }))
    .sort((a, b) => (a.status === "direct" ? 0 : a.status === "playin" ? 1 : 2) - (b.status === "direct" ? 0 : b.status === "playin" ? 1 : 2) || b.wins - a.wins || a.losses - b.losses || scores[b.id] - scores[a.id]);
  return { rows, playins };
}

function buildLikelyPlayoff(swiss: LikelyBracket, answers: AnswerMap, liveMatches: LiveMatch[]): LikelyPlayoff {
  const direct = swiss.rows.filter((row) => row.status === "direct").map((row) => row.id);
  const qualifiers = [...direct, ...swiss.playins.map((match) => match.winner)].slice(0, 8);
  const versus = (label: string, a: string, b: string, format: "BO3" | "BO5" = "BO3"): LikelyPlayoffMatch => {
    const actual = liveMatches.find((match) => match.stage === "playoff" && ((match.team_a === a && match.team_b === b) || (match.team_a === b && match.team_b === a)));
    const saved = actual?.predicted_probability === null || actual?.predicted_probability === undefined ? null : actual.team_a === a ? actual.predicted_probability : 100 - actual.predicted_probability;
    const probabilityA = saved ?? storedProbability(a, b, answers) ?? 50;
    return { label, a, b, winner: actual?.winner ?? (probabilityA >= 50 ? a : b), probabilityA, format };
  };
  if (qualifiers.length < 8) return { qualifiers, stages: [] };
  const knownOpening = liveMatches.filter((match) => match.stage === "playoff" && match.round === 1).slice(0, 4);
  const openingPairs = knownOpening.length === 4 ? knownOpening.map((match) => [match.team_a, match.team_b] as [string, string]) : [[qualifiers[0], qualifiers[7]], [qualifiers[3], qualifiers[4]], [qualifiers[1], qualifiers[6]], [qualifiers[2], qualifiers[5]]] as [string, string][];
  const uq = openingPairs.map(([a, b], index) => versus(`UB QF ${index + 1}`, a, b));
  const loser = (match: LikelyPlayoffMatch) => match.winner === match.a ? match.b : match.a;
  const us = [versus("UB SF 1", uq[0].winner, uq[1].winner), versus("UB SF 2", uq[2].winner, uq[3].winner)];
  const lr1 = [versus("LB R1 1", loser(uq[0]), loser(uq[1])), versus("LB R1 2", loser(uq[2]), loser(uq[3]))];
  const lr2 = [versus("LB R2 1", lr1[0].winner, loser(us[1])), versus("LB R2 2", lr1[1].winner, loser(us[0]))];
  const uf = versus("UB FINAL", us[0].winner, us[1].winner);
  const ls = versus("LB SF", lr2[0].winner, lr2[1].winner);
  const lf = versus("LB FINAL", ls.winner, loser(uf));
  const gf = versus("GRAND FINAL", uf.winner, lf.winner, "BO5");
  return { qualifiers, stages: [{ name: "Верхняя сетка · 1/4", matches: uq }, { name: "Верхняя 1/2 · Нижняя R1", matches: [...us, ...lr1] }, { name: "Финалы сеток", matches: [...lr2, uf, ls, lf] }, { name: "Гранд-финал", matches: [gf] }] };
}

function runSimulation(
  answers: AnswerMap,
  iterations = 10000,
  seed = Math.floor(Math.random() * 0xffffffff),
  options: { liveMatches?: LiveMatch[]; statisticalModel?: StatisticalModel | null } = {},
): SimulationResult {
  const scores = teamScores(answers);
  const random = seededRandom(seed);
  const totals = Object.fromEntries(
    TEAMS.map((team) => [
      team.id,
      { direct: 0, playin: 0, viaPlayin: 0, out: 0, wins: 0, losses: 0 },
    ]),
  ) as Record<
    string,
    { direct: number; playin: number; viaPlayin: number; out: number; wins: number; losses: number }
  >;
  const scenarioCounts = new Map<string, number>();
  const matchupCounts = new Map<string, { count: number; firstWins: number }>();
  const uniqueBracketHashes = new Set<number>();

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const pathParts: string[] = [];
    let currentRound = 1;
    const records = Object.fromEntries(
      TEAMS.map((team) => [
        team.id,
        { wins: 0, losses: 0, opponents: new Set<string>() },
      ]),
    ) as Record<
      string,
      { wins: number; losses: number; opponents: Set<string> }
    >;

    // A team's tournament form is a latent shock: it is sampled once and then
    // consistently affects all of that team's matches in this simulated bracket.
    const formShock = Object.fromEntries(TEAMS.map((team) => [team.id, normalRandom(random) * 0.16]));
    const sampleWinner = (a: string, b: string) => {
      const base = matchupProbability(a, b, answers, scores);
      const stat = options.statisticalModel?.pairwise[pairKey(a, b)];
      const uncertainty = stat?.uncertainty ?? 0.07;
      const probability = 1 / (1 + Math.exp(-(logit(base) + formShock[a] - formShock[b] + normalRandom(random) * uncertainty)));
      return random() < probability ? a : b;
    };

    const playMatch = (a: string, b: string, fixedWinner?: string | null) => {
      const winner = fixedWinner === a || fixedWinner === b ? fixedWinner : sampleWinner(a, b);
      const loser = winner === a ? b : a;
      records[winner].wins += 1;
      records[loser].losses += 1;
      records[a].opponents.add(b);
      records[b].opponents.add(a);
      pathParts.push(`${currentRound}:${pairKey(a, b)}>${winner}`);
    };

    const completed = (options.liveMatches ?? []).filter((match) => match.stage === "swiss" && match.winner);
    const playRound = (round: number) => {
      currentRound = round;
      const actual = completed.filter((match) => match.round === round);
      const alreadyPlaying = new Set<string>();
      actual.forEach((match) => {
        if (records[match.team_a] && records[match.team_b]) {
          playMatch(match.team_a, match.team_b, match.winner);
          alreadyPlaying.add(match.team_a); alreadyPlaying.add(match.team_b);
        }
      });
      if (round === 1) {
        ROUND_ONE.filter(([a, b]) => !alreadyPlaying.has(a) && !alreadyPlaying.has(b)).forEach(([a, b]) => playMatch(a, b));
        return;
      }
      const active = TEAMS.filter(
        (team) => records[team.id].wins < 4 && records[team.id].losses < 4 && !alreadyPlaying.has(team.id),
      );
      const buckets = new Map<string, string[]>();
      active.forEach((team) => {
        const record = records[team.id];
        const key = swissBucketKey(team.id, record.wins, record.losses, round);
        buckets.set(key, [...(buckets.get(key) ?? []), team.id]);
      });

      [...buckets.values()].forEach((ids) => {
        pairBucket(ids, records, random).forEach(([a, b]) => playMatch(a, b));
      });
    };
    for (let round = 1; round <= 5; round += 1) playRound(round);

    const direct: string[] = [];
    const via: string[] = [];
    TEAMS.forEach((team) => {
      const record = records[team.id];
      const aggregate = totals[team.id];
      aggregate.wins += record.wins;
      aggregate.losses += record.losses;
      if (record.wins === 4) {
        aggregate.direct += 1;
        direct.push(team.id);
      } else if (record.losses === 4) {
        aggregate.out += 1;
      } else {
        aggregate.playin += 1;
      }
    });

    const buchholz = (id: string) =>
      [...records[id].opponents].reduce((sum, opponent) => sum + records[opponent].wins, 0);
    const upper = TEAMS.filter((team) => records[team.id].wins === 3).map((team) => team.id)
      .sort((a, b) => buchholz(b) - buchholz(a) || scores[b] - scores[a] || a.localeCompare(b));
    const lower = TEAMS.filter((team) => records[team.id].wins === 2).map((team) => team.id)
      .sort((a, b) => buchholz(a) - buchholz(b) || scores[a] - scores[b] || b.localeCompare(a));
    const completedPlayins = (options.liveMatches ?? []).filter((match) => match.stage === "playin" && match.winner);

    upper.forEach((upperTeam, index) => {
      const lowerTeam = lower[index];
      const actual = completedPlayins.find((match) => (match.team_a === upperTeam && match.team_b === lowerTeam) || (match.team_a === lowerTeam && match.team_b === upperTeam));
      const winner = actual?.winner ?? sampleWinner(upperTeam, lowerTeam);
      const loser = winner === upperTeam ? lowerTeam : upperTeam;
      totals[winner].viaPlayin += 1;
      totals[loser].out += 1;
      via.push(winner);
      pathParts.push(`P:${pairKey(upperTeam, lowerTeam)}>${winner}`);

      const key = pairKey(upperTeam, lowerTeam);
      const first = key.split("|")[0];
      const current = matchupCounts.get(key) ?? { count: 0, firstWins: 0 };
      current.count += 1;
      if (winner === first) current.firstWins += 1;
      matchupCounts.set(key, current);
    });

    const signature = JSON.stringify({ direct: direct.sort(), via: via.sort() });
    scenarioCounts.set(signature, (scenarioCounts.get(signature) ?? 0) + 1);
    let hash = 2166136261;
    const pathSignature = pathParts.join(";");
    for (let index = 0; index < pathSignature.length; index += 1) {
      hash ^= pathSignature.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    uniqueBracketHashes.add(hash >>> 0);
  }

  const teams = TEAMS.map((team) => ({
    ...team,
    qualify: ((totals[team.id].direct + totals[team.id].viaPlayin) / iterations) * 100,
    direct: (totals[team.id].direct / iterations) * 100,
    playin: (totals[team.id].playin / iterations) * 100,
    viaPlayin: (totals[team.id].viaPlayin / iterations) * 100,
    out: (totals[team.id].out / iterations) * 100,
    avgWins: totals[team.id].wins / iterations,
    avgLosses: totals[team.id].losses / iterations,
  })).sort((a, b) => b.qualify - a.qualify || b.direct - a.direct);

  const scenarios = [...scenarioCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([signature, count]) => ({
      ...JSON.parse(signature),
      probability: (count / iterations) * 100,
    })) as Scenario[];

  const playinMatchups = [...matchupCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([key, value]) => {
      const [a, b] = key.split("|");
      return {
        a,
        b,
        probability: (value.count / iterations) * 100,
        aWinProbability: (value.firstWins / value.count) * 100,
      };
    });

  return { teams, scenarios, playinMatchups, iterations, seed, uniqueBrackets: uniqueBracketHashes.size, duplicateRate: 100 * (1 - uniqueBracketHashes.size / iterations), formatVersion: "hidden-groups-r1-r3-v1" };
}

function TeamMark({ team, small = false }: { team: Team; small?: boolean }) {
  return (
    <span
      className={`team-mark ${small ? "team-mark--small" : ""}`}
      style={{ "--team-color": team.color } as React.CSSProperties}
      title={team.name}
    >
      {/* Logos are tiny local WebP assets; framework image processing would add more overhead than it saves. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={team.logo} alt="" />
    </span>
  );
}

export default function Home() {
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [slider, setSlider] = useState(50);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [isCalculating, setIsCalculating] = useState(false);
  const [view, setView] = useState<"all" | "direct" | "playin" | "out">("all");
  const [answersLoaded, setAnswersLoaded] = useState(false);
  const [backupMessage, setBackupMessage] = useState("");
  const [stats, setStats] = useState<StatisticalModel | null>(null);
  const [forecastMode, setForecastMode] = useState<"personal" | "mixed" | "stats">("mixed");
  const [opinionWeight, setOpinionWeight] = useState(50);
  const [iterationCount, setIterationCount] = useState(100000);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [serverState, setServerState] = useState<ServerState | null>(null);
  const [serverAvailable, setServerAvailable] = useState(false);
  const [adminUsername, setAdminUsername] = useState("admin");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminMessage, setAdminMessage] = useState("");
  const [matchRound, setMatchRound] = useState(1);
  const [matchTeamA, setMatchTeamA] = useState(ROUND_ONE[0][0]);
  const [matchTeamB, setMatchTeamB] = useState(ROUND_ONE[0][1]);
  const [matchWinner, setMatchWinner] = useState("");
  const [matchStage, setMatchStage] = useState<"swiss" | "playin" | "playoff">("swiss");
  const [historyTeamId, setHistoryTeamId] = useState("spirit");
  const previousLiveSignature = useRef<string | null>(null);

  const currentPair = ALL_PAIRS[questionIndex];
  const teamA = getTeam(currentPair[0]);
  const teamB = getTeam(currentPair[1]);
  const answeredCount = Object.keys(answers).length;
  const currentIsAnswered = answers[pairKey(...currentPair)] !== undefined;
  const nextUnanswered = nextUnansweredIndex(questionIndex, answers);
  const currentStat = stats?.pairwise[pairKey(...currentPair)];
  const currentStatProbability = currentStat
    ? (pairKey(...currentPair).startsWith(`${currentPair[0]}|`) ? currentStat.probabilityA : 100 - currentStat.probabilityA)
    : null;
  const selectedTeam = selectedTeamId ? getTeam(selectedTeamId) : null;
  const selectedTeamStats = selectedTeamId ? stats?.teams[selectedTeamId] : null;
  const canEdit = !serverAvailable || Boolean(serverState?.isAdmin);
  const liveMatches = useMemo(() => serverState?.matches ?? [], [serverState?.matches]);
  const completedLiveMatches = useMemo(() => liveMatches.filter((match) => match.winner), [liveMatches]);
  const scheduledLiveMatches = useMemo(() => liveMatches.filter((match) => !match.winner), [liveMatches]);
  const forecastSource = useMemo(() => {
    const base = forecastMode === "stats" ? statisticalAnswers(stats) : forecastMode === "mixed" ? mixedAnswers(answers, stats, opinionWeight) : completePersonalAnswers(answers);
    return applyLiveEvidence(base, completedLiveMatches);
  }, [answers, completedLiveMatches, forecastMode, opinionWeight, stats]);
  const likelyBracket = useMemo(() => buildLikelyBracket(forecastSource, liveMatches), [forecastSource, liveMatches]);
  const likelyPlayoff = useMemo(() => buildLikelyPlayoff(likelyBracket, forecastSource, liveMatches), [forecastSource, likelyBracket, liveMatches]);
  const liveResultSignature = completedLiveMatches.map((match) => `${match.id}:${match.winner}:${match.score_a}:${match.score_b}`).join(";");
  const snapshots = useMemo(() => serverState?.snapshots ?? [], [serverState?.snapshots]);
  const historyPoints = useMemo(() => [...snapshots].reverse().slice(-16).map((snapshot) => ({
    id: snapshot.id,
    createdAt: snapshot.created_at,
    trigger: snapshot.trigger,
    qualify: snapshot.result.teams.find((team) => team.id === historyTeamId)?.qualify ?? 0,
    completed: snapshot.completed_match_count,
  })), [historyTeamId, snapshots]);
  const currentExplanation = predictionExplanation(currentPair[0], currentPair[1], answers, stats, forecastMode, opinionWeight, completedLiveMatches);
  const predictionScore = completedLiveMatches.reduce((total, match) => {
    const pA = match.predicted_probability ?? storedProbability(match.team_a, match.team_b, mixedAnswers(answers, stats, opinionWeight)) ?? 50;
    return total + ((pA >= 50 ? match.team_a : match.team_b) === match.winner ? 1 : 0);
  }, 0);
  const filteredTeams = useMemo(() => {
    if (!result) return [];
    if (view === "direct") return result.teams.filter((team) => team.direct >= 18.75);
    if (view === "playin") return result.teams.filter((team) => team.playin >= 50);
    if (view === "out") return result.teams.filter((team) => team.out >= 50);
    return result.teams;
  }, [result, view]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("ti26-forecast-answers");
      const fallback = window.localStorage.getItem("ti26-forecast-answers-backup");
      let parsed = saved ? (JSON.parse(saved) as AnswerMap) : {};
      if (Object.keys(parsed).length === 0 && fallback) {
        const backup = JSON.parse(fallback) as AnswerMap;
        if (Object.keys(backup).length > 0) parsed = backup;
      }
      // Initial hydration from browser storage is intentionally performed once.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAnswers(parsed);
      const firstUnanswered = ALL_PAIRS.findIndex(([a, b]) => parsed[pairKey(a, b)] === undefined);
      const initialIndex = firstUnanswered === -1 ? 0 : firstUnanswered;
      setQuestionIndex(initialIndex);
      setSlider(Math.round(storedProbability(...ALL_PAIRS[initialIndex], parsed) ?? 50));
      setResult(runSimulation(parsed, 4000));
    } catch {
      setResult(runSimulation({}, 4000));
    } finally {
      setAnswersLoaded(true);
    }
  }, []);

  const loadServerState = async () => {
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      if (!response.ok) throw new Error("server unavailable");
      const data = await response.json() as ServerState;
      setServerAvailable(true);
      setServerState(data);
      if (Object.keys(data.answers).length) setAnswers(data.answers);
    } catch {
      setServerAvailable(false);
    }
  };

  useEffect(() => {
    // The first request and subsequent interval synchronize an external API state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadServerState();
    const timer = window.setInterval(() => void loadServerState(), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    fetch("/team-stats.json")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("stats unavailable")))
      .then((data: StatisticalModel) => setStats(data))
      .catch(() => setStats(null));
  }, []);

  useEffect(() => {
    if (!answersLoaded) return;
    const serialized = JSON.stringify(answers);
    const previous = window.localStorage.getItem("ti26-forecast-answers");
    if (previous && previous !== "{}" && previous !== serialized) {
      window.localStorage.setItem("ti26-forecast-answers-backup", previous);
    }
    window.localStorage.setItem("ti26-forecast-answers", serialized);
  }, [answers, answersLoaded]);

  useEffect(() => {
    if (!answersLoaded || previousLiveSignature.current === liveResultSignature) return;
    previousLiveSignature.current = liveResultSignature;
    if (!liveResultSignature) return;
    const baseSource = forecastMode === "stats" ? statisticalAnswers(stats) : forecastMode === "mixed" ? mixedAnswers(answers, stats, opinionWeight) : answers;
    const source = applyLiveEvidence(baseSource, completedLiveMatches);
    const timer = window.setTimeout(() => {
      setResult(runSimulation(source, iterationCount, undefined, { liveMatches, statisticalModel: stats }));
      setAdminMessage("Прогноз автоматически пересчитан с учётом результатов TI.");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [answers, answersLoaded, completedLiveMatches, forecastMode, iterationCount, liveMatches, liveResultSignature, opinionWeight, stats]);

  useEffect(() => {
    if (!selectedTeamId) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedTeamId(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selectedTeamId]);

  const moveToQuestion = (index: number, nextAnswers = answers) => {
    const bounded = Math.max(0, Math.min(ALL_PAIRS.length - 1, index));
    const [a, b] = ALL_PAIRS[bounded];
    setQuestionIndex(bounded);
    setSlider(Math.round(storedProbability(a, b, nextAnswers) ?? 50));
  };

  const saveAnswer = () => {
    if (!canEdit) { setAdminMessage("Войдите как администратор, чтобы менять прогнозы."); return; }
    const [a, b] = currentPair;
    const key = pairKey(a, b);
    const normalized = key.startsWith(`${a}|`) ? slider : 100 - slider;
    const nextAnswers = { ...answers, [key]: normalized };
    setAnswers(nextAnswers);
    if (serverAvailable) {
      void fetch("/api/admin/answers", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers: nextAnswers }) })
        .then((response) => { if (!response.ok) throw new Error(); })
        .catch(() => setAdminMessage("Не удалось сохранить ответ на сервере."));
    }
    const next = nextUnansweredIndex(questionIndex, nextAnswers);
    if (next !== null) {
      moveToQuestion(next, nextAnswers);
    } else {
      moveToQuestion((questionIndex + 1) % ALL_PAIRS.length, nextAnswers);
    }
  };

  const skipQuestion = () => {
    if (nextUnanswered !== null) moveToQuestion(nextUnanswered);
  };

  const calculate = () => {
    setIsCalculating(true);
    window.setTimeout(() => {
      const baseSource = forecastMode === "stats"
        ? statisticalAnswers(stats)
        : forecastMode === "mixed"
          ? mixedAnswers(answers, stats, opinionWeight)
          : answers;
      const source = applyLiveEvidence(baseSource, completedLiveMatches);
      const simulation = runSimulation(source, iterationCount, undefined, { liveMatches, statisticalModel: stats });
      setResult(simulation);
      if (serverAvailable && serverState?.isAdmin) {
        void fetch("/api/admin/snapshots", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ trigger: "manual_run", forecastMode, opinionWeight, iterations: simulation.iterations, seed: simulation.seed, completedMatchCount: completedLiveMatches.length, modelGeneratedAt: stats?.generatedAt ?? null, probabilities: source, result: simulation }),
        }).then((response) => response.ok ? loadServerState() : Promise.reject(new Error("snapshot")))
          .catch(() => setAdminMessage("Прогон рассчитан, но не удалось сохранить его в историю."));
      }
      setIsCalculating(false);
      document.getElementById("forecast")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 40);
  };

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    const response = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: adminUsername, password: adminPassword }) });
    if (!response.ok) { setAdminMessage("Неверный пароль или слишком много попыток."); return; }
    setAdminPassword(""); setAdminMessage("Режим администратора включён."); await loadServerState();
  };

  const logout = async () => {
    await fetch("/api/logout", { method: "POST" }); setAdminMessage("Вы вышли из режима администратора."); await loadServerState();
  };

  const refreshStats = async () => {
    setAdminMessage("Обновление OpenDota запущено — оно может занять несколько минут.");
    const response = await fetch("/api/admin/refresh", { method: "POST" });
    if (!response.ok) setAdminMessage("Не удалось запустить обновление или оно уже идёт.");
    await loadServerState();
  };

  const syncLiveResults = async () => {
    setAdminMessage("Проверяю новые результаты TI в OpenDota…");
    const response = await fetch("/api/admin/live/sync", { method: "POST" });
    if (!response.ok) { setAdminMessage("Не удалось синхронизировать результаты или проверка уже идёт."); return; }
    const summary = await response.json() as { inserted: number; updated: number };
    setAdminMessage(summary.inserted || summary.updated ? `Получено новых результатов: ${summary.inserted + summary.updated}.` : "Новых завершённых серий пока нет.");
    await loadServerState();
  };

  const prepareRoundOne = async () => {
    setAdminMessage("Сохраняю восемь матчей первого раунда и предматчевые вероятности…");
    const response = await fetch("/api/admin/rounds/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ round: 1 }) });
    if (!response.ok) { setAdminMessage("Не удалось подготовить первый раунд."); return; }
    const summary = await response.json() as { inserted: number };
    setAdminMessage(summary.inserted ? `Первый раунд подготовлен: сохранено ${summary.inserted} матчей и создан контрольный снимок.` : "Первый раунд уже был подготовлен — дубликаты не созданы.");
    await loadServerState();
  };

  const addLiveMatch = async (event: React.FormEvent) => {
    event.preventDefault();
    const baseSource = forecastMode === "stats" ? statisticalAnswers(stats) : forecastMode === "mixed" ? mixedAnswers(answers, stats, opinionWeight) : answers;
    const source = applyLiveEvidence(baseSource, completedLiveMatches);
    const predictedProbability = (storedProbability(matchTeamA, matchTeamB, source) ?? 50);
    const response = await fetch("/api/admin/matches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: matchStage, round: matchRound, teamA: matchTeamA, teamB: matchTeamB, winner: matchWinner, predictedProbability }) });
    if (!response.ok) { setAdminMessage("Матч не сохранён: проверьте команды и раунд."); return; }
    setAdminMessage(matchWinner ? "Фактический результат сохранён и будет зафиксирован во всех следующих прогонах." : "Матч запланирован: вероятность до начала сохранена, OpenDota подставит результат автоматически.");
    await loadServerState();
  };

  const resetAnswers = () => {
    if (!window.confirm("Сбросить все ваши оценки матчапов?")) return;
    setAnswers({});
    setQuestionIndex(0);
    setSlider(50);
    setResult(runSimulation({}, 4000));
  };

  const exportAnswers = () => {
    const rows = Object.entries(answers).map(([key, probability]) => {
      const [a, b] = key.split("|");
      return [a, b, probability, 100 - probability, getTeam(a).name, getTeam(b).name]
        .map(csvCell)
        .join(",");
    });
    const csv = [
      "team_a_id,team_b_id,probability_a,probability_b,team_a_name,team_b_name",
      ...rows,
    ].join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "ti-2026-predictions.csv";
    link.click();
    URL.revokeObjectURL(url);
    setBackupMessage(`Сохранено в CSV: ${rows.length} ответов`);
  };

  const importAnswers = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = (await file.text()).replace(/^\uFEFF/, "");
    const imported: AnswerMap = {};
    const validIds = new Set(TEAMS.map((team) => team.id));
    text.split(/\r?\n/).slice(1).forEach((line) => {
      if (!line.trim()) return;
      const [a, b, rawProbability] = parseCsvLine(line);
      const probability = Number(rawProbability);
      if (!validIds.has(a) || !validIds.has(b) || a === b || !Number.isFinite(probability)) return;
      const bounded = Math.min(95, Math.max(5, probability));
      const key = pairKey(a, b);
      imported[key] = key.startsWith(`${a}|`) ? bounded : 100 - bounded;
    });

    const nextAnswers = { ...answers, ...imported };
    setAnswers(nextAnswers);
    const firstUnanswered = ALL_PAIRS.findIndex(([a, b]) => nextAnswers[pairKey(a, b)] === undefined);
    moveToQuestion(firstUnanswered === -1 ? 0 : firstUnanswered, nextAnswers);
    setResult(runSimulation(nextAnswers, 4000));
    setBackupMessage(`Загружено из CSV: ${Object.keys(imported).length} ответов`);
    event.target.value = "";
  };

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="TI Predictor — наверх">
          <span className="brand-glyph">T</span>
          <span>TI / PREDICTOR</span>
        </a>
        <nav aria-label="Разделы страницы">
          <a href="#matchups">Матчапы</a>
          <a href="#forecast">Прогноз</a>
          <a href="#format">Формат</a>
        </nav>
        <div className="live-pill"><span /> TI 2026</div>
      </header>

      <section className="hero" id="top">
        <div className="hero-kicker"><span>THE INTERNATIONAL 2026</span><span>13–16 АВГУСТА · ШАНХАЙ</span></div>
        <h1>Собери свою<br /><em>швейцарку.</em></h1>
        <p>
          Оценивай матчапы, а симулятор разыграет все пять раундов —
          с вероятностями побед и случайной жеребьёвкой внутри каждого счёта.
        </p>
        <div className="format-track" aria-label="Формат групповой стадии">
          <div><b>3</b><span>напрямую<br />в плей-офф</span></div>
          <i />
          <div><b>10</b><span>в стыковые<br />матчи</span></div>
          <i />
          <div><b>3</b><span>покидают<br />турнир</span></div>
        </div>
      </section>

      <section className="live-console" id="live">
        <div className="live-console__head">
          <div><p className="eyebrow">ЖИВОЙ ТУРНИР</p><h2>Факты вместо лишних веток</h2></div>
          <div className="live-score"><b>{completedLiveMatches.length}</b><span>результатов внесено</span><b>{completedLiveMatches.length ? `${predictionScore}/${completedLiveMatches.length}` : "—"}</b><span>угадано до матча</span></div>
        </div>
        <p className="muted">Сыгранные матчи фиксируются как факт, поэтому симулятор больше не разыгрывает уже невозможные ветки. Сохранённая до результата вероятность используется для честной проверки точности.</p>
        {serverState?.liveSync && <p className="live-sync-status">
          <b>OpenDota · лига {serverState.liveSync.leagueId}</b>
          <span>{serverState.liveSync.enabled ? `автопроверка каждые ${serverState.liveSync.intervalMinutes} мин.` : "автопроверка выключена"}</span>
          <span>{serverState.liveSync.running ? "проверяется сейчас" : serverState.liveSync.lastSync ? `${serverState.liveSync.lastSync.ok ? "последняя проверка" : "ошибка"}: ${new Date(serverState.liveSync.lastSync.updatedAt).toLocaleString("ru-RU")}` : "ещё не проверялось"}</span>
        </p>}
        {serverState?.liveSync.lastSync?.unknownTeamIds?.length ? <p className="sync-warning">В OpenDota появились неизвестные team ID: {serverState.liveSync.lastSync.unknownTeamIds.join(", ")}. Эти карты пока не записаны — требуется проверить соответствие команды.</p> : null}
        {serverAvailable ? (
          serverState?.isAdmin ? (
            <div className="admin-grid">
              <form className="admin-match-form" onSubmit={addLiveMatch}>
                <label>Стадия<select value={matchStage} onChange={(event) => setMatchStage(event.target.value as "swiss" | "playin" | "playoff")}><option value="swiss">Швейцарка</option><option value="playin">Стыки</option><option value="playoff">Плей-офф</option></select></label>
                <label>Раунд<input type="number" min="1" max="20" value={matchRound} onChange={(event) => setMatchRound(Number(event.target.value))} /></label>
                <label>Команда A<select value={matchTeamA} onChange={(event) => setMatchTeamA(event.target.value)}>{TEAMS.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
                <label>Команда B<select value={matchTeamB} onChange={(event) => setMatchTeamB(event.target.value)}>{TEAMS.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
                <label>Результат<select value={matchWinner} onChange={(event) => setMatchWinner(event.target.value)}><option value="">Ещё не сыгран</option><option value={matchTeamA}>Победа {getTeam(matchTeamA).name}</option><option value={matchTeamB}>Победа {getTeam(matchTeamB).name}</option></select></label>
                <button className="primary-button" type="submit">{matchWinner ? "Зафиксировать результат" : "Сохранить до матча"}</button>
              </form>
              <div className="admin-actions"><button onClick={prepareRoundOne}>Подготовить раунд 1</button><button onClick={syncLiveResults} disabled={serverState.liveSync.running}>{serverState.liveSync.running ? "Проверяю TI…" : "Проверить результаты TI"}</button><button onClick={refreshStats} disabled={serverState.refreshRunning}>{serverState.refreshRunning ? "Статистика обновляется…" : "Подтянуть свежую статистику"}</button><button onClick={logout}>Выйти из админки</button></div>
            </div>
          ) : (
            <form className="admin-login" onSubmit={login}><input type="text" value={adminUsername} onChange={(event) => setAdminUsername(event.target.value)} placeholder="Логин" autoComplete="username" /><input type="password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} placeholder="Пароль администратора" autoComplete="current-password" /><button type="submit">Войти для редактирования</button><span>Просмотр доступен всем; изменения защищены.</span></form>
          )
        ) : <p className="local-mode">Локальный режим: серверное API не запущено, редактирование и автосохранение работают только в этом браузере.</p>}
        {adminMessage && <p className="admin-message">{adminMessage}</p>}
        {scheduledLiveMatches.length > 0 && <div className="scheduled-results"><b>ОЖИДАЮТ РЕЗУЛЬТАТА</b>{scheduledLiveMatches.map((match) => <span key={match.id}>{match.stage === "swiss" ? "SW" : match.stage === "playin" ? "PI" : "PO"} R{match.round} · {getTeam(match.team_a).name} — {getTeam(match.team_b).name} · прогноз до матча {Math.round(match.predicted_probability ?? 50)}%</span>)}</div>}
        {completedLiveMatches.length > 0 && <div className="live-results">{completedLiveMatches.map((match) => {
          const pA = match.predicted_probability ?? 50;
          const predicted = pA >= 50 ? match.team_a : match.team_b;
          const correct = predicted === match.winner;
          const explanation = predictionExplanation(match.team_a, match.team_b, answers, stats, forecastMode, opinionWeight, completedLiveMatches.filter((item) => item.id < match.id));
          return <article key={match.id} className="live-result-card"><div><span>{match.stage === "swiss" ? "SW" : match.stage === "playin" ? "PI" : "PO"} R{match.round}</span><strong><TeamMark team={getTeam(match.team_a)} small />{getTeam(match.team_a).name} — {getTeam(match.team_b).name}<TeamMark team={getTeam(match.team_b)} small /></strong><b>{match.score_a ?? "?"}–{match.score_b ?? "?"} · {getTeam(match.winner!).name}</b><i className={correct ? "is-correct" : "is-wrong"}>{correct ? "ПРОГНОЗ ВЕРЕН" : "ОШИБКА"}</i></div><details><summary>До матча: {getTeam(match.team_a).name} {pA.toFixed(1)}% · показать факторы</summary><div>{explanation.items.map((item) => <span key={item.label}><b>{item.label}</b><em>{item.value >= 0 ? "+" : ""}{item.value.toFixed(1)} п.п.</em><small>{item.text}</small></span>)}</div></details></article>;
        })}</div>}
        <div className="prediction-history">
          <div className="prediction-history__head"><div><p className="eyebrow">ИСТОРИЯ МОДЕЛИ</p><h3>Что модель думала до результатов</h3></div><span>{snapshots.length} сохранённых прогонов</span></div>
          {historyPoints.length > 0 && <div className="history-chart">
            <div className="history-chart__controls"><label>Динамика команды<select value={historyTeamId} onChange={(event) => setHistoryTeamId(event.target.value)}>{TEAMS.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label><span>Шанс попасть в плей-офф после каждого сохранённого состояния модели</span></div>
            <div className="history-chart__bars">{historyPoints.map((point) => <div key={point.id} title={`${new Date(point.createdAt).toLocaleString("ru-RU")} · ${point.qualify.toFixed(1)}% · ${point.completed} результатов`}><b>{point.qualify.toFixed(0)}%</b><i style={{ height: `${Math.max(3, point.qualify)}%` }} /><small>{point.completed ? `+${point.completed}M` : "PRE"}</small></div>)}</div>
          </div>}
          {snapshots.length ? <div className="snapshot-list">{snapshots.map((snapshot) => {
            const evaluation = snapshotEvaluation(snapshot, completedLiveMatches);
            return <details key={snapshot.id}>
              <summary><time>{new Date(snapshot.created_at).toLocaleString("ru-RU")}</time><b>{snapshot.trigger === "manual_run" ? "ручной прогон" : snapshot.trigger.startsWith("pre_") ? "до начала раунда" : snapshot.trigger.startsWith("auto_") ? "после результата" : snapshot.trigger} · {snapshot.forecast_mode === "mixed" ? `смесь ${snapshot.opinion_weight}% мнения` : snapshot.forecast_mode === "stats" ? "только статистика" : "только мнение"} · {snapshot.result.formatVersion === "hidden-groups-r1-r3-v1" ? "группы R1–R3" : "старый формат"}</b><span>{evaluation.count ? `${evaluation.correct}/${evaluation.count} верно` : "ждёт новых матчей"}</span></summary>
              <div className="snapshot-metrics">
                <div><b>{snapshot.iterations.toLocaleString("ru-RU")}</b><span>прогонов</span></div>
                <div><b>{snapshot.result.uniqueBrackets?.toLocaleString("ru-RU") ?? "—"}</b><span>уникальных путей</span></div>
                <div><b>{evaluation.brier === null ? "—" : evaluation.brier.toFixed(3)}</b><span>Brier, меньше лучше</span></div>
                <div><b>{evaluation.logLoss === null ? "—" : evaluation.logLoss.toFixed(3)}</b><span>log loss</span></div>
              </div>
              <div className="snapshot-teams">{snapshot.result.teams.slice(0, 8).map((team) => <span key={team.id}><TeamMark team={getTeam(team.id)} small />{team.name}<b>{team.qualify.toFixed(1)}%</b></span>)}</div>
            </details>;
          })}</div> : <p className="history-empty">История появится после первого серверного прогона из режима администратора. Она не переписывается после получения результатов.</p>}
        </div>
      </section>

      <section className="workspace" id="matchups">
        <div className="section-heading">
          <span className="step-number">01</span>
          <div><p>ТВОЁ МНЕНИЕ</p><h2>Кто сильнее?</h2></div>
          <span className="section-note">
            {answeredCount === ALL_PAIRS.length ? <>Все {ALL_PAIRS.length} пар оценены.<br />Можно вернуться и изменить любой ответ.</> : <>Осталось без ответа: {ALL_PAIRS.length - answeredCount}.<br />Заполненные пары больше не повторяются.</>}
          </span>
        </div>

        <div className="workspace-grid">
          <article className="duel-card">
            <div className="card-topline">
              <span>МАТЧАП {String(questionIndex + 1).padStart(2, "0")} / {ALL_PAIRS.length}</span>
              <div className="matchup-statuses">
                <span className={`answer-tag ${currentIsAnswered ? "answer-tag--done" : "answer-tag--empty"}`}>
                  {currentIsAnswered ? "ОТВЕЧЕНО" : "БЕЗ ОТВЕТА"}
                </span>
                <span className={questionIndex < 8 ? "round-tag round-tag--lime" : "round-tag"}>
                  {questionIndex < 8 ? "РАУНД 1" : "ВОЗМОЖНАЯ ПАРА"}
                </span>
              </div>
            </div>

            <div className="duel-teams">
              <button disabled={!canEdit} className={`duel-team ${slider > 50 ? "is-picked" : ""}`} onClick={() => setSlider(slider > 50 ? slider : 70)}>
                <TeamMark team={teamA} />
                <strong>{teamA.name}</strong>
                <span>{slider}%</span>
              </button>
              <div className="versus">VS</div>
              <button disabled={!canEdit} className={`duel-team ${slider < 50 ? "is-picked" : ""}`} onClick={() => setSlider(slider < 50 ? slider : 30)}>
                <TeamMark team={teamB} />
                <strong>{teamB.name}</strong>
                <span>{100 - slider}%</span>
              </button>
            </div>

            <div className="range-wrap">
              <div className="range-labels"><span>{teamA.short}</span><b>ШАНС ПОБЕДЫ</b><span>{teamB.short}</span></div>
              <input
                type="range"
                min="5"
                max="95"
                step="1"
                value={slider}
                disabled={!canEdit}
                onChange={(event) => setSlider(Number(event.target.value))}
                aria-label={`Вероятность победы ${teamA.name}`}
                style={{ "--range-value": `${slider}%` } as React.CSSProperties}
              />
              <div className="presets" aria-label="Быстрый выбор вероятности">
                {[15, 30, 40, 50, 60, 70, 85].map((value) => (
                  <button disabled={!canEdit} key={value} onClick={() => setSlider(value)} className={slider === value ? "active" : ""}>
                    {value}/{100 - value}
                  </button>
                ))}
              </div>
              <div className="stat-hint">
                {currentStat && currentStatProbability !== null ? (
                  <>
                    <div>
                      <span>{currentStat.source === "roster_proxy" ? "OPEN DOTA · LGD: ИСТОРИЧЕСКАЯ БАЗА 4/5" : "OPEN DOTA · СОСТАВ ПРОВЕРЕН"}</span>
                      <strong>{teamA.short} {currentStatProbability.toFixed(1)} / {(100 - currentStatProbability).toFixed(1)} {teamB.short}</strong>
                      <small>
                        {currentStat.source === "roster_proxy" ? `новая пятёрка без матчей · доверие ${Math.round((currentStat.rosterReliability ?? 0.65) * 100)}%` : currentStat.source === "head_to_head_and_indirect" ? "личные встречи + общие соперники" : "через общих соперников"}
                        {` · уверенность ${currentStat.confidence === "high" ? "высокая" : currentStat.confidence === "medium" ? "средняя" : "низкая"}`}
                      </small>
                    </div>
                    <button onClick={() => setSlider(Math.round(currentStatProbability))}>Взять оценку</button>
                  </>
                ) : <span>Статистическая оценка загружается…</span>}
              </div>
              <details className="model-explanation" open>
                <summary>Почему модель дала {currentExplanation.afterLive.toFixed(1)}% на {teamA.name}</summary>
                <div className="explanation-total"><b>{teamA.short} {currentExplanation.afterLive.toFixed(1)}%</b><span>итог после всех поправок</span></div>
                {currentExplanation.items.map((item) => (
                  <div className="explanation-row" key={item.label}>
                    <div><strong>{item.label}</strong><small>{item.text}</small></div>
                    <span className={item.value >= 0 ? "positive" : "negative"}>{item.value >= 0 ? "+" : ""}{item.value.toFixed(1)}</span>
                  </div>
                ))}
                <p>Это объяснимая рейтинговая модель, а не нейросеть-чёрный ящик: каждый сдвиг можно проследить до матчей, веса состава или выбранной тобой смеси.</p>
              </details>
            </div>

            <div className="card-actions">
              <button className="ghost-button" onClick={skipQuestion} disabled={nextUnanswered === null}>Пропустить</button>
              <button className="primary-button" onClick={saveAnswer} disabled={!canEdit}>{currentIsAnswered ? "Обновить и дальше" : "Сохранить и дальше"} <span>→</span></button>
            </div>

            <div className="question-nav">
              <button onClick={() => moveToQuestion(questionIndex - 1)} disabled={questionIndex === 0}>← Назад</button>
              <div className="progress-line"><span style={{ width: `${(answeredCount / ALL_PAIRS.length) * 100}%` }} /></div>
              <span>{answeredCount} ответов</span>
              {nextUnanswered !== null && <button onClick={() => moveToQuestion(nextUnanswered)}>Следующий пустой →</button>}
              <button onClick={resetAnswers} disabled={answeredCount === 0}>Сбросить</button>
            </div>
            <div className="backup-row">
              <span className="autosave-status"><i /> Автосохранение в браузере включено</span>
              <div>
                <button onClick={exportAnswers} disabled={answeredCount === 0}>Скачать CSV</button>
                <label>Загрузить CSV<input type="file" accept=".csv,text/csv" onChange={importAnswers} /></label>
              </div>
              {backupMessage && <small>{backupMessage}</small>}
            </div>
          </article>

          <aside className="simulation-card">
            <div className="sim-orbit" aria-hidden="true"><span>{iterationCount >= 1000 ? `${iterationCount / 1000}K` : iterationCount}</span></div>
            <p className="eyebrow">МОНТЕ-КАРЛО</p>
            <h3>Развилка каждого<br />следующего раунда</h3>
            <p className="muted">
              В раундах 1–3 соперник с тем же счётом выбирается случайно только внутри своей группы. В раундах 4–5 группы объединяются. Повторные встречи исключаются, пока это возможно.
            </p>
            <ul>
              <li><span>01</span> Ваши точные вероятности</li>
              <li><span>02</span> Сила из других ответов</li>
              <li><span>03</span> Случайная жеребьёвка</li>
              <li><span>04</span> Стык: команда 3–2 против 2–3</li>
            </ul>
            <div className="model-switch" aria-label="Источник вероятностей">
              <button className={forecastMode === "personal" ? "active" : ""} onClick={() => setForecastMode("personal")}>Моё мнение</button>
              <button className={forecastMode === "mixed" ? "active" : ""} onClick={() => setForecastMode("mixed")} disabled={!stats}>Смешанный</button>
              <button className={forecastMode === "stats" ? "active" : ""} onClick={() => setForecastMode("stats")} disabled={!stats}>Статистика</button>
            </div>
            {forecastMode === "mixed" && (
              <div className="blend-control">
                <div><span>СТАТИСТИКА {100 - opinionWeight}%</span><span>МОЁ МНЕНИЕ {opinionWeight}%</span></div>
                <input type="range" min="0" max="100" step="5" value={opinionWeight} onChange={(event) => setOpinionWeight(Number(event.target.value))} aria-label="Вес личного мнения" style={{ "--range-value": `${opinionWeight}%` } as React.CSSProperties} />
              </div>
            )}
            <div className="iteration-picker">
              <span>КОЛИЧЕСТВО ПРОГОНОВ</span>
              <div>{[10000, 50000, 100000, 250000].map((count) => <button key={count} className={iterationCount === count ? "active" : ""} onClick={() => setIterationCount(count)}>{count >= 1000 ? `${count / 1000}K` : count}</button>)}</div>
            </div>
            <button className="calculate-button" onClick={calculate} disabled={isCalculating || (forecastMode !== "personal" && !stats)}>
              {isCalculating ? `Считаю ${iterationCount.toLocaleString("ru-RU")} сеток…` : "Запустить новый прогон"}
              <span>{isCalculating ? "···" : "↗"}</span>
            </button>
            <small>Каждый запуск использует новую независимую случайную выборку. Максимальная статистическая погрешность при {iterationCount.toLocaleString("ru-RU")} прогонах — около ±{samplingMargin(iterationCount).toFixed(2)} п.п.</small>
            {result && <small className="stats-meta">Примерно {result.uniqueBrackets.toLocaleString("ru-RU")} уникальных полных путей · повторов {result.duplicateRate.toFixed(1)}%. Повторы нужны для оценки вероятности, а не являются ошибкой.</small>}
            {stats && <small className="stats-meta">{stats.totals.uniqueAcceptedGames} карт · одна контрольная карта на турнир · половина веса за {stats.methodology.recencyHalfLifeDays} дней</small>}
          </aside>
        </div>
      </section>

      <section className="forecast-section" id="forecast">
        <div className="section-heading section-heading--light">
          <span className="step-number">02</span>
          <div><p>РЕЗУЛЬТАТ СИМУЛЯЦИИ</p><h2>Куда попадёт команда</h2></div>
          <span className="section-note">{result ? <>{result.iterations.toLocaleString("ru-RU")} независимых сеток · ~{result.uniqueBrackets.toLocaleString("ru-RU")} уникальных<br />погрешность до ±{samplingMargin(result.iterations).toFixed(2)} п.п.</> : "Готовим первый прогноз…"}</span>
        </div>

        <div className="swiss-groups" aria-label="Скрытые группы первых трёх раундов">
          {Object.entries(SWISS_GROUPS).map(([group, ids]) => <article key={group}>
            <header><div><span>СКРЫТАЯ ГРУППА</span><b>{group === "A" ? "A" : "Б"}</b></div><small>только раунды 1–3</small></header>
            <div>{ids.map((id) => <span key={id}><TeamMark team={getTeam(id)} small /><strong>{getTeam(id).name}</strong></span>)}</div>
          </article>)}
        </div>

        <div className="likely-bracket">
          <div className="likely-bracket__head"><div><p className="eyebrow">ВЕРОЯТНЕЙШИЙ СЦЕНАРИЙ</p><h3>Одна конкретная сетка</h3></div><span>Фаворит выигрывает каждый матч; R1–R3 жеребятся внутри скрытой группы, R4–R5 — среди всех команд с тем же счётом. Реванши исключаются, пока возможно. Фактические результаты отмечены точкой.</span></div>
          <div className="likely-bracket__scroll">
            <table>
              <thead><tr><th>#</th><th>Команда</th><th>Группа</th><th>Счёт</th>{[1, 2, 3, 4, 5].map((round) => <th key={round}>Раунд {round}</th>)}<th>Итог</th></tr></thead>
              <tbody>{likelyBracket.rows.map((row, index) => <tr key={row.id} className={`likely-row likely-row--${row.status}`}>
                <td>{index + 1}</td>
                <td><TeamMark team={getTeam(row.id)} small /><strong>{getTeam(row.id).name}</strong></td>
                <td><span className={`group-badge group-badge--${SWISS_GROUP_BY_TEAM[row.id].toLowerCase()}`}>{SWISS_GROUP_BY_TEAM[row.id] === "A" ? "A" : "Б"}</span></td>
                <td><b>{row.wins}–{row.losses}</b></td>
                {row.rounds.map((round, roundIndex) => <td key={roundIndex}>{round ? <span className={`round-opponent ${round.won ? "is-win" : "is-loss"} ${round.fixed ? "is-fixed" : ""}`} title={`${round.probability.toFixed(1)}% на ${getTeam(row.id).name}`}><TeamMark team={getTeam(round.opponent)} small />{getTeam(round.opponent).short}<i>{round.won ? "W" : "L"}</i></span> : <span className="round-empty">—</span>}</td>)}
                <td><span className={`bracket-status bracket-status--${row.status}`}>{row.status === "direct" ? "ПЛЕЙ-ОФФ" : row.status === "playin" ? "СТЫК" : "ВЫЛЕТ"}</span></td>
              </tr>)}</tbody>
            </table>
          </div>
          <div className="likely-playins"><b>ВЕРОЯТНЕЙШИЕ СТЫКИ</b>{likelyBracket.playins.map((match) => <div key={`${match.a}-${match.b}`}><span><TeamMark team={getTeam(match.a)} small />{getTeam(match.a).name}</span><em>{match.probabilityA.toFixed(0)}% : {(100 - match.probabilityA).toFixed(0)}%</em><span>{getTeam(match.b).name}<TeamMark team={getTeam(match.b)} small /></span><strong>→ {getTeam(match.winner).name}</strong></div>)}</div>
        </div>

        {likelyPlayoff.stages.length > 0 && <div className="likely-playoff">
          <div className="likely-playoff__head"><div><p className="eyebrow">ПРОГНОЗ ПЛЕЙ-ОФФ</p><h3>Double elimination до чемпиона</h3></div><span>Предварительная сетка из восьми вероятнейших участников. Посев будет автоматически заменён фактическим, когда организаторы опубликуют пары. Все серии BO3, гранд-финал BO5.</span></div>
          <div className="likely-playoff__grid">{likelyPlayoff.stages.map((stage) => <section key={stage.name}><h4>{stage.name}</h4>{stage.matches.map((match) => <article key={match.label}><header><span>{match.label}</span><b>{match.format}</b></header><div className={match.winner === match.a ? "is-winner" : ""}><TeamMark team={getTeam(match.a)} small /><strong>{getTeam(match.a).name}</strong><em>{match.probabilityA.toFixed(0)}%</em></div><div className={match.winner === match.b ? "is-winner" : ""}><TeamMark team={getTeam(match.b)} small /><strong>{getTeam(match.b).name}</strong><em>{(100 - match.probabilityA).toFixed(0)}%</em></div></article>)}</section>)}</div>
          <p className="likely-champion">Вероятнейший чемпион: <TeamMark team={getTeam(likelyPlayoff.stages.at(-1)!.matches[0].winner)} small /><b>{getTeam(likelyPlayoff.stages.at(-1)!.matches[0].winner).name}</b></p>
        </div>}

        <div className="forecast-filters" role="group" aria-label="Фильтр прогноза">
          {(["all", "direct", "playin", "out"] as const).map((filter) => (
            <button key={filter} className={view === filter ? "active" : ""} onClick={() => setView(filter)}>
              {{ all: "Все 16", direct: "Прямой выход", playin: "Стыки", out: "Вылет" }[filter]}
            </button>
          ))}
        </div>

        <div className="forecast-table-wrap">
          <table className="forecast-table">
            <thead><tr><th>#</th><th>Команда</th><th>Средний счёт</th><th>В плей-офф</th><th>Напрямую</th><th>Через стык</th><th>Вылет</th></tr></thead>
            <tbody>
              {filteredTeams.map((team, index) => (
                <tr key={team.id}>
                  <td>{String(index + 1).padStart(2, "0")}</td>
                  <td>
                    <button className="team-stats-button" onClick={() => setSelectedTeamId(team.id)} disabled={!stats}>
                      <TeamMark team={team} small /><strong>{team.name}</strong><span>ИСТОРИЯ →</span>
                    </button>
                  </td>
                  <td>{team.avgWins.toFixed(1)}–{team.avgLosses.toFixed(1)}</td>
                  <td><div className="probability"><span>{team.qualify.toFixed(1)}%</span><i><b style={{ width: `${team.qualify}%` }} /></i></div></td>
                  <td><div className="probability probability--lime"><span>{team.direct.toFixed(1)}%</span><i><b style={{ width: `${team.direct}%` }} /></i></div></td>
                  <td><div className="probability probability--amber"><span>{team.viaPlayin.toFixed(1)}%</span><i><b style={{ width: `${team.viaPlayin}%` }} /></i></div></td>
                  <td><div className="probability probability--red"><span>{team.out.toFixed(1)}%</span><i><b style={{ width: `${team.out}%` }} /></i></div></td>
                </tr>
              ))}
              {!result && <tr><td colSpan={7} className="loading-row">Собираем вероятностную таблицу…</td></tr>}
            </tbody>
          </table>
        </div>

        {result && (
          <div className="playin-panel">
            <div className="playin-heading">
              <div>
                <p className="eyebrow">СТЫКОВЫЕ МАТЧИ · BO3</p>
                <h3>Самые вероятные пары</h3>
              </div>
              <p>Пять команд со счётом 3–2 получают соперников 2–3. В каждой карточке — шанс появления пары и вероятность победы.</p>
            </div>
            <div className="playin-grid">
              {result.playinMatchups.map((matchup, index) => {
                const first = getTeam(matchup.a);
                const second = getTeam(matchup.b);
                return (
                  <article className="playin-match" key={`${matchup.a}-${matchup.b}`}>
                    <header><span>{String(index + 1).padStart(2, "0")}</span><b>{matchup.probability.toFixed(1)}% ПАРЫ</b></header>
                    <div className="playin-teams">
                      <div><TeamMark team={first} small /><strong>{first.name}</strong></div>
                      <i>VS</i>
                      <div><strong>{second.name}</strong><TeamMark team={second} small /></div>
                    </div>
                    <div className="playin-meter"><span style={{ width: `${matchup.aWinProbability}%` }} /></div>
                    <div className="playin-odds"><b>{matchup.aWinProbability.toFixed(0)}%</b><span>ШАНС В СТЫКЕ</span><b>{(100 - matchup.aWinProbability).toFixed(0)}%</b></div>
                  </article>
                );
              })}
            </div>
          </div>
        )}

        {result && (
          <div className="scenario-grid">
            <div className="scenario-intro">
              <p className="eyebrow">ТОП-3 СЦЕНАРИЯ</p>
              <h3>Самые частые<br />финальные расклады</h3>
              <p>Точное сочетание трёх команд, прошедших напрямую, и пяти победителей стыков — итоговая восьмёрка плей-офф.</p>
            </div>
            {result.scenarios.map((scenario, index) => (
              <article className="scenario-card" key={`${scenario.direct.join("-")}-${scenario.via.join("-")}`}>
                <header><span>0{index + 1}</span><b>{scenario.probability.toFixed(2)}%</b></header>
                <p>НАПРЯМУЮ</p>
                <div>{scenario.direct.map((id) => <span className="team-chip team-chip--green" key={id}><TeamMark team={getTeam(id)} small />{getTeam(id).name}</span>)}</div>
                <p>ЧЕРЕЗ СТЫК</p>
                <div>{scenario.via.map((id) => <span className="team-chip team-chip--amber" key={id}><TeamMark team={getTeam(id)} small />{getTeam(id).name}</span>)}</div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="format-section" id="format">
        <div className="section-heading">
          <span className="step-number">03</span>
          <div><p>СТАРТОВАЯ СЕТКА</p><h2>Раунд 1</h2></div>
          <span className="section-note">Все матчи — Bo3.<br />Дальше играют команды с одинаковым счётом.</span>
        </div>
        <div className="round-grid">
          {ROUND_ONE.map(([a, b], index) => (
            <button className="round-match" key={a} onClick={() => moveToQuestion(index)}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div><TeamMark team={getTeam(a)} small /><strong>{getTeam(a).name}</strong></div>
              <i>VS</i>
              <div><strong>{getTeam(b).name}</strong><TeamMark team={getTeam(b)} small /></div>
              <b>→</b>
            </button>
          ))}
        </div>
      </section>

      {selectedTeam && selectedTeamStats && (
        <div className="team-modal-backdrop" role="presentation">
          <section className="team-modal" role="dialog" aria-modal="true" aria-label={`Статистика ${selectedTeam.name}`}>
            <header className="team-modal-header">
              <div><TeamMark team={selectedTeam} /><div><span>OPEN DOTA · ПОСЛЕДНИЙ ГОД</span><h2>{selectedTeam.name}</h2></div></div>
              <button onClick={() => setSelectedTeamId(null)} aria-label="Закрыть статистику">×</button>
            </header>
            <div className="team-stat-summary">
              <div><b>{selectedTeamStats.matchesInPeriod}</b><span>всего карт найдено</span></div>
              <div><b>{selectedTeamStats.rosterProjection ? selectedTeamStats.proxyRosterGames : selectedTeamStats.exactRosterGames}</b><span>{selectedTeamStats.rosterProjection ? "карт исторической пятёркой 4/5" : "карт текущим составом"}</span></div>
              <div><b>{selectedTeamStats.includedTournaments.length}</b><span>турниров учтено</span></div>
              <div><b>{selectedTeamStats.excludedTournaments.length}</b><span>турниров исключено</span></div>
            </div>
            {selectedTeamStats.rosterProjection && (
              <div className="roster-projection-alert">
                <b>НОВАЯ ПЯТЁРКА: {selectedTeamStats.rosterProjection.replacementIn.name} ВМЕСТО {selectedTeamStats.rosterProjection.replacementOut.name}</b>
                <p>Официальных карт этим составом пока нет. История остальных четырёх игроков используется как приближение, а отклонение прогноза от 50/50 умножается на {selectedTeamStats.rosterProjection.reliability.toFixed(2)}. Уверенность принудительно снижена.</p>
              </div>
            )}
            <div className="roster-legend">
              <span className="roster-badge roster-badge--current">Текущий состав</span>
              <span className="roster-badge roster-badge--proxy">Историческая база 4/5</span>
              <span className="roster-badge roster-badge--different">Другой состав</span>
              <span className="roster-badge roster-badge--unknown">Не проверялся</span>
            </div>
            <div className="tournament-history">
              {selectedTeamStats.tournaments.map((tournament, index) => (
                <details key={tournament.leagueId} open={index === 0}>
                  <summary>
                    <div><strong>{tournament.name}</strong><span>{tournament.series.length} серий · {tournament.series.reduce((sum, series) => sum + series.maps.length, 0)} карт</span></div>
                    <span className={`roster-badge roster-badge--${tournament.rosterStatus}`}>{tournament.rosterStatus === "current" ? "Состав совпал" : tournament.rosterStatus === "proxy" ? "База 4/5" : "Не учитывается"}</span>
                  </summary>
                  <div className="tournament-body">
                    <p>{tournament.rosterStatus === "current" ? "Контрольная карта совпала с заявленной пятёркой TI — результаты турнира участвуют в модели." : tournament.rosterStatus === "proxy" ? "Четыре игрока совпадают с составом TI, но здесь играл TaiLung вместо Topson. Турнир используется как база с пониженным доверием." : "На контрольной карте была другая пятёрка — турнир показан для истории, но полностью исключён из модели."}</p>
                    <div className="series-list">
                      {tournament.series.map((series) => (
                        <div className="series-row" key={`${series.opponentOpenDotaId}-${series.startTime}`}>
                          <time>{new Date(series.startTime * 1000).toLocaleDateString("ru-RU", { day: "2-digit", month: "short", year: "numeric" })}</time>
                          <div><span className="opponent-name"><strong>{series.opponentName}</strong>{series.reportedName !== series.opponentName && <small>в данных: {series.reportedName}</small>}</span><span className={`roster-badge roster-badge--${series.opponentRosterStatus === "unverified" ? "unknown" : series.opponentRosterStatus}`}>{series.opponentRosterStatus === "current" ? "нынешний состав" : series.opponentRosterStatus === "proxy" ? "история 4/5" : series.opponentRosterStatus === "different" ? "другой состав" : "не участник TI"}</span></div>
                          <b className={series.wins > series.losses ? "series-win" : series.wins < series.losses ? "series-loss" : "series-draw"}>{series.wins}–{series.losses}</b>
                        </div>
                      ))}
                    </div>
                  </div>
                </details>
              ))}
            </div>
          </section>
        </div>
      )}

      <footer>
        <div className="brand"><span className="brand-glyph">T</span><span>TI / PREDICTOR</span></div>
        <p>Фанатский вероятностный симулятор · данные сохраняются только в вашем браузере</p>
        <a href="#top">Наверх ↑</a>
      </footer>
    </main>
  );
}
