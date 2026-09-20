// Single choke point for OpenDota traffic: one in-flight request at a time, a
// hard gap between calls, and a persisted daily budget so a runaway job cannot
// burn the free tier before the live poll needs it.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { getJsonSetting, setJsonSetting } from "./db.mjs";

const API_URL = process.env.OPENDOTA_API_URL || "https://api.opendota.com/api";
const API_KEY = process.env.OPENDOTA_API_KEY || "";
const USER_AGENT = process.env.OPENDOTA_USER_AGENT || "dota-predictor/2.0 (self-hosted)";
const REQUEST_GAP_MS = Math.max(200, Number(process.env.OPENDOTA_REQUEST_GAP_MS || (API_KEY ? 120 : 1400)));
const DAILY_LIMIT = Math.max(100, Number(process.env.OPENDOTA_DAILY_LIMIT || (API_KEY ? 200_000 : 1900)));
const CACHE_DIR = path.resolve(process.env.OPENDOTA_CACHE_DIR || "work/opendota-cache");
const MAX_RETRIES = Math.max(1, Number(process.env.OPENDOTA_MAX_RETRIES || 5));
// After a 429 the whole client backs off, not just the request that tripped it:
// the limit is per key, so racing other callers straight back in makes it worse.
const THROTTLE_BASE_MS = Math.max(1000, Number(process.env.OPENDOTA_THROTTLE_BASE_MS || 4000));
const THROTTLE_MAX_MS = Math.max(THROTTLE_BASE_MS, Number(process.env.OPENDOTA_THROTTLE_MAX_MS || 120_000));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const utcDay = (date = new Date()) => date.toISOString().slice(0, 10);

let throttledUntil = 0;
let consecutiveThrottles = 0;

/** True while the API has asked us to slow down. Jobs use it to stop early. */
export function isThrottled() {
  return Date.now() < throttledUntil;
}

export function throttleStatus() {
  return {
    throttled: isThrottled(),
    retryInMs: Math.max(0, throttledUntil - Date.now()),
    consecutiveThrottles,
  };
}

export class Throttled extends Error {
  constructor(retryInMs) {
    super(`opendota_throttled (retry in ${Math.ceil(retryInMs / 1000)}s)`);
    this.name = "Throttled";
    this.retryInMs = retryInMs;
  }
}

let chain = Promise.resolve();
let lastRequestAt = 0;

// Budget lives in the DB so it survives a restart mid-day.
function readBudget(db) {
  const stored = getJsonSetting(db, "opendota_budget", null);
  if (stored && stored.day === utcDay()) return stored;
  return { day: utcDay(), used: 0, limit: DAILY_LIMIT };
}

export function budgetStatus(db) {
  const budget = readBudget(db);
  return { ...budget, limit: DAILY_LIMIT, remaining: Math.max(0, DAILY_LIMIT - budget.used) };
}

function chargeBudget(db, count = 1) {
  const budget = readBudget(db);
  budget.used += count;
  budget.limit = DAILY_LIMIT;
  setJsonSetting(db, "opendota_budget", budget);
  return budget;
}

export class BudgetExhausted extends Error {
  constructor(remaining) {
    super(`opendota_daily_budget_exhausted (remaining ${remaining})`);
    this.name = "BudgetExhausted";
    this.remaining = remaining;
  }
}

function cachePath(key) {
  const safe = key.replace(/[^a-z0-9._-]/gi, "_").slice(0, 180);
  return path.join(CACHE_DIR, `${safe}.json`);
}

function readCache(key, maxAgeMs) {
  const file = cachePath(key);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (maxAgeMs != null && Date.now() - Number(parsed.at || 0) > maxAgeMs) return null;
    return parsed.body;
  } catch { return null; }
}

function writeCache(key, body) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cachePath(key), JSON.stringify({ at: Date.now(), body }));
  } catch { /* cache is best effort */ }
}

