// A picture of how the tournament is expected to go: the group table as it is
// likely to finish, and the playoff bracket with its empty slots filled in.
//
// This is deliberately not scored. Only the per-match predictions frozen before
// a game starts are graded; a projected bracket is a view of the same model's
// beliefs, and grading it would count one belief many times over.
import { nowIso } from "../core/db.mjs";
import { analyzeTournament } from "../core/format.mjs";
import { loadRatings, ratingPairProbability } from "../core/ratings.mjs";
import { bestOfProbability } from "../team-model.mjs";
import { buildTopology, playBracket } from "../core/bracket-topology.mjs";

const ITERATIONS = Math.max(1000, Number(process.env.PROJECTION_ITERATIONS || 8000));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** The bracket as stored, rebuilt into the shape the topology builder wants. */
export function storedBracket(db, leagueId) {
  const rows = db.prepare(`SELECT slot, stage, lane, best_of, start_time, team_a_id, team_b_id,
                                  team_a_name, team_b_name, winner_slot, series_key
                           FROM scheduled_matches
                           WHERE league_id = ? AND slot IS NOT NULL AND lane IN ('upper','lower','final')
                           ORDER BY COALESCE(start_time, 0) ASC`).all(leagueId);
  if (!rows.length) return null;

  const sections = [];
  for (const row of rows) {
    const name = row.stage || row.slot;
    let section = sections.find((entry) => entry.name === name);
    if (!section) { section = { name, lane: row.lane, matches: [] }; sections.push(section); }
    section.matches.push({
      slot: row.slot,
      bestOf: row.best_of,
      startTime: row.start_time ? new Date(row.start_time * 1000).toISOString() : null,
      teamAId: row.team_a_id,
      teamBId: row.team_b_id,
      teamA: row.team_a_name,
      teamB: row.team_b_name,
      winner: row.winner_slot,
      // Carried so a drawn match can be clicked through to its explanation.
      seriesKey: row.series_key,
    });
  }
  return { type: null, sections, matches: rows };
}


/**
 * Seed order that keeps the strongest apart: 1v8, 4v5, 2v7, 3v6.
 * The top two can only meet in the final, which is how a bracket is drawn.
 */
export function bracketSeedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const doubled = order.length * 2;
    order = order.flatMap((seed) => [seed, doubled + 1 - seed]);
  }
  return order.slice(0, size);
}

/**
 * One concrete bracket rather than per-slot averages.
 *
 * Averaging over unknown seedings puts the same two favourites in every
 * quarter-final at 25% each, which says nothing. Seeding the expected standings
 * and playing that through gives a bracket that can actually be read, and each
 * match still carries the probability behind it.
 */
function projectMostLikelyBracket({ topology, bracket, standings, names, seriesProbability, slotCounts, iterations }) {
  const actualBySlot = new Map(bracket.sections.flatMap((section) => section.matches).map((match) => [match.slot, match]));
  const seedOrder = bracketSeedOrder(topology.seeds);
  const qualifiers = standings.slice(0, topology.seeds);
  const seeded = seedOrder.map((seed) => qualifiers[seed - 1]?.id ?? null);

  const winners = new Map();
  const losers = new Map();
  const rows = [];
  let seedIndex = 0;

  for (const node of topology.nodes) {
    const actual = actualBySlot.get(node.slot);
    const known = Boolean(actual?.teamAId && actual?.teamBId);

    let sides;
    if (known) {
      sides = [String(actual.teamAId), String(actual.teamBId)];
    } else {
      sides = node.sources.map((source) => {
        if (source.from === "seed") return seeded[seedIndex++] ?? null;
        return source.from === "winner" ? winners.get(source.slot) ?? null : losers.get(source.slot) ?? null;
      });
    }
    if (node.sources.some((source) => source.from === "seed") && known) {
      // A decided slot still consumes its seeds so later rounds line up.
      seedIndex += node.sources.filter((source) => source.from === "seed").length;
    }

    const [a, b] = sides;
    let winner = null;
    let probabilityA = null;
    if (a && b) {
      probabilityA = seriesProbability(a, b, node.bestOf ?? 3);
      // A played match has a real result; only an unplayed one is predicted.
      winner = actual?.winner === 1 ? a : actual?.winner === 2 ? b : (probabilityA >= 0.5 ? a : b);
      winners.set(node.slot, winner);
      losers.set(node.slot, winner === a ? b : a);
    }

    const counts = slotCounts.get(node.slot);
    const reach = (teamId) => (counts?.teams.get(teamId) ? 100 * counts.teams.get(teamId) / iterations : null);

    rows.push({
      slot: node.slot,
      lane: node.lane,
      column: node.column,
      section: node.section,
      // The wiring travels with the row: without it the page has no way to draw
      // a line from one match to the next, which is what makes it a bracket.
      sources: node.sources,
      seriesKey: actual?.seriesKey ?? null,
      bestOf: node.bestOf,
      startTime: actual?.startTime ? Math.floor(Date.parse(actual.startTime) / 1000) : null,
      decided: Boolean(actual?.winner),
      known,
      teamA: a ? { ...names.get(a), reachChance: reach(a) } : null,
      teamB: b ? { ...names.get(b), reachChance: reach(b) } : null,
      probabilityA,
      winner: winner ? names.get(winner) : null,
    });
  }
  return rows;
}

/**
 * Project the whole tournament: who finishes where in the group stage, and who
 * is expected in each bracket slot.
 */
