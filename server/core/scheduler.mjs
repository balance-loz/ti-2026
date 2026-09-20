// In-process job runner. One timer per job, never overlapping with itself, each
// run recorded in job_runs so the site can show when data was last refreshed and
// what failed.
import { startJobRun, finishJobRun, getJsonSetting, setJsonSetting, nowIso } from "./db.mjs";
import { budgetStatus } from "./opendota.mjs";
import { syncLiveGames, currentLiveGames, livePollIntervalSeconds } from "./live.mjs";
import { discoverFromProMatches, activeTournaments, syncLeague, resolveTournamentNames, untrackOutOfScopeTournaments } from "./tournaments.mjs";
import { syncHeroes, invalidateHeroCache } from "./heroes.mjs";
import { resolvePredictions } from "./predictions.mjs";
import { trainRatings, invalidateRatingsCache } from "./ratings.mjs";
import { trainDraftModel } from "./draft-model.mjs";
import { backfillHistory, collectRecent, fetchMissingDrafts } from "../jobs/collect-history.mjs";
import { forecastActiveTournaments } from "../jobs/forecast.mjs";
import { importPendingArchives } from "../jobs/import-archive.mjs";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

export const JOB_DEFINITIONS = {
  importArchive: { intervalMs: number(process.env.JOB_IMPORT_MINUTES, 10) * MINUTE, description: "Import a dropped match archive" },
  live: { intervalMs: 30_000, adaptive: true, description: "Live games and draft predictions" },
  resolve: { intervalMs: 10 * MINUTE, description: "Score finished predictions" },
  syncActive: { intervalMs: number(process.env.JOB_SYNC_ACTIVE_MINUTES, 15) * MINUTE, description: "Re-pull running tournaments" },
  discover: { intervalMs: number(process.env.JOB_DISCOVER_MINUTES, 60) * MINUTE, description: "Find new tournaments" },
  forecast: { intervalMs: number(process.env.JOB_FORECAST_MINUTES, 20) * MINUTE, description: "Tournament outlook Monte Carlo" },
  collectRecent: { intervalMs: number(process.env.JOB_COLLECT_HOURS, 3) * HOUR, description: "New finished pro matches" },
  backfill: { intervalMs: number(process.env.JOB_BACKFILL_MINUTES, 30) * MINUTE, description: "Historical match backfill" },
  draftDetail: { intervalMs: number(process.env.JOB_DRAFT_DETAIL_MINUTES, 30) * MINUTE, description: "Fetch missing pick/ban data" },
  retrain: { intervalMs: number(process.env.JOB_RETRAIN_HOURS, 24) * HOUR, description: "Retrain ratings and draft model" },
};

