// Shared client for the predictor API. Every page reads from these endpoints;
// nothing is hardcoded to a particular tournament.

export type TournamentSummary = {
  leagueId: number;
  slug: string;
  name: string;
  tier: string | null;
  status: "live" | "upcoming" | "finished";
  playingNow: boolean;
  startTime: number | null;
  endTime: number | null;
  lastMatchTime: number | null;
  teamCount: number | null;
  mapCount: number;
  seriesCount: number;
  prizePool: number | null;
  lastSyncedAt: string | null;
};

export type TeamRef = { id: string; name: string; logoUrl?: string | null };

export type SeriesRow = {
  seriesKey: string;
  teamA: TeamRef;
  teamB: TeamRef;
  bestOf: number | null;
  startTime: number | null;
  scoreA: number;
  scoreB: number;
  winnerId: string | null;
  status: "scheduled" | "live" | "finished";
  mapIds: number[];
  prediction: null | {
    probabilityA: number;
    modelId: string | null;
    capturedAt: string;
    predictedWinner: string | null;
    correct: boolean | null;
  };
};


export type FormatStage = { name: string; bestOf: number | null; rules: string[] };

export type TournamentFormat = {
  stages: FormatStage[];
  bestOf: number | null;
  bracketType: string | null;
};

export type ScheduleSlot = {
  id: number;
  slot: string | null;
  stage: string | null;
  lane: "upper" | "lower" | "final" | "group" | null;
  round: number | null;
  seriesKey: string | null;
  startTime: number | null;
  bestOf: number | null;
  winnerSlot: number | null;
  teamA: TeamRef | null;
  teamB: TeamRef | null;
};


export type ProjectedStanding = TeamRef & {
  seriesWins: number;
  seriesLosses: number;
  expectedPlace: number;
  qualifyChance: number;
};

/** Where one match's two entrants come from. Drawn only for `winner`. */
export type BracketSource = { from: "seed" | "winner" | "loser"; slot?: string };

export type BracketBox = { slot: string; lane: string; column: number; x: number; y: number; w: number; h: number };
export type BracketEdge = { from: string; to: string; points: [number, number][] };

export type BracketLayout = {
  width: number;
  height: number;
  columns: number;
  boxes: BracketBox[];
  edges: BracketEdge[];
  headers: { lane: string; column: number; label: string | null; x: number; y: number; w: number }[];
  lanes: { lane: string; y: number; height: number }[];
  dividers: number[];
  metrics: Record<string, number>;
};

export type ProjectedSlot = {
  slot: string;
  lane: "upper" | "lower" | "final";
  column: number;
  section: string;
  sources?: BracketSource[];
  seriesKey?: string | null;
  bestOf: number | null;
  startTime: number | null;
  decided: boolean;
  known: boolean;
  teamA: (TeamRef & { reachChance: number | null }) | null;
  teamB: (TeamRef & { reachChance: number | null }) | null;
  probabilityA: number | null;
  winner: TeamRef | null;
};

export type Projection = {
  generatedAt: string;
  iterations: number;
  playoffSlots: number;
  standings: ProjectedStanding[];
  bracket: ProjectedSlot[];
  columns: number;
  note: string;
  // Computed per response, so an older stored forecast still gets a picture.
  layout?: BracketLayout | null;
  layoutCompact?: BracketLayout | null;
};

export type GroupCell = {
  round: number | null;
  opponent: TeamRef;
  status: "finished" | "live" | "scheduled";
  result: "win" | "loss" | "draw" | null;
  scoreFor: number | null;
  scoreAgainst: number | null;
  bestOf: number | null;
  startTime: number | null;
  seriesKey: string | null;
  href: string | null;
  probability: number | null;
  probabilitySource: "frozen" | "model" | null;
};