export function projectTournament(db, leagueId, { iterations = ITERATIONS } = {}) {
  const ratings = loadRatings();
  if (!ratings) return null;

  const analysis = analyzeTournament(db, leagueId);
  const bracket = storedBracket(db, leagueId);
  const topology = bracket ? buildTopology(bracket) : null;

  const alive = analysis.teams.filter((team) => !team.stoppedPlaying);
  if (alive.length < 2) return null;

  const names = new Map(analysis.teams.map((team) => [team.teamId, { id: team.teamId, name: team.name, logoUrl: team.logoUrl }]));
  const pairCache = new Map();
  const mapProbability = (a, b) => {
    const key = `${a}|${b}`;
    if (pairCache.has(key)) return pairCache.get(key);
    const value = ratingPairProbability(ratings, a, b).mapProbabilityA;
    pairCache.set(key, value);
    pairCache.set(`${b}|${a}`, 1 - value);
    return value;
  };
  const seriesProbability = (a, b, bestOf) => clamp(bestOfProbability(mapProbability(a, b), bestOf || 3), 0.02, 0.98);

  const random = seededRandom((leagueId * 2654435761) >>> 0);
  const shuffle = (items) => {
    for (let index = items.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      [items[index], items[swap]] = [items[swap], items[index]];
    }
    return items;
  };

  const slots = Number(analysis.format.playoffSlots) || topology?.seeds || Math.min(8, alive.length);
  const groupRounds = Math.ceil(Math.log2(Math.max(2, analysis.format.teamCount || alive.length))) + 1;

  // Group standings: how often each team finishes in each position.
  const placements = new Map(alive.map((team) => [team.teamId, new Array(alive.length).fill(0)]));
  const qualified = new Map(alive.map((team) => [team.teamId, 0]));
  // Bracket: how often each team appears in each slot, and wins there.
  const slotCounts = new Map();

  const rating = (teamId) => Number(ratings.ratings?.[String(teamId)]?.rating ?? 0);

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const record = new Map(alive.map((team) => [team.teamId, { wins: team.seriesWins, losses: team.seriesLosses }]));

    for (const pending of analysis.pendingSeries) {
      if (!record.has(pending.teamA) || !record.has(pending.teamB)) continue;
      const winner = random() < seriesProbability(pending.teamA, pending.teamB, pending.bestOf) ? pending.teamA : pending.teamB;
      const loser = winner === pending.teamA ? pending.teamB : pending.teamA;
      record.get(winner).wins += 1;
      record.get(loser).losses += 1;
    }

    for (let round = 0; round < groupRounds * 2; round += 1) {
      const waiting = [...record.entries()]
        .filter(([, value]) => value.wins + value.losses < groupRounds)
        .map(([teamId]) => teamId);
      if (waiting.length < 2) break;
      const order = shuffle(waiting);
      for (let index = 0; index + 1 < order.length; index += 2) {
        const [a, b] = [order[index], order[index + 1]];
        const winner = random() < seriesProbability(a, b, 3) ? a : b;
        const loser = winner === a ? b : a;
        record.get(winner).wins += 1;
        record.get(loser).losses += 1;
      }
    }

    const table = [...record.entries()].sort(([leftId, left], [rightId, right]) =>
      (right.wins - right.losses) - (left.wins - left.losses)
      || right.wins - left.wins
      || rating(rightId) - rating(leftId));

    table.forEach(([teamId], position) => {
      placements.get(teamId)[position] += 1;
      if (position < slots) qualified.set(teamId, qualified.get(teamId) + 1);
    });

    if (!topology) continue;
    // Seeding inside the bracket is not published, so the qualifiers are drawn
    // at random; over many runs that averages the draw out rather than
    // pretending to know it.
    const seeds = shuffle(table.slice(0, topology.seeds).map(([teamId]) => teamId));
    const played = playBracket(topology, seeds, (a, b, bestOf) =>
      (random() < seriesProbability(a, b, bestOf) ? a : b));

    for (const [slot, sides] of played.entrants) {
      const entry = slotCounts.get(slot) ?? { teams: new Map(), winners: new Map() };
      for (const teamId of sides) {
        if (!teamId) continue;
        entry.teams.set(teamId, (entry.teams.get(teamId) || 0) + 1);
      }
      const winner = played.winners.get(slot);
      if (winner) entry.winners.set(winner, (entry.winners.get(winner) || 0) + 1);
      slotCounts.set(slot, entry);
    }
  }

  const standings = alive.map((team) => {
    const counts = placements.get(team.teamId);
    const expected = counts.reduce((sum, value, position) => sum + value * (position + 1), 0) / iterations;
    return {
      ...names.get(team.teamId),
      seriesWins: team.seriesWins,
      seriesLosses: team.seriesLosses,
      expectedPlace: expected,
      qualifyChance: 100 * qualified.get(team.teamId) / iterations,
    };
  }).sort((a, b) => a.expectedPlace - b.expectedPlace);

  const bracketSlots = topology
    ? projectMostLikelyBracket({ topology, bracket, standings, names, seriesProbability, slotCounts, iterations })
    : [];

  return {
    generatedAt: nowIso(),
    iterations,
    ratingsModelId: ratings.modelId,
    playoffSlots: slots,
    groupRounds,
    standings,
    bracket: bracketSlots,
    columns: topology?.columns ?? 0,
    // Said out loud on the page: this is a view, not a scored prediction.
    note: "Проекция показывает ожидаемое развитие турнира. Оценивается точность только тех прогнозов, что зафиксированы до начала конкретного матча.",
  };
}
