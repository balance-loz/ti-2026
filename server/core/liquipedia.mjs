// Liquipedia as the source of everything the results feed cannot give:
// the tournament format, its stages, the playoff bracket, and — most valuable —
// the official start time of each match, which is what lets a prediction be
// frozen genuinely before a game rather than after its first map.
//
// Their API terms require an identifying User-Agent, rate limiting and caching,
// so requests go through one queue at a fixed gap and every page is cached.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const API = process.env.LIQUIPEDIA_API_URL || "https://liquipedia.net/dota2/api.php";
const CONTACT = process.env.LIQUIPEDIA_CONTACT || "github.com/balance-loz/ti-2026";
const USER_AGENT = `dota-predictor/2.0 (self-hosted; ${CONTACT})`;
// Liquipedia documents one parse request per two seconds.
const REQUEST_GAP_MS = Math.max(2000, Number(process.env.LIQUIPEDIA_GAP_MS || 2200));
const CACHE_DIR = path.resolve(process.env.LIQUIPEDIA_CACHE_DIR || "work/liquipedia-cache");
const PAGE_TTL_MS = Math.max(60 * 60_000, Number(process.env.LIQUIPEDIA_PAGE_TTL_HOURS || 6) * 60 * 60_000);

// How long to stay away after being told we are asking too often. Liquipedia
// warns that repeatedly tripping their limiter turns the block permanent, so
// the cooldown is long and is written to disk: a restart must not undo it.
const COOLDOWN_MS = Math.max(60_000, Number(process.env.LIQUIPEDIA_COOLDOWN_MINUTES || 60) * 60_000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let chain = Promise.resolve();
let lastRequestAt = 0;

export class LiquipediaUnavailable extends Error {
  constructor(reason) {
    super(`liquipedia_unavailable: ${reason}`);
    this.name = "LiquipediaUnavailable";
  }
}

const cooldownFile = () => path.join(CACHE_DIR, "cooldown.json");

/** Milliseconds left on the rate-limit cooldown, or 0 when clear. */
export function cooldownRemainingMs() {
  try {
    const until = Number(JSON.parse(readFileSync(cooldownFile(), "utf8"))?.until || 0);
    return Math.max(0, until - Date.now());
  } catch { return 0; }
}

function startCooldown(reason) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cooldownFile(), JSON.stringify({ until: Date.now() + COOLDOWN_MS, reason, at: new Date().toISOString() }));
  } catch { /* best effort */ }
}

function cacheFile(key) {
  return path.join(CACHE_DIR, `${key.replace(/[^a-z0-9._-]/gi, "_").slice(0, 180)}.json`);
}

function readCache(key, maxAgeMs) {
  const file = cacheFile(key);
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
    writeFileSync(cacheFile(key), JSON.stringify({ at: Date.now(), body }));
  } catch { /* cache is best effort */ }
}

function request(params, { cacheKey = null, cacheMaxAgeMs = null } = {}) {
  if (cacheKey) {
    const cached = readCache(cacheKey, cacheMaxAgeMs);
    if (cached !== null) return Promise.resolve(cached);
  }
  // Blocked: serve whatever we cached, however old, rather than adding to the
  // requests that got us blocked in the first place.
  const cooldown = cooldownRemainingMs();
  if (cooldown > 0) {
    const stale = cacheKey ? readCache(cacheKey, Infinity) : null;
    if (stale !== null) return Promise.resolve(stale);
    return Promise.reject(new LiquipediaUnavailable(`cooling_down_${Math.round(cooldown / 60_000)}m`));
  }

  const run = async () => {
    const wait = Math.max(0, REQUEST_GAP_MS - (Date.now() - lastRequestAt));
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    const url = new URL(API);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    let response;
    try {
      response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      throw new LiquipediaUnavailable(String(error?.message || error));
    }
    if (response.status === 429 || response.status === 403) {
      startCooldown(`http_${response.status}`);
      throw new LiquipediaUnavailable("rate_limited");
    }
    if (!response.ok) throw new LiquipediaUnavailable(`http_${response.status}`);

    // A block comes back as an HTML interstitial with a 200, not as JSON, so
    // the content type is what distinguishes it from a real answer.
    const text = await response.text();
    if (!text.trimStart().startsWith("{") && !text.trimStart().startsWith("[")) {
      startCooldown(/rate limited/i.test(text) ? "rate_limit_page" : "non_json");
      throw new LiquipediaUnavailable("rate_limited");
    }
    let body;
    try { body = JSON.parse(text); } catch { throw new LiquipediaUnavailable("bad_json"); }

    if (cacheKey) writeCache(cacheKey, body);
    return body;
  };
  const task = chain.then(run, run);
  chain = task.then(() => undefined, () => undefined);
  return task;
}

