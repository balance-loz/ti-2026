"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ForecastClientWorker from "./forecast-client-worker.ts?worker";
import { runForecast } from "../server/forecast-engine.mjs";
import { assessPredictionConfidence } from "../server/prediction-confidence.mjs";
import { predictionDecision } from "../server/prediction-decision.mjs";

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
  methodology: {
    recencyHalfLifeDays: number;
    rosterWeights?: Record<string, number>;
    directMatchPriorSeries?: number;
    ratingL2Penalty?: number;
    seriesInformation?: { singleMap: number; multiMapBase: number; decisiveBonus: number };
  };
  teams: Record<string, StatisticalTeam>;
  pairwise: Record<string, StatisticalPair>;
  tournamentCalibration?: { selected?: { liveGlobal?: number; liveRematch?: number; formLogitSd?: number; seriesNoiseLogitSd?: number; probabilityTemperature?: number }; validation?: { validated?: boolean } };
};

type TeamForecast = Team & {
  qualify: number;
  direct: number;
  playin: number;
  viaPlayin: number;
  playinLoss: number;
  swissOut: number;
  out: number;
  champion: number;
  final: number;
  top3: number;
  avgWins: number;
  avgLosses: number;
};

type ForecastOutcome = "direct" | "playinWin" | "playinLoss" | "swissOut";

type Scenario = {
  probability: number;
  occurrences?: number;
  direct40: string[];
  direct41: string[];
  via: string[];
};

type PlayoffScenario = {
  probability: number;
  occurrences?: number;
  champion: string;
  runnerUp: string;
  third: string;
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
  playoffScenarios: PlayoffScenario[];
  playinMatchups: PlayinMatchup[];
  iterations: number;
  seed: number;
  uniqueBrackets: number;
  duplicateRate: number;
  uniqueSwissPaths?: number;
  swissDuplicateRate?: number;
  uniqueTournamentPaths?: number;
  tournamentDuplicateRate?: number;
  uniqueSwissOutcomes?: number;
  uniquePlayoffPodiums?: number;
  uniqueFinalOutcomes?: number;
  pathSampleIterations?: number;
  requestedIterations?: number;
  convergence?: {
    adaptive: boolean;
    converged: boolean;
    stopReason: "stable" | "max_iterations" | "fixed_budget";
    minIterations: number;
    maxIterations: number;
    batchSize: number;
    tolerancePp: number;
    maxDeltaPp: number | null;
    maxSamplingMarginPp: number;
  };
  formatVersion?: string;
};

type ConditionalBranchAnalysis = {
  loading: boolean;
  error?: string;
  iterations?: number;
  noisePp?: number;
  aWins?: SimulationResult;
  bWins?: SimulationResult;
};

type PredictionConfidence = ReturnType<typeof assessPredictionConfidence>;
type LikelyRound = { opponent: string; won: boolean; fixed: boolean; probability: number; confidence: PredictionConfidence } | null;
type LikelyBracket = {
  rows: { id: string; wins: number; losses: number; status: "direct" | "playinWin" | "playinLoss" | "out"; rounds: LikelyRound[] }[];
  playins: { a: string; b: string; winner: string; probabilityA: number; confidence: PredictionConfidence }[];
};
type LikelyPlayoffMatch = { label: string; a: string; b: string; winner: string; probabilityA: number; format: "BO3" | "BO5"; confidence: PredictionConfidence };
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
  scheduleEnabled: boolean;
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
    scheduledFound?: number;
    scheduledInserted?: number;
    scheduledUpdated?: number;
    scheduledRemoved?: number;
    forecastQueued?: boolean;
    scheduleSource?: string;
    scheduleError?: string | null;
    resultError?: string | null;
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
  inputs?: { answers?: AnswerMap; cutoffCompletedMatches?: number } | null;
  snapshot_kind?: "original" | "revision";
  root_snapshot_id?: number | null;
  parent_snapshot_id?: number | null;
  profile_key?: string | null;
};

