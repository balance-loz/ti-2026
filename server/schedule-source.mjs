const TEAM_ALIASES = new Map(Object.entries({
  "1W": "1w", "1WTEAM": "1w", "1WIN": "1w", "1WINTEAM": "1w", TUNDRA: "1w", TUNDRAESPORTS: "1w", AURORA: "aurora", AURORAGAMING: "aurora",
  BETBOOM: "betboom", BETBOOMTEAM: "betboom", FALCONS: "falcons", TEAMFALCONS: "falcons",
  GAMERLEGION: "gamerlegion", L1GA: "l1ga", L1GATEAM: "l1ga", L1TEAM: "l1ga", LIGATEAM: "l1ga", LGD: "lgd", LGDGAMING: "lgd",
  LIQUID: "liquid", TEAMLIQUID: "liquid", NIGMA: "nigma", NIGMAGALAXY: "nigma", OG: "og",
  PARIVISION: "parivision", PVISION: "parivision", TEAMVISION: "parivision",
  RESILIENCE: "resilience", TEAMRESILIENCE: "resilience", SPIRIT: "spirit", TEAMSPIRIT: "spirit",
  VG: "vg", VICIGAMING: "vg", XTREME: "xtreme", XTREMEGAMING: "xtreme",
  YANDEX: "yandex", TEAMYANDEX: "yandex",
}));

const decodeHtml = (value) => value.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replace(/<[^>]+>/g, "").trim();
const normalize = (value) => decodeHtml(value).normalize("NFKD").replace(/[^a-z0-9]/gi, "").toUpperCase();
const pad = (value) => String(value).padStart(2, "0");

function calendarDateAt(now, timezoneOffset, dayDelta = 0) {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(timezoneOffset);
  const offsetMinutes = match ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
  const shifted = new Date(now.getTime() + offsetMinutes * 60_000 + dayDelta * 86_400_000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

function scheduledAtFromText(text, { now, timezoneOffset }) {
  const clean = decodeHtml(text).replace(/\s+/g, " ").trim();
  const explicit = /(\d{2})\.(\d{2})\.(\d{2})\s+(?:в|РІ)\s+(\d{2}):(\d{2})/i.exec(clean);
  if (explicit) {
    const [, day, month, year, hour, minute] = explicit;
    return new Date(`20${year}-${month}-${day}T${hour}:${minute}:00${timezoneOffset}`).toISOString();
  }
  const relative = /(?:Сегодня|Завтра)\s+в\s+(\d{2}):(\d{2})/i.exec(clean);
  if (relative) {
    const delta = /^Завтра/i.test(clean) ? 1 : 0;
    return new Date(`${calendarDateAt(now, timezoneOffset, delta)}T${relative[1]}:${relative[2]}:00${timezoneOffset}`).toISOString();
  }
  // Cybersport removes the time as soon as a series becomes LIVE and can expose
  // a newly drawn pair before assigning its start time. The pairing is still
  // official and must constrain the Monte Carlo immediately.
  return now.toISOString();
}

function participantsFromChunk(chunk) {
  return [...new Set([...chunk.matchAll(/<img[^>]+alt="([^"]+)"[^>]*>/gi)]
    .map((item) => TEAM_ALIASES.get(normalize(item[1]))).filter(Boolean))].slice(0, 2);
}

function addScheduled(scheduled, seen, chunk, round, options) {
  const [teamA, teamB] = participantsFromChunk(chunk);
  if (!teamA || !teamB || teamA === teamB) return;
  const dateHtml = chunk.match(/<div[^>]*class="[^"]*date_[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? chunk;
  const scheduledAt = scheduledAtFromText(dateHtml, options);
  const key = [teamA, teamB].sort().join("|");
  if (seen.has(key)) return;
  seen.add(key);
  scheduled.push({ teamA, teamB, round, scheduledAt, source: "cybersport" });
}

export function scheduledSeriesFromCybersportHtml(html, { timezoneOffset = "+03:00", now = new Date() } = {}) {
  if (typeof html !== "string" || !html.length) return [];
  const activeTab = [...html.matchAll(/class="[^"]*tab_[^"]*isActive_[^"]*"[^>]*>\s*<span>([^<]*)<\/span>/gi)].at(-1);
  const round = Number(decodeHtml(activeTab?.[1] || "").match(/\d+/)?.[0] || 1);
  const scheduled = [];
  const seen = new Set();
  const options = { now: now instanceof Date ? now : new Date(now), timezoneOffset };

  // Current Cybersport markup renders only the active round and wraps every
  // series in an item_* block. Parse named LIVE and time-less pairings too, not
  // just the old "dd.mm.yy в hh:mm ... vs" layout.
  const scheduleStart = html.search(/<h2[^>]*>\s*Расписание\s*<\/h2>/i);
  const scheduleEnd = html.search(/id="stage-participants"/i);
  const scope = scheduleStart >= 0 ? html.slice(scheduleStart, scheduleEnd > scheduleStart ? scheduleEnd : html.length) : html;
  const itemStarts = [...scope.matchAll(/<div class="[^"]*item_[^"]*"/gi)];
  for (let index = 0; index < itemStarts.length; index += 1) {
    const start = itemStarts[index].index;
    const end = itemStarts[index + 1]?.index ?? scope.length;
    addScheduled(scheduled, seen, scope.slice(start, end), round, options);
  }

  // Keep compatibility with the former server-rendered layout and compact test
  // fixtures where there are no item_* wrappers.
  const datePattern = /(\d{2})\.(\d{2})\.(\d{2})\s+(?:в|РІ)\s+(\d{2}):(\d{2})/gi;
  const dates = [...scope.matchAll(datePattern)];
  for (let index = 0; index < dates.length; index += 1) {
    const match = dates[index];
    const end = dates[index + 1]?.index ?? Math.min(scope.length, match.index + 6500);
    const chunk = scope.slice(match.index, end);
    if (!/<span[^>]*class="[^"]*vs_[^"]*"[^>]*>\s*vs\s*<\/span>/i.test(chunk)) continue;
    addScheduled(scheduled, seen, chunk, round, options);
  }
  return scheduled;
}
