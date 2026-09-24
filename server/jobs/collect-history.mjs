// Backfill and daily top-up of professional match history. The /proMatches feed
// is the cheapest source: 100 matches per call, newest first, every one of them
// usable as a training row. The cursor is persisted so a run that hits the
// daily budget resumes where it stopped instead of starting over.
import { getJsonSetting, setJsonSetting, nowIso } from "../core/db.mjs";
import { opendota, BudgetExhausted, Throttled, budgetStatus } from "../core/opendota.mjs";
import { upsertMap, rebuildSeries, refreshTournamentAggregates, upsertTournament, TRACKED_TIERS } from "../core/tournaments.mjs";

const DAY = 86_400;
const CURSOR_KEY = "history_backfill_cursor";
const NEWEST_KEY = "history_newest_match_id";

const HISTORY_DAYS = Math.max(60, Number(process.env.HISTORY_DAYS || 540));
const MAX_PAGES_PER_RUN = Math.max(1, Number(process.env.HISTORY_MAX_PAGES || 120));
const BUDGET_RESERVE = Math.max(0, Number(process.env.HISTORY_BUDGET_RESERVE || 250));

/**
 * Walk backwards from the oldest match we have until the history window is
 * covered. Safe to call repeatedly; it is a no-op once the window is full.
 */
export async function backfillHistory(db, { pages = MAX_PAGES_PER_RUN, nowSeconds = Date.now() / 1000 } = {}) {
  const horizon = Math.floor(nowSeconds - HISTORY_DAYS * DAY);
  const state = getJsonSetting(db, CURSOR_KEY, { cursor: null, done: false, oldestSeen: null });
  if (state.done) return { skipped: true, reason: "window_complete", oldestSeen: state.oldestSeen };

  const touchedLeagues = new Set();
  let stored = 0;
  let pagesUsed = 0;
  let cursor = state.cursor;
  let oldestSeen = state.oldestSeen;
  let done = false;
  let stoppedBy = "page_limit";

  // The cursor is written after every page: a run cut short by throttling or a
  // restart must resume where it stopped, not re-walk the whole feed.
  const saveCursor = () => setJsonSetting(db, CURSOR_KEY, { cursor, done, oldestSeen, updatedAt: nowIso() });

  for (let page = 0; page < pages; page += 1) {
    let rows;
    try {
      rows = await opendota.proMatches(db, cursor);
    } catch (error) {
      if (error instanceof BudgetExhausted) { stoppedBy = "budget"; break; }
      if (error instanceof Throttled) { stoppedBy = "throttled"; break; }
      saveCursor();
      throw error;
    }
    pagesUsed += 1;
    if (!Array.isArray(rows) || !rows.length) { done = true; stoppedBy = "feed_empty"; break; }
    for (const row of rows) {
      const leagueId = Number(row.leagueid || 0);
      if (upsertMap(db, row, { leagueId })) stored += 1;
      if (leagueId) touchedLeagues.add(leagueId);
      const startTime = Number(row.start_time || 0);
      if (startTime && (oldestSeen === null || startTime < oldestSeen)) oldestSeen = startTime;
    }
    cursor = rows.at(-1)?.match_id ?? null;
    if (!cursor) { done = true; stoppedBy = "no_cursor"; saveCursor(); break; }
    if (oldestSeen !== null && oldestSeen <= horizon) { done = true; stoppedBy = "window_complete"; saveCursor(); break; }
    saveCursor();
    if (budgetStatus(db).remaining <= BUDGET_RESERVE) { stoppedBy = "budget_reserve"; break; }
  }

  saveCursor();
  for (const leagueId of touchedLeagues) {
    rebuildSeries(db, leagueId);
    refreshTournamentAggregates(db, leagueId, { nowSeconds });
  }
  return { stored, pagesUsed, cursor, done, stoppedBy, oldestSeen, leagues: touchedLeagues.size };
}

/**
 * Pull everything newer than the last match we stored. This is the daily
 * "what happened yesterday" pass and it also registers leagues we have not
 * seen before.
 */
export async function collectRecent(db, { maxPages = 12, nowSeconds = Date.now() / 1000 } = {}) {
  const knownNewest = Number(getJsonSetting(db, NEWEST_KEY, { matchId: 0 }).matchId || 0);
  const catalog = new Map();
  try {
    for (const league of (await opendota.leagues(db)) || []) catalog.set(Number(league.leagueid), league);
  } catch (error) {
    if (!(error instanceof BudgetExhausted) && !(error instanceof Throttled)) throw error;
  }

  const touchedLeagues = new Set();
  let cursor = null;
  let stored = 0;
  let newestSeen = knownNewest;
  let reachedKnown = false;

  for (let page = 0; page < maxPages; page += 1) {
    let rows;
    try {
      rows = await opendota.proMatches(db, cursor);
    } catch (error) {
      if (error instanceof BudgetExhausted || error instanceof Throttled) break;
      throw error;
    }
    if (!Array.isArray(rows) || !rows.length) break;
    for (const row of rows) {
      const matchId = Number(row.match_id);
      if (matchId > newestSeen) newestSeen = matchId;
      if (knownNewest && matchId <= knownNewest) { reachedKnown = true; continue; }
      const leagueId = Number(row.leagueid || 0);
      if (upsertMap(db, row, { leagueId })) stored += 1;
      if (leagueId) touchedLeagues.add(leagueId);
    }
    if (reachedKnown) break;
    cursor = rows.at(-1)?.match_id ?? null;
    if (!cursor) break;
  }

  for (const leagueId of touchedLeagues) {
    const league = catalog.get(leagueId);
    const tier = league?.tier ?? null;
    if (!TRACKED_TIERS.size || (tier && TRACKED_TIERS.has(tier))) {
      upsertTournament(db, { leagueId, name: league?.name || `League ${leagueId}`, tier });
    }
    rebuildSeries(db, leagueId);
    refreshTournamentAggregates(db, leagueId, { nowSeconds });
  }

  setJsonSetting(db, NEWEST_KEY, { matchId: newestSeen, updatedAt: nowIso() });
  return { stored, leagues: touchedLeagues.size, newestMatchId: newestSeen, reachedKnown };
}

/**
 * Fetch full detail (picks_bans) for recent maps that lack it. Draft training
 * and live draft inference both depend on these rows, but each map costs one
 * API call, so the per-run cap keeps it inside the budget.
 */
export async function fetchMissingDrafts(db, { limit = Number(process.env.DRAFT_DETAIL_LIMIT || 60), reserve = BUDGET_RESERVE } = {}) {
  const rows = db.prepare(`SELECT m.match_id FROM maps m LEFT JOIN tournaments t ON t.league_id=m.league_id
                           WHERE m.detail_fetched = 0 AND m.radiant_team_id > 0 AND m.dire_team_id > 0
                             AND m.radiant_win IS NOT NULL AND COALESCE(t.tracked,1)=1
                           ORDER BY m.start_time DESC LIMIT ?`).all(limit);
  let fetched = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const detail = await opendota.match(db, row.match_id, reserve);
      if (!detail) { db.prepare("UPDATE maps SET detail_fetched = 1, updated_at = ? WHERE match_id = ?").run(nowIso(), row.match_id); failed += 1; continue; }
      upsertMap(db, detail, { leagueId: Number(detail.leagueid || 0), detail: true });
      fetched += 1;
    } catch (error) {
      if (error instanceof BudgetExhausted || error instanceof Throttled) break;
      failed += 1;
    }
  }
  return { fetched, failed, candidates: rows.length };
}
