// Tournament registry. Every league OpenDota reports activity for becomes a
// tracked tournament with its own slug, so a new event gets a page without any
// code change.
import { nowIso } from "./db.mjs";
import { opendota, BudgetExhausted, Throttled } from "./opendota.mjs";

const HOUR = 3600;
const DAY = 24 * HOUR;

// A tournament counts as running while maps keep landing; most events have rest
// days, so the idle window is generous before it is called finished.
export const LIVE_WINDOW_SECONDS = Math.max(HOUR, Number(process.env.TOURNAMENT_LIVE_WINDOW_HOURS || 24) * HOUR);
export const ACTIVE_WINDOW_SECONDS = Math.max(DAY, Number(process.env.TOURNAMENT_ACTIVE_WINDOW_DAYS || 7) * DAY);
export const TRACKED_TIERS = new Set((process.env.TOURNAMENT_TIERS || "premium,professional").split(",").map((tier) => tier.trim()).filter(Boolean));
export const HISTORY_WINDOW_SECONDS = Math.max(30 * DAY, Number(process.env.TOURNAMENT_HISTORY_DAYS || 540) * DAY);

export function slugify(name, leagueId) {
  const base = String(name || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base ? `${base}-${leagueId}` : `league-${leagueId}`;
}

export function tournamentStatus({ lastMatchTime, nowSeconds = Date.now() / 1000, hasMaps = true }) {
  if (!hasMaps || !lastMatchTime) return "upcoming";
  const idle = nowSeconds - Number(lastMatchTime);
  if (idle <= LIVE_WINDOW_SECONDS) return "live";
  if (idle <= ACTIVE_WINDOW_SECONDS) return "live";
  return "finished";
}

export function isPlayingNow(lastMatchTime, nowSeconds = Date.now() / 1000) {
  return Boolean(lastMatchTime) && nowSeconds - Number(lastMatchTime) <= 6 * HOUR;
}

function uniqueSlug(db, name, leagueId) {
  const base = slugify(name, leagueId);
  const clash = db.prepare("SELECT league_id FROM tournaments WHERE slug = ? AND league_id != ?").get(base, leagueId);
  return clash ? `${base}-x` : base;
}

export function upsertTournament(db, { leagueId, name, tier = null, prizePool = null }) {
  const existing = db.prepare("SELECT league_id, slug, name FROM tournaments WHERE league_id = ?").get(leagueId);
  const at = nowIso();
  if (existing) {
    db.prepare("UPDATE tournaments SET name = COALESCE(?, name), tier = COALESCE(?, tier), prize_pool = COALESCE(?, prize_pool), updated_at = ? WHERE league_id = ?")
      .run(name ?? null, tier ?? null, prizePool ?? null, at, leagueId);
    return existing.slug;
  }
  const slug = uniqueSlug(db, name, leagueId);
  db.prepare(`INSERT INTO tournaments(league_id, slug, name, tier, prize_pool, status, first_seen_at, updated_at)
              VALUES(?,?,?,?,?,'upcoming',?,?)`)
    .run(leagueId, slug, String(name || `League ${leagueId}`), tier, prizePool, at, at);
  return slug;
}

/** Recompute the derived columns of one tournament from its stored maps. */
export function refreshTournamentAggregates(db, leagueId, { nowSeconds = Date.now() / 1000 } = {}) {
  const totals = db.prepare(`
    SELECT COUNT(*) AS map_count, MIN(start_time) AS start_time, MAX(start_time) AS last_match_time
    FROM maps WHERE league_id = ?`).get(leagueId);
  const teamCount = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT radiant_team_id AS t FROM maps WHERE league_id = ? AND radiant_team_id > 0
      UNION SELECT dire_team_id FROM maps WHERE league_id = ? AND dire_team_id > 0)`).get(leagueId, leagueId);
  const seriesCount = db.prepare("SELECT COUNT(*) AS n FROM series WHERE league_id = ?").get(leagueId);
  const hasMaps = Number(totals?.map_count || 0) > 0;
  const lastMatchTime = totals?.last_match_time ?? null;
  const status = tournamentStatus({ lastMatchTime, nowSeconds, hasMaps });
  const endTime = status === "finished" ? lastMatchTime : null;
  db.prepare(`UPDATE tournaments SET map_count = ?, series_count = ?, team_count = ?, start_time = ?, last_match_time = ?,
              end_time = ?, status = ?, updated_at = ? WHERE league_id = ?`)
    .run(Number(totals?.map_count || 0), Number(seriesCount?.n || 0), Number(teamCount?.n || 0),
      totals?.start_time ?? null, lastMatchTime, endTime, status, nowIso(), leagueId);
  return { status, mapCount: Number(totals?.map_count || 0), lastMatchTime };
}

export function upsertTeam(db, { teamId, name = null, tag = null, logoUrl = null, lastMatchTime = null }) {
  if (!Number(teamId)) return;
  db.prepare(`INSERT INTO teams(team_id, name, tag, logo_url, last_match_time, updated_at) VALUES(?,?,?,?,?,?)
              ON CONFLICT(team_id) DO UPDATE SET
                name = COALESCE(excluded.name, teams.name),
                tag = COALESCE(excluded.tag, teams.tag),
                logo_url = COALESCE(excluded.logo_url, teams.logo_url),
                last_match_time = MAX(COALESCE(excluded.last_match_time,0), COALESCE(teams.last_match_time,0)),
                updated_at = excluded.updated_at`)
    .run(Number(teamId), name, tag, logoUrl, lastMatchTime, nowIso());
}

// OpenDota sends a boolean, but archives and other feeds use 0/1. Accepting
// only one of those silently discards every result from the other.
function normalizeWin(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === 1 || value === 0) return value;
  if (value === "true") return 1;
  if (value === "false") return 0;
  return null;
}

const heroIdsFromPicksBans = (picksBans, isRadiant) => (picksBans || [])
  .filter((row) => row?.is_pick && Boolean(row?.team === 0) === isRadiant)
  .map((row) => Number(row.hero_id))
  .filter((id) => Number.isInteger(id) && id > 0);

/** Store one map. Accepts both the compact league-matches shape and full detail. */
export function upsertMap(db, row, { leagueId = null, detail = false } = {}) {
  const matchId = Number(row.match_id);
  if (!Number.isInteger(matchId) || matchId <= 0) return false;
  const league = Number(leagueId ?? row.leagueid ?? row.league_id ?? 0) || 0;
  const picksBans = Array.isArray(row.picks_bans) ? row.picks_bans : null;
  const radiantPicks = picksBans ? heroIdsFromPicksBans(picksBans, true) : null;
  const direPicks = picksBans ? heroIdsFromPicksBans(picksBans, false) : null;
  const players = Array.isArray(row.players)
    ? row.players.map((player) => ({
      accountId: Number(player.account_id || 0) || null,
      heroId: Number(player.hero_id || 0) || null,
      slot: Number(player.player_slot ?? player.team_slot ?? 0),
      isRadiant: player.isRadiant ?? Number(player.player_slot ?? 0) < 128,
      name: player.name || player.personaname || null,
    }))
    : null;

  db.prepare(`INSERT INTO maps(match_id, league_id, series_id, series_type, radiant_team_id, dire_team_id,
      radiant_name, dire_name, radiant_win, start_time, duration, patch, radiant_score, dire_score,
      radiant_picks_json, dire_picks_json, picks_bans_json, players_json, detail_fetched, updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(match_id) DO UPDATE SET
      league_id = CASE WHEN excluded.league_id > 0 THEN excluded.league_id ELSE maps.league_id END,
      series_id = COALESCE(excluded.series_id, maps.series_id),
      series_type = COALESCE(excluded.series_type, maps.series_type),
      radiant_team_id = COALESCE(excluded.radiant_team_id, maps.radiant_team_id),
      dire_team_id = COALESCE(excluded.dire_team_id, maps.dire_team_id),
      radiant_name = COALESCE(excluded.radiant_name, maps.radiant_name),
      dire_name = COALESCE(excluded.dire_name, maps.dire_name),
      radiant_win = COALESCE(excluded.radiant_win, maps.radiant_win),
      start_time = COALESCE(excluded.start_time, maps.start_time),
      duration = COALESCE(excluded.duration, maps.duration),
      patch = COALESCE(excluded.patch, maps.patch),
      radiant_score = COALESCE(excluded.radiant_score, maps.radiant_score),
      dire_score = COALESCE(excluded.dire_score, maps.dire_score),
      radiant_picks_json = COALESCE(excluded.radiant_picks_json, maps.radiant_picks_json),
      dire_picks_json = COALESCE(excluded.dire_picks_json, maps.dire_picks_json),
      picks_bans_json = COALESCE(excluded.picks_bans_json, maps.picks_bans_json),
      players_json = COALESCE(excluded.players_json, maps.players_json),
      detail_fetched = MAX(excluded.detail_fetched, maps.detail_fetched),
      updated_at = excluded.updated_at`)
    .run(matchId, league,
      row.series_id != null ? String(row.series_id) : null,
      row.series_type != null ? Number(row.series_type) : null,
      Number(row.radiant_team_id || 0) || null,
      Number(row.dire_team_id || 0) || null,
      row.radiant_name || row.radiant_team?.name || null,
      row.dire_name || row.dire_team?.name || null,
      normalizeWin(row.radiant_win),
      Number(row.start_time || 0) || null,
      Number(row.duration || 0) || null,
      row.patch != null ? String(row.patch) : null,
      Number(row.radiant_score ?? 0) || null,
      Number(row.dire_score ?? 0) || null,
      radiantPicks?.length ? JSON.stringify(radiantPicks) : null,
      direPicks?.length ? JSON.stringify(direPicks) : null,
      picksBans ? JSON.stringify(picksBans) : null,
      players ? JSON.stringify(players) : null,
      detail ? 1 : 0, nowIso());

  if (Number(row.radiant_team_id)) upsertTeam(db, { teamId: row.radiant_team_id, name: row.radiant_name || row.radiant_team?.name || null, lastMatchTime: Number(row.start_time) || null });
  if (Number(row.dire_team_id)) upsertTeam(db, { teamId: row.dire_team_id, name: row.dire_name || row.dire_team?.name || null, lastMatchTime: Number(row.start_time) || null });
  return true;
}

// How long a series must sit untouched, while its league keeps playing,
// before it counts as over rather than in progress.
const SETTLE_SECONDS = Math.max(3600, Number(process.env.SERIES_SETTLE_HOURS || 12) * 3600);

const bestOfFromSeriesType = (seriesType) => (seriesType === 2 ? 5 : seriesType === 1 ? 3 : seriesType === 0 ? 1 : null);
const pairKey = (a, b) => [Number(a), Number(b)].sort((left, right) => left - right).join("-");

/**
 * Fold a league's maps into series rows. Maps carrying an OpenDota series_id are
 * grouped by it; the rest fall back to same-pair maps inside one 12h block,
 * which is how a best-of looks when the feed omits the id.
 */
export function rebuildSeries(db, leagueId) {
  const maps = db.prepare(`SELECT match_id, series_id, series_type, radiant_team_id, dire_team_id, radiant_win, start_time
                           FROM maps WHERE league_id = ? AND radiant_team_id > 0 AND dire_team_id > 0
                           ORDER BY start_time ASC, match_id ASC`).all(leagueId);
  const latestLeagueMap = maps.reduce((latest, map) => Math.max(latest, Number(map.start_time) || 0), 0);

  const groups = new Map();
  for (const map of maps) {
    const pair = pairKey(map.radiant_team_id, map.dire_team_id);
    let key;
    if (map.series_id && String(map.series_id) !== "0") {
      key = `s:${map.series_id}`;
    } else {
      // Attach to the most recent open synthetic group for this pair if it is
      // still inside the same block, otherwise start a new one.
      const previous = [...groups.values()].filter((group) => group.pair === pair && !group.seriesId).at(-1);
      const withinBlock = previous && Number(map.start_time) - Number(previous.lastStart) <= 12 * HOUR;
      key = withinBlock ? previous.key : `p:${pair}:${map.start_time}`;
    }
    if (!groups.has(key)) {
      groups.set(key, {
        key, pair, seriesId: map.series_id && String(map.series_id) !== "0" ? String(map.series_id) : null,
        teamA: null, teamB: null, seriesType: null, mapIds: [],
        firstStart: map.start_time, lastStart: map.start_time, winsA: 0, winsB: 0,
      });
    }
    const group = groups.get(key);
    if (group.teamA == null) {
      group.teamA = Number(map.radiant_team_id);
      group.teamB = Number(map.dire_team_id);
    }
    if (map.series_type != null) group.seriesType = Number(map.series_type);
    group.mapIds.push(Number(map.match_id));
    group.lastStart = Math.max(Number(group.lastStart), Number(map.start_time));
    group.firstStart = Math.min(Number(group.firstStart), Number(map.start_time));
    if (map.radiant_win != null) {
      const winnerId = map.radiant_win ? Number(map.radiant_team_id) : Number(map.dire_team_id);
      if (winnerId === group.teamA) group.winsA += 1; else if (winnerId === group.teamB) group.winsB += 1;
    }
  }

  const at = nowIso();
  const keep = new Set();
  for (const group of groups.values()) {
    if (!group.teamA || !group.teamB || group.teamA === group.teamB) continue;
    const seriesKey = `${leagueId}:${group.key}`;
    keep.add(seriesKey);
    const played = group.winsA + group.winsB;
    const declared = bestOfFromSeriesType(group.seriesType);
    const official = db.prepare(`SELECT best_of FROM scheduled_matches
                                 WHERE league_id = ? AND best_of IS NOT NULL
                                   AND ((team_a_id = ? AND team_b_id = ?) OR (team_a_id = ? AND team_b_id = ?))
                                   AND (start_time IS NULL OR ABS(start_time - ?) <= ?)
                                 ORDER BY CASE WHEN series_key IS NOT NULL THEN 0 ELSE 1 END, ABS(COALESCE(start_time, ?) - ?) ASC
                                 LIMIT 1`)
      .get(leagueId, group.teamA, group.teamB, group.teamB, group.teamA,
        group.firstStart, 24 * HOUR, group.firstStart, group.firstStart);
    // Never claim a best-of smaller than what was actually played.
    let bestOf = Number(official?.best_of) >= played ? Number(official.best_of)
      : declared && declared >= played ? declared : played >= 4 ? 5 : played >= 2 ? 3 : 1;
    let needed = Math.floor(bestOf / 2) + 1;
    let decided = group.winsA >= needed || group.winsB >= needed;

    // The tournament has moved on past this series: whatever it was, it is over.
    const settled = latestLeagueMap > 0 && latestLeagueMap - Number(group.lastStart) > SETTLE_SECONDS;
    // Two maps, one each, and nothing more coming: that is a drawn Bo2, not a
    // Bo3 waiting for a decider. The feed's series_type cannot be trusted here
    // — most of these arrive tagged as something else entirely.
    const publishedBestOf = official?.best_of ?? declared ?? null;
    const isDraw = !decided && settled && played === 2 && group.winsA === group.winsB
      && (publishedBestOf == null || Number(publishedBestOf) % 2 === 0);
    if (isDraw) { bestOf = 2; needed = 2; decided = true; }

    const abandoned = !decided && settled;
    const winnerId = !decided || isDraw ? null
      : group.winsA > group.winsB ? group.teamA : group.teamB;
    const status = isDraw || (decided && !isDraw) ? "finished" : abandoned ? "abandoned" : "live";
    db.prepare(`INSERT INTO series(series_key, league_id, opendota_series_id, team_a_id, team_b_id, best_of, stage,
                  start_time, end_time, score_a, score_b, winner_id, status, map_ids_json, updated_at, is_draw)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(series_key) DO UPDATE SET
                  best_of = excluded.best_of, start_time = excluded.start_time, end_time = excluded.end_time,
                  score_a = excluded.score_a, score_b = excluded.score_b, winner_id = excluded.winner_id,
                  status = excluded.status, map_ids_json = excluded.map_ids_json, updated_at = excluded.updated_at,
                  is_draw = excluded.is_draw`)
      .run(seriesKey, leagueId, group.seriesId, group.teamA, group.teamB, bestOf, null,
        group.firstStart, group.lastStart, group.winsA, group.winsB, winnerId,
        status, JSON.stringify(group.mapIds), at, isDraw ? 1 : 0);
  }
  // Drop synthetic series that no longer match any map (e.g. after a re-sync).
  const stale = db.prepare("SELECT series_key FROM series WHERE league_id = ?").all(leagueId)
    .map((row) => row.series_key).filter((key) => !keep.has(key));
  for (const key of stale) db.prepare("DELETE FROM series WHERE series_key = ?").run(key);
  return { series: keep.size, removed: stale.length };
}

/** Pull one league's full match list and refresh its derived rows. */
export async function syncLeague(db, leagueId, { reserve = 0 } = {}) {
  const rows = await opendota.leagueMatches(db, leagueId, reserve);
  if (!Array.isArray(rows)) return { leagueId, maps: 0, skipped: true };
  let stored = 0;
  for (const row of rows) if (upsertMap(db, row, { leagueId })) stored += 1;
  rebuildSeries(db, leagueId);
  const aggregates = refreshTournamentAggregates(db, leagueId);
  db.prepare("UPDATE tournaments SET last_synced_at = ? WHERE league_id = ?").run(nowIso(), leagueId);
  return { leagueId, maps: stored, ...aggregates };
}

/**
 * Discover tournaments from the recent professional match feed. Each page is
 * 100 matches; the feed is also the cheapest source of training history, so the
 * rows are stored as we go.
 */
export async function discoverFromProMatches(db, { pages = 3, tiers = TRACKED_TIERS } = {}) {
  const leagueCatalog = new Map();
  try {
    const leagues = await opendota.leagues(db);
    for (const league of leagues || []) leagueCatalog.set(Number(league.leagueid), league);
  } catch (error) {
    if (!(error instanceof BudgetExhausted) && !(error instanceof Throttled)) throw error;
  }

  const seen = new Map();
  let cursor = null;
  let storedMaps = 0;
  for (let page = 0; page < pages; page += 1) {
    const rows = await opendota.proMatches(db, cursor);
    if (!Array.isArray(rows) || !rows.length) break;
    for (const row of rows) {
      const leagueId = Number(row.leagueid || 0);
      if (upsertMap(db, row, { leagueId })) storedMaps += 1;
      if (!leagueId) continue;
      const catalog = leagueCatalog.get(leagueId);
      const tier = catalog?.tier ?? null;
      if (tiers.size && tier && !tiers.has(tier)) continue;
      if (tiers.size && !tier) continue;
      const current = seen.get(leagueId) || { leagueId, name: catalog?.name || row.league_name || `League ${leagueId}`, tier, lastStart: 0 };
      current.lastStart = Math.max(current.lastStart, Number(row.start_time || 0));
      seen.set(leagueId, current);
    }
    cursor = rows.at(-1)?.match_id ?? null;
    if (!cursor) break;
  }

  const registered = [];
  for (const entry of seen.values()) {
    const slug = upsertTournament(db, { leagueId: entry.leagueId, name: entry.name, tier: entry.tier });
    rebuildSeries(db, entry.leagueId);
    refreshTournamentAggregates(db, entry.leagueId);
    registered.push({ leagueId: entry.leagueId, slug, name: entry.name, tier: entry.tier });
  }
  return { discovered: registered.length, storedMaps, registered };
}

const PLACEHOLDER_NAME = /^League \d+$/;

/**
 * Give real names (and real slugs) to tournaments that were registered from a
 * feed that only carried a league id. The leagues catalog is one cached call,
 * so this is cheap to re-run.
 */
export async function resolveTournamentNames(db, { limit = 500 } = {}) {
  const pending = db.prepare(`SELECT league_id, name, slug FROM tournaments
                              WHERE name LIKE 'League %' OR tier IS NULL
                              ORDER BY last_match_time DESC LIMIT ?`).all(limit);
  if (!pending.length) return { renamed: 0, checked: 0 };

  const catalog = new Map();
  try {
    for (const league of (await opendota.leagues(db)) || []) catalog.set(Number(league.leagueid), league);
  } catch (error) {
    if (!(error instanceof BudgetExhausted) && !(error instanceof Throttled)) throw error;
    return { renamed: 0, checked: 0, reason: "catalog_unavailable" };
  }

  let renamed = 0;
  for (const row of pending) {
    const league = catalog.get(Number(row.league_id));
    if (!league) continue;
    const name = String(league.name || "").trim();
    const tier = league.tier ?? null;
    const needsName = name && PLACEHOLDER_NAME.test(row.name);
    if (!needsName && !tier) continue;
    if (needsName) {
      // The slug was derived from the placeholder, so regenerate it too.
      const slug = uniqueSlug(db, name, Number(row.league_id));
      db.prepare("UPDATE tournaments SET name = ?, slug = ?, tier = COALESCE(?, tier), updated_at = ? WHERE league_id = ?")
        .run(name, slug, tier, nowIso(), row.league_id);
      renamed += 1;
    } else {
      db.prepare("UPDATE tournaments SET tier = COALESCE(?, tier), updated_at = ? WHERE league_id = ?")
        .run(tier, nowIso(), row.league_id);
    }
  }
  return { renamed, checked: pending.length };
}

/** Drop tournaments whose tier is outside the tracked set. */
export function untrackOutOfScopeTournaments(db, { tiers = TRACKED_TIERS } = {}) {
  if (!tiers.size) return { untracked: 0 };
  const placeholders = [...tiers].map(() => "?").join(",");
  const info = db.prepare(`UPDATE tournaments SET tracked = 0, updated_at = ?
                           WHERE tracked = 1 AND tier IS NOT NULL AND tier NOT IN (${placeholders})`)
    .run(nowIso(), ...tiers);
  return { untracked: Number(info.changes) };
}

/** Tournaments worth polling: anything live or recently active. */
export function activeTournaments(db, { nowSeconds = Date.now() / 1000 } = {}) {
  return db.prepare(`SELECT * FROM tournaments WHERE tracked = 1 AND (status = 'live' OR status = 'upcoming'
                     OR last_match_time >= ?) ORDER BY last_match_time DESC`)
    .all(Math.floor(nowSeconds - ACTIVE_WINDOW_SECONDS));
}

export function tournamentBySlug(db, slug) {
  return db.prepare("SELECT * FROM tournaments WHERE slug = ?").get(slug)
    ?? (/^\d+$/.test(String(slug)) ? db.prepare("SELECT * FROM tournaments WHERE league_id = ?").get(Number(slug)) : undefined);
}
