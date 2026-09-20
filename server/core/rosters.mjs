// Lineup awareness for the team ratings.
//
// A rating attached to a team id credits a squad with results its current five
// players had nothing to do with. Dota rosters turn over constantly, so a
// result from a lineup that shares two players with today's is weak evidence
// about today's team — and the rating model has no way to know that unless it
// is told.

const parseJson = (value, fallback = null) => {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};

// Overlap with the current five, and how much a result at that overlap is
// worth. A whole squad change is not zero: organisations keep their coaching,
// infrastructure and draft habits, and the number is small rather than nil.
export const DEFAULT_OVERLAP_WEIGHTS = Object.freeze([0.02, 0.02, 0.06, 0.2, 0.5, 1]);

/**
 * Every map's lineup, as the set of account ids each side fielded.
 * One pass over the stored maps; the rest is set arithmetic.
 */
export function loadMapLineups(db, { sinceSeconds = 0 } = {}) {
  const rows = db.prepare(`SELECT match_id, radiant_team_id, dire_team_id, start_time, players_json
                           FROM maps
                           WHERE players_json IS NOT NULL AND start_time >= ?
                             AND radiant_team_id > 0 AND dire_team_id > 0`).all(sinceSeconds);
  const byMatch = new Map();
  for (const row of rows) {
    const players = parseJson(row.players_json, []);
    if (!Array.isArray(players) || !players.length) continue;
    const radiant = new Set();
    const dire = new Set();
    for (const player of players) {
      const accountId = Number(player.accountId ?? player.account_id ?? 0);
      if (!accountId) continue;
      const isRadiant = player.isRadiant ?? (Number(player.slot ?? player.player_slot ?? 0) < 128);
      (isRadiant ? radiant : dire).add(accountId);
    }
    if (!radiant.size && !dire.size) continue;
    byMatch.set(Number(row.match_id), {
      startTime: Number(row.start_time),
      [String(row.radiant_team_id)]: radiant,
      [String(row.dire_team_id)]: dire,
    });
  }
  return byMatch;
}

/**
 * The five a team is fielding now, taken from its most recent maps.
 *
 * A player is counted as current if they appear in most of the recent games, so
 * a single stand-in does not redefine the lineup.
 */
export function currentLineups(db, { recentMaps = 12, nowSeconds = Date.now() / 1000, windowDays = 120 } = {}) {
  const since = Math.floor(nowSeconds - windowDays * 86_400);
  const rows = db.prepare(`SELECT radiant_team_id, dire_team_id, start_time, players_json
                           FROM maps
                           WHERE players_json IS NOT NULL AND start_time >= ?
                             AND radiant_team_id > 0 AND dire_team_id > 0
                           ORDER BY start_time DESC`).all(since);

  const seen = new Map();
  for (const row of rows) {
    const players = parseJson(row.players_json, []);
    if (!Array.isArray(players)) continue;
    for (const [teamId, isRadiantSide] of [[row.radiant_team_id, true], [row.dire_team_id, false]]) {
      const key = String(teamId);
      const entry = seen.get(key) ?? { maps: 0, counts: new Map() };
      if (entry.maps >= recentMaps) continue;
      let counted = false;
      for (const player of players) {
        const accountId = Number(player.accountId ?? player.account_id ?? 0);
        if (!accountId) continue;
        const isRadiant = player.isRadiant ?? (Number(player.slot ?? player.player_slot ?? 0) < 128);
        if (isRadiant !== isRadiantSide) continue;
        entry.counts.set(accountId, (entry.counts.get(accountId) || 0) + 1);
        counted = true;
      }
      if (counted) entry.maps += 1;
      seen.set(key, entry);
    }
  }

  const lineups = new Map();
  for (const [teamId, entry] of seen) {
    if (!entry.maps) continue;
    const five = [...entry.counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([accountId]) => accountId);
    if (five.length) lineups.set(teamId, { players: new Set(five), maps: entry.maps });
  }
  return lineups;
}

const overlapWeight = (shared, weights) => weights[Math.min(shared, weights.length - 1)];

/**
 * Attach a roster weight to every training series.
 *
 * Both sides matter: a result is only fully informative about today's teams if
 * both lineups are still the ones that played it, so the two weights multiply.
 * A series we have no lineup for keeps weight 1 rather than being penalised for
 * missing data.
 */
