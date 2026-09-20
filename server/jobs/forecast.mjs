// Tournament outlook refresh. Recomputed whenever a league's results change,
// so every tracked event always has a current champion projection on its page.
import { createHash } from "node:crypto";
import { nowIso } from "../core/db.mjs";
import { analyzeTournament, simulateTournament } from "../core/format.mjs";
import { loadRatings } from "../core/ratings.mjs";
import { freezeUpcomingSeries } from "../core/predictions.mjs";

const ITERATIONS = Math.max(2000, Number(process.env.FORECAST_ITERATIONS || 20_000));

function inputHash(db, leagueId, ratingsModelId) {
  const row = db.prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(updated_at),'') AS latest,
                          COALESCE(SUM(score_a + score_b),0) AS maps FROM series WHERE league_id = ?`).get(leagueId);
  return createHash("sha1")
    .update(`${leagueId}|${row.n}|${row.latest}|${row.maps}|${ratingsModelId ?? "none"}`)
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