function retryAfterMs(response, attempt) {
  const header = Number(response.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.min(THROTTLE_MAX_MS, header * 1000);
  return Math.min(THROTTLE_MAX_MS, THROTTLE_BASE_MS * 2 ** attempt);
}

async function performRequest(url) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const cooldown = Math.max(0, throttledUntil - Date.now());
    if (cooldown > 0) await sleep(cooldown);
    const wait = Math.max(0, REQUEST_GAP_MS - (Date.now() - lastRequestAt));
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    let response;
    try {
      response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      if (attempt === MAX_RETRIES) throw error;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      const delay = retryAfterMs(response, attempt);
      if (response.status === 429) {
        consecutiveThrottles += 1;
        throttledUntil = Date.now() + delay;
      }
      if (attempt === MAX_RETRIES) throw new Throttled(delay);
      await sleep(delay);
      continue;
    }
    consecutiveThrottles = 0;
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`opendota_http_${response.status}`);
    return response.json();
  }
  return null;
}

/**
 * @param db open database handle (for budget accounting)
 * @param endpoint path below /api, e.g. "/proMatches"
 * @param options.query      query params
 * @param options.cacheKey   enables the on-disk cache under that key
 * @param options.cacheMaxAgeMs  null = never expires (immutable resources)
 * @param options.reserve    refuse the call when fewer than this many requests remain
 */
export function openDotaGet(db, endpoint, { query = {}, cacheKey = null, cacheMaxAgeMs = null, reserve = 0 } = {}) {
  if (cacheKey) {
    const cached = readCache(cacheKey, cacheMaxAgeMs);
    if (cached !== null) return Promise.resolve(cached);
  }
  const run = async () => {
    const budget = budgetStatus(db);
    if (budget.remaining <= reserve) throw new BudgetExhausted(budget.remaining);
    const url = new URL(`${API_URL}${endpoint}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    if (API_KEY) url.searchParams.set("api_key", API_KEY);
    chargeBudget(db, 1);
    const body = await performRequest(url.toString());
    if (cacheKey && body !== null) writeCache(cacheKey, body);
    return body;
  };
  // Serialize every caller through one chain so the gap is actually honoured.
  const task = chain.then(run, run);
  chain = task.then(() => undefined, () => undefined);
  return task;
}

export const opendota = {
  /** All known leagues with tier. Large and slow-moving, cached for a day. */
  leagues: (db) => openDotaGet(db, "/leagues", { cacheKey: "leagues", cacheMaxAgeMs: 12 * 60 * 60_000 }),
  /** Recent professional matches, newest first. Paginate with lessThan. */
  proMatches: (db, lessThan = null) => openDotaGet(db, "/proMatches", { query: lessThan ? { less_than_match_id: lessThan } : {} }),
  /** Every match of one league. */
  leagueMatches: (db, leagueId, reserve = 0) => openDotaGet(db, `/leagues/${leagueId}/matches`, { reserve }),
  /** Teams that played in one league, with wins/losses. */
  leagueTeams: (db, leagueId, reserve = 0) => openDotaGet(db, `/leagues/${leagueId}/teams`, { reserve }),
  /** One league's metadata. */
  league: (db, leagueId) => openDotaGet(db, `/leagues/${leagueId}`, { cacheKey: `league-${leagueId}`, cacheMaxAgeMs: 6 * 60 * 60_000 }),
  /** Full match detail including picks_bans. Immutable once played. */
  match: (db, matchId, reserve = 0) => openDotaGet(db, `/matches/${matchId}`, { cacheKey: `match-${matchId}`, cacheMaxAgeMs: null, reserve }),
  /** Currently running games. Never cached. */
  live: (db) => openDotaGet(db, "/live"),
  /** Every known professional player, with their handle. One call, cached a day. */
  proPlayers: (db) => openDotaGet(db, "/proPlayers", { cacheKey: "proPlayers", cacheMaxAgeMs: 24 * 60 * 60_000 }),
  /** Hero reference data. */
  heroes: (db) => openDotaGet(db, "/heroes", { cacheKey: "heroes", cacheMaxAgeMs: 7 * 24 * 60 * 60_000 }),
  /** Team reference data by id. */
  team: (db, teamId) => openDotaGet(db, `/teams/${teamId}`, { cacheKey: `team-${teamId}`, cacheMaxAgeMs: 24 * 60 * 60_000 }),
};

export { API_KEY as OPENDOTA_API_KEY, DAILY_LIMIT as OPENDOTA_DAILY_LIMIT };
