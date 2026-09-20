// Strength as the players who play, not only the badge they play under.
//
// A rating attached to a team id treats an organisation as the thing that wins
// games. It mostly is not: rosters move, a new organisation can field five
// established players, and an old one can field five nobody has seen. Rating
// team ids alone produced exactly that failure — a side with eight results in
// pub brackets out-rated a team with two hundred, because the model had no way
// to know that one fielded known players and the other did not.
//
// So the two are fitted together. A side's strength is the sum of its five
// players plus a team term, and that team term is what the organisation adds
// beyond its players: coaching, drafting, practice. Fitting both at once means
// the split between them is estimated rather than asserted.
import { seriesInformation } from "../team-model.mjs";

const DAY = 86_400;
const sigmoid = (value) => 1 / (1 + Math.exp(-Math.min(30, Math.max(-30, value))));

export const DEFAULT_STRENGTH_CONFIG = Object.freeze({
  halfLifeDays: 180,
  // The organisation term is heavily shrunk: most of what a team is, is who
  // plays for it, and the residual has to earn its place against that.
  teamL2: 15,
  playerL2: 2,
  iterations: 500,
  learningRate: 0.02,
});

const parseJson = (value, fallback = null) => {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};

/**
 * The five each side fielded in every series.
 *
 * One pass over the maps, folded up through each series' map list. Reads the
 * whole table on purpose — this runs at training time, where a third of a
 * second is nothing and a per-series query would be thousands of them.
 */
export function loadSeriesLineups(db, { sinceSeconds = 0 } = {}) {
  const maps = db.prepare(`SELECT match_id, radiant_team_id, dire_team_id, players_json FROM maps
                           WHERE players_json IS NOT NULL AND start_time >= ?
                             AND radiant_team_id > 0 AND dire_team_id > 0`).all(sinceSeconds);
  const byMatch = new Map();
  for (const row of maps) {
    const players = parseJson(row.players_json, []);
    if (!Array.isArray(players) || !players.length) continue;
    const radiant = [];
    const dire = [];
    for (const player of players) {
      const accountId = Number(player.accountId ?? player.account_id ?? 0);
      if (!accountId) continue;
      const isRadiant = player.isRadiant ?? (Number(player.slot ?? player.player_slot ?? 0) < 128);
      (isRadiant ? radiant : dire).push(accountId);
    }
    byMatch.set(Number(row.match_id), {
      [String(row.radiant_team_id)]: radiant,
      [String(row.dire_team_id)]: dire,
    });
  }

  const bySeries = new Map();
  const rows = db.prepare("SELECT series_key, map_ids_json FROM series WHERE map_ids_json IS NOT NULL").all();
  for (const row of rows) {
    const ids = parseJson(row.map_ids_json, []);
    if (!Array.isArray(ids)) continue;
    // Counted rather than merged into a set: across a best-of, the five that
    // played the most maps are the five that played the series.
    const counts = new Map();
    for (const matchId of ids) {
      const lineup = byMatch.get(Number(matchId));
      if (!lineup) continue;
      for (const [teamId, accounts] of Object.entries(lineup)) {
        const perTeam = counts.get(teamId) ?? new Map();
        for (const accountId of accounts) perTeam.set(accountId, (perTeam.get(accountId) || 0) + 1);
        counts.set(teamId, perTeam);
      }
    }
    if (!counts.size) continue;
    const fielded = {};
    for (const [teamId, perTeam] of counts) {
      fielded[teamId] = [...perTeam.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => id);
    }
    bySeries.set(row.series_key, fielded);
  }
  return bySeries;
}

/** Attach each training row's two lineups. Returns how much of it resolved. */
export function attachSeriesLineups(rows, db, { sinceSeconds = 0 } = {}) {
  const lineups = loadSeriesLineups(db, { sinceSeconds });
  const players = new Set();
  let covered = 0;
  for (const row of rows) {
    const fielded = lineups.get(row.seriesKey);
    row.lineupA = fielded?.[String(row.targetLineup)] ?? [];
    row.lineupB = fielded?.[String(row.opponentLineup)] ?? [];
    for (const accountId of row.lineupA) players.add(accountId);
    for (const accountId of row.lineupB) players.add(accountId);
    if (row.lineupA.length && row.lineupB.length) covered += 1;
  }
  return { covered, total: rows.length, players: players.size };
}

