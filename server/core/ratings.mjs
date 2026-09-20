// Global team strength, fitted on every professional series we have stored.
// Nothing here is tournament specific: a team keeps one rating across events,
// which is what lets a brand new league be forecast on day one.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  createOnlineTeamModel,
  fitProductionTeamModel,
  productionPairPrediction,
  seriesInformation,
  TEAM_MODEL_ARENA,
  DEFAULT_TEAM_MODEL_CONFIG,
} from "../team-model.mjs";
import { nowIso } from "./db.mjs";
import { attachRosterWeights } from "./rosters.mjs";

const DAY = 86_400;
// Trained here, never shipped: public/ holds the retired pipeline's artifacts.
export const RATINGS_PATH = path.resolve(process.env.TEAM_RATINGS_MODEL || "models/team-ratings.json");
const TRAINING_WINDOW_DAYS = Math.max(120, Number(process.env.RATINGS_WINDOW_DAYS || 540));
const MIN_SERIES_PER_TEAM = Math.max(1, Number(process.env.RATINGS_MIN_SERIES || 3));
const HOLDOUT_DAYS = Math.max(7, Number(process.env.RATINGS_HOLDOUT_DAYS || 45));

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const logLoss = (probability, outcome) => -(outcome * Math.log(clamp(probability, 1e-6, 1 - 1e-6)) + (1 - outcome) * Math.log(clamp(1 - probability, 1e-6, 1 - 1e-6)));

/** Finished series across all leagues, oldest first, as model rows. */
export function loadTrainingSeries(db, { nowSeconds = Date.now() / 1000, windowDays = TRAINING_WINDOW_DAYS } = {}) {
  const since = Math.floor(nowSeconds - windowDays * DAY);
  // Draws are kept. A level Bo2 says the two sides are close, which is real
  // evidence; dropping them would throw away every drawn group-stage series.
  const rows = db.prepare(`SELECT series_key, league_id, team_a_id, team_b_id, best_of, start_time, score_a, score_b,
                                  winner_id, is_draw
                           FROM series
                           WHERE status = 'finished' AND (winner_id IS NOT NULL OR is_draw = 1) AND start_time >= ?
                             AND team_a_id > 0 AND team_b_id > 0
                           ORDER BY start_time ASC, series_key ASC`).all(since);
  return rows.map((row) => ({
    seriesKey: row.series_key,
    leagueId: Number(row.league_id),
    targetLineup: String(row.team_a_id),
    opponentLineup: String(row.team_b_id),
    isDraw: Number(row.is_draw) === 1,
    targetScore: Number(row.is_draw) === 1 ? 0.5 : (Number(row.winner_id) === Number(row.team_a_id) ? 1 : 0),
    startTime: Number(row.start_time),
    wins: Number(row.score_a),
    losses: Number(row.score_b),
    bestOf: Number(row.best_of) || 3,
    rosterWeight: 1,
    seriesInformation: seriesInformation(Number(row.score_a), Number(row.score_b)),
  }));
}

/**
 * Walk-forward over the tail of the history: each series is predicted by a model
 * that has only seen earlier series, then folded in. No future leaks in.
 */
export function runRatingArena(series, { holdoutDays = HOLDOUT_DAYS, nowSeconds = Date.now() / 1000 } = {}) {
  const cutoff = nowSeconds - holdoutDays * DAY;
  const results = [];
  for (const definition of TEAM_MODEL_ARENA) {
    const model = createOnlineTeamModel(definition);
    let count = 0; let loss = 0; let brier = 0; let correct = 0;
    for (const row of series) {
      // A drawn series still teaches the model, but there is no winner to be
      // scored against, so it is folded in without being graded.
      if (!row.isDraw && row.startTime >= cutoff && model.evidence(row.targetLineup, row.opponentLineup) >= 4) {
        const probability = model.predict(row.targetLineup, row.opponentLineup, row.startTime);
        loss += logLoss(probability, row.targetScore);
        brier += (probability - row.targetScore) ** 2;
        correct += (probability >= 0.5 ? 1 : 0) === row.targetScore ? 1 : 0;
        count += 1;
      }
      model.update(row);
    }
    if (count >= 30) {
      results.push({ modelId: definition.id, family: definition.family, samples: count, logLoss: loss / count, brier: brier / count, accuracy: correct / count });
    }
  }
  results.sort((a, b) => a.logLoss - b.logLoss);
  return results;
}