export type GroupRow = {
  rank: number;
  team: TeamRef;
  seriesWins: number;
  seriesLosses: number;
  seriesDraws: number;
  mapWins: number;
  mapLosses: number;
  mapDiff: number;
  played: number;
  qualifying: boolean | null;
  qualifyChance: number | null;
  expectedPlace: number | null;
  cells: (GroupCell | null)[];
};

export type GroupStage = {
  leagueId: number;
  source: "published_rounds" | "match_ordinal";
  stageSource: string;
  playoffSlots: number | null;
  rounds: { round: number | null; label: string; startTime: number | null; played: number; total: number }[];
  rows: GroupRow[];
  caveat: string;
};

export type ForecastTeam = {
  teamId: string;
  name: string;
  logoUrl?: string | null;
  seriesWins: number;
  seriesLosses: number;
  mapWins: number;
  mapLosses: number;
  eliminated: boolean;
  champion: number;
  final: number;
  top4: number;
};

export type TournamentForecast = {
  generatedAt: string;
  ratingsModelId: string | null;
  format: {
    type: string;
    confidence: string;
    eliminationThreshold: number | null;
    eliminationThresholdUsed?: number;
    playoffSlots?: number | null;
    shape?: string | null;
    declared?: boolean;
    source?: string;
    bracketType?: string | null;
    teamCount: number;
    pairDensity: number;
    seriesPerTeam: number;
    eliminatedTeams: number;
  };
  confidence: string;
  method: string;
  caveat: string;
  teams: ForecastTeam[];
  standings: Array<Omit<ForecastTeam, "champion" | "final" | "top4">>;
  pendingSeries: Array<{ seriesKey: string; teamA: string; teamB: string; bestOf: number }>;
  finishedSeries: number;
  projection: Projection | null;
  iterations: number;
};

export type LiveGame = {
  matchId: number;
  leagueId: number;
  seriesId: string | null;
  radiantTeam: TeamRef;
  direTeam: TeamRef;
  radiantPicks: number[];
  direPicks: number[];
  gameTime: number;
  radiantLead: number | null;
  radiantScore: number;
  direScore: number;
  phase: "draft" | "game";
  picksComplete: boolean;
  spectators?: number;
  lastSeenAt: string;
  frozenDraftProbabilityRadiant: number | null;
  frozenAt: string | null;
  tournament?: { name: string; slug: string } | null;
  draft?: null | {
    probabilityRadiant: number;
    priorProbabilityRadiant: number;
    draftDelta: number;
    available: boolean;
    reason?: string;
    modelId: string | null;
    confidence: string;
  };
  liveState?: null | {
    liveProbabilityRadiant: number | null;
    frozenDraftProbabilityRadiant: number;
    stateImpactPp: number | null;
    availability: string;
    assessment?: { status: string; leader: string | null; goldLead: number | null; killLead: number };
  };
};

export type Hero = { id: number; name: string; image: string };
export type HeroCatalog = Record<string, Hero>;

export type AccuracyRow = {
  modelKind: string;
  scope: string;
  count: number;
  decided?: number;
  draws?: number;
  brier: number | null;
  logLoss: number | null;
  accuracy: number | null;
  exactScore?: { count: number; accuracy: number | null };
};

export type ModelStatus = {
  versions: Array<{ kind: string; modelId: string; trainedAt: string; samples: number | null; active: boolean; metrics: unknown }>;
  scheduler: Array<{ job: string; description: string; intervalSeconds: number; running: boolean; lastRunAt: string | null; lastStatus: string | null; lastError: string | null; lastDetail: unknown }>;
  accuracy: AccuracyRow[];
  accuracy30d: AccuracyRow[];
  opendota: { used: number; limit: number; remaining: number; day: string };
  generatedAt: string;
};

export type HealthStatus = {
  ok: boolean;
  at: string;
  counts: Record<string, number>;
  ratingsModelId: string | null;
  ratingsGeneratedAt: string | null;
  opendota: { used: number; limit: number; remaining: number; keyed: boolean };
  scheduler: boolean;
};


