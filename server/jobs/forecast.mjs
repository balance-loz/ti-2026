// Tournament outlook refresh. Recomputed whenever a league's results change,
// so every tracked event always has a current champion projection on its page.
import { createHash } from "node:crypto";
import { nowIso } from "../core/db.mjs";
import { analyzeTournament, simulateTournament } from "../core/format.mjs";
import { loadRatings } from "../core/ratings.mjs";
import { freezeUpcomingSeries } from "../core/predictions.mjs";
import { projectTournament } from "./project-bracket.mjs";

const ITERATIONS = Math.max(2000, Number(process.env.FORECAST_ITERATIONS || 20_000));

// Bumped when the stored payload gains a field. The fingerprint below is made
// of data, so without this a league whose results have stopped changing would
// keep serving the old shape for ever — a finished tournament would never get
// the bracket wiring that makes its matches clickable.
const PAYLOAD_VERSION = 3;

/**
 * Everything a forecast depends on, in one fingerprint.
 *
 * A recomputation must be triggered by both kinds of new information: a result
 * arriving, and the schedule of what is still to come being published or moved.
 */
function inputHash(db, leagueId, ratingsModelId) {
  const results = db.prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(updated_at),'') AS latest,
                              COALESCE(SUM(score_a + score_b),0) AS maps FROM series WHERE league_id = ?`).get(leagueId);
  const schedule = db.prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(updated_at),'') AS latest,
                               COALESCE(SUM(COALESCE(start_time,0)),0) AS times,
                               SUM(CASE WHEN team_a_id IS NOT NULL THEN 1 ELSE 0 END) AS filled
                               FROM scheduled_matches WHERE league_id = ?`).get(leagueId);
  return createHash("sha1")
    .update([
      leagueId, PAYLOAD_VERSION, results.n, results.latest, results.maps,
      schedule.n, schedule.latest, schedule.times, schedule.filled,
      ratingsModelId ?? "none",
    ].join("|"))
    .digest("hex");
}

/** Recompute one league's outlook. Skips the Monte Carlo when nothing changed. */
export function forecastTournament(db, leagueId, { force = false, iterations = ITERATIONS } = {}) {
  const ratings = loadRatings();
  if (!ratings) return { leagueId, skipped: true, reason: "no_ratings" };

  const hash = inputHash(db, leagueId, ratings.modelId);
  const existing = db.prepare("SELECT input_hash FROM tournament_forecasts WHERE league_id = ?").get(leagueId);
  if (!force && existing?.input_hash === hash) return { leagueId, skipped: true, reason: "unchanged" };

  freezeUpcomingSeries(db, leagueId);

  const analysis = analyzeTournament(db, leagueId);
  if (analysis.teams.length < 2) return { leagueId, skipped: true, reason: "not_enough_teams" };

  const simulation = simulateTournament(analysis, ratings, { iterations, seed: (leagueId * 2654435761) >>> 0 });
  // The projection is a picture of the same beliefs, not a separate prediction:
  // it is never scored, only the per-match calls frozen before a game are.
  let projection = null;
  try {
    projection = projectTournament(db, leagueId);
  } catch (error) {
    projection = { error: String(error?.message || error) };
  }
  if (Array.isArray(projection?.outcomes)) {
    const official = new Map(projection.outcomes.map((row) => [String(row.teamId), row]));
    for (const team of simulation.teams) {
      const outcome = official.get(String(team.teamId));
      if (!outcome) continue;
      team.champion = outcome.champion;
      team.final = outcome.final;
      team.top4 = outcome.top4;
    }
    simulation.method = `${simulation.method}+official_bracket_topology`;
    simulation.caveat = "Групповой посев моделируется; плей-офф проходит по опубликованной сетке и учитывает уже сыгранные результаты.";
  }
  const payload = {
    generatedAt: nowIso(),
    ratingsModelId: ratings.modelId,
    format: simulation.format,
    confidence: simulation.confidence,
    method: simulation.method,
    caveat: simulation.caveat,
    teams: simulation.teams,
    standings: analysis.teams.map((team) => ({
      teamId: team.teamId, name: team.name, logoUrl: team.logoUrl,
      seriesWins: team.seriesWins, seriesLosses: team.seriesLosses,
      mapWins: team.mapWins, mapLosses: team.mapLosses, eliminated: team.stoppedPlaying,
    })),
    pendingSeries: analysis.pendingSeries,
    finishedSeries: analysis.finishedSeries,
    projection,
  };

  db.prepare(`INSERT INTO tournament_forecasts(league_id, generated_at, iterations, format, confidence, input_hash, payload_json)
              VALUES(?,?,?,?,?,?,?)
              ON CONFLICT(league_id) DO UPDATE SET generated_at=excluded.generated_at, iterations=excluded.iterations,
                format=excluded.format, confidence=excluded.confidence, input_hash=excluded.input_hash,
                payload_json=excluded.payload_json`)
    .run(leagueId, payload.generatedAt, simulation.iterations, simulation.format.type, simulation.confidence, hash, JSON.stringify(payload));

  return { leagueId, iterations: simulation.iterations, format: simulation.format.type, teams: simulation.teams.length };
}

/** Refresh every tournament that is currently running. */
export function forecastActiveTournaments(db, { force = false } = {}) {
  const leagues = db.prepare("SELECT league_id FROM tournaments WHERE tracked = 1 AND status = 'live'").all();
  const results = [];
  for (const row of leagues) {
    try {
      results.push(forecastTournament(db, Number(row.league_id), { force }));
    } catch (error) {
      results.push({ leagueId: Number(row.league_id), error: String(error?.message || error) });
    }
  }
  return { leagues: leagues.length, updated: results.filter((row) => !row.skipped && !row.error).length, results };
}

export function readForecast(db, leagueId) {
  const row = db.prepare("SELECT * FROM tournament_forecasts WHERE league_id = ?").get(leagueId);
  if (!row) return null;
  try {
    return { ...JSON.parse(row.payload_json), iterations: Number(row.iterations) };
  } catch { return null; }
}