/** Baseline every candidate must beat: a coin flip. */
export const COINFLIP_LOG_LOSS = Math.log(2);

export function trainRatings(db, { nowSeconds = Date.now() / 1000 } = {}) {
  const series = loadTrainingSeries(db, { nowSeconds });
  if (series.length < 200) {
    return { ok: false, reason: "insufficient_history", series: series.length };
  }
  // Roster weighting is applied only if it earns its place. A result from a
  // lineup that shares two players with today's says less about today's team,
  // but down-weighting also throws away evidence — so the walk-forward decides,
  // and the comparison is recorded either way.
  const plainArena = runRatingArena(series, { nowSeconds });
  const rosterCoverage = attachRosterWeights(series, db, { nowSeconds });
  const rosterArena = runRatingArena(series, { nowSeconds });

  const plainBest = plainArena[0] ?? null;
  const rosterBest = rosterArena[0] ?? null;
  const rosterHelps = Boolean(plainBest && rosterBest && rosterBest.logLoss < plainBest.logLoss);
  if (!rosterHelps) {
    for (const row of series) row.rosterWeight = 1;
  }
  const arena = rosterHelps ? rosterArena : plainArena;
  const champion = arena[0] ?? null;

  // Production ratings come from the batch Bradley-Terry fit, which is the one
  // that exposes per-pair direct-H2H blending; the arena picks the online
  // variant used for uncertainty and as the sanity gate.
  const production = fitProductionTeamModel(series, [], { nowSeconds, config: DEFAULT_TEAM_MODEL_CONFIG });

  const appearances = new Map();
  for (const row of series) {
    appearances.set(row.targetLineup, (appearances.get(row.targetLineup) || 0) + 1);
    appearances.set(row.opponentLineup, (appearances.get(row.opponentLineup) || 0) + 1);
  }

  const teamRows = db.prepare("SELECT team_id, name, tag FROM teams").all();
  const teamNames = new Map(teamRows.map((row) => [String(row.team_id), row.name || row.tag || `Team ${row.team_id}`]));

  const ratings = {};
  for (const [teamId, rating] of Object.entries(production.ratings)) {
    const games = appearances.get(teamId) || 0;
    if (games < MIN_SERIES_PER_TEAM) continue;
    ratings[teamId] = { rating: Number(rating.toFixed(5)), series: games, name: teamNames.get(teamId) || `Team ${teamId}` };
  }

  const modelId = `ratings-${new Date(nowSeconds * 1000).toISOString().slice(0, 10)}-${Object.keys(ratings).length}`;
  const artifact = {
    schemaVersion: 1,
    modelId,
    generatedAt: nowIso(),
    trainedThroughSeconds: Math.floor(nowSeconds),
    config: DEFAULT_TEAM_MODEL_CONFIG,
    dataset: {
      series: series.length,
      teams: Object.keys(ratings).length,
      leagues: new Set(series.map((row) => row.leagueId)).size,
      windowDays: TRAINING_WINDOW_DAYS,
      earliest: series[0]?.startTime ?? null,
      latest: series.at(-1)?.startTime ?? null,
    },
    validation: {
      holdoutDays: HOLDOUT_DAYS,
      coinflipLogLoss: COINFLIP_LOG_LOSS,
      champion: champion ? { modelId: champion.modelId, family: champion.family, samples: champion.samples, logLoss: champion.logLoss, brier: champion.brier, accuracy: champion.accuracy } : null,
      beatsCoinflip: champion ? champion.logLoss < COINFLIP_LOG_LOSS : false,
      rosterWeighting: {
        applied: rosterHelps,
        coverage: rosterCoverage,
        withoutRosters: plainBest ? { logLoss: plainBest.logLoss, accuracy: plainBest.accuracy } : null,
        withRosters: rosterBest ? { logLoss: rosterBest.logLoss, accuracy: rosterBest.accuracy } : null,
        // The holdout is small, so this choice is evidence, not proof.
        samples: champion?.samples ?? 0,
      },
      arena: arena.slice(0, 8),
    },
    ratings,
  };

  mkdirSync(path.dirname(RATINGS_PATH), { recursive: true });
  writeFileSync(RATINGS_PATH, JSON.stringify(artifact));

  db.prepare(`INSERT INTO model_versions(kind, model_id, trained_at, samples, metrics_json, artifact_path, active, notes)
              VALUES('team_ratings',?,?,?,?,?,1,?)
              ON CONFLICT(kind, model_id) DO UPDATE SET trained_at=excluded.trained_at, samples=excluded.samples,
                metrics_json=excluded.metrics_json, active=1`)
    .run(modelId, nowIso(), series.length, JSON.stringify(artifact.validation), RATINGS_PATH,
      champion ? `champion ${champion.modelId} logloss ${champion.logLoss.toFixed(4)}` : "no arena champion");
  db.prepare("UPDATE model_versions SET active = 0 WHERE kind = 'team_ratings' AND model_id != ?").run(modelId);

  return { ok: true, modelId, series: series.length, teams: Object.keys(ratings).length, validation: artifact.validation };
}