export function createScheduler(db, { enabled = true, logger = console } = {}) {
  const state = new Map();
  const timers = new Map();
  let stopped = false;

  const handlers = {
    live: async () => {
      const tracked = new Set(activeTournaments(db).map((row) => Number(row.league_id)));
      const result = await syncLiveGames(db, { leagueFilter: tracked.size ? tracked : null });
      const open = currentLiveGames(db);
      const nextSeconds = livePollIntervalSeconds(open, { remainingBudget: budgetStatus(db).remaining });
      state.get("live").nextIntervalMs = nextSeconds * 1000;
      return { ...result, games: undefined, openGames: open.length, nextPollSeconds: nextSeconds };
    },
    // Picking up an archive means a lot of new history at once, so retrain
    // straight away instead of waiting up to a day for the scheduled pass.
    importArchive: async () => {
      const result = await importPendingArchives(db);
      if (!result.imported) return result;
      const ratings = trainRatings(db);
      invalidateRatingsCache();
      const draft = trainDraftModel(db);
      const forecasts = forecastActiveTournaments(db, { force: true });
      return { ...result, ratings, draft, forecasts: { leagues: forecasts.leagues, updated: forecasts.updated } };
    },
    resolve: async () => resolvePredictions(db),
    syncActive: async () => {
      const leagues = activeTournaments(db).slice(0, number(process.env.JOB_SYNC_MAX_LEAGUES, 12));
      const results = [];
      for (const league of leagues) {
        try {
          results.push(await syncLeague(db, Number(league.league_id), { reserve: 200 }));
        } catch (error) {
          results.push({ leagueId: Number(league.league_id), error: String(error?.message || error) });
        }
      }
      return { leagues: leagues.length, results };
    },
    discover: async () => {
      const discovered = await discoverFromProMatches(db, { pages: number(process.env.JOB_DISCOVER_PAGES, 3) });
      // A league first seen through a match feed only carries an id; give it a
      // real name and slug before its page is linked anywhere.
      const named = await resolveTournamentNames(db, { limit: 200 });
      const scoped = untrackOutOfScopeTournaments(db);
      // Hero names change only when Valve adds a hero; one cached call covers it.
      const heroes = await syncHeroes(db);
      if (heroes.synced) invalidateHeroCache();
      return { ...discovered, registered: discovered.registered?.length ?? 0, named, scoped, heroes };
    },
    forecast: async () => forecastActiveTournaments(db),
    collectRecent: async () => collectRecent(db),
    backfill: async () => backfillHistory(db, { pages: number(process.env.JOB_BACKFILL_PAGES, 40) }),
    draftDetail: async () => fetchMissingDrafts(db),
    retrain: async () => {
      const ratings = trainRatings(db);
      invalidateRatingsCache();
      const draft = trainDraftModel(db);
      // Fresh ratings change every projection, so force a full recompute.
      const forecasts = forecastActiveTournaments(db, { force: true });
      return { ratings, draft, forecasts: { leagues: forecasts.leagues, updated: forecasts.updated } };
    },
  };

  async function runJob(name, { manual = false } = {}) {
    const entry = state.get(name);
    if (!entry) throw new Error(`unknown_job_${name}`);
    if (entry.running) return { skipped: true, reason: "already_running" };
    entry.running = true;
    entry.startedAt = nowIso();
    const runId = startJobRun(db, name);
    try {
      const detail = await handlers[name]();
      entry.lastStatus = "ok";
      entry.lastDetail = detail;
      entry.lastError = null;
      finishJobRun(db, runId, "ok", detail);
      return detail;
    } catch (error) {
      entry.lastStatus = "error";
      entry.lastError = String(error?.message || error);
      finishJobRun(db, runId, "error", null, error);
      logger.error?.(`[scheduler] ${name} failed:`, error?.message || error);
      if (manual) throw error;
      return { error: entry.lastError };
    } finally {
      entry.running = false;
      entry.lastRunAt = nowIso();
      setJsonSetting(db, `job_last_run_${name}`, { at: entry.lastRunAt, status: entry.lastStatus });
    }
  }

  function schedule(name) {
    if (stopped) return;
    const entry = state.get(name);
    const delay = entry.nextIntervalMs ?? entry.definition.intervalMs;
    const timer = setTimeout(async () => {
      await runJob(name);
      schedule(name);
    }, delay);
    timer.unref?.();
    timers.set(name, timer);
  }

  for (const [name, definition] of Object.entries(JOB_DEFINITIONS)) {
    const persisted = getJsonSetting(db, `job_last_run_${name}`, null);
    state.set(name, {
      name, definition, running: false,
      lastRunAt: persisted?.at ?? null,
      lastStatus: persisted?.status ?? null,
      lastError: null, lastDetail: null,
      nextIntervalMs: null,
    });
  }

  return {
    async start() {
      if (!enabled) {
        logger.warn?.("[scheduler] disabled by configuration");
        return;
      }
      // Stagger the first run of each job so a cold start does not fire
      // everything into the API at once.
      const order = ["importArchive", "live", "discover", "syncActive", "resolve", "forecast", "collectRecent", "draftDetail", "backfill", "retrain"];
      order.forEach((name, index) => {
        const timer = setTimeout(async () => {
          if (stopped) return;
          await runJob(name);
          schedule(name);
        }, index * 4000);
        timer.unref?.();
        timers.set(`boot-${name}`, timer);
      });
      logger.log?.(`[scheduler] started ${order.length} jobs`);
    },
    stop() {
      stopped = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
    run: (name) => runJob(name, { manual: true }),
    status: () => [...state.values()].map((entry) => ({
      job: entry.name,
      description: entry.definition.description,
      intervalSeconds: Math.round((entry.nextIntervalMs ?? entry.definition.intervalMs) / 1000),
      running: entry.running,
      lastRunAt: entry.lastRunAt,
      lastStatus: entry.lastStatus,
      lastError: entry.lastError,
      lastDetail: entry.lastDetail,
    })),
  };
}