/**
 * Fit players and teams together.
 *
 * Both sides of a series get the same error term spread across their five. That
 * is deliberate: within one series there is nothing in the data that says which
 * of the five was responsible, and splitting the credit by kills or farm would
 * be inventing a signal the design cannot identify. Players separate only
 * because they appear in different combinations across thousands of series —
 * which is also why a player who moves between teams carries his rating with
 * him.
 */
export function fitStrengthModel(rows, {
  nowSeconds = Date.now() / 1000,
  config = DEFAULT_STRENGTH_CONFIG,
} = {}) {
  const teamIndex = new Map();
  const playerIndex = new Map();
  const teamSlot = (id) => {
    const key = String(id);
    if (!teamIndex.has(key)) teamIndex.set(key, teamIndex.size);
    return teamIndex.get(key);
  };
  const playerSlot = (id) => {
    const key = Number(id);
    if (!playerIndex.has(key)) playerIndex.set(key, playerIndex.size);
    return playerIndex.get(key);
  };

  // Laid out flat so the inner loop touches typed arrays only: an object-keyed
  // fit over nine thousand nodes is an order of magnitude slower.
  const prepared = rows.map((row) => {
    const sideA = (row.lineupA ?? []).map(playerSlot);
    const sideB = (row.lineupB ?? []).map(playerSlot);
    const decay = 0.5 ** (((nowSeconds - row.startTime) / DAY) / config.halfLifeDays);
    const information = row.seriesInformation ?? seriesInformation(row.wins, row.losses);
    return {
      teamA: teamSlot(row.targetLineup),
      teamB: teamSlot(row.opponentLineup),
      sideA: Int32Array.from(sideA),
      sideB: Int32Array.from(sideB),
      // A missing slot is imputed at the side's own average rather than summed
      // short, so a partial lineup is not silently penalised.
      scaleA: sideA.length ? 5 / sideA.length : 0,
      scaleB: sideB.length ? 5 / sideB.length : 0,
      target: row.targetScore,
      // Two weights, one row. The organisation term takes the tier discount;
      // the players keep nearly full credit, because the only thing a low-tier
      // result is good for is knowing who a player is when he moves up.
      teamWeight: (row.tierWeight ?? 1) * information * decay,
      playerWeight: (row.playerTierWeight ?? 1) * information * decay,
    };
  });

  const teams = new Float64Array(teamIndex.size);
  const players = new Float64Array(playerIndex.size);
  const teamGradient = new Float64Array(teamIndex.size);
  const playerGradient = new Float64Array(playerIndex.size);

  for (let iteration = 0; iteration < config.iterations; iteration += 1) {
    for (let index = 0; index < teams.length; index += 1) teamGradient[index] = -config.teamL2 * teams[index];
    for (let index = 0; index < players.length; index += 1) playerGradient[index] = -config.playerL2 * players[index];

    for (const game of prepared) {
      let sumA = 0;
      for (let index = 0; index < game.sideA.length; index += 1) sumA += players[game.sideA[index]];
      let sumB = 0;
      for (let index = 0; index < game.sideB.length; index += 1) sumB += players[game.sideB[index]];

      const delta = (teams[game.teamA] - teams[game.teamB]) + sumA * game.scaleA - sumB * game.scaleB;
      const error = game.target - sigmoid(delta);

      const teamError = game.teamWeight * error;
      teamGradient[game.teamA] += teamError;
      teamGradient[game.teamB] -= teamError;

      const playerErrorA = game.playerWeight * error * game.scaleA;
      const playerErrorB = game.playerWeight * error * game.scaleB;
      for (let index = 0; index < game.sideA.length; index += 1) playerGradient[game.sideA[index]] += playerErrorA;
      for (let index = 0; index < game.sideB.length; index += 1) playerGradient[game.sideB[index]] -= playerErrorB;
    }

    const rate = config.learningRate / Math.sqrt(1 + iteration / 120);
    for (let index = 0; index < teams.length; index += 1) teams[index] += rate * teamGradient[index];
    for (let index = 0; index < players.length; index += 1) players[index] += rate * playerGradient[index];
  }

  // How much evidence stands behind each node, in the same units the fit used.
  const teamWeightTotals = new Float64Array(teamIndex.size);
  const playerWeightTotals = new Float64Array(playerIndex.size);
  for (const game of prepared) {
    teamWeightTotals[game.teamA] += game.teamWeight;
    teamWeightTotals[game.teamB] += game.teamWeight;
    for (let index = 0; index < game.sideA.length; index += 1) playerWeightTotals[game.sideA[index]] += game.playerWeight;
    for (let index = 0; index < game.sideB.length; index += 1) playerWeightTotals[game.sideB[index]] += game.playerWeight;
  }

  const teamRating = (teamId) => teams[teamIndex.get(String(teamId)) ?? -1] ?? 0;
  const playerRating = (accountId) => players[playerIndex.get(Number(accountId)) ?? -1] ?? 0;

  /** A side's strength: its five, plus whatever the organisation adds. */
  const strength = (teamId, five = []) => {
    const known = five.filter((accountId) => playerIndex.has(Number(accountId)));
    const sum = known.reduce((total, accountId) => total + playerRating(accountId), 0);
    return teamRating(teamId) + (known.length ? sum * (5 / known.length) : 0);
  };

  return {
    teamIndex,
    playerIndex,
    teams,
    players,
    teamRating,
    playerRating,
    strength,
    teamWeight: (teamId) => teamWeightTotals[teamIndex.get(String(teamId)) ?? -1] ?? 0,
    playerWeight: (accountId) => playerWeightTotals[playerIndex.get(Number(accountId)) ?? -1] ?? 0,
    diagnostics: { teams: teamIndex.size, players: playerIndex.size, rows: prepared.length },
  };
}