type ServerState = {
  answers: AnswerMap;
  matches: LiveMatch[];
  snapshots: PredictionSnapshot[];
  officialForecast?: { forecastMode: "stats"; opinionWeight: 0; iterations: number; adaptive?: boolean; maxIterations?: number; batchSize?: number; tolerancePp?: number };
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
const PERSONAL_INFERENCE_SCALE = 0.78;
const calibrationFor = (model: StatisticalModel | null) => ({ liveGlobal: 0, liveRematch: 0, formLogitSd: 0, seriesNoiseLogitSd: .04, probabilityTemperature: 1, ...(model?.tournamentCalibration?.selected ?? {}) });

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

function applyLiveEvidence(source: AnswerMap, matches: LiveMatch[], model: StatisticalModel | null = null) {
  const calibration = calibrationFor(model);
  const strength = Object.fromEntries(TEAMS.map((team) => [team.id, 0])) as Record<string, number>;
  const direct = new Map<string, number>();
  for (const match of matches.filter((item) => item.winner)) {
    const p = storedProbability(match.team_a, match.team_b, source) ?? 50;
    const outcome = match.winner === match.team_a ? 1 : 0;
    const surprise = outcome - p / 100;
    // One TI series is deliberately worth roughly several ordinary historical
    // series: it measures the current lineup, patch and tournament conditions.
    strength[match.team_a] += surprise * calibration.liveGlobal;
    strength[match.team_b] -= surprise * calibration.liveGlobal;
    const key = pairKey(match.team_a, match.team_b);
    const oriented = key.startsWith(`${match.team_a}|`) ? surprise : -surprise;
    direct.set(key, (direct.get(key) ?? 0) + oriented * calibration.liveRematch);
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
  const afterLive = storedProbability(a, b, applyLiveEvidence(base, liveMatches, model)) ?? beforeLive;
  const pair = model?.pairwise[pairKey(a, b)];
  const orientation = pairKey(a, b).startsWith(`${a}|`) ? 1 : -1;
  const items = [];
  if (mode !== "personal" && stat !== undefined) items.push({ label: "Общие соперники + свежесть", value: orientation * (pair?.featureContributions?.commonOpponentsPp ?? (stat - 50)), text: `${getTeam(a).short} ${stat.toFixed(1)}% · половина веса матча теряется за ${model?.methodology.recencyHalfLifeDays ?? 45} дней` });
  if (mode !== "personal" && pair) items.push({ label: "Личные встречи", value: orientation * (pair.featureContributions?.headToHeadPp ?? 0), text: pair.directEffectiveGames >= 0.75 ? `эффективный вес ${pair.directEffectiveGames.toFixed(1)} серий · prior ${model?.methodology.directMatchPriorSeries ?? 6} серий не даёт H2H переобучиться` : `вес меньше 0.75 серии · prior ${model?.methodology.directMatchPriorSeries ?? 6}, поэтому влияние почти нулевое` });
  if (mode !== "personal" && pair) items.push({ label: "Состав и надёжность", value: orientation * (pair.featureContributions?.rosterPp ?? 0), text: `${pair.modelEffectiveGames.toFixed(1)} эффективных серий · веса 5/5=${model?.methodology.rosterWeights?.["5"] ?? 1}, 4/5=${model?.methodology.rosterWeights?.["4"] ?? 0.25}, 3/5=${model?.methodology.rosterWeights?.["3"] ?? 0.07}` });
  if (mode === "personal" && personal !== undefined) items.push({ label: "Твоё мнение", value: personal - 50, text: "применено напрямую; неоценённые пары достраиваются из среднего рейтинга твоих ответов" });
  if (mode === "mixed" && personal !== undefined && stat !== undefined) items.push({ label: "Твоё мнение", value: (personal - stat) * opinionWeight / 100, text: `${opinionWeight}% смеси: сдвиг ${((personal - stat) * opinionWeight / 100).toFixed(1)} п.п.` });
  const calibration = calibrationFor(model);
  if (liveMatches.length) items.push({ label: "Матчи текущего TI", value: afterLive - beforeLive, text: `${liveMatches.length} серий · исторически откалиброванные веса ${calibration.liveGlobal}/${calibration.liveRematch}` });
  return { beforeLive, afterLive, items, coefficients: { recencyHalfLifeDays: model?.methodology.recencyHalfLifeDays ?? 45, directPrior: model?.methodology.directMatchPriorSeries ?? 6, rosterWeights: model?.methodology.rosterWeights ?? { 5: 1, 4: 0.25, 3: 0.07 }, personalWeight: mode === "mixed" ? opinionWeight / 100 : mode === "personal" ? 1 : 0, liveGlobal: calibration.liveGlobal, liveRematch: calibration.liveRematch, uncertainty: pair?.uncertainty ?? calibration.seriesNoiseLogitSd, formShock: calibration.formLogitSd, inferenceScale: PERSONAL_INFERENCE_SCALE } };
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

function matchEvaluation(matches: LiveMatch[]) {
  const scored = matches.filter((match) => match.winner && Number.isFinite(match.predicted_probability));
  let correct = 0; let brier = 0; let logLoss = 0;
  for (const match of scored) {
    const pA = Number(match.predicted_probability) / 100;
    const outcome = match.winner === match.team_a ? 1 : 0;
    correct += (pA >= 0.5 ? match.team_a : match.team_b) === match.winner ? 1 : 0;
    brier += (pA - outcome) ** 2;
    const safe = Math.min(0.999, Math.max(0.001, pA));
    logLoss += -(outcome * Math.log(safe) + (1 - outcome) * Math.log(1 - safe));
  }
  return { count: scored.length, correct, brier: scored.length ? brier / scored.length : null, logLoss: scored.length ? logLoss / scored.length : null };
}

function samplingMargin(iterations: number) {
  return 98 / Math.sqrt(iterations);
}

function likelyOutcomePartition(teams: TeamForecast[]): Record<string, ForecastOutcome> {
  const outcomes: { key: ForecastOutcome; capacity: number; probability: (team: TeamForecast) => number }[] = [
    { key: "direct", capacity: 3, probability: (team) => team.direct },
    { key: "playinWin", capacity: 5, probability: (team) => team.viaPlayin },
    { key: "playinLoss", capacity: 5, probability: (team) => team.playinLoss },
    { key: "swissOut", capacity: 3, probability: (team) => team.swissOut },
  ];
  type Assignment = { counts: number[]; score: number; byTeam: Record<string, ForecastOutcome> };
  let states = new Map<string, Assignment>([["0,0,0,0", { counts: [0, 0, 0, 0], score: 0, byTeam: {} }]]);
  for (const team of teams) {
    const next = new Map<string, Assignment>();
    for (const state of states.values()) outcomes.forEach((outcome, index) => {
      if (state.counts[index] >= outcome.capacity) return;
      const counts = [...state.counts]; counts[index] += 1;
      const key = counts.join(",");
      const candidate = { counts, score: state.score + outcome.probability(team), byTeam: { ...state.byTeam, [team.id]: outcome.key } };
      if (!next.has(key) || next.get(key)!.score < candidate.score) next.set(key, candidate);
    });
    states = next;
  }
  return states.get("3,5,5,3")?.byTeam ?? {};
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
  const estimated = 1 / (1 + Math.exp(-(scores[a] - scores[b]) * PERSONAL_INFERENCE_SCALE));
  return Math.min(0.9, Math.max(0.1, estimated));
}

function logit(p: number) {
  const safe = Math.min(0.97, Math.max(0.03, p));
  return Math.log(safe / (1 - safe));
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

function pairConfidence(model: StatisticalModel | null, a: string, b: string, probability: number, fixed = false) {
  return assessPredictionConfidence(model?.pairwise[pairKey(a, b)], probability, { fixed });
}

function ConfidenceBadge({ confidence, compact = false }: { confidence: PredictionConfidence; compact?: boolean }) {
  return <span className={`prediction-confidence prediction-confidence--${confidence.level} ${confidence.roulette ? "is-roulette" : ""}`} title={`${confidence.roulette ? "Рулетка: " : ""}уверенность ${confidence.score}/100 · ${confidence.reasons.join(" · ")}`} aria-label={`${confidence.roulette ? "Рулетка, " : ""}уверенность модели ${confidence.score} из 100`}>
    {confidence.roulette ? <b aria-hidden="true">🎰</b> : null}<i>{compact ? confidence.score : `уверенность ${confidence.score}/100`}</i>
  </span>;
}

function buildLikelyBracket(answers: AnswerMap, liveMatches: LiveMatch[], model: StatisticalModel | null): LikelyBracket {
  const scores = teamScores(answers);
  const records = Object.fromEntries(TEAMS.map((team) => [team.id, { wins: 0, losses: 0, opponents: new Set<string>(), rounds: Array<LikelyRound>(5).fill(null) }])) as Record<string, { wins: number; losses: number; opponents: Set<string>; rounds: LikelyRound[] }>;
  const play = (round: number, a: string, b: string, fixedWinner?: string | null, savedProbabilityA?: number | null) => {
    const probabilityA = savedProbabilityA ?? storedProbability(a, b, answers) ?? 50;
    const winner = fixedWinner === a || fixedWinner === b ? fixedWinner : probabilityA >= 50 ? a : b;
    const loser = winner === a ? b : a;
    records[winner].wins += 1; records[loser].losses += 1;
    records[a].opponents.add(b); records[b].opponents.add(a);
    const confidence = pairConfidence(model, a, b, probabilityA, Boolean(fixedWinner));
    records[a].rounds[round - 1] = { opponent: b, won: winner === a, fixed: Boolean(fixedWinner), probability: probabilityA, confidence };
    records[b].rounds[round - 1] = { opponent: a, won: winner === b, fixed: Boolean(fixedWinner), probability: 100 - probabilityA, confidence };
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
  const knownPlayins = liveMatches.filter((match) => match.stage === "playin");
  const playinPairs = knownPlayins.length === 5 ? knownPlayins.map((match) => [match.team_a, match.team_b] as [string, string]) : upper.map((a, index) => [a, lower[index]] as [string, string]);
  const playins = playinPairs.map(([a, b]) => { const actual = knownPlayins.find((match) => (match.team_a === a && match.team_b === b) || (match.team_a === b && match.team_b === a)); const probabilityA = actual ? (actual.team_a === a ? actual.predicted_probability : actual.predicted_probability === null ? null : 100 - actual.predicted_probability) ?? (storedProbability(a, b, answers) ?? 50) : storedProbability(a, b, answers) ?? 50; return { a, b, winner: actual?.winner ?? (probabilityA >= 50 ? a : b), probabilityA, confidence: pairConfidence(model, a, b, probabilityA, Boolean(actual?.winner)) }; });
  const playinWinners = new Set(playins.map((match) => match.winner));
  const playinLosers = new Set(playins.map((match) => match.winner === match.a ? match.b : match.a));
  const statusOrder = { direct: 0, playinWin: 1, playinLoss: 2, out: 3 };
  const rows = TEAMS.map((team) => ({
    id: team.id,
    wins: records[team.id].wins,
    losses: records[team.id].losses,
    status: (records[team.id].wins === 4 ? "direct" : records[team.id].losses === 4 ? "out" : playinWinners.has(team.id) ? "playinWin" : playinLosers.has(team.id) ? "playinLoss" : "out") as "direct" | "playinWin" | "playinLoss" | "out",
    rounds: records[team.id].rounds,
  })).sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || b.wins - a.wins || a.losses - b.losses || scores[b.id] - scores[a.id]);
  return { rows, playins };
}

function buildLikelyPlayoff(swiss: LikelyBracket, answers: AnswerMap, liveMatches: LiveMatch[], model: StatisticalModel | null): LikelyPlayoff {
  const direct = swiss.rows.filter((row) => row.status === "direct").map((row) => row.id);
  const qualifiers = [...direct, ...swiss.playins.map((match) => match.winner)].slice(0, 8);
  const versus = (label: string, a: string, b: string, format: "BO3" | "BO5" = "BO3"): LikelyPlayoffMatch => {
    const actual = liveMatches.find((match) => match.stage === "playoff" && ((match.team_a === a && match.team_b === b) || (match.team_a === b && match.team_b === a)));
    const saved = actual?.predicted_probability === null || actual?.predicted_probability === undefined ? null : actual.team_a === a ? actual.predicted_probability : 100 - actual.predicted_probability;
    const probabilityA = saved ?? storedProbability(a, b, answers) ?? 50;
    return { label, a, b, winner: actual?.winner ?? (probabilityA >= 50 ? a : b), probabilityA, format, confidence: pairConfidence(model, a, b, probabilityA, Boolean(actual?.winner)) };
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
  return runForecast(answers, iterations, seed, { matches: options.liveMatches ?? [], stats: options.statisticalModel });
}

function runSimulationInWorker(
  answers: AnswerMap,
  iterations: number,
  seed: number,
  options: { liveMatches?: LiveMatch[]; statisticalModel?: StatisticalModel | null; adaptive?: boolean } = {},
): Promise<SimulationResult> {
  return new Promise((resolve, reject) => {
    const worker = new ForecastClientWorker();
    const cleanup = () => worker.terminate();
    worker.onmessage = (event) => {
      cleanup();
      if (event.data?.ok) resolve(event.data.result as SimulationResult);
      else reject(new Error(event.data?.error || "simulation_worker_failed"));
    };
    worker.onerror = (event) => { cleanup(); reject(new Error(event.message || "simulation_worker_failed")); };
    const adaptive = options.adaptive ? { enabled: true, minIterations: 250_000, maxIterations: 1_000_000, batchSize: 250_000, tolerancePp: .1, stableChecksRequired: 2 } : null;
    worker.postMessage({ answers, iterations, seed, matches: options.liveMatches ?? [], stats: options.statisticalModel, adaptive });
  });
}

function iterationLabel(iterations: number) {
  if (iterations >= 1_000_000) return `${iterations / 1_000_000}M`;
  return iterations >= 1000 ? `${iterations / 1000}K` : String(iterations);
}

function formatRareScenarioProbability(probability: number) {
  if (!Number.isFinite(probability) || probability <= 0) return "—";
  if (probability < .001) return `${probability.toFixed(5)}%`;
  if (probability < .01) return `${probability.toFixed(4)}%`;
  if (probability < .1) return `${probability.toFixed(3)}%`;
  return `${probability.toFixed(2)}%`;
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

function MatchupBreakdown({ a, explanation, open = false, compact = false }: { a: string; explanation: ReturnType<typeof predictionExplanation>; open?: boolean; compact?: boolean }) {
  const coefficients = explanation.coefficients;
  return <details className={`model-explanation matchup-breakdown ${compact ? "matchup-breakdown--compact" : ""}`} open={open}>
    <summary>Почему модель дала {explanation.afterLive.toFixed(1)}% на {getTeam(a).name}</summary>
    <div className="matchup-breakdown__body">
      <div className="explanation-total"><b>{getTeam(a).short} {explanation.afterLive.toFixed(1)}%</b><span>итог после всех применимых поправок</span></div>
      {explanation.items.map((item) => <div className="explanation-row" key={item.label}><div><strong>{item.label}</strong><small>{item.text}</small></div><span className={item.value >= 0 ? "positive" : "negative"}>{item.value >= 0 ? "+" : ""}{item.value.toFixed(1)} п.п.</span></div>)}
      <div className="coefficient-grid">
        <span><b>{coefficients.recencyHalfLifeDays} дн.</b>полураспад свежести</span>
        <span><b>{coefficients.directPrior}</b>prior серий для H2H</span>
        <span><b>{coefficients.rosterWeights["5"]} / {coefficients.rosterWeights["4"]} / {coefficients.rosterWeights["3"]}</b>веса составов 5/5 · 4/5 · 3/5</span>
        <span><b>{coefficients.personalWeight.toFixed(2)}</b>вес твоего мнения</span>
        <span><b>{coefficients.liveGlobal} + {coefficients.liveRematch}</b>TI: общая форма + реванш</span>
        <span><b>σ {coefficients.formShock} + {coefficients.uncertainty.toFixed(3)}</b>форма турнира + неопределённость пары</span>
        <span><b>{coefficients.inferenceScale}</b>перенос мнения на неоценённые пары</span>
      </div>
      <p>Коэффициент применяется только при наличии соответствующих данных. Сдвиги показаны в процентных пунктах; случайная форма и неопределённость меняют отдельные симуляции, поэтому не входят в детерминированную сумму выше.</p>
    </div>
  </details>;
}

function PlayoffMatchCard({ match, explanation }: { match: LikelyPlayoffMatch; explanation: ReturnType<typeof predictionExplanation> }) {
  return <article className="playoff-match">
    <header><span>{match.label}</span><ConfidenceBadge confidence={match.confidence} compact /><b>{match.format}</b></header>
    <div className={match.winner === match.a ? "is-winner" : ""}><TeamMark team={getTeam(match.a)} small /><strong>{getTeam(match.a).name}</strong><em>{match.probabilityA.toFixed(0)}%</em></div>
    <div className={match.winner === match.b ? "is-winner" : ""}><TeamMark team={getTeam(match.b)} small /><strong>{getTeam(match.b).name}</strong><em>{(100 - match.probabilityA).toFixed(0)}%</em></div>
    <MatchupBreakdown a={match.a} explanation={explanation} compact />
  </article>;
}

export default function Home() {
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [slider, setSlider] = useState(50);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [isCalculating, setIsCalculating] = useState(false);
  const [view, setView] = useState<"all" | ForecastOutcome>("all");
  const [answersLoaded, setAnswersLoaded] = useState(false);
  const [backupMessage, setBackupMessage] = useState("");
  const [stats, setStats] = useState<StatisticalModel | null>(null);
  const [forecastMode, setForecastMode] = useState<"personal" | "mixed" | "stats">("stats");
  const [opinionWeight, setOpinionWeight] = useState(0);
  const [iterationCount, setIterationCount] = useState(250000);
  const [adaptiveRun, setAdaptiveRun] = useState(true);
  const [conditionalBranches, setConditionalBranches] = useState<Record<number, ConditionalBranchAnalysis>>({});
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [decisionPolicy, setDecisionPolicy] = useState({ probabilityTemperature: 1, selectivePrediction: { minMarginPp: 5 } });
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
    return applyLiveEvidence(base, completedLiveMatches, stats);
  }, [answers, completedLiveMatches, forecastMode, opinionWeight, stats]);
  const likelyBracket = useMemo(() => buildLikelyBracket(forecastSource, liveMatches, stats), [forecastSource, liveMatches, stats]);
  const likelyPlayoff = useMemo(() => buildLikelyPlayoff(likelyBracket, forecastSource, liveMatches, stats), [forecastSource, likelyBracket, liveMatches, stats]);
  const playoffMatches = useMemo(() => Object.fromEntries(likelyPlayoff.stages.flatMap((stage) => stage.matches).map((match) => [match.label, match])) as Record<string, LikelyPlayoffMatch>, [likelyPlayoff]);
  const liveConstraintSignature = liveMatches.map((match) => `${match.id}:${match.stage}:${match.round}:${match.team_a}:${match.team_b}:${match.winner ?? "scheduled"}:${match.score_a ?? ""}:${match.score_b ?? ""}`).join(";");
  const snapshots = useMemo(() => serverState?.snapshots ?? [], [serverState?.snapshots]);
  const selectedSnapshot = useMemo(() => selectedRunId ? snapshots.find((snapshot) => snapshot.id === selectedRunId) ?? null : null, [selectedRunId, snapshots]);
  const selectedRoot = useMemo(() => selectedSnapshot ? snapshots.find((snapshot) => snapshot.id === (selectedSnapshot.root_snapshot_id ?? selectedSnapshot.id)) ?? selectedSnapshot : null, [selectedSnapshot, snapshots]);
  const selectedLatest = useMemo(() => selectedRoot ? snapshots.filter((snapshot) => (snapshot.root_snapshot_id ?? snapshot.id) === selectedRoot.id).sort((a, b) => b.completed_match_count - a.completed_match_count || b.id - a.id)[0] ?? selectedRoot : null, [selectedRoot, snapshots]);
  const displayedResult = selectedLatest?.result ?? result;
  const displayedProbabilities = selectedLatest?.probabilities ?? forecastSource;
  const matchMetrics = useMemo(() => matchEvaluation(completedLiveMatches), [completedLiveMatches]);
  const stageMetrics = useMemo(() => (["swiss", "playin", "playoff"] as const).map((stage) => ({ stage, ...matchEvaluation(completedLiveMatches.filter((match) => match.stage === stage)) })), [completedLiveMatches]);
  const decisionAudit = useMemo(() => {
    const rows = completedLiveMatches.filter((match) => Number.isFinite(match.predicted_probability)).map((match) => {
      const decision = predictionDecision(stats?.pairwise[pairKey(match.team_a, match.team_b)], match.predicted_probability ?? 50, { temperature: decisionPolicy.probabilityTemperature, minMarginPp: decisionPolicy.selectivePrediction.minMarginPp });
      const predicted = (match.predicted_probability ?? 50) >= 50 ? match.team_a : match.team_b;
      return { decision, correct: predicted === match.winner };
    });
    const accepted = rows.filter((row) => row.decision.status === "pick");
    return { total: rows.length, accepted: accepted.length, correct: accepted.filter((row) => row.correct).length, pass: rows.length - accepted.length };
  }, [completedLiveMatches, decisionPolicy, stats]);
  const matchHistoryPoints = useMemo(() => {
    const ordered = [...completedLiveMatches].filter((match) => Number.isFinite(match.predicted_probability)).sort((a, b) => Date.parse(a.scheduled_at || a.created_at) - Date.parse(b.scheduled_at || b.created_at));
    return ordered.map((match, index) => ({ match, ...matchEvaluation(ordered.slice(0, index + 1)) })).slice(-24);
  }, [completedLiveMatches]);
  const currentExplanation = predictionExplanation(currentPair[0], currentPair[1], answers, stats, forecastMode, opinionWeight, completedLiveMatches);
  const explainMatchup = (a: string, b: string) => predictionExplanation(a, b, answers, stats, forecastMode, opinionWeight, completedLiveMatches);
  const likelyOutcomes = useMemo(() => displayedResult ? likelyOutcomePartition(displayedResult.teams) : {}, [displayedResult]);
  const filteredTeams = useMemo(() => {
    if (!displayedResult) return [];
    if (view !== "all") return displayedResult.teams.filter((team) => likelyOutcomes[team.id] === view);
    return displayedResult.teams;
  }, [displayedResult, likelyOutcomes, view]);

  useEffect(() => {
    const run = Number(new URLSearchParams(window.location.search).get("run"));
    if (Number.isInteger(run) && run > 0) setSelectedRunId(run);
  }, []);

  const selectSnapshot = (snapshot: PredictionSnapshot | null) => {
    const id = snapshot?.id ?? null;
    setSelectedRunId(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("run", String(id)); else url.searchParams.delete("run");
    window.history.replaceState({}, "", url);
    if (snapshot) {
      const rootId = snapshot.root_snapshot_id ?? snapshot.id;
      const latest = snapshots.filter((item) => (item.root_snapshot_id ?? item.id) === rootId).sort((a, b) => b.completed_match_count - a.completed_match_count || b.id - a.id)[0] ?? snapshot;
      setForecastMode(snapshot.forecast_mode); setOpinionWeight(snapshot.opinion_weight); setIterationCount(snapshot.iterations); setAdaptiveRun(Boolean(latest.result.convergence?.adaptive));
      if (snapshot.inputs?.answers) setAnswers(snapshot.inputs.answers);
      setResult(latest.result);
    } else {
      setForecastMode("stats"); setOpinionWeight(0); setIterationCount(250000); setAdaptiveRun(true);
      if (stats) setResult(runSimulation(applyLiveEvidence(statisticalAnswers(stats), completedLiveMatches, stats), 250000, undefined, { liveMatches, statisticalModel: stats }));
    }
  };

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

  useEffect(() => { fetch("/decision-policy.json").then((response) => response.ok ? response.json() : Promise.reject()).then(setDecisionPolicy).catch(() => undefined); }, []);

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
    if (!answersLoaded || previousLiveSignature.current === liveConstraintSignature) return;
    previousLiveSignature.current = liveConstraintSignature;
    if (!liveConstraintSignature) return;
    const baseSource = forecastMode === "stats" ? statisticalAnswers(stats) : forecastMode === "mixed" ? mixedAnswers(answers, stats, opinionWeight) : answers;
    const source = applyLiveEvidence(baseSource, completedLiveMatches, stats);
    const timer = window.setTimeout(() => {
      setResult(runSimulation(source, iterationCount, undefined, { liveMatches, statisticalModel: stats }));
      setAdminMessage("Прогноз автоматически пересчитан с учётом официальных пар и результатов TI.");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [answers, answersLoaded, completedLiveMatches, forecastMode, iterationCount, liveConstraintSignature, liveMatches, opinionWeight, stats]);

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
    window.setTimeout(async () => {
      const baseSource = forecastMode === "stats"
        ? statisticalAnswers(stats)
        : forecastMode === "mixed"
          ? mixedAnswers(answers, stats, opinionWeight)
          : answers;
      const source = applyLiveEvidence(baseSource, completedLiveMatches, stats);
      const seed = Math.floor(Math.random() * 0xffffffff);
      try {
        const simulation = await runSimulationInWorker(source, adaptiveRun ? 250_000 : iterationCount, seed, { liveMatches, statisticalModel: stats, adaptive: adaptiveRun });
        setResult(simulation);
        if (serverAvailable && serverState?.isAdmin) {
          void fetch("/api/admin/snapshots", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ trigger: "manual_run", forecastMode, opinionWeight, answers, iterations: simulation.iterations, seed: simulation.seed, completedMatchCount: completedLiveMatches.length, modelGeneratedAt: stats?.generatedAt ?? null, probabilities: source, result: simulation }),
          }).then((response) => response.ok ? loadServerState() : Promise.reject(new Error("snapshot")))
            .catch(() => setAdminMessage("Прогон рассчитан, но не удалось сохранить его в историю."));
        }
        document.getElementById("forecast")?.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (error) {
        setAdminMessage(`Не удалось выполнить Monte Carlo: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setIsCalculating(false);
      }
    }, 40);
  };

  const calculateConditionalBranches = async (match: LiveMatch) => {
    setConditionalBranches((current) => ({ ...current, [match.id]: { loading: true } }));
    const iterations = 50_000;
    const seed = Math.floor(Math.random() * 0xffffffff);
    const branchMatches = (winner: string) => liveMatches.map((item) => item.id === match.id ? { ...item, winner } : item);
    try {
      const [aWins, bWins] = await Promise.all([
        runSimulationInWorker(forecastSource, iterations, seed, { liveMatches: branchMatches(match.team_a), statisticalModel: stats }),
        runSimulationInWorker(forecastSource, iterations, seed, { liveMatches: branchMatches(match.team_b), statisticalModel: stats }),
      ]);
      setConditionalBranches((current) => ({ ...current, [match.id]: { loading: false, iterations, noisePp: 2 * samplingMargin(iterations), aWins, bWins } }));
    } catch {
      setConditionalBranches((current) => ({ ...current, [match.id]: { loading: false, error: "Не удалось рассчитать условные ветки." } }));
    }
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
    const summary = await response.json() as { inserted: number; updated: number; scheduledInserted?: number; scheduledUpdated?: number; scheduledRemoved?: number; forecastQueued?: boolean };
    const pairingChanges = (summary.scheduledInserted ?? 0) + (summary.scheduledUpdated ?? 0) + (summary.scheduledRemoved ?? 0);
    if (pairingChanges) setAdminMessage(`Официальные пары обновлены: ${pairingChanges}. Новый прогноз запущен автоматически.`);
    else
    setAdminMessage(summary.inserted || summary.updated ? `Получено новых результатов: ${summary.inserted + summary.updated}.` : "Новых завершённых серий пока нет.");
    await loadServerState();
  };

  const deleteSnapshot = async (snapshot: PredictionSnapshot) => {
    const created = new Date(snapshot.created_at).toLocaleString("ru-RU");
    if (!window.confirm(`Удалить сохранённый прогноз от ${created}? Ответы, матчи и остальные прогнозы останутся.`)) return;
    const response = await fetch(`/api/admin/snapshots/${snapshot.id}`, { method: "DELETE" });
    if (!response.ok) {
      setAdminMessage("Не удалось удалить прогноз. Возможно, сессия администратора закончилась.");
      return;
    }
    setAdminMessage(`Прогноз от ${created} удалён. Остальные данные не изменены.`);
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
    const source = applyLiveEvidence(baseSource, completedLiveMatches, stats);
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
          <a href="/drafts">Пики</a>
          <a href="/intel">Разведка</a>
          <a href="#format">Формат</a>
        </nav>
        <div className="live-pill"><span /> TI 2026</div>
      </header>

      <section className="hero" id="top">
        <div className="hero-kicker"><span>THE INTERNATIONAL 2026</span><span>13–23 АВГУСТА · ШАНХАЙ</span></div>
        <h1>Предскажи весь<br /><em>турнир.</em></h1>
        <p>
          Оценивай матчи, а модель разыграет швейцарку, стыки и double-elimination плей-офф. Официальные пары заменяют симуляцию сразу после публикации, а каждый прогноз проверяется отдельно после результата.
        </p>
        <div className="format-track" aria-label="Формат групповой стадии">
          <div><b>3</b><span>напрямую<br />в плей-офф</span></div>
          <i />
          <div><b>5</b><span>выигрывают<br />стык</span></div>
          <i />
          <div><b>5</b><span>проигрывают<br />стык</span></div>
          <i />
          <div><b>3</b><span>вылетают<br />в Swiss</span></div>
        </div>
      </section>

      <section className="live-console" id="live">
        <div className="live-console__head">
          <div><p className="eyebrow">ЖИВОЙ ПРОГНОЗ TI 2026</p><h2>Каждый матч — отдельная проверка</h2></div>
          <div className="live-score"><b>{matchMetrics.count}</b><span>матчей оценено</span><b>{matchMetrics.count ? `${matchMetrics.correct}/${matchMetrics.count}` : "—"}</b><span>победителей угадано</span><b>{matchMetrics.brier === null ? "—" : matchMetrics.brier.toFixed(3)}</b><span>Brier · меньше лучше</span></div>
        </div>
        <p className="muted">Вероятность замораживается при публикации официальной пары. После результата отдельно оцениваются угаданный победитель, Brier score и log loss; сыгранный матч одновременно становится важным свежим фактом для следующих прогнозов.</p>
        {serverState?.liveSync && <p className="live-sync-status">
          <b>OpenDota · результаты · лига {serverState.liveSync.leagueId}</b>
          <b>Cybersport.ru · официальные пары</b>
          <span>{serverState.liveSync.enabled ? `автопроверка каждые ${serverState.liveSync.intervalMinutes} мин.` : "автопроверка выключена"}</span>
          <span>{serverState.liveSync.lastSync?.scheduledFound !== undefined ? `официальных будущих пар найдено: ${serverState.liveSync.lastSync.scheduledFound}` : "расписание ещё не проверялось"}</span>
          <span>{serverState.liveSync.running ? "проверяется сейчас" : serverState.liveSync.lastSync ? `${serverState.liveSync.lastSync.ok ? "последняя проверка" : "ошибка"}: ${new Date(serverState.liveSync.lastSync.updatedAt).toLocaleString("ru-RU")}` : "ещё не проверялось"}</span>
        </p>}
        {serverState?.liveSync.lastSync?.scheduleError ? <p className="sync-warning">Расписание Cybersport.ru временно не прочитано: {serverState.liveSync.lastSync.scheduleError}. Результаты OpenDota продолжают обновляться независимо.</p> : null}
        {matchMetrics.count > 0 && <div className="stage-score-grid">{stageMetrics.map((metric) => <article key={metric.stage}><span>{metric.stage === "swiss" ? "ШВЕЙЦАРКА" : metric.stage === "playin" ? "СТЫКИ" : "ПЛЕЙ-ОФФ"}</span><b>{metric.count ? `${metric.correct}/${metric.count}` : "—"}</b><small>точность {metric.count ? `${(100 * metric.correct / metric.count).toFixed(0)}%` : "—"}</small><small>Brier {metric.brier === null ? "—" : metric.brier.toFixed(3)} · log loss {metric.logLoss === null ? "—" : metric.logLoss.toFixed(3)}</small></article>)}</div>}
        {decisionAudit.total > 0 && <div className="decision-audit"><div><b>{decisionAudit.accepted ? `${decisionAudit.correct}/${decisionAudit.accepted}` : "—"}</b><span>точность среди матчей, где модель сказала «да»</span></div><div><b>{decisionAudit.total ? `${Math.round(100 * decisionAudit.accepted / decisionAudit.total)}%` : "—"}</b><span>coverage · доля принятых решений</span></div><div><b>{decisionAudit.pass}</b><span>матчей честно отправлено в PASS</span></div></div>}
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
              <div className="admin-actions"><button onClick={prepareRoundOne}>Подготовить раунд 1</button><button onClick={syncLiveResults} disabled={serverState.liveSync.running}>{serverState.liveSync.running ? "Проверяю TI…" : "Проверить пары и результаты"}</button><button onClick={refreshStats} disabled={serverState.refreshRunning}>{serverState.refreshRunning ? "Статистика обновляется…" : "Подтянуть свежую статистику"}</button><button onClick={logout}>Выйти из админки</button></div>
            </div>
          ) : (
            <form className="admin-login" onSubmit={login}><input type="text" value={adminUsername} onChange={(event) => setAdminUsername(event.target.value)} placeholder="Логин" autoComplete="username" /><input type="password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} placeholder="Пароль администратора" autoComplete="current-password" /><button type="submit">Войти для редактирования</button><span>Просмотр доступен всем; изменения защищены.</span></form>
          )
        ) : <p className="local-mode">Локальный режим: серверное API не запущено, редактирование и автосохранение работают только в этом браузере.</p>}
        {adminMessage && <p className="admin-message">{adminMessage}</p>}
        {scheduledLiveMatches.length > 0 && <div className="scheduled-results"><b>ОФИЦИАЛЬНО ОБЪЯВЛЕННЫЕ ПАРЫ</b>{scheduledLiveMatches.map((match) => <span key={match.id}>{match.stage === "swiss" ? "SW" : match.stage === "playin" ? "PI" : "PO"} R{match.round} · {getTeam(match.team_a).name} — {getTeam(match.team_b).name} · {match.predicted_probability === null ? "прогноз ещё не сохранён" : `зафиксировано ${getTeam(match.team_a).short} ${match.predicted_probability.toFixed(1)}%`}{match.scheduled_at ? ` · ${new Date(match.scheduled_at).toLocaleString("ru-RU")}` : ""}</span>)}</div>}
        {scheduledLiveMatches.length > 0 && <div className="hypothesis-grid"><div className="hypothesis-grid__head"><b>КАК РЕЗУЛЬТАТ ИЗМЕНИТ ТУРНИРНЫЕ ШАНСЫ</b><span>Рейтинг команд заморожен. Гипотеза меняет только победителя матча и дальнейшую сетку; вымышленный результат не попадает в данные или обучение.</span></div>{scheduledLiveMatches.slice(0, 8).map((match) => {
          const analysis = conditionalBranches[match.id];
          const teamResult = (result: SimulationResult | undefined, id: string) => result?.teams.find((team) => team.id === id);
          const aInA = teamResult(analysis?.aWins, match.team_a); const aInB = teamResult(analysis?.bWins, match.team_a);
          const bInA = teamResult(analysis?.aWins, match.team_b); const bInB = teamResult(analysis?.bWins, match.team_b);
          const championChanges = analysis?.aWins && analysis.bWins ? analysis.aWins.teams.map((team) => {
            const other = analysis.bWins!.teams.find((item) => item.id === team.id)!;
            return { id: team.id, a: team.champion, b: other.champion, delta: team.champion - other.champion };
          }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 3) : [];
          const meaningful = championChanges.some((item) => Math.abs(item.delta) > (analysis?.noisePp ?? Infinity));
          return <article key={match.id}><header><strong>{getTeam(match.team_a).name} — {getTeam(match.team_b).name}</strong><small>{match.stage === "swiss" ? `SW R${match.round}` : match.stage === "playin" ? "СТЫК" : "ПЛЕЙ-ОФФ"}</small></header>{!analysis ? <button type="button" onClick={() => void calculateConditionalBranches(match)}>Сравнить две ветки</button> : analysis.loading ? <span>Считаю две ветки по 50 000…</span> : analysis.error ? <span>{analysis.error}</span> : <>
            <div className="branch-table"><b>ЕСЛИ ПОБЕДИТ</b><b>{getTeam(match.team_a).short}</b><b>{getTeam(match.team_b).short}</b><span>Проход {getTeam(match.team_a).short}</span><em>{aInA?.qualify.toFixed(1)}%</em><em>{aInB?.qualify.toFixed(1)}%</em><span>Проход {getTeam(match.team_b).short}</span><em>{bInA?.qualify.toFixed(1)}%</em><em>{bInB?.qualify.toFixed(1)}%</em></div>
            <div className="branch-impact"><b>ИЗМЕНЕНИЕ ШАНСА НА ЧЕМПИОНСТВО · {getTeam(match.team_a).short} ПОБЕДИЛА ПРОТИВ {getTeam(match.team_b).short} ПОБЕДИЛА</b>{meaningful ? championChanges.map((item) => <span key={item.id}><strong>{getTeam(item.id).name}</strong><em>{item.a.toFixed(2)}% → {item.b.toFixed(2)}%</em><i className={item.delta >= 0 ? "is-positive" : "is-negative"}>{item.delta >= 0 ? "+" : ""}{item.delta.toFixed(2)} п.п.</i></span>) : <span className="branch-no-effect">Существенного влияния на чемпионство не обнаружено: различия не превышают консервативный порог шума ±{analysis.noisePp?.toFixed(2)} п.п.</span>}</div>
            <small className="branch-method">{analysis.iterations?.toLocaleString("ru-RU")} прогонов на ветку · одинаковый seed · никаких изменений рейтинга или обучения</small>
          </>}</article>;
        })}</div>}
        {completedLiveMatches.length > 0 && <div className="live-results">{completedLiveMatches.map((match) => {
          const hasSavedPrediction = Number.isFinite(match.predicted_probability);
          const pA = match.predicted_probability ?? 50;
          const predicted = pA >= 50 ? match.team_a : match.team_b;
          const correct = predicted === match.winner;
          const outcome = match.winner === match.team_a ? 1 : 0;
          const brier = ((pA / 100) - outcome) ** 2;
          const winnerProbability = match.winner === match.team_a ? pA / 100 : 1 - pA / 100;
          const logLoss = -Math.log(Math.min(.999, Math.max(.001, winnerProbability)));
          const decision = predictionDecision(stats?.pairwise[pairKey(match.team_a, match.team_b)], pA, { temperature: decisionPolicy.probabilityTemperature, minMarginPp: decisionPolicy.selectivePrediction.minMarginPp });
          const explanation = predictionExplanation(match.team_a, match.team_b, answers, stats, forecastMode, opinionWeight, completedLiveMatches.filter((item) => item.id < match.id));
          return <article key={match.id} className="live-result-card"><div><span>{match.stage === "swiss" ? "SW" : match.stage === "playin" ? "PI" : "PO"} R{match.round}</span><strong><TeamMark team={getTeam(match.team_a)} small />{getTeam(match.team_a).name} — {getTeam(match.team_b).name}<TeamMark team={getTeam(match.team_b)} small /></strong><b>{match.score_a ?? "?"}–{match.score_b ?? "?"} · {getTeam(match.winner!).name}</b><i className={!hasSavedPrediction ? "is-unscored" : correct ? "is-correct" : "is-wrong"}>{!hasSavedPrediction ? "НЕТ PRE-MATCH" : correct ? "ПРОГНОЗ ВЕРЕН" : "ОШИБКА"}</i></div><div className={`match-decision match-decision--${decision.status}`}><b>{decision.label}</b><span>уверенность {decision.confidence.score}/100 · интервал {decision.interval.low.toFixed(0)}–{decision.interval.high.toFixed(0)}%</span></div><details><summary>{hasSavedPrediction ? `До матча: ${getTeam(match.team_a).name} ${pA.toFixed(1)}% · Brier ${brier.toFixed(3)} · log loss ${logLoss.toFixed(3)}` : "До начала матча вероятность не была сохранена — результат не участвует в оценке"}</summary>{hasSavedPrediction && <div>{explanation.items.map((item) => <span key={item.label}><b>{item.label}</b><em>{item.value >= 0 ? "+" : ""}{item.value.toFixed(1)} п.п.</em><small>{item.text}</small></span>)}</div>}</details></article>;
        })}</div>}
        <div className="prediction-history">
          <div className="prediction-history__head"><div><p className="eyebrow">ИСТОРИЯ МОДЕЛИ</p><h3>Что модель думала до результатов</h3></div><span>{snapshots.length} сохранённых прогонов</span></div>
          {selectedRoot && selectedLatest ? <div className="selected-run-banner"><div><b>ПРОГНОЗ #{selectedRoot.id} · {selectedRoot.forecast_mode === "mixed" ? `${selectedRoot.opinion_weight}% личного мнения` : selectedRoot.forecast_mode === "stats" ? "официальная статистическая база" : "личный сценарий"}</b><span>Оригинал от {new Date(selectedRoot.created_at).toLocaleString("ru-RU")} сохранён неизменным. На странице показана ревизия #{selectedLatest.id}, учитывающая {selectedLatest.completed_match_count} завершённых серий.</span></div><button type="button" onClick={() => selectSnapshot(null)}>Вернуться к Official baseline</button></div> : <div className="official-baseline-banner"><b>OFFICIAL BASELINE</b><span>Только статистика · 0% личного мнения · адаптивно от 250 000 до 1 000 000 симуляций · пересчёт после результатов</span></div>}
          {matchHistoryPoints.length > 0 && <div className="history-chart">
            <div className="history-chart__controls"><strong>НАКОПИТЕЛЬНАЯ ТОЧНОСТЬ ПОСЛЕ КАЖДОГО МАТЧА</strong><span>Наведи на столбец: увидишь пару, Brier и log loss на тот момент</span></div>
            <div className="history-chart__bars">{matchHistoryPoints.map((point) => { const accuracy = 100 * point.correct / point.count; return <div key={point.match.id} title={`${getTeam(point.match.team_a).name} — ${getTeam(point.match.team_b).name} · точность ${accuracy.toFixed(1)}% · Brier ${point.brier?.toFixed(3)} · log loss ${point.logLoss?.toFixed(3)}`}><b>{accuracy.toFixed(0)}%</b><i style={{ height: `${Math.max(3, accuracy)}%` }} /><small>{point.match.stage === "swiss" ? `S${point.match.round}` : point.match.stage === "playin" ? "PI" : "PO"}</small></div>; })}</div>
          </div>}
          {snapshots.length ? <div className="snapshot-list">{snapshots.map((snapshot) => {
            const evaluation = snapshotEvaluation(snapshot, completedLiveMatches);
            return <details key={snapshot.id} open={selectedRunId === snapshot.id}>
              <summary onClick={(event) => { event.preventDefault(); selectSnapshot(snapshot); }}><time>{new Date(snapshot.created_at).toLocaleString("ru-RU")}</time><b>{snapshot.snapshot_kind === "revision" ? `ревизия прогноза #${snapshot.root_snapshot_id}` : snapshot.trigger === "manual_run" ? "ручной прогон" : "Official baseline"} · {snapshot.forecast_mode === "mixed" ? `смесь ${snapshot.opinion_weight}% мнения` : snapshot.forecast_mode === "stats" ? "только статистика" : "только мнение"} · {snapshot.iterations.toLocaleString("ru-RU")} прогонов</b><span>{evaluation.count ? `${evaluation.correct}/${evaluation.count} верно` : "ждёт новых матчей"}</span></summary>
              <div className="snapshot-metrics">
                <div><b>{snapshot.iterations.toLocaleString("ru-RU")}</b><span>прогонов</span></div>
                <div><b>{snapshot.result.uniqueBrackets?.toLocaleString("ru-RU") ?? "—"}</b><span>уникальных путей</span></div>
                <div><b>{evaluation.brier === null ? "—" : evaluation.brier.toFixed(3)}</b><span>Brier, меньше лучше</span></div>
                <div><b>{evaluation.logLoss === null ? "—" : evaluation.logLoss.toFixed(3)}</b><span>log loss</span></div>
              </div>
              <div className="snapshot-teams">{snapshot.result.teams.slice(0, 8).map((team) => <span key={team.id}><TeamMark team={getTeam(team.id)} small />{team.name}<b>{team.qualify.toFixed(1)}%</b></span>)}</div>
              {serverState?.isAdmin && <div className="snapshot-admin-row"><span>Удаляется только этот сохранённый прогон.</span><button type="button" onClick={() => void deleteSnapshot(snapshot)}>Удалить прогноз</button></div>}
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
              <MatchupBreakdown a={currentPair[0]} explanation={currentExplanation} open />
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
            <div className="sim-orbit" aria-hidden="true"><span>{adaptiveRun ? "AUTO" : iterationLabel(iterationCount)}</span></div>
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
              <div>
                <button className={adaptiveRun ? "active" : ""} onClick={() => setAdaptiveRun(true)}>AUTO</button>
                {[10000, 50000, 100000, 250000, 500000, 1000000].map((count) => <button key={count} className={!adaptiveRun && iterationCount === count ? "active" : ""} onClick={() => { setAdaptiveRun(false); setIterationCount(count); }}>{iterationLabel(count)}</button>)}
              </div>
            </div>
            <button className="calculate-button" onClick={calculate} disabled={isCalculating || (forecastMode !== "personal" && !stats)}>
              {isCalculating ? (adaptiveRun ? "Считаю до сходимости…" : `Считаю ${iterationCount.toLocaleString("ru-RU")} сеток…`) : "Запустить новый прогон"}
              <span>{isCalculating ? "···" : "↗"}</span>
            </button>
            <small>{adaptiveRun ? "AUTO: от 250 000 до 1 000 000; остановка после двух стабильных проверок с изменением ≤0,10 п.п." : `Фиксированный бюджет: ${iterationCount.toLocaleString("ru-RU")} полных турниров.`} Расчёт идёт в фоновом потоке и не должен блокировать интерфейс.</small>
            {result && <small className="stats-meta">Итоговых восьмёрок Swiss: {result.uniqueSwissOutcomes?.toLocaleString("ru-RU") ?? "—"}; вариантов подиума: {result.uniquePlayoffPodiums?.toLocaleString("ru-RU") ?? "—"}; полных итогов «восьмёрка + подиум»: {result.uniqueFinalOutcomes?.toLocaleString("ru-RU") ?? "—"}. Детальных путей всего турнира: {(result.uniqueTournamentPaths ?? result.uniqueBrackets).toLocaleString("ru-RU")} из {(result.pathSampleIterations ?? result.iterations).toLocaleString("ru-RU")} проверенных для уникальности ({(100 - (result.tournamentDuplicateRate ?? result.duplicateRate)).toFixed(3)}%). Это разные метрики: один итог может быть достигнут множеством разных жеребьёвок и результатов по раундам.</small>}
            {stats && <small className="stats-meta">{stats.totals.uniqueAcceptedGames} карт · одна контрольная карта на турнир · половина веса за {stats.methodology.recencyHalfLifeDays} дней</small>}
          </aside>
        </div>
      </section>

      <section className="forecast-section" id="forecast">
        <div className="section-heading section-heading--light">
          <span className="step-number">02</span>
          <div><p>РЕЗУЛЬТАТ СИМУЛЯЦИИ</p><h2>Куда попадёт команда</h2></div>
          <span className="section-note">{result ? <>{result.iterations.toLocaleString("ru-RU")} независимых полных турниров · {(result.uniqueTournamentPaths ?? result.uniqueBrackets).toLocaleString("ru-RU")} уникальных путей в выборке<br />{result.convergence?.adaptive ? (result.convergence.converged ? `сошлось: Δ ≤ ${result.convergence.tolerancePp.toFixed(2)} п.п.` : `достигнут лимит; последнее Δ ${result.convergence.maxDeltaPp?.toFixed(2) ?? "—"} п.п.`) : "фиксированный бюджет"} · погрешность до ±{(result.convergence?.maxSamplingMarginPp ?? samplingMargin(result.iterations)).toFixed(2)} п.п.</> : "Готовим первый прогноз…"}</span>
        </div>

        <div className="swiss-groups" aria-label="Скрытые группы первых трёх раундов">
          {Object.entries(SWISS_GROUPS).map(([group, ids]) => <article key={group}>
            <header><div><span>СКРЫТАЯ ГРУППА</span><b>{group === "A" ? "A" : "Б"}</b></div><small>только раунды 1–3</small></header>
            <div>{ids.map((id) => <span key={id}><TeamMark team={getTeam(id)} small /><strong>{getTeam(id).name}</strong></span>)}</div>
          </article>)}
        </div>

        <div className="likely-bracket">
          <div className="likely-bracket__head"><div><p className="eyebrow">ЭКСПЕРИМЕНТАЛЬНЫЙ СЦЕНАРИЙ · НЕ ГОТОВЫЕ КОЭФФИЦИЕНТЫ</p><h3>Одна конкретная сетка</h3></div><span>Фаворит выигрывает каждый матч; R1–R3 жеребятся внутри скрытой группы, R4–R5 — среди всех команд с тем же счётом. 🎰 означает низкую надёжность данных или неустойчивую ветку около 50/50 — ставить по такой карточке особенно рискованно.</span></div>
          <div className="likely-bracket__scroll">
            <table>
              <thead><tr><th>#</th><th>Команда</th><th>Группа</th><th>Счёт</th>{[1, 2, 3, 4, 5].map((round) => <th key={round}>Раунд {round}</th>)}<th>Итог</th></tr></thead>
              <tbody>{likelyBracket.rows.map((row, index) => <tr key={row.id} className={`likely-row likely-row--${row.status}`}>
                <td>{index + 1}</td>
                <td><TeamMark team={getTeam(row.id)} small /><strong>{getTeam(row.id).name}</strong></td>
                <td><span className={`group-badge group-badge--${SWISS_GROUP_BY_TEAM[row.id].toLowerCase()}`}>{SWISS_GROUP_BY_TEAM[row.id] === "A" ? "A" : "Б"}</span></td>
                <td><b>{row.wins}–{row.losses}</b></td>
                {row.rounds.map((round, roundIndex) => <td key={roundIndex}>{round ? <span className={`round-opponent ${round.won ? "is-win" : "is-loss"} ${round.fixed ? "is-fixed" : ""}`} title={`${round.probability.toFixed(1)}% на ${getTeam(row.id).name} · уверенность ${round.confidence.score}/100 · ${round.confidence.reasons.join(" · ")}`}><TeamMark team={getTeam(round.opponent)} small />{getTeam(round.opponent).short}<small className={`round-confidence round-confidence--${round.confidence.level}`}>{round.confidence.score}</small>{round.confidence.roulette ? <b className="roulette-icon" aria-label="Низкая уверенность">🎰</b> : null}<i>{round.won ? "W" : "L"}</i></span> : <span className="round-empty">—</span>}</td>)}
                <td><span className={`bracket-status bracket-status--${row.status}`}>{row.status === "direct" ? "НАПРЯМУЮ" : row.status === "playinWin" ? "ПРОШЁЛ СТЫК" : row.status === "playinLoss" ? "НЕ ПРОШЁЛ СТЫК" : "ВЫЛЕТ В SWISS"}</span></td>
              </tr>)}</tbody>
            </table>
          </div>
          <div className="likely-playins"><b>ВЕРОЯТНЕЙШИЕ СТЫКИ</b>{likelyBracket.playins.map((match) => <div key={`${match.a}-${match.b}`}><span><TeamMark team={getTeam(match.a)} small />{getTeam(match.a).name}</span><em>{match.probabilityA.toFixed(0)}% : {(100 - match.probabilityA).toFixed(0)}%</em><span>{getTeam(match.b).name}<TeamMark team={getTeam(match.b)} small /></span><ConfidenceBadge confidence={match.confidence} /><strong>→ {getTeam(match.winner).name}</strong></div>)}</div>
        </div>

        {likelyPlayoff.stages.length > 0 && <div className="likely-playoff">
          <div className="likely-playoff__head"><div><p className="eyebrow">ПРОГНОЗ ПЛЕЙ-ОФФ</p><h3>Double elimination до чемпиона</h3></div><span>Предварительная сетка из восьми вероятнейших участников. Посев будет автоматически заменён фактическим, когда организаторы опубликуют пары. Все серии BO3, гранд-финал BO5.</span></div>
          <div className="playoff-bracket" aria-label="Сетка плей-офф double elimination">
            <div className="playoff-bracket__canvas">
              <section className="playoff-stage playoff-stage--uq"><h4>1/4 финала</h4>{[1, 2, 3, 4].map((number) => { const match = playoffMatches[`UB QF ${number}`]; return <PlayoffMatchCard key={number} match={match} explanation={explainMatchup(match.a, match.b)} />; })}</section>
              <section className="playoff-stage playoff-stage--us"><h4>Полуфинал верхней сетки</h4>{[1, 2].map((number) => { const match = playoffMatches[`UB SF ${number}`]; return <PlayoffMatchCard key={number} match={match} explanation={explainMatchup(match.a, match.b)} />; })}</section>
              <section className="playoff-stage playoff-stage--uf"><h4>Финал верхней сетки</h4><PlayoffMatchCard match={playoffMatches["UB FINAL"]} explanation={explainMatchup(playoffMatches["UB FINAL"].a, playoffMatches["UB FINAL"].b)} /></section>
              <section className="playoff-stage playoff-stage--gf"><h4>Гранд-финал</h4><PlayoffMatchCard match={playoffMatches["GRAND FINAL"]} explanation={explainMatchup(playoffMatches["GRAND FINAL"].a, playoffMatches["GRAND FINAL"].b)} /></section>
              <div className="playoff-bracket__divider" />
              <section className="playoff-stage playoff-stage--lr1"><h4>Нижняя сетка · Раунд 1</h4>{[1, 2].map((number) => { const match = playoffMatches[`LB R1 ${number}`]; return <PlayoffMatchCard key={number} match={match} explanation={explainMatchup(match.a, match.b)} />; })}</section>
              <section className="playoff-stage playoff-stage--lr2"><h4>Нижняя сетка · Раунд 2</h4>{[1, 2].map((number) => { const match = playoffMatches[`LB R2 ${number}`]; return <PlayoffMatchCard key={number} match={match} explanation={explainMatchup(match.a, match.b)} />; })}</section>
              <section className="playoff-stage playoff-stage--ls"><h4>Полуфинал нижней сетки</h4><PlayoffMatchCard match={playoffMatches["LB SF"]} explanation={explainMatchup(playoffMatches["LB SF"].a, playoffMatches["LB SF"].b)} /></section>
              <section className="playoff-stage playoff-stage--lf"><h4>Финал нижней сетки</h4><PlayoffMatchCard match={playoffMatches["LB FINAL"]} explanation={explainMatchup(playoffMatches["LB FINAL"].a, playoffMatches["LB FINAL"].b)} /></section>
            </div>
          </div>
          <p className="likely-champion">Вероятнейший чемпион: <TeamMark team={getTeam(likelyPlayoff.stages.at(-1)!.matches[0].winner)} small /><b>{getTeam(likelyPlayoff.stages.at(-1)!.matches[0].winner).name}</b></p>
        </div>}

        <div className="forecast-filters" role="group" aria-label="Фильтр прогноза">
          {(["all", "direct", "playinWin", "playinLoss", "swissOut"] as const).map((filter) => (
            <button key={filter} className={view === filter ? "active" : ""} onClick={() => setView(filter)}>
              {{ all: "Все 16", direct: "Напрямую · 3", playinWin: "Прошли стык · 5", playinLoss: "Не прошли · 5", swissOut: "Вылетели в Swiss · 3" }[filter]}
            </button>
          ))}
        </div>

        <div className="forecast-table-wrap">
          <table className="forecast-table">
            <thead><tr><th>#</th><th>Команда</th><th>Средний счёт</th><th>В плей-офф</th><th>Напрямую</th><th>Прошла стык</th><th>Не прошла стык</th><th>Вылет в Swiss</th></tr></thead>
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
                  <td><div className="probability probability--green"><span>{team.viaPlayin.toFixed(1)}%</span><i><b style={{ width: `${team.viaPlayin}%` }} /></i></div></td>
                  <td><div className="probability probability--amber"><span>{team.playinLoss.toFixed(1)}%</span><i><b style={{ width: `${team.playinLoss}%` }} /></i></div></td>
                  <td><div className="probability probability--red"><span>{team.swissOut.toFixed(1)}%</span><i><b style={{ width: `${team.swissOut}%` }} /></i></div></td>
                </tr>
              ))}
              {!result && <tr><td colSpan={8} className="loading-row">Собираем вероятностную таблицу…</td></tr>}
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
                    <MatchupBreakdown a={matchup.a} explanation={explainMatchup(matchup.a, matchup.b)} compact />
                  </article>
                );
              })}
            </div>
          </div>
        )}

        {result && (
          <div className="scenario-grid">
            <div className="scenario-intro">
              <p className="eyebrow">ТОП-3 ГРУППОВОГО ЭТАПА</p>
              <h3>Самые вероятные<br />итоги группы и стыков</h3>
              <p>Сначала все симуляции объединяются по одинаковой итоговой восьмёрке без учёта дальнейшего плей‑офф. Три варианта выбираются по точному числу попаданий; процент округляется только после ранжирования.</p>
            </div>
            {result.scenarios.map((scenario, index) => (
              <article className="scenario-card" key={`${scenario.direct40.join("-")}-${scenario.direct41.join("-")}-${scenario.via.join("-")}`}>
                <header><span>0{index + 1}</span><b title={`${scenario.occurrences ?? 0} попаданий из ${result.iterations.toLocaleString("ru-RU")} симуляций`}>{formatRareScenarioProbability(scenario.probability)}</b></header>
                <small className="scenario-rarity">{(scenario.occurrences ?? 0).toLocaleString("ru-RU")} ИЗ {result.iterations.toLocaleString("ru-RU")} ПРОГОНОВ{(scenario.occurrences ?? 0) <= 1 ? " · НЕУСТОЙЧИВО" : ""}</small>
                <p>4–0 · БЕЗ ПОРАЖЕНИЙ</p>
                <div>{scenario.direct40.map((id) => <span className="team-chip team-chip--lime" key={id}><TeamMark team={getTeam(id)} small />{getTeam(id).name}</span>)}</div>
                <p>4–1 · НАПРЯМУЮ</p>
                <div>{scenario.direct41.map((id) => <span className="team-chip team-chip--green" key={id}><TeamMark team={getTeam(id)} small />{getTeam(id).name}</span>)}</div>
                <p>ЧЕРЕЗ СТЫК</p>
                <div>{scenario.via.map((id) => <span className="team-chip team-chip--amber" key={id}><TeamMark team={getTeam(id)} small />{getTeam(id).name}</span>)}</div>
              </article>
            ))}
          </div>
        )}

        {result?.playoffScenarios?.length > 0 && (
          <div className="scenario-grid scenario-grid--playoff">
            <div className="scenario-intro">
              <p className="eyebrow">3 НАБЛЮДАЕМЫХ ПЛЕЙ-ОФФ</p>
              <h3>Репрезентативные<br />подиумы турнира</h3>
              <p>Точные совместные исходы из выборки. Они заметно менее устойчивы, чем отдельные вероятности чемпионства, финала и топ‑3.</p>
            </div>
            {result.playoffScenarios.map((scenario, index) => (
              <article className="scenario-card playoff-scenario-card" key={`${scenario.champion}-${scenario.runnerUp}-${scenario.third}`}>
                <header><span>0{index + 1}</span><b title={`${scenario.occurrences ?? 0} попаданий из ${result.iterations.toLocaleString("ru-RU")} симуляций`}>{formatRareScenarioProbability(scenario.probability)}</b></header>
                {(scenario.occurrences ?? 0) <= 1 ? <small className="scenario-rarity">ЕДИНИЧНОЕ ПОПАДАНИЕ · НЕУСТОЙЧИВО</small> : null}
                <p>ЧЕМПИОН</p><div><span className="team-chip team-chip--lime"><TeamMark team={getTeam(scenario.champion)} small />{getTeam(scenario.champion).name}</span></div>
                <p>ФИНАЛИСТ</p><div><span className="team-chip team-chip--green"><TeamMark team={getTeam(scenario.runnerUp)} small />{getTeam(scenario.runnerUp).name}</span></div>
                <p>ТРЕТЬЕ МЕСТО</p><div><span className="team-chip team-chip--amber"><TeamMark team={getTeam(scenario.third)} small />{getTeam(scenario.third).name}</span></div>
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
