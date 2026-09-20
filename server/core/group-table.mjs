// The group stage as a table: one row per team, one cell per round.
//
// A standings list says who is ahead. A group table says why — who each team
// played, in what order, and how it went. That is the thing a reader actually
// scans, and it is the shape every tournament site settles on.
//
// Two honesty rules run through this file. A played cell shows only what
// happened and the number the model committed to beforehand — never a
// probability recomputed now, which would be hindsight dressed as foresight.
// And the round number is used only when the organiser published it; when it is
// inferred the column is labelled differently, because a team with a bye breaks
// the inference and the table must not claim otherwise.
import { predictSeries } from "./predictions.mjs";
import { analyzeTournament } from "./format.mjs";

const PLAYOFF_LANES = new Set(["upper", "lower", "final"]);

/**
 * Which stage each played series belonged to.
 *
 * `series.stage` was never populated by the results feed, so this is resolved
 * from the schedule where possible and from the calendar where not. The route
 * taken is reported, so a page can say how confident the split is.
 */
export function seriesStages(db, leagueId) {
  const byKey = new Map();

  // The schedule knows: a series linked to a bracket slot is a playoff series,
  // one linked to a group fixture is not.
  const linked = db.prepare(`SELECT series_key, lane FROM scheduled_matches
                             WHERE league_id = ? AND series_key IS NOT NULL`).all(leagueId);
  for (const row of linked) {
    byKey.set(row.series_key, PLAYOFF_LANES.has(row.lane) ? "playoff" : "group");
  }

  const stored = db.prepare(`SELECT series_key, stage, start_time FROM series
                             WHERE league_id = ? ORDER BY start_time ASC`).all(leagueId);
  for (const row of stored) {
    if (byKey.has(row.series_key)) continue;
    if (row.stage === "group" || row.stage === "playoff") byKey.set(row.series_key, row.stage);
  }

  // Everything else falls to the calendar: the bracket starts on a known day,
  // and a series at or after it is a playoff series even if nobody linked it.
  const playoffFrom = db.prepare(`SELECT MIN(start_time) AS from_time FROM scheduled_matches
                                  WHERE league_id = ? AND lane IN ('upper','lower','final')
                                    AND start_time IS NOT NULL`).get(leagueId)?.from_time ?? null;

  for (const row of stored) {
    if (byKey.has(row.series_key)) continue;
    byKey.set(row.series_key, playoffFrom && Number(row.start_time) >= Number(playoffFrom) ? "playoff" : "group");
  }

  const source = linked.length ? "schedule_link"
    : playoffFrom ? "bracket_start_time"
      : "no_bracket_published";
  return { byKey, source, playoffFrom };
}

const teamIndex = (db, ids) => {
  if (!ids.size) return new Map();
  const placeholders = [...ids].map(() => "?").join(",");
  const rows = db.prepare(`SELECT team_id, name, logo_url FROM teams WHERE team_id IN (${placeholders})`)
    .all(...ids);
  return new Map(rows.map((row) => [Number(row.team_id), {
    id: String(row.team_id), name: row.name || `Команда ${row.team_id}`, logoUrl: row.logo_url ?? null,
  }]));
};

const pairKey = (a, b) => [Number(a), Number(b)].sort((left, right) => left - right).join("|");

/**
 * Group fixtures, each with the series that played it when there is one.
 *
 * A schedule row and a played series are two views of the same match, so they
 * are merged rather than listed twice. A rescheduled fixture leaves a second
 * schedule row behind — its key carries the old time — so identical pairs
 * within a round collapse, keeping the one that reached a result.
 */
function loadFixtures(db, leagueId, stages) {
  const scheduled = db.prepare(`SELECT * FROM scheduled_matches
                                WHERE league_id = ? AND (lane = 'group' OR lane IS NULL)
                                ORDER BY COALESCE(start_time, 0) ASC`).all(leagueId);
  const series = db.prepare("SELECT * FROM series WHERE league_id = ?").all(leagueId);
  const seriesByKey = new Map(series.map((row) => [row.series_key, row]));

  const fixtures = [];
  const claimed = new Set();
  const seenPairs = new Map();

  const push = (fixture) => {
    // Same two teams, same round: one match, however many rows describe it.
    const key = `${fixture.round ?? "?"}|${pairKey(fixture.teamAId, fixture.teamBId)}`;
    const existing = seenPairs.get(key);
    if (existing) {
      if (!existing.series && fixture.series) Object.assign(existing, fixture);
      return;
    }
    seenPairs.set(key, fixture);
    fixtures.push(fixture);
  };

  for (const row of scheduled) {
    if (!row.team_a_id || !row.team_b_id) continue; // a cell with no team is not a cell
    const played = row.series_key ? seriesByKey.get(row.series_key) ?? null : null;
    if (played) claimed.add(played.series_key);
    push({
      round: row.round ?? null,
      startTime: played?.start_time ?? row.start_time ?? null,
      teamAId: Number(row.team_a_id),
      teamBId: Number(row.team_b_id),
      bestOf: played?.best_of ?? row.best_of ?? null,
      externalKey: row.external_key,
      seriesKey: played?.series_key ?? null,
      series: played,
    });
  }

  // A league with no published schedule still gets a full table: every group
  // series we recorded ourselves is a fixture in its own right.
  for (const row of series) {
    if (claimed.has(row.series_key)) continue;
    if (stages.byKey.get(row.series_key) !== "group") continue;
    if (!row.team_a_id || !row.team_b_id) continue;
    push({
      round: null,
      startTime: row.start_time ?? null,
      teamAId: Number(row.team_a_id),
      teamBId: Number(row.team_b_id),
      bestOf: row.best_of ?? null,
      externalKey: null,
      seriesKey: row.series_key,
      series: row,
    });
  }

  return fixtures;
}