/**
 * The five a team is expected to field, as of a moment in time.
 *
 * `beforeSeconds` is what keeps an evaluation honest: asked for a date, it uses
 * only series that had already been played then, so a walk-forward test cannot
 * see the roster that a match it is about to predict will reveal.
 */
export function currentFives(db, { beforeSeconds = null, recentSeries = 5, lineups = null } = {}) {
  const rows = db.prepare(`SELECT series_key, team_a_id, team_b_id, start_time FROM series
                           WHERE status = 'finished' AND start_time <= ?
                           ORDER BY start_time DESC`)
    .all(beforeSeconds == null ? Number.MAX_SAFE_INTEGER : Math.floor(beforeSeconds));

  // Hoistable: an evaluation asks for the rosters as of several dates, and
  // re-reading every map for each of them would dominate its cost.
  const fielded5 = lineups ?? loadSeriesLineups(db);
  const seen = new Map();
  for (const row of rows) {
    const fielded = fielded5.get(row.series_key);
    if (!fielded) continue;
    for (const teamId of [row.team_a_id, row.team_b_id]) {
      const key = String(teamId);
      const entry = seen.get(key) ?? { counts: new Map(), sampled: 0, lastSeen: null };
      if (entry.sampled >= recentSeries) continue;
      const five = fielded[key];
      if (!five?.length) continue;
      for (const accountId of five) entry.counts.set(accountId, (entry.counts.get(accountId) || 0) + 1);
      entry.sampled += 1;
      entry.lastSeen ??= Number(row.start_time);
      seen.set(key, entry);
    }
  }

  const result = new Map();
  for (const [teamId, entry] of seen) {
    if (!entry.sampled) continue;
    const five = [...entry.counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (!five.length) continue;
    // How settled the roster is: five players who appeared in every one of the
    // sampled series score 1, a side with a stand-in scores less.
    const agreement = five.reduce((sum, [, count]) => sum + count, 0) / (5 * entry.sampled);
    result.set(teamId, {
      players: five.map(([accountId]) => accountId),
      seriesSampled: entry.sampled,
      agreement: Math.min(1, agreement),
      lastSeen: entry.lastSeen,
    });
  }
  return result;
}