/** Page titles starting with `prefix`. Cheap and good at finding a page family. */
export async function openSearch(prefix) {
  const body = await request(
    { action: "opensearch", format: "json", search: prefix, limit: 15, namespace: 0 },
    { cacheKey: `search-${prefix}`, cacheMaxAgeMs: 24 * 60 * 60_000 },
  );
  return Array.isArray(body?.[1]) ? body[1] : [];
}

/** Raw wikitext of one page, or null when the page does not exist. */
export async function fetchWikitext(title, { maxAgeMs = PAGE_TTL_MS } = {}) {
  const body = await request(
    { action: "parse", format: "json", page: title, prop: "wikitext" },
    { cacheKey: `page-${title}`, cacheMaxAgeMs: maxAgeMs },
  );
  if (body?.error) return null;
  return body?.parse?.wikitext?.["*"] ?? null;
}

// --- name → page ------------------------------------------------------------

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 };

/**
 * Season number carried by an OpenDota tournament name.
 * Liquipedia numbers its pages, so "Season 9", "VII" and "II" all have to land
 * on the same kind of suffix.
 */
export function editionNumber(name) {
  const text = String(name || "");
  const labelled = /\b(?:season|s|part|stage|division|masters)\s*#?(\d{1,2})\b/i.exec(text);
  if (labelled) return Number(labelled[1]);
  const roman = /\b([ivx]{1,5})\b(?!\w)/i.exec(text.replace(/\b(?:i|v|x)\b/gi, ""));
  if (roman && ROMAN[roman[1].toLowerCase()]) return ROMAN[roman[1].toLowerCase()];
  const trailing = /\b(\d{1,2})\s*$/.exec(text.replace(/\b(19|20)\d{2}\b/g, ""));
  if (trailing) return Number(trailing[1]);
  return null;
}

/** Four-digit year in a tournament name, if any. */
export function editionYear(name) {
  const match = /\b(20\d{2})\b/.exec(String(name || ""));
  return match ? Number(match[1]) : null;
}

const normalise = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Candidate Liquipedia titles for an OpenDota tournament name, best first.
 *
 * Liquipedia titles look like `PGL/Wallachia/9`, so the organiser prefix is
 * searched for the page family and the edition number picks the page inside it.
 */
export async function candidateTitles(name) {
  const words = String(name || "").split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const prefixes = [...new Set([
    words[0],
    words.slice(0, 2).join(" "),
    words.slice(0, 2).join("/"),
    words.slice(0, 3).join(" "),
  ].filter((entry) => entry && entry.length >= 2))];

  const found = new Set();
  for (const prefix of prefixes) {
    try {
      for (const title of await openSearch(prefix)) found.add(title);
    } catch (error) {
      if (!(error instanceof LiquipediaUnavailable)) throw error;
    }
  }

  const edition = editionNumber(name);
  const year = editionYear(name);
  const target = normalise(name);

  // A family is a title with its trailing number stripped: PGL/Wallachia/8 -> PGL/Wallachia
  const families = new Set();
  for (const title of found) {
    const family = title.replace(/\/\d{1,4}$/, "");
    if (family !== title) families.add(family);
  }
  const constructed = [];
  for (const family of families) {
    if (edition != null) constructed.push(`${family}/${edition}`);
    if (year != null) constructed.push(`${family}/${year}`);
  }

  const score = (title) => {
    const normalised = normalise(title);
    const shared = normalised.split(" ").filter((word) => word.length > 2 && target.includes(word)).length;
    let value = shared * 10;
    if (edition != null && new RegExp(`/${edition}$`).test(title)) value += 25;
    if (year != null && new RegExp(`/${year}$`).test(title)) value += 20;
    if (/\/(qualifier|playoffs?|group|play-in)/i.test(title)) value -= 15;
    return value;
  };

  return [...new Set([...constructed, ...found])]
    .sort((a, b) => score(b) - score(a))
    .slice(0, 8);
}

