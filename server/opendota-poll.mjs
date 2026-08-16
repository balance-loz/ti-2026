export const LIVE_POLL = Object.freeze({
  tickSeconds: 15,
  draftSeconds: 20,
  windowSeconds: 45,
  picksKnownSeconds: 120,
  lowBudgetFloorSeconds: 300,
  criticalBudgetFloorSeconds: 600,
  leadMs: 2 * 60 * 60_000,
  postponeMs: 3 * 60 * 60_000,
  sameBlockMs: 36 * 60 * 60_000,
  bo3TrailMs: 3.5 * 60 * 60_000,
  bo5TrailMs: 5.5 * 60 * 60_000,
  recentMapMs: 3 * 60 * 60_000,
});

export function liveGameHasCompletePicks(game) {
  return (game?.radiantPicks?.length ?? 0) === 5 && (game?.direPicks?.length ?? 0) === 5;
}

function seriesTrailMs(match) {
  if (match?.stage === "playoff" || Number(match?.best_of) === 5) return LIVE_POLL.bo5TrailMs;
  return LIVE_POLL.bo3TrailMs;
}

export function seriesPairKey(match) {
  const teamA = match?.team_a || match?.teamA;
  const teamB = match?.team_b || match?.teamB;
  if (!teamA || !teamB) return "";
  return [teamA, teamB].sort().join("|");
}

function matchHasStarted(match) {
  if (!match) return false;
  if (match.winner) return true;
  return (Number(match.score_a) || 0) + (Number(match.score_b) || 0) > 0;
}

function inSameScheduleBlock(leftMs, rightMs) {
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && Math.abs(leftMs - rightMs) <= LIVE_POLL.sameBlockMs;
}

function scheduleBlockHasMoved(match, matches) {
  const start = Date.parse(match?.scheduled_at || "");
  return (matches || []).some((other) => {
    if (other === match || !matchHasStarted(other)) return false;
    const otherStart = Date.parse(other.scheduled_at || "");
    if (!Number.isFinite(start) || !Number.isFinite(otherStart)) return true;
    return inSameScheduleBlock(start, otherStart);
  });
}

export function matchWindowBounds(match, { matches = [] } = {}) {
  const start = Date.parse(match?.scheduled_at || "");
  if (!Number.isFinite(start)) return null;
  const earliest = start - LIVE_POLL.leadMs;
  const latest = start + LIVE_POLL.postponeMs + seriesTrailMs(match);
  const pulledEarly = scheduleBlockHasMoved(match, matches);
  return { earliest: pulledEarly ? Number.NEGATIVE_INFINITY : earliest, latest };
}

export function matchWindowActive(match, nowMs, { matches = [], livePairs = [] } = {}) {
  if (!match || match.winner) return false;
  if (match.live || (livePairs || []).includes(seriesPairKey(match))) return true;
  if (matchHasStarted(match)) return true;
  const bounds = matchWindowBounds(match, { matches });
  if (!bounds) return false;
  return nowMs >= bounds.earliest && nowMs <= bounds.latest;
}

export function anyMatchWindowActive({ nowMs, matches = [], liveGames = [], livePairs = [], latestMapStartSeconds = 0 } = {}) {
  if ((liveGames || []).some((game) => game?.matchId)) return true;
  if ((matches || []).some((match) => matchWindowActive(match, nowMs, { matches, livePairs }))) return true;
  const latestMapMs = Number(latestMapStartSeconds) * 1000;
  return Number.isFinite(latestMapMs) && latestMapMs > 0 && nowMs - latestMapMs <= LIVE_POLL.recentMapMs;
}

function stretchForBudget(intervalSeconds, remainingDaily) {
  if (!Number.isFinite(remainingDaily) || intervalSeconds == null) return intervalSeconds;
  if (remainingDaily < 150) return Math.max(intervalSeconds, LIVE_POLL.criticalBudgetFloorSeconds);
  if (remainingDaily < 400) return Math.max(intervalSeconds, LIVE_POLL.lowBudgetFloorSeconds);
  return intervalSeconds;
}

function planFromWindow({
  inWindow,
  liveGames = [],
  remainingDaily,
  draftSeconds,
  windowSeconds,
  kind,
}) {
  const usable = (liveGames || []).filter((game) => game?.matchId);
  if (kind === "live") {
    const drafting = usable.some((game) => game.phase === "draft" || !liveGameHasCompletePicks(game));
    const picksKnown = usable.length > 0 && usable.every((game) => game.phase !== "draft" && liveGameHasCompletePicks(game));
    if (!inWindow && !usable.length) return { shouldPoll: false, intervalSeconds: null, reason: "idle_no_match_window" };
    let intervalSeconds = windowSeconds;
    let reason = "match_window_waiting";
    if (drafting) {
      intervalSeconds = Math.max(15, Number(draftSeconds) || LIVE_POLL.draftSeconds);
      reason = "draft_in_progress";
    } else if (picksKnown) {
      intervalSeconds = LIVE_POLL.picksKnownSeconds;
      reason = "picks_known";
    }
    const stretched = stretchForBudget(intervalSeconds, remainingDaily);
    return { shouldPoll: true, intervalSeconds: stretched, reason: stretched !== intervalSeconds ? `${reason}_low_budget` : reason };
  }
  if (!inWindow) return { shouldPoll: false, intervalSeconds: null, reason: "idle_no_match_window" };
  const stretched = stretchForBudget(Math.max(60, Number(windowSeconds) || 120), remainingDaily);
  return { shouldPoll: true, intervalSeconds: stretched, reason: stretched !== windowSeconds ? "match_window_low_budget" : "match_window" };
}

export function livePollPlan({
  nowMs = Date.now(),
  matches = [],
  liveGames = [],
  livePairs = [],
  remainingDaily = Number.POSITIVE_INFINITY,
  draftSeconds = LIVE_POLL.draftSeconds,
  latestMapStartSeconds = 0,
} = {}) {
  const inWindow = anyMatchWindowActive({ nowMs, matches, liveGames, livePairs, latestMapStartSeconds });
  return planFromWindow({
    inWindow,
    liveGames,
    remainingDaily,
    draftSeconds,
    windowSeconds: LIVE_POLL.windowSeconds,
    kind: "live",
  });
}

export function leagueMapsPollPlan({
  nowMs = Date.now(),
  matches = [],
  liveGames = [],
  livePairs = [],
  remainingDaily = Number.POSITIVE_INFINITY,
  windowSeconds = 120,
  latestMapStartSeconds = 0,
} = {}) {
  const inWindow = anyMatchWindowActive({ nowMs, matches, liveGames, livePairs, latestMapStartSeconds });
  return planFromWindow({
    inWindow,
    liveGames,
    remainingDaily,
    windowSeconds,
    kind: "maps",
  });
}
