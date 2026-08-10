const TEAM_ALIASES = new Map(Object.entries({
  "1W": "1w", "1WTEAM": "1w", AURORA: "aurora", AURORAGAMING: "aurora",
  BETBOOM: "betboom", BETBOOMTEAM: "betboom", FALCONS: "falcons", TEAMFALCONS: "falcons",
  GAMERLEGION: "gamerlegion", L1GA: "l1ga", L1GATEAM: "l1ga", LGD: "lgd", LGDGAMING: "lgd",
  LIQUID: "liquid", TEAMLIQUID: "liquid", NIGMA: "nigma", NIGMAGALAXY: "nigma", OG: "og",
  PARIVISION: "parivision", PVISION: "parivision", TEAMVISION: "parivision",
  RESILIENCE: "resilience", TEAMRESILIENCE: "resilience", SPIRIT: "spirit", TEAMSPIRIT: "spirit",
  VG: "vg", VICIGAMING: "vg", XTREME: "xtreme", XTREMEGAMING: "xtreme",
  YANDEX: "yandex", TEAMYANDEX: "yandex",
}));

const decodeHtml = (value) => value.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replace(/<[^>]+>/g, "").trim();
const normalize = (value) => decodeHtml(value).normalize("NFKD").replace(/[^a-z0-9]/gi, "").toUpperCase();

export function scheduledSeriesFromCybersportHtml(html, { timezoneOffset = "+03:00" } = {}) {
  if (typeof html !== "string" || !html.length) return [];
  const activeRound = [...html.matchAll(/class="[^"]*tab_[^"]*isActive_[^"]*"[^>]*>\s*<span>Раунд\s+(\d+)<\/span>/gi)].at(-1);
  const round = Number(activeRound?.[1] || 1);
  const datePattern = /(\d{2})\.(\d{2})\.(\d{2})\s+в\s+(\d{2}):(\d{2})/g;
  const dates = [...html.matchAll(datePattern)];
  const scheduled = [];
  const seen = new Set();
  for (let index = 0; index < dates.length; index += 1) {
    const match = dates[index];
    const end = dates[index + 1]?.index ?? Math.min(html.length, match.index + 6500);
    const chunk = html.slice(match.index + match[0].length, end);
    if (!/<span[^>]*class="[^"]*vs_[^"]*"[^>]*>\s*vs\s*<\/span>/i.test(chunk)) continue;
    const participants = [...chunk.matchAll(/<img[^>]+alt="([^"]+)"[^>]*>/gi)]
      .map((item) => TEAM_ALIASES.get(normalize(item[1]))).filter(Boolean);
    const [teamA, teamB] = [...new Set(participants)];
    if (!teamA || !teamB || teamA === teamB) continue;
    const [, day, month, year, hour, minute] = match;
    const scheduledAt = new Date(`20${year}-${month}-${day}T${hour}:${minute}:00${timezoneOffset}`).toISOString();
    const key = [teamA, teamB].sort().join("|");
    if (seen.has(`${scheduledAt}:${key}`)) continue;
    seen.add(`${scheduledAt}:${key}`);
    scheduled.push({ teamA, teamB, round, scheduledAt, source: "cybersport" });
  }
  return scheduled;
}