/** Predictions frozen for this league, by whatever key they were written under. */
function frozenProbabilities(db, leagueId) {
  const rows = db.prepare(`SELECT subject_key, side_a, probability_a FROM predictions
                           WHERE scope = 'series' AND model_kind = 'team_ratings' AND league_id = ?`)
    .all(leagueId);
  return new Map(rows.map((row) => [row.subject_key, row]));
}

const orient = (frozen, teamId) =>
  (String(frozen.side_a) === String(teamId) ? Number(frozen.probability_a) : 1 - Number(frozen.probability_a));

/**
 * Build the group table.
 *
 * `projection` only ever adds columns to the right; the order of the rows and
 * everything left of the seam is what happened.
 */
export function groupTable(db, leagueId, { projection = null, playoffSlots = null, ratings = null } = {}) {
  const stages = seriesStages(db, leagueId);
  const fixtures = loadFixtures(db, leagueId, stages)
    .filter((fixture) => !fixture.seriesKey || stages.byKey.get(fixture.seriesKey) === "group");
  if (!fixtures.length) return null;

  const ids = new Set();
  for (const fixture of fixtures) { ids.add(fixture.teamAId); ids.add(fixture.teamBId); }
  const names = teamIndex(db, ids);
  const frozen = frozenProbabilities(db, leagueId);

  // --- rounds ---------------------------------------------------------------
  const published = [...new Set(fixtures.map((fixture) => fixture.round).filter((round) => round != null))]
    .sort((a, b) => a - b);
  const byTeam = new Map([...ids].map((id) => [id, []]));
  for (const fixture of fixtures) {
    byTeam.get(fixture.teamAId).push(fixture);
    byTeam.get(fixture.teamBId).push(fixture);
  }
  for (const list of byTeam.values()) {
    list.sort((a, b) => (a.startTime ?? Infinity) - (b.startTime ?? Infinity)
      || String(a.seriesKey ?? a.externalKey ?? "").localeCompare(String(b.seriesKey ?? b.externalKey ?? "")));
  }

  const usePublished = published.length > 0;
  const hasStrays = usePublished && fixtures.some((fixture) => fixture.round == null);
  const columns = usePublished
    ? [...published.map((round) => ({ round, label: `Раунд ${round}` })), ...(hasStrays ? [{ round: null, label: "Прочие" }] : [])]
    : Array.from({ length: Math.max(...[...byTeam.values()].map((list) => list.length), 0) },
      (_, index) => ({ round: index + 1, label: `Матч ${index + 1}` }));
  const columnOf = (fixture, position) => (usePublished
    ? columns.findIndex((column) => column.round === (fixture.round ?? null))
    : position);

  // --- one row per team ------------------------------------------------------
  const memo = new Map();
  const upcomingProbability = (teamId, opponentId, bestOf) => {
    if (!ratings) return null;
    const key = `${pairKey(teamId, opponentId)}|${bestOf ?? 3}`;
    if (!memo.has(key)) {
      const prediction = predictSeries(db, { teamAId: teamId, teamBId: opponentId, bestOf: bestOf || 3, ratings });
      memo.set(key, prediction.confidence === "none" ? null : { probability: prediction.probabilityA, sideA: teamId });
    }
    const cached = memo.get(key);
    if (!cached) return null;
    return String(cached.sideA) === String(teamId) ? cached.probability : 1 - cached.probability;
  };

  const rows = [];
  for (const teamId of ids) {
    const list = byTeam.get(teamId);
    const cells = new Array(columns.length).fill(null);
    let seriesWins = 0;
    let seriesLosses = 0;
    let seriesDraws = 0;
    let mapWins = 0;
    let mapLosses = 0;

    list.forEach((fixture, position) => {
      const isA = fixture.teamAId === teamId;
      const opponentId = isA ? fixture.teamBId : fixture.teamAId;
      const played = fixture.series;
      const finished = played?.status === "finished";

      let result = null;
      let scoreFor = null;
      let scoreAgainst = null;
      if (played) {
        scoreFor = isA ? played.score_a : played.score_b;
        scoreAgainst = isA ? played.score_b : played.score_a;
        if (finished) {
          if (Number(played.is_draw) === 1) { result = "draw"; seriesDraws += 1; }
          else if (Number(played.winner_id) === teamId) { result = "win"; seriesWins += 1; }
          else { result = "loss"; seriesLosses += 1; }
          mapWins += Number(scoreFor) || 0;
          mapLosses += Number(scoreAgainst) || 0;
        }
      }

      // A frozen call is the only probability a played match may show. For one
      // still to come, the model is asked directly.
      const stored = (fixture.seriesKey && frozen.get(fixture.seriesKey))
        || (fixture.externalKey && frozen.get(`sched:${leagueId}:${fixture.externalKey}`))
        || null;
      let probability = stored ? orient(stored, teamId) : null;
      let probabilitySource = stored ? "frozen" : null;
      if (probability === null && !finished) {
        probability = upcomingProbability(teamId, opponentId, fixture.bestOf);
        probabilitySource = probability === null ? null : "model";
      }

      const index = columnOf(fixture, position);
      if (index < 0 || index >= cells.length) return;
      cells[index] = {
        round: columns[index].round,
        opponent: names.get(opponentId) ?? { id: String(opponentId), name: `Команда ${opponentId}`, logoUrl: null },
        status: finished ? "finished" : played?.status === "live" ? "live" : "scheduled",
        result,
        scoreFor: finished ? scoreFor : null,
        scoreAgainst: finished ? scoreAgainst : null,
        bestOf: fixture.bestOf,
        startTime: fixture.startTime,
        seriesKey: fixture.seriesKey,
        href: fixture.seriesKey ? `/match/${encodeURIComponent(fixture.seriesKey)}` : null,
        probability,
        probabilitySource,
      };
    });

    rows.push({
      team: names.get(teamId) ?? { id: String(teamId), name: `Команда ${teamId}`, logoUrl: null },
      seriesWins, seriesLosses, seriesDraws,
      mapWins, mapLosses, mapDiff: mapWins - mapLosses,
      played: seriesWins + seriesLosses + seriesDraws,
      cells,
    });
  }

  // Same ordering the simulation uses for its own table, so the facts and the
  // forecast never disagree about who is first. Buchholz is not available to us.
  rows.sort((a, b) => (b.seriesWins - b.seriesLosses) - (a.seriesWins - a.seriesLosses)
    || b.seriesWins - a.seriesWins
    || b.mapDiff - a.mapDiff
    || b.mapWins - a.mapWins
    || a.team.name.localeCompare(b.team.name, "ru"));

  const slots = Number(playoffSlots) || Number(analyzeTournament(db, leagueId)?.format?.playoffSlots) || null;
  const standings = new Map((projection?.standings ?? []).map((row) => [String(row.id), row]));
  rows.forEach((row, index) => {
    row.rank = index + 1;
    // Only a published cut-off may tint a row. Inventing one from the forecast
    // would colour the table with the model's opinion of itself.
    row.qualifying = slots ? index < slots : null;
    const projected = standings.get(row.team.id);
    row.qualifyChance = projected ? projected.qualifyChance : null;
    row.expectedPlace = projected ? projected.expectedPlace : null;
  });

  const roundsWithCounts = columns.map((column, index) => {
    const cells = rows.map((row) => row.cells[index]).filter(Boolean);
    return {
      ...column,
      startTime: cells.reduce((earliest, cell) => (cell.startTime && (!earliest || cell.startTime < earliest) ? cell.startTime : earliest), null),
      played: cells.filter((cell) => cell.status === "finished").length / 2,
      total: cells.length / 2,
    };
  });

  return {
    leagueId,
    source: usePublished ? "published_rounds" : "match_ordinal",
    stageSource: stages.source,
    playoffSlots: slots,
    rounds: roundsWithCounts,
    rows,
    caveat: usePublished
      ? "Номера раундов взяты у организатора. Порядок — по разнице побед, затем по разнице карт; бухгольц не считается."
      : "Организатор не публикует номера раундов, поэтому матчи пронумерованы по порядку для каждой команды —"
        + " при переносе или пропуске порядок может разойтись с официальным. Порядок в таблице — по разнице побед,"
        + " затем по разнице карт; бухгольц не считается.",
  };
}