export function attachRosterWeights(series, db, {
  weights = DEFAULT_OVERLAP_WEIGHTS,
  nowSeconds = Date.now() / 1000,
} = {}) {
  const lineups = currentLineups(db, { nowSeconds });
  const mapLineups = loadMapLineups(db);

  // Which account ids each series fielded, folded from its maps.
  const seriesLineups = new Map();
  const mapRows = db.prepare(`SELECT series_key, map_ids_json FROM series WHERE map_ids_json IS NOT NULL`).all();
  for (const row of mapRows) {
    const ids = parseJson(row.map_ids_json, []);
    if (!Array.isArray(ids)) continue;
    const perTeam = new Map();
    for (const matchId of ids) {
      const lineup = mapLineups.get(Number(matchId));
      if (!lineup) continue;
      for (const [teamId, players] of Object.entries(lineup)) {
        if (teamId === "startTime" || !(players instanceof Set)) continue;
        const existing = perTeam.get(teamId) ?? new Set();
        for (const accountId of players) existing.add(accountId);
        perTeam.set(teamId, existing);
      }
    }
    if (perTeam.size) seriesLineups.set(row.series_key, perTeam);
  }

  let covered = 0;
  for (const row of series) {
    const played = seriesLineups.get(row.seriesKey);
    if (!played) { row.rosterWeight = 1; continue; }
    const sideWeight = (teamId) => {
      const current = lineups.get(String(teamId));
      const fielded = played.get(String(teamId));
      if (!current || !fielded || !fielded.size) return 1;
      let shared = 0;
      for (const accountId of current.players) if (fielded.has(accountId)) shared += 1;
      return overlapWeight(shared, weights);
    };
    row.rosterWeight = sideWeight(row.targetLineup) * sideWeight(row.opponentLineup);
    covered += 1;
  }
  return { covered, total: series.length, lineups: lineups.size };
}

// --- roster history ---------------------------------------------------------

/** The five a team fielded on one map, as account ids with whatever name we saw. */
function fieldedFive(row, teamId) {
  const players = parseJson(row.players_json, []);
  if (!Array.isArray(players)) return [];
  const ours = Number(row.radiant_team_id) === Number(teamId);
  const side = [];
  for (const player of players) {
    const radiant = player.isRadiant ?? (Number(player.slot ?? player.player_slot ?? 0) < 128);
    if (radiant !== ours) continue;
    const accountId = Number(player.accountId ?? player.account_id ?? 0);
    if (accountId) side.push({ accountId, name: player.name || null });
  }
  return side;
}

/**
 * A team's roster history, as the spells during which it fielded one lineup.
 *
 * A single stand-in is not a new roster, so a map joins the running spell while
 * it shares at least four players with it — the same four-of-five rule the
 * training weights already use. Anything less starts a new one.
 *
 * Deliberately scoped to one team's maps: `loadMapLineups` parses all 53,000 of
 * them and takes a third of a second, which is fine for training and far too
 * much for a page.
 */
export function rosterEras(db, teamId, { limit = 4000 } = {}) {
  const rows = db.prepare(`SELECT match_id, radiant_team_id, players_json, start_time FROM maps
                           WHERE (radiant_team_id = ? OR dire_team_id = ?)
                             AND players_json IS NOT NULL
                           ORDER BY start_time ASC LIMIT ?`).all(teamId, teamId, limit);

  const eras = [];
  let era = null;
  for (const row of rows) {
    const five = fieldedFive(row, teamId);
    if (!five.length) continue;
    const ids = new Set(five.map((player) => player.accountId));

    let shared = 0;
    if (era) for (const accountId of era.core) if (ids.has(accountId)) shared += 1;
    if (!era || shared < 4) {
      era = { core: ids, counts: new Map(), maps: 0, from: null, to: null };
      eras.push(era);
    }

    era.maps += 1;
    era.from ??= Number(row.start_time) || null;
    era.to = Number(row.start_time) || era.to;
    for (const player of five) {
      const entry = era.counts.get(player.accountId) ?? { accountId: player.accountId, name: null, maps: 0 };
      entry.maps += 1;
      if (!entry.name && player.name) entry.name = player.name;
      era.counts.set(player.accountId, entry);
    }
    // The core follows the five that actually play, so a spell that drifts by
    // one player at a time stays one spell rather than splitting on the drift.
    era.core = new Set([...era.counts.values()].sort((a, b) => b.maps - a.maps).slice(0, 5)
      .map((player) => player.accountId));
  }

  const shaped = eras.map((entry) => ({
    players: [...entry.counts.values()].sort((a, b) => b.maps - a.maps).slice(0, 5),
    maps: entry.maps,
    from: entry.from,
    to: entry.to,
  }));

  const known = resolvePlayerNames(db, shaped.flatMap((entry) => entry.players.map((player) => player.accountId)));
  for (const entry of shaped) {
    for (const player of entry.players) player.name = known.get(player.accountId) ?? player.name ?? null;
  }
  return shaped;
}

/**
 * Names for a set of account ids: the pro-player list first, then whatever the
 * results feed happened to record, then the bare id. Most archived maps carry
 * no names at all, so the bare id is a common and honest answer.
 */
export function resolvePlayerNames(db, accountIds) {
  const ids = [...new Set([...accountIds].map(Number).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = db.prepare(`SELECT account_id, name FROM players WHERE account_id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids);
  return new Map(rows.map((row) => [Number(row.account_id), row.name]));
}