let cachedArtifact = null;
let cachedAt = 0;

export function loadRatings({ maxAgeMs = 60_000 } = {}) {
  if (cachedArtifact && Date.now() - cachedAt < maxAgeMs) return cachedArtifact;
  if (!existsSync(RATINGS_PATH)) return null;
  try {
    cachedArtifact = JSON.parse(readFileSync(RATINGS_PATH, "utf8"));
    cachedAt = Date.now();
    return cachedArtifact;
  } catch { return null; }
}

export function invalidateRatingsCache() {
  cachedArtifact = null;
  cachedAt = 0;
}

/**
 * Map-level win probability for team A, before any draft information.
 * Falls back to 0.5 with `confidence: "none"` when neither team is rated.
 */
export function ratingPairProbability(artifact, teamAId, teamBId) {
  const ratings = artifact?.ratings || {};
  const a = ratings[String(teamAId)];
  const b = ratings[String(teamBId)];
  if (!a && !b) return { mapProbabilityA: 0.5, confidence: "none", seriesA: 0, seriesB: 0 };
  const ratingA = Number(a?.rating ?? 0);
  const ratingB = Number(b?.rating ?? 0);
  const mapProbabilityA = 1 / (1 + Math.exp(-(ratingA - ratingB)));
  // Both teams thinly observed means the gap is mostly noise; pull toward even.
  const evidence = Math.min(Number(a?.series ?? 0), Number(b?.series ?? 0));
  const reliability = clamp(evidence / 8, 0.15, 1);
  const shrunk = 0.5 + (mapProbabilityA - 0.5) * reliability;
  return {
    mapProbabilityA: clamp(shrunk, 0.02, 0.98),
    rawMapProbabilityA: mapProbabilityA,
    confidence: evidence >= 8 ? "high" : evidence >= 3 ? "medium" : "low",
    seriesA: Number(a?.series ?? 0),
    seriesB: Number(b?.series ?? 0),
    ratingA, ratingB,
  };
}

/** Direct head-to-head aware variant, used when we have the fitted history. */
export function pairPredictionWithHistory(fit, teamAId, teamBId, options = {}) {
  // Thin wrapper so callers do not need to know the lineup keys are team ids.
  return productionPairPrediction(fit, String(teamAId), String(teamBId), options);
}