export type TeamRecord = { wins: number; losses: number; draws: number };

export type TeamSeriesRow = {
  seriesKey: string;
  tournament: { slug: string; name: string } | null;
  opponent: TeamRef;
  scoreFor: number;
  scoreAgainst: number;
  bestOf: number | null;
  startTime: number | null;
  status: string;
  isDraw: boolean;
  won: boolean | null;
  prediction: null | {
    probability: number;
    capturedAt: string;
    predictedScore: string | null;
    actualScore: string | null;
    scoreCorrect: boolean | null;
    outcomeKind: string | null;
    correct: boolean | null;
  };
};

export type HeadToHeadRow = {
  opponent: TeamRef;
  wins: number; losses: number; draws: number;
  mapsFor: number; mapsAgainst: number;
};

export type HeroRecord = { heroId: number; games: number; wins: number; winRate: number | null };

export type RosterEra = {
  players: { accountId: number; name: string | null; maps: number }[];
  maps: number;
  from: number | null;
  to: number | null;
};

export type TeamDetail = {
  team: TeamRef;
  rating: null | { rating: number; series: number; rank: number; of: number };
  ratingsModelId: string | null;
  record: TeamRecord;
  lineup: Lineup;
  rosterHistory: RosterEra[];
  series: TeamSeriesRow[];
  headToHead: HeadToHeadRow[];
  heroes: HeroRecord[];
  heroCatalog: HeroCatalog;
};

/** One named, signed step between two probabilities. */
export type Factor = {
  key: string;
  label: string;
  detail: string;
  logit: number | null;
  from: number;
  to: number;
  delta: number;
  evidence: Record<string, unknown> | null;
};

export type ExplanationNote = { key: string; text: string };

export type HeroContribution = {
  heroId: number;
  name: string;
  side: "radiant" | "dire";
  logit: number;
  impact: number;
  games: number;
  known: boolean;
  favours: "radiant" | "dire" | "none";
};

export type DraftExplanation = {
  available: boolean;
  reason?: string;
  basis: "frozen" | "current_model";
  modelId: string | null;
  priorProbabilityRadiant: number;
  probabilityRadiant: number;
  draftDelta: number;
  prior: { label: string; ratingRadiant: number; ratingDire: number; confidence: string };
  factors: Factor[];
  heroes: HeroContribution[];
  quality: null | {
    logLoss: number;
    accuracy: number;
    samples: number;
    baselineLogLoss: number;
    baselineDescription: string | null;
    improvementNats: number;
  };
  notes: ExplanationNote[];
};

export type Lineup = null | {
  players: { accountId: number; name: string | null; maps: number; share: number }[];
  sampledMaps: number;
  stableMaps: number;
  stableSince: number | null;
  unchangedThroughout: boolean;
};

export type SeriesExplanation = {
  basis: "frozen" | "current";
  modelId: string | null;
  bestOf: number;
  probabilityA: number;
  probabilityB: number;
  drawProbability: number;
  confidence: string;
  factors: Factor[];
  context: {
    headToHead: {
      played: number;
      winsA: number;
      winsB: number;
      draws: number;
      matches: { seriesKey: string; startTime: number | null; bestOf: number | null; scoreA: number; scoreB: number; winner: "a" | "b" | null; isDraw: boolean }[];
    };
    lineupA: Lineup;
    lineupB: Lineup;
    formA: { seriesKey: string; startTime: number | null; opponentId: number; score: string; result: "win" | "loss" | "draw" }[];
    formB: { seriesKey: string; startTime: number | null; opponentId: number; score: string; result: "win" | "loss" | "draw" }[];
  };
  quality: null | {
    family: string | null;
    logLoss: number;
    accuracy: number;
    coinflipLogLoss: number;
    samples: number;
    holdoutDays: number | null;
  };
  notes: ExplanationNote[];
};

