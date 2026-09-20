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
  brier: number | null;
  logLoss: number | null;
  accuracy: number | null;
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

const BASE = process.env.NEXT_PUBLIC_API_BASE || "";

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`api_${response.status}`);
  return response.json() as Promise<T>;
}

export const api = {
  health: (signal?: AbortSignal) => get<HealthStatus>("/api/health", signal),
  tournaments: (status?: string, signal?: AbortSignal) =>
    get<{ tournaments: TournamentSummary[]; generatedAt: string }>(`/api/tournaments${status ? `?status=${status}` : ""}`, signal),
  tournament: (slug: string, signal?: AbortSignal) =>
    get<{
      tournament: TournamentSummary;
      forecast: TournamentForecast | null;
      series: SeriesRow[];
      live: LiveGame[];
      heroes: HeroCatalog;
      accuracy: AccuracyRow[];
      generatedAt: string;
    }>(`/api/tournaments/${encodeURIComponent(slug)}`, signal),
  live: (signal?: AbortSignal) => get<{ games: LiveGame[]; heroes: HeroCatalog; generatedAt: string }>("/api/live", signal),
  model: (signal?: AbortSignal) => get<ModelStatus>("/api/model", signal),
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
