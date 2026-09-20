// Generic tournament outlook. OpenDota publishes results, never brackets, so
// the structure is inferred from what has actually been played and every
// forecast carries the confidence that inference deserves. Nothing here knows
// about any specific event.
import { ratingPairProbability } from "./ratings.mjs";
import { bestOfProbability } from "../team-model.mjs";
import { resolveFormat } from "./declared-format.mjs";

const DAY = 86_400;
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

/** Standings and structural signals for one league, straight from stored series. */
export function analyzeTournament(db, leagueId, { declaredFormat = undefined } = {}) {
  const series = db.prepare(`SELECT * FROM series WHERE league_id = ? ORDER BY start_time ASC`).all(leagueId);
  const finished = series.filter((row) => row.status === "finished" && row.winner_id);
  const pending = series.filter((row) => row.status !== "finished");

  const teams = new Map();
  const ensure = (teamId) => {
    const key = String(teamId);
    if (!teams.has(key)) {
      teams.set(key, { teamId: key, seriesWins: 0, seriesLosses: 0, mapWins: 0, mapLosses: 0, opponents: new Set(), lastSeriesAt: 0, firstSeriesAt: Infinity });
    }
    return teams.get(key);
  };

  for (const row of finished) {
    const a = ensure(row.team_a_id);
    const b = ensure(row.team_b_id);
    const winner = String(row.winner_id) === String(row.team_a_id) ? a : b;
    const loser = winner === a ? b : a;
    winner.seriesWins += 1;
    loser.seriesLosses += 1;
    a.mapWins += Number(row.score_a || 0); a.mapLosses += Number(row.score_b || 0);
    b.mapWins += Number(row.score_b || 0); b.mapLosses += Number(row.score_a || 0);
    a.opponents.add(b.teamId); b.opponents.add(a.teamId);
    for (const team of [a, b]) {
      team.lastSeriesAt = Math.max(team.lastSeriesAt, Number(row.end_time || row.start_time || 0));
      team.firstSeriesAt = Math.min(team.firstSeriesAt, Number(row.start_time || 0));
    }
  }
  for (const row of pending) { ensure(row.team_a_id); ensure(row.team_b_id); }

  const names = new Map(db.prepare("SELECT team_id, name, tag, logo_url FROM teams").all()
    .map((row) => [String(row.team_id), { name: row.name || row.tag || `Team ${row.team_id}`, logoUrl: row.logo_url }]));

  const latestSeriesAt = finished.length ? Math.max(...finished.map((row) => Number(row.end_time || row.start_time || 0))) : 0;
  // A team that stopped playing while others kept going is out. The grace
  // window keeps a team alive through a normal overnight break.
  const idleGrace = Math.max(DAY, Number(process.env.FORMAT_IDLE_GRACE_HOURS || 30) * 3600);
  const list = [...teams.values()].map((team) => {
    const idle = latestSeriesAt - team.lastSeriesAt;
    const stoppedPlaying = team.lastSeriesAt > 0 && idle > idleGrace;
    const hasPending = pending.some((row) => String(row.team_a_id) === team.teamId || String(row.team_b_id) === team.teamId);
    return {
      ...team,
      opponents: [...team.opponents],
      name: names.get(team.teamId)?.name ?? `Team ${team.teamId}`,
      logoUrl: names.get(team.teamId)?.logoUrl ?? null,
      firstSeriesAt: Number.isFinite(team.firstSeriesAt) ? team.firstSeriesAt : null,
      stoppedPlaying: stoppedPlaying && !hasPending,
    };
  }).sort((a, b) => b.seriesWins - a.seriesWins || a.seriesLosses - b.seriesLosses || b.mapWins - a.mapWins);

  // Losses carried by teams that are out: that is the elimination threshold.
  const eliminatedLossCounts = list.filter((team) => team.stoppedPlaying && team.seriesLosses > 0).map((team) => team.seriesLosses);
  const histogram = new Map();
  for (const count of eliminatedLossCounts) histogram.set(count, (histogram.get(count) || 0) + 1);
  const modalLosses = [...histogram.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;

  const teamCount = list.length;
  const playedPairs = new Set(finished.map((row) => [row.team_a_id, row.team_b_id].sort().join("-")));
  const possiblePairs = teamCount > 1 ? (teamCount * (teamCount - 1)) / 2 : 1;
  const pairDensity = playedPairs.size / possiblePairs;
  const seriesPerTeam = teamCount ? (2 * finished.length) / teamCount : 0;

  let type = "unknown";
  let confidence = "low";
  if (finished.length < 4 || teamCount < 3) {
    type = "too_early";
  } else if (modalLosses === 1 && pairDensity < 0.45) {
    type = "single_elimination";
    confidence = eliminatedLossCounts.length >= 3 ? "medium" : "low";
  } else if (modalLosses === 2 && pairDensity < 0.5) {
    type = "double_elimination";
    confidence = eliminatedLossCounts.length >= 3 ? "medium" : "low";
  } else if (pairDensity >= 0.6) {
    type = "round_robin";
    confidence = "medium";
  } else if (seriesPerTeam >= 3 && (modalLosses === null || modalLosses >= 3)) {
    type = "group_stage";
    confidence = "low";
  } else if (modalLosses != null) {
    type = modalLosses <= 1 ? "single_elimination" : "double_elimination";
  }

  const eliminationThreshold = type === "single_elimination" ? 1
    : type === "double_elimination" ? 2
      : modalLosses && modalLosses >= 1 ? modalLosses : null;

  // Prefer what the organiser published over what the results imply. Reading
  // the format off loss counts is a fallback, and one that looks just as
  // confident as knowing.
  let declared = declaredFormat;
  if (declared === undefined) {
    const row = db.prepare("SELECT format_json FROM tournaments WHERE league_id = ?").get(leagueId);
    try { declared = row?.format_json ? JSON.parse(row.format_json) : null; } catch { declared = null; }
  }

  return {
    leagueId,
    teams: list,
    finishedSeries: finished.length,
    pendingSeries: pending.map((row) => ({
      seriesKey: row.series_key, teamA: String(row.team_a_id), teamB: String(row.team_b_id),
      bestOf: Number(row.best_of) || 3, startTime: Number(row.start_time) || null,
    })),
    format: resolveFormat(declared, {
      type, confidence, eliminationThreshold,
      teamCount, pairDensity: Number(pairDensity.toFixed(3)),
      seriesPerTeam: Number(seriesPerTeam.toFixed(2)),
      eliminatedTeams: eliminatedLossCounts.length,
      latestSeriesAt, modalEliminationLosses: modalLosses,
    }),
  };
}

/**
 * Monte-Carlo the rest of the event.
 *
 * Known-but-unfinished series are played first at their real best-of. After
 * that the survivors are resolved as a knockout at the inferred elimination
 * threshold: teams are paired at random each round and a loss counts toward
 * their budget. Random pairing is not the real bracket, so seeding effects are
 * averaged out rather than modelled — the format confidence says so.
 */
export function simulateTournament(analysis, ratingsArtifact, {
  iterations = 20_000,
  seed = 12345,
  defaultBestOf = 3,
} = {}) {
  const { teams, format, pendingSeries } = analysis;
  const alive = teams.filter((team) => !team.stoppedPlaying);
  // With no detectable structure, assume a double-elimination style budget: it
  // is the most common Dota playoff shape and the least opinionated guess.
  const threshold = Math.max(1, format.eliminationThreshold ?? 2);

  if (alive.length < 2) {
    const champion = alive[0] ?? teams[0] ?? null;
    return {
      iterations: 0,
      format,
      confidence: "resolved",
      teams: teams.map((team) => ({
        teamId: team.teamId, name: team.name,
        champion: champion && team.teamId === champion.teamId ? 100 : 0,
        final: champion && team.teamId === champion.teamId ? 100 : 0,
        top4: champion && team.teamId === champion.teamId ? 100 : 0,
        eliminated: team.stoppedPlaying,
      })),
    };
  }

  // Map-level probability for every pair, computed once.
  const pairCache = new Map();
  const mapProbability = (a, b) => {
    const key = `${a}|${b}`;
    if (pairCache.has(key)) return pairCache.get(key);
    const value = ratingPairProbability(ratingsArtifact, a, b).mapProbabilityA;
    pairCache.set(key, value);
    pairCache.set(`${b}|${a}`, 1 - value);
    return value;
  };
  const seriesProbability = (a, b, bestOf) => clamp(bestOfProbability(mapProbability(a, b), bestOf || defaultBestOf), 0.02, 0.98);

  const random = seededRandom(seed);
  const totals = new Map(teams.map((team) => [team.teamId, { champion: 0, final: 0, top4: 0 }]));
  const aliveIds = alive.map((team) => team.teamId);
  const aliveById = new Map(alive.map((team) => [team.teamId, team]));
  const rating = (teamId) => Number(ratingsArtifact?.ratings?.[String(teamId)]?.rating ?? 0);

  // How many teams reach the playoffs, and how many rounds the group stage
  // needs to separate them. A Swiss field of N is normally resolved in about
  // log2(N)+1 rounds, which is what real formats use.
  const playoffSlots = Number(format.playoffSlots) || null;
  const groupRounds = Math.ceil(Math.log2(Math.max(2, format.teamCount || alive.length))) + 1;
  // A team that is still playing cannot already be out, whatever its record
  // says about a threshold we only guessed. Its losses are capped one short of
  // elimination so past defeats still cost it, but never remove it up front.
  const baseLosses = new Map(alive.map((team) => [team.teamId, Math.min(team.seriesLosses, threshold - 1)]));

  const shuffle = (items) => {
    for (let index = items.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      [items[index], items[swap]] = [items[swap], items[index]];
    }
    return items;
  };

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const losses = new Map(baseLosses);

    // 1. Resolve the series we actually know about.
    for (const pending of pendingSeries) {
      if (!losses.has(pending.teamA) || !losses.has(pending.teamB)) continue;
      const probabilityA = seriesProbability(pending.teamA, pending.teamB, pending.bestOf);
      const loser = random() < probabilityA ? pending.teamB : pending.teamA;
      losses.set(loser, (losses.get(loser) || 0) + 1);
    }
    let remaining = aliveIds.filter((teamId) => (losses.get(teamId) || 0) < threshold);
    if (remaining.length < 2) remaining = [...aliveIds];

    // 2. Group stage, when the organiser said how many teams leave it.
    //    Without this the simulation eliminates straight from the full field,
    //    which is the wrong shape entirely: a team can lose twice in a Swiss
    //    and still reach the playoffs.
    if (playoffSlots && remaining.length > playoffSlots) {
      const record = new Map(remaining.map((teamId) => {
        const team = aliveById.get(teamId);
        return [teamId, { wins: team.seriesWins, losses: team.seriesLosses }];
      }));
      for (let round = 0; round < groupRounds * 2; round += 1) {
        const pending = [...record.entries()]
          .filter(([, value]) => value.wins + value.losses < groupRounds)
          .map(([teamId]) => teamId);
        if (pending.length < 2) break;
        const order = shuffle(pending);
        for (let index = 0; index + 1 < order.length; index += 2) {
          const [a, b] = [order[index], order[index + 1]];
          const winner = random() < seriesProbability(a, b, defaultBestOf) ? a : b;
          const loser = winner === a ? b : a;
          record.get(winner).wins += 1;
          record.get(loser).losses += 1;
        }
      }
      remaining = [...record.entries()]
        .sort(([leftId, left], [rightId, right]) =>
          (right.wins - right.losses) - (left.wins - left.losses)
          || right.wins - left.wins
          || rating(rightId) - rating(leftId))
        .slice(0, playoffSlots)
        .map(([teamId]) => teamId);
      // The playoff bracket starts clean: group losses do not carry into it.
      for (const teamId of remaining) losses.set(teamId, 0);
    }

    // 3. Knock the rest out at the elimination budget. Each round pairs the
    //    survivors at random; an odd team out gets a bye.
    let countedTop4 = false;
    let countedFinal = false;
    for (let round = 0; round < 48 && remaining.length > 1; round += 1) {
      if (!countedTop4 && remaining.length <= 4) {
        for (const teamId of remaining) totals.get(teamId).top4 += 1;
        countedTop4 = true;
      }
      if (!countedFinal && remaining.length <= 2) {
        for (const teamId of remaining) totals.get(teamId).final += 1;
        countedFinal = true;
      }
      const order = shuffle([...remaining]);
      const decisive = remaining.length <= 2;
      for (let index = 0; index + 1 < order.length; index += 2) {
        const [a, b] = [order[index], order[index + 1]];
        const probabilityA = seriesProbability(a, b, decisive ? 5 : defaultBestOf);
        const loser = random() < probabilityA ? b : a;
        losses.set(loser, (losses.get(loser) || 0) + 1);
      }
      remaining = order.filter((teamId) => (losses.get(teamId) || 0) < threshold);
    }
    const champion = remaining[0] ?? aliveIds[0];
    if (totals.has(champion)) {
      totals.get(champion).champion += 1;
      if (!countedFinal) totals.get(champion).final += 1;
      if (!countedTop4) totals.get(champion).top4 += 1;
    }
  }

  const rows = teams.map((team) => {
    const total = totals.get(team.teamId) ?? { champion: 0, final: 0, top4: 0 };
    return {
      teamId: team.teamId,
      name: team.name,
      logoUrl: team.logoUrl ?? null,
      seriesWins: team.seriesWins,
      seriesLosses: team.seriesLosses,
      mapWins: team.mapWins,
      mapLosses: team.mapLosses,
      eliminated: team.stoppedPlaying,
      champion: 100 * total.champion / iterations,
      final: 100 * Math.max(total.final, total.champion) / iterations,
      top4: 100 * Math.max(total.top4, total.final, total.champion) / iterations,
    };
  }).sort((a, b) => b.champion - a.champion || b.seriesWins - a.seriesWins);

  return {
    iterations,
    seed,
    // Report the budget the simulation actually used, not the one we failed to detect.
    format: { ...format, eliminationThresholdUsed: threshold, thresholdInferred: format.eliminationThreshold != null },
    confidence: format.confidence,
    method: "random_pairing_knockout_with_known_schedule",
    caveat: format.declared
      ? `Формат взят у организатора${format.shape ? ` (${format.shape})` : ""}. Посев внутри сетки неизвестен, поэтому пары усредняются по случайным жеребьёвкам.`
      : format.eliminationThreshold == null
        ? "Формат турнира не удалось определить по результатам: считаем как double elimination, пары усредняются по случайным жеребьёвкам."
        : "Формат восстановлен по результатам, а не взят у организатора. Сетка и посев неизвестны — пары усредняются по случайным жеребьёвкам.",
    teams: rows,
  };
}