// --- the tournament catalog -------------------------------------------------
//
// Guessing a page title from a tournament's name only works when the two look
// alike. They often do not: OpenDota calls one event "RES Unchained - A Blast
// Dota Slam IX Quali" while Liquipedia files it under `BLAST/SLAM/9/Europe`.
// No amount of prefix searching bridges that.
//
// Liquipedia does publish the mapping, though — its tier index pages list every
// tournament with its page, its full name and its dates. Read those once a day
// and the question stops being "what might this page be called" and becomes a
// local lookup against a real catalog.

const INDEX_PAGES = String(process.env.LIQUIPEDIA_INDEX_PAGES
  || "Tier 1 Tournaments,Tier 2 Tournaments,Tier 3 Tournaments,Tier 4 Tournaments,Qualifier Tournaments")
  .split(",").map((entry) => entry.trim()).filter(Boolean);
const CATALOG_TTL_MS = Math.max(60 * 60_000, Number(process.env.LIQUIPEDIA_CATALOG_TTL_HOURS || 24) * 60 * 60_000);
const DAY = 86_400;

const decodeEntities = (value) => String(value || "")
  .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
  .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&amp;/g, "&");

const stripTags = (value) => decodeEntities(String(value || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

/** Rendered HTML of a page. The index pages only exist as rendered tables. */
export async function fetchRenderedHtml(title, { cache = true, maxAgeMs = PAGE_TTL_MS } = {}) {
  const body = await request(
    { action: "parse", format: "json", page: title, prop: "text", redirects: 1 },
    cache ? { cacheKey: `html-${title}`, cacheMaxAgeMs: maxAgeMs } : {},
  );
  if (body?.error) return null;
  return body?.parse?.text?.["*"] ?? null;
}

/**
 * Start and end of an index page's date cell.
 * They come in four shapes: "Sep 10, 2026", "Oct 19-31, 2027",
 * "Apr 26 - May 09, 2027" and "Dec 30, 2025 - Jan 05, 2026".
 */
export function parseIndexDates(raw) {
  const text = String(raw || "").replace(/[‐-―−]/g, "-").replace(/\s+/g, " ").trim();
  if (!text || !/\b20\d{2}\b/.test(text)) return { startTime: null, endTime: null };

  const part = (chunk) => {
    const word = /\b([a-z]{3,9})\b/i.exec(chunk);
    const month = word ? MONTHS.findIndex((name) => name.startsWith(word[1].toLowerCase())) : -1;
    const year = /\b(20\d{2})\b/.exec(chunk);
    const day = /\b(\d{1,2})\b/.exec(chunk.replace(/\b20\d{2}\b/g, " "));
    return { month: month >= 0 ? month : null, day: day ? Number(day[1]) : null, year: year ? Number(year[1]) : null };
  };

  const chunks = text.split(/\s*-\s*/);
  const left = part(chunks[0]);
  const right = chunks.length > 1 ? part(chunks[1]) : null;
  if (right) {
    // "Oct 19-31, 2027" states the month once and the year once; each side
    // borrows whatever the other spelled out.
    if (right.month == null) right.month = left.month;
    if (left.month == null) left.month = right.month;
    if (left.year == null) left.year = right.year;
    if (right.year == null) right.year = left.year;
  }

  const epoch = (entry) => (entry && entry.month != null && entry.day != null && entry.year != null
    ? Math.floor(Date.UTC(entry.year, entry.month, entry.day) / 1000)
    : null);
  const startTime = epoch(left);
  const endTime = epoch(right) ?? startTime;
  return { startTime, endTime: endTime != null && startTime != null && endTime < startTime ? startTime : endTime };
}

/** Every tournament row on a rendered index page. */
export function parseTournamentIndex(html) {
  const text = decodeEntities(html);
  const entries = [];
  for (const row of text.split('class="table2__row--body"').slice(1)) {
    const link = /<td[^>]*class="[^"]*column__tournament[^"]*"[^>]*>\s*<a href="\/dota2\/([^"#]+)"[^>]*>([\s\S]*?)<\/a>/.exec(row);
    if (!link) continue;
    let page;
    try { page = decodeURIComponent(link[1]); } catch { page = link[1]; }
    page = page.replace(/_/g, " ").trim();
    const name = stripTags(link[2]);
    if (!page || !name) continue;

    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => stripTags(cell[1]));
    // The date is the cell after the tournament name, but rather than trusting
    // the column count, take the first cell that reads as a date.
    let dates = { startTime: null, endTime: null };
    let dateText = null;
    for (const cell of cells.slice(2)) {
      const parsed = parseIndexDates(cell);
      if (parsed.startTime != null) { dates = parsed; dateText = cell; break; }
    }
    entries.push({ page, name, dateText, ...dates });
  }
  return entries;
}

/**
 * The catalog, cached for a day.
 *
 * A partial read is still useful, so index pages that fail are skipped rather
 * than failing the whole build; only a build that found nothing at all falls
 * back to the previous catalog.
 */
export async function fetchTournamentCatalog({ maxAgeMs = CATALOG_TTL_MS, pages = INDEX_PAGES } = {}) {
  const cached = readCache("catalog", maxAgeMs);
  if (cached) return cached;

  const byPage = new Map();
  const sources = [];
  for (const indexPage of pages) {
    try {
      const html = await fetchRenderedHtml(indexPage, { cache: false });
      const rows = html ? parseTournamentIndex(html) : [];
      for (const row of rows) if (!byPage.has(row.page)) byPage.set(row.page, row);
      sources.push({ page: indexPage, rows: rows.length });
    } catch (error) {
      if (!(error instanceof LiquipediaUnavailable)) throw error;
      sources.push({ page: indexPage, rows: 0, error: error.message });
    }
  }

  if (!byPage.size) {
    const stale = readCache("catalog", Infinity);
    if (stale) return { ...stale, stale: true };
    return { fetchedAt: new Date().toISOString(), entries: [], sources };
  }

  const catalog = { fetchedAt: new Date().toISOString(), entries: [...byPage.values()], sources };
  writeCache("catalog", catalog);
  return catalog;
}

/**
 * Tokens a tournament name is worth matching on, with roman numerals folded
 * into digits so "Slam IX" and "Season 9" meet.
 */
export function nameTokens(value) {
  return normalise(value).split(" ")
    .filter((token) => token.length > 1)
    .map((token) => (token.length >= 2 && ROMAN[token] ? String(ROMAN[token]) : token));
}

/**
 * Catalog entries that could be this tournament, best first.
 *
 * Words are weighted by how rare they are across the catalog, so "dota",
 * "season" and "qualifier" count for little while "unchained" counts for a lot.
 * Nothing here needs the network — the catalog is already on disk.
 */
export function rankCatalog(name, { entries = [], startTime = null, limit = 8, minScore = 0.4 } = {}) {
  const query = nameTokens(name);
  if (!query.length || !entries.length) return [];

  const indexed = entries.map((entry) => ({ entry, tokens: new Set(nameTokens(entry.name)) }));
  const frequency = new Map();
  for (const { tokens } of indexed) for (const token of tokens) frequency.set(token, (frequency.get(token) || 0) + 1);
  const weight = (token) => 1 / Math.log(2 + (frequency.get(token) || 0));

  // OpenDota truncates long names ("... Slam IX Quali"), so the final word may
  // be a fragment of the real one.
  const last = query.at(-1);
  const total = query.reduce((sum, token) => sum + weight(token), 0);

  const scored = [];
  for (const { entry, tokens } of indexed) {
    let matched = 0;
    for (const token of query) {
      const hit = tokens.has(token)
        || (token === last && token.length >= 3 && [...tokens].some((other) => other.startsWith(token)));
      if (hit) matched += weight(token);
    }
    let score = total ? matched / total : 0;

    if (startTime && entry.startTime) {
      const from = entry.startTime - 2 * DAY;
      const to = (entry.endTime ?? entry.startTime) + 3 * DAY;
      if (startTime >= from && startTime <= to) score += 0.35;
      else score -= Math.min(0.5, (startTime < from ? from - startTime : startTime - to) / (60 * DAY));
    }
    if (score >= minScore) scored.push({ ...entry, score });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

// --- parsing ----------------------------------------------------------------

const TIMEZONES = {
  UTC: 0, GMT: 0, BST: 60, WET: 0, WEST: 60,
  CET: 60, CEST: 120, EET: 120, EEST: 180, MSK: 180,
  EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420,
  BRT: -180, ART: -180, CLT: -240,
  SGT: 480, HKT: 480, PHT: 480, KST: 540, JST: 540, AEST: 600, AEDT: 660,
  IST: 330, ICT: 420, MYT: 480, WIB: 420,
  // Liquipedia writes China Standard Time as CST in Asian events; the American
  // CST above wins by default, so China pages must be read with care.
};

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/**
 * `September 24, 2026 - 10:00 {{Abbr/EEST}}` → ISO instant.
 * Returns null when the zone is unknown: a wrong time is worse than none,
 * because it would freeze predictions at the wrong moment.
 */
export function parseMatchDate(raw) {
  if (!raw) return null;
  const text = String(raw).replace(/\{\{Abbr\/([A-Z]{2,5})\}\}/gi, "$1").replace(/\s+/g, " ").trim();
  const match = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s*[-–]\s*(\d{1,2}):(\d{2})\s*([A-Z]{2,5})?/.exec(text);
  if (!match) return null;
  const monthIndex = MONTHS.indexOf(match[1].toLowerCase());
  if (monthIndex < 0) return null;
  const [, , day, year, hour, minute, zone] = match;
  if (zone && !(zone.toUpperCase() in TIMEZONES)) return null;
  const offsetMinutes = zone ? TIMEZONES[zone.toUpperCase()] : 0;
  const utc = Date.UTC(Number(year), monthIndex, Number(day), Number(hour), Number(minute)) - offsetMinutes * 60_000;
  return Number.isFinite(utc) ? new Date(utc).toISOString() : null;
}

const stripMarkup = (value) => String(value || "")
  .replace(/\{\{Abbr\/(Bo\d)\}\}/gi, "$1")
  .replace(/\{\{Bgcolortext\|[^|]*\|([^}]*)\}\}/gi, "$1")
  .replace(/\{\{[^}]*\}\}/g, "")
  .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
  .replace(/'''?/g, "")
  .trim();

const bestOfFrom = (text) => {
  const match = /\bBo(\d)\b/i.exec(String(text || ""));
  return match ? Number(match[1]) : null;
};

/** The ==Format== section as readable lines plus the best-of it mentions. */
export function parseFormat(wikitext) {
  if (!wikitext) return null;
  const start = wikitext.search(/^==\s*Format\s*==/m);
  if (start < 0) return null;
  const rest = wikitext.slice(start);
  const end = rest.slice(2).search(/^==[^=]/m);
  const section = end > 0 ? rest.slice(0, end + 2) : rest;

  const stages = [];
  let current = null;
  for (const line of section.split(/\r?\n/)) {
    const heading = /^\*'''(.+?)'''/.exec(line);
    if (heading) {
      current = { name: stripMarkup(heading[1]), rules: [], bestOf: null };
      stages.push(current);
      continue;
    }
    const bullet = /^\*{2,}\s*(.+)$/.exec(line);
    if (bullet && current) {
      // A template that opens on this line and closes further down leaves its
      // opening tag behind, so those lines are dropped rather than printed raw.
      if (/\{\{/.test(bullet[1].replace(/\{\{[^{}]*\}\}/g, ""))) continue;
      const text = stripMarkup(bullet[1]);
      if (!text || /^click here/i.test(text) || /[{}|]/.test(text)) continue;
      current.rules.push(text);
      current.bestOf = current.bestOf ?? bestOfFrom(bullet[1]);
    }
  }
  return stages.length ? { stages, bestOf: bestOfFrom(section) } : null;
}

/**
 * The balanced `{{...}}` starting at `start`.
 *
 * Templates nest — a Match contains Maps which contain more templates — so a
 * fixed-length slice reads fields belonging to the next match and miscounts
 * everything. Brace matching is the only way to get one match's own body.
 */
function extractTemplate(text, start) {
  let depth = 0;
  for (let index = start; index < text.length - 1; index += 1) {
    const pair = text.slice(index, index + 2);
    if (pair === "{{") { depth += 1; index += 1; continue; }
    if (pair === "}}") {
      depth -= 1;
      index += 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/** Top-level `|key=value` pairs of a template, ignoring anything nested. */
function templateFields(template) {
  const inner = template.slice(2, -2);
  const parts = [];
  let depth = 0;
  let current = "";
  for (let index = 0; index < inner.length; index += 1) {
    const pair = inner.slice(index, index + 2);
    if (pair === "{{" || pair === "[[") { depth += 1; current += pair; index += 1; continue; }
    if (pair === "}}" || pair === "]]") { depth -= 1; current += pair; index += 1; continue; }
    if (inner[index] === "|" && depth === 0) { parts.push(current); current = ""; continue; }
    current += inner[index];
  }
  parts.push(current);

  const fields = {};
  for (const part of parts.slice(1)) {
    const equals = part.indexOf("=");
    if (equals < 0) continue;
    fields[part.slice(0, equals).trim().toLowerCase()] = part.slice(equals + 1).trim();
  }
  return fields;
}

const opponentName = (raw) => {
  if (!raw) return null;
  const inner = /\{\{[A-Za-z ]*Opponent\|([^|}]*)/.exec(raw);
  const name = stripMarkup(inner ? inner[1] : raw);
  return name && name.length > 1 ? name : null;
};

/** Read one `{{Match ...}}` template: opponents, date, best-of, winner. */
function parseMatchTemplate(template) {
  const fields = templateFields(template);
  const maps = Object.keys(fields).filter((key) => /^map\d+$/.test(key) && /\{\{Map/i.test(fields[key])).length;
  const winner = Number(fields.winner);
  return {
    teamA: opponentName(fields.opponent1),
    teamB: opponentName(fields.opponent2),
    startTime: parseMatchDate(fields.date),
    bestOf: maps > 0 ? maps : null,
    winner: winner === 1 || winner === 2 ? winner : null,
  };
}

/**
 * The playoff bracket: its Liquipedia type id, and every slot grouped under the
 * section comment that labels it ("Upper Bracket Quarterfinals" and so on).
 */
export function parseBracket(wikitext) {
  if (!wikitext) return null;
  const start = wikitext.indexOf("{{Bracket|Bracket/");
  if (start < 0) return null;
  const type = /\{\{Bracket\|Bracket\/([^|]+)/.exec(wikitext.slice(start))?.[1]?.trim() ?? null;
  const region = wikitext.slice(start);

  const rounds = [];
  let label = null;
  const pattern = /<!--\s*([^>]*?)\s*-->|^\|([A-Z0-9]+M\d+)=\{\{Match/gm;
  let match;
  while ((match = pattern.exec(region)) !== null) {
    if (match[1] !== undefined) {
      const text = match[1].trim();
      // Section comments name bracket rounds; anything else is editorial noise.
      label = /bracket|final|round|semi|quarter|grand/i.test(text) ? text : label;
      continue;
    }
    const slot = match[2];
    const template = extractTemplate(region, region.indexOf("{{Match", match.index));
    if (!template) continue;
    const parsed = parseMatchTemplate(template);
    const roundNumber = Number(/^R(\d+)/.exec(slot)?.[1] ?? 0);
    rounds.push({ slot, round: roundNumber, section: label, ...parsed });
  }
  if (!rounds.length) return null;

  const sections = [];
  for (const entry of rounds) {
    const name = entry.section || `Round ${entry.round}`;
    let bucket = sections.find((item) => item.name === name);
    if (!bucket) { bucket = { name, lane: /lower/i.test(name) ? "lower" : /grand/i.test(name) ? "final" : "upper", matches: [] }; sections.push(bucket); }
    bucket.matches.push(entry);
  }
  return { type, sections, matches: rounds };
}

/** Teams listed on the page, from participant cards or bracket opponents. */
export function parseParticipants(wikitext) {
  if (!wikitext) return [];
  const names = new Set();
  const add = (raw) => {
    const name = stripMarkup(raw);
    if (name && name.length > 1) names.add(name);
  };
  for (const match of wikitext.matchAll(/\{\{TeamCard\s*\|\s*team\s*=\s*([^|}\n]+)/gi)) add(match[1]);
  // The participant table names a team as the first positional argument, which
  // is the only place it appears before the bracket has been drawn.
  for (const match of wikitext.matchAll(/\{\{(?:Team)?Opponent\|([^|}\n=]+)/gi)) add(match[1]);
  for (const match of wikitext.matchAll(/\|team\d+\s*=\s*([^|}\n]+)/gi)) add(match[1]);
  return [...names].filter(Boolean);
}

/**
 * Rosters as the organiser listed them: five players per team, by role.
 *
 * This is what makes a team's strength attributable to a lineup rather than to
 * a name, so a squad that changed three players is not credited with the old
 * squad's results.
 */
export function parseRosters(wikitext) {
  if (!wikitext) return [];
  const rosters = [];
  const pattern = /\{\{Opponent\|([^|}\n=]+)/gi;
  let match;
  while ((match = pattern.exec(wikitext)) !== null) {
    const team = stripMarkup(match[1]);
    if (!team) continue;
    const template = extractTemplate(wikitext, match.index);
    if (!template) continue;
    pattern.lastIndex = match.index + template.length;
    const players = [];
    for (const person of template.matchAll(/\{\{Person\|role=([^|}]*)\|([^|}\n]+)/gi)) {
      const role = person[1].trim().toLowerCase();
      const name = stripMarkup(person[2]);
      if (!name || role === "coach" || role === "manager" || role === "analyst") continue;
      players.push({ role, name });
    }
    if (players.length) rosters.push({ team, players });
  }
  return rosters;
}

/** A round number out of a heading or a match-list title, if it states one. */
export function roundNumber(text) {
  const match = /\b(?:round|раунд)\s*#?(\d{1,2})\b/i.exec(String(text || ""));
  return match ? Number(match[1]) : null;
}

/**
 * Every match on the page that carries a start time, bracket or not. This is
 * the schedule the predictor needs in order to freeze before a game begins.
 *
 * Group matches also carry the round they were published under. That number
 * cannot be recovered afterwards — counting a team's matches gets it wrong the
 * moment somebody has a bye — so the enclosing heading or `Matchlist` title is
 * tracked while scanning rather than thrown away.
 */
export function parseScheduledMatches(wikitext) {
  if (!wikitext) return [];
  const results = [];
  // One alternating scan: headings and match lists set the context that the
  // matches after them inherit.
  const pattern = /^(={2,6})[ \t]*(.+?)[ \t]*\1[ \t]*$|\{\{Matchlist\b|\{\{Match\b/gm;

  let headingRound = null;
  let headingDepth = 0;
  let listRound = null;
  let listEnd = -1;
  let match;

  while ((match = pattern.exec(wikitext)) !== null) {
    if (match[1]) {
      const depth = match[1].length;
      const round = roundNumber(match[2]);
      // A heading that names a round sets it; any heading at the same level or
      // above that does not clears it, so a later section cannot inherit it.
      if (round != null) { headingRound = round; headingDepth = depth; }
      else if (depth <= headingDepth) { headingRound = null; headingDepth = 0; }
      continue;
    }

    const template = extractTemplate(wikitext, match.index);
    if (!template) continue;
    pattern.lastIndex = match.index + template.length;

    if (match[0] === "{{Matchlist") {
      const fields = templateFields(template);
      listRound = roundNumber(fields.title) ?? roundNumber(fields.id);
      listEnd = match.index + template.length;
      // The list's own matches are read by the scan that continues inside it.
      pattern.lastIndex = match.index + "{{Matchlist".length;
      continue;
    }

    const parsed = parseMatchTemplate(template);
    if (!parsed.startTime || !parsed.teamA || !parsed.teamB) continue;
    const inList = match.index < listEnd;
    results.push({ ...parsed, round: (inList ? listRound : null) ?? headingRound ?? null });
  }

  // The same match can appear in both a match list and the bracket.
  const seen = new Set();
  return results.filter((row) => {
    const key = `${row.startTime}|${[row.teamA, row.teamB].sort().join("|")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Everything the predictor wants from one tournament page. */
export function parseTournamentPage(wikitext) {
  return {
    format: parseFormat(wikitext),
    bracket: parseBracket(wikitext),
    participants: parseParticipants(wikitext),
    rosters: parseRosters(wikitext),
    schedule: parseScheduledMatches(wikitext),
  };
}