export type SeriesMap = {
  matchId: number;
  radiant: TeamRef;
  dire: TeamRef;
  radiantWin: boolean | null;
  startTime: number | null;
  duration: number | null;
  patch: string | null;
  radiantPicks: number[];
  direPicks: number[];
  draftPrediction: null | {
    probabilityRadiant: number;
    capturedAt: string;
    modelId: string | null;
    correct: boolean | null;
    features: Record<string, unknown> | null;
  };
  explanation: DraftExplanation;
};

export type SeriesDetail = {
  seriesKey: string;
  tournament: { slug: string; name: string } | null;
  teamA: TeamRef;
  teamB: TeamRef;
  scoreA: number;
  scoreB: number;
  bestOf: number | null;
  status: string;
  isDraw: boolean;
  winnerId: string | null;
  startTime: number | null;
  prediction: null | {
    probabilityA: number;
    capturedAt: string;
    modelId: string | null;
    predictedScore: string | null;
    predictedScoreProbability: number | null;
    drawProbability: number | null;
    actualScore: string | null;
    scoreCorrect: boolean | null;
    outcomeKind: string | null;
    features: Record<string, unknown> | null;
  };
  explanation: SeriesExplanation;
  maps: SeriesMap[];
  heroCatalog: HeroCatalog;
};

export type ModelPrediction = {
  id: number;
  scope: string;
  subjectKey: string;
  tournament: { slug: string; name: string } | null;
  sideA: TeamRef;
  sideB: TeamRef;
  probabilityA: number;
  bestOf: number | null;
  capturedAt: string;
  modelId: string | null;
  resolvedAt: string | null;
  outcome: number | null;
  outcomeKind: string | null;
  brier: number | null;
  logLoss: number | null;
  predictedScore: string | null;
  actualScore: string | null;
  scoreCorrect: boolean | null;
  correct: boolean | null;
  features: Record<string, unknown> | null;
  picks?: { radiant: number[]; dire: number[] } | null;
  patch?: string | null;
  startTime?: number | null;
};

export type ModelDetail = {
  modelKind: string;
  accuracy: AccuracyRow[];
  versions: ModelVersion[];
  selectedVersions: string[];
  predictions: ModelPrediction[];
  heroes: HeroCatalog;
  generatedAt: string;
};


export type JobState = {
  job: string;
  title: string;
  description: string;
  running: boolean;
  intervalSeconds: number;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  summary: string | null;
  startedAt?: string | null;
};

export type JobRun = {
  id: number;
  job: string;
  title: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  durationMs: number | null;
  summary: string | null;
};

export type Activity = {
  running: JobState[];
  jobs: JobState[];
  runs: JobRun[];
  generatedAt: string;
};

export type ModelVersion = {
  modelId: string;
  total: number;
  resolved: number;
  firstUsed: string;
  lastUsed: string;
  accuracy: number | null;
  brier: number | null;
};

const BASE = process.env.NEXT_PUBLIC_API_BASE || "";

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`api_${response.status}`);
  return response.json() as Promise<T>;
}

/**
 * Trigger a background job by hand.
 *
 * The site is behind one password and the API is not reachable except through
 * that proxy, so no second credential is asked for here; the server decides.
 */
async function post<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { method: "POST", headers: { Accept: "application/json" } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error((body as { error?: string })?.error ?? `api_${response.status}`);
  return body as T;
}

export type RetrainResult = {
  job: string;
  detail: {
    ratings?: { ok?: boolean; reason?: string; modelId?: string; series?: number; teams?: number; validation?: RatingsValidation };
    draft?: { ok?: boolean; reason?: string; modelId?: string; maps?: number; validation?: Record<string, unknown> };
    forecasts?: { leagues?: number; updated?: number };
  };
};

export type RatingsValidation = {
  coinflipLogLoss?: number;
  beatsCoinflip?: boolean;
  /** Several refits across the history, scored on the leagues the site publishes. */
  rollingOrigin?: null | {
    samples: number;
    logLoss: number;
    accuracy: number;
    standardError: number;
    thin: null | { samples: number; logLoss: number; accuracy: number };
  };
};

export const api = {
  health: (signal?: AbortSignal) => get<HealthStatus>("/api/health", signal),
  tournaments: (status?: string, signal?: AbortSignal) =>
    get<{ tournaments: TournamentSummary[]; generatedAt: string }>(`/api/tournaments${status ? `?status=${status}` : ""}`, signal),
  tournament: (slug: string, signal?: AbortSignal) =>
    get<{
      tournament: TournamentSummary;
      format: TournamentFormat | null;
      structure: { source: string | null; page: string | null; syncedAt: string | null };
      schedule: ScheduleSlot[];
      groupStage: GroupStage | null;
      forecast: TournamentForecast | null;
      series: SeriesRow[];
      live: LiveGame[];
      heroes: HeroCatalog;
      accuracy: AccuracyRow[];
      generatedAt: string;
    }>(`/api/tournaments/${encodeURIComponent(slug)}`, signal),
  live: (signal?: AbortSignal) => get<{ games: LiveGame[]; heroes: HeroCatalog; generatedAt: string }>("/api/live", signal),
  model: (signal?: AbortSignal) => get<ModelStatus>("/api/model", signal),
  team: (teamId: string, signal?: AbortSignal) => get<TeamDetail>(`/api/teams/${encodeURIComponent(teamId)}`, signal),
  series: (seriesKey: string, signal?: AbortSignal) => get<SeriesDetail>(`/api/series/${encodeURIComponent(seriesKey)}`, signal),
  modelDetail: (kind: string, versions: string[] = [], signal?: AbortSignal) =>
    get<ModelDetail>(`/api/models/${encodeURIComponent(kind)}?limit=200${versions.length ? `&versions=${encodeURIComponent(versions.join(","))}` : ""}`, signal),
  activity: (signal?: AbortSignal) => get<Activity>("/api/activity", signal),
  runJob: (name: string) => post<RetrainResult>(`/api/admin/jobs/${encodeURIComponent(name)}`),
};

export const percent = (value: number | null | undefined, digits = 1) =>
  value === null || value === undefined || Number.isNaN(value) ? "—" : `${value.toFixed(digits)}%`;

export const probabilityPercent = (value: number | null | undefined, digits = 1) =>
  value === null || value === undefined || Number.isNaN(value) ? "—" : `${(value * 100).toFixed(digits)}%`;

export const clock = (seconds: number) =>
  `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds) % 60)).padStart(2, "0")}`;

export function formatDate(unixSeconds: number | null | undefined) {
  if (!unixSeconds) return "—";
  return new Date(unixSeconds * 1000).toLocaleDateString("ru-RU", { day: "2-digit", month: "short", year: "numeric" });
}

export function formatDateTime(unixSeconds: number | null | undefined) {
  if (!unixSeconds) return "—";
  return new Date(unixSeconds * 1000).toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function relativeTime(iso: string | null | undefined) {
  if (!iso) return "—";
  const deltaSeconds = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(deltaSeconds)) return "—";
  if (deltaSeconds < 60) return "только что";
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)} мин назад`;
  if (deltaSeconds < 86_400) return `${Math.floor(deltaSeconds / 3600)} ч назад`;
  return `${Math.floor(deltaSeconds / 86_400)} дн назад`;
}

export const FORMAT_LABELS: Record<string, string> = {
  single_elimination: "Single elimination",
  double_elimination: "Double elimination",
  round_robin: "Round robin",
  group_stage: "Групповой этап",
  too_early: "Мало матчей",
  unknown: "Формат не определён",
};

export const CONFIDENCE_LABELS: Record<string, string> = {
  high: "высокая",
  medium: "средняя",
  low: "низкая",
  resolved: "турнир завершён",
};
