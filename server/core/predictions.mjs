// Prediction ledger. Every probability we publish is written here once, before
// the outcome exists, and is never rewritten — that is what makes the accuracy
// numbers on the site honest rather than retrospective.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { nowIso } from "./db.mjs";
import { loadRatings, ratingPairProbability } from "./ratings.mjs";
import { bestOfProbability } from "../team-model.mjs";
import { predictTemporalDraft } from "../draft-inference.mjs";
import { estimateLiveMap } from "../live-map-prediction.mjs";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const probabilityClamp = (value) => clamp(Number(value), 0.01, 0.99);

const DRAFT_MODEL_PATH = path.resolve(process.env.DRAFT_TEMPORAL_MODEL || "models/draft-temporal-model.json");
const LIVE_MAP_MODEL_PATH = path.resolve(process.env.LIVE_MAP_MODEL || "public/live-map-model.json");

const artifactCache = new Map();
function loadArtifact(file) {
  const cached = artifactCache.get(file);
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  let value = null;
  if (existsSync(file)) {
    try { value = JSON.parse(readFileSync(file, "utf8")); } catch { value = null; }
  }
  artifactCache.set(file, { at: Date.now(), value });
  return value;
}

export const loadDraftModel = () => loadArtifact(DRAFT_MODEL_PATH);
export const loadLiveMapModel = () => loadArtifact(LIVE_MAP_MODEL_PATH);

/** Pre-draft series probability from team ratings alone. */
export function predictSeries(db, { teamAId, teamBId, bestOf = 3, ratings = null }) {
  const artifact = ratings ?? loadRatings();
  const pair = ratingPairProbability(artifact, teamAId, teamBId);
  const seriesProbabilityA = probabilityClamp(bestOfProbability(pair.mapProbabilityA, bestOf || 3));
  return {
    modelKind: "team_ratings",
    modelId: artifact?.modelId ?? null,
    mapProbabilityA: pair.mapProbabilityA,
    probabilityA: seriesProbabilityA,
    bestOf: bestOf || 3,
    confidence: pair.confidence,
    evidence: { seriesA: pair.seriesA, seriesB: pair.seriesB, ratingA: pair.ratingA ?? null, ratingB: pair.ratingB ?? null },
  };
}

/**
 * Map probability given a completed or partial draft. The team rating enters as
 * the prior, the draft model moves it; with no draft model the prior stands.
 */
export function predictDraftMap({ radiantTeamId, direTeamId, radiantPicks = [], direPicks = [], ratings = null, draftModel = null }) {
  const artifact = ratings ?? loadRatings();
  const pair = ratingPairProbability(artifact, radiantTeamId, direTeamId);
  const priorLogit = Math.log(pair.mapProbabilityA / (1 - pair.mapProbabilityA));
  const model = draftModel ?? loadDraftModel();
  const picksComplete = radiantPicks.length === 5 && direPicks.length === 5;
  if (!model || !picksComplete) {
    return {
      modelKind: "draft",
      modelId: model?.modelId ?? null,
      probabilityRadiant: probabilityClamp(pair.mapProbabilityA),
      priorProbabilityRadiant: probabilityClamp(pair.mapProbabilityA),
      draftDelta: 0,
      available: false,
      reason: !model ? "draft_model_unavailable" : "incomplete_picks",
      confidence: pair.confidence,
    };
  }
  try {
    const draft = predictTemporalDraft(model, { picksA: radiantPicks, picksB: direPicks, radiant: "a" });
    const combinedLogit = priorLogit + Number(draft.rawLogitA || 0);
    const probabilityRadiant = probabilityClamp(1 / (1 + Math.exp(-combinedLogit)));
    return {
      modelKind: "draft",
      modelId: draft.modelId ?? model.modelId ?? null,
      probabilityRadiant,
      priorProbabilityRadiant: probabilityClamp(pair.mapProbabilityA),
      draftDelta: probabilityRadiant - probabilityClamp(pair.mapProbabilityA),
      available: true,
      components: draft.components,
      evidence: draft.evidence,
      confidence: pair.confidence,
    };
  } catch (error) {
    return {
      modelKind: "draft",
      modelId: model?.modelId ?? null,
      probabilityRadiant: probabilityClamp(pair.mapProbabilityA),
      priorProbabilityRadiant: probabilityClamp(pair.mapProbabilityA),
      draftDelta: 0,
      available: false,
      reason: String(error?.message || error),
      confidence: pair.confidence,
    };
  }
}

/** Mid-game update from gold lead, only inside the window the model validated. */
export function predictLiveState({ draftProbabilityRadiant, game }) {
  return estimateLiveMap(loadLiveMapModel(), { draftProbabilityRadiant, game });
}

/**
 * Write a prediction once. A second call for the same subject and model kind is
 * ignored, which is the whole point: the first published number is the one we
 * are judged on.
 */
export function freezePrediction(db, {
  scope, subjectKey, leagueId = null, modelKind, modelId = null,
  sideA, sideB, probabilityA, bestOf = null, features = null,
}) {
  const probability = probabilityClamp(probabilityA);
  const info = db.prepare(`INSERT INTO predictions(scope, subject_key, league_id, model_kind, model_id, side_a, side_b,
                             probability_a, best_of, features_json, created_at)
                           VALUES(?,?,?,?,?,?,?,?,?,?,?)
                           ON CONFLICT(scope, subject_key, model_kind) DO NOTHING`)
    .run(scope, String(subjectKey), leagueId, modelKind, modelId, String(sideA), String(sideB),
      probability, bestOf, features ? JSON.stringify(features) : null, nowIso());
  return { inserted: Number(info.changes) > 0, probabilityA: probability };
}

export function getPrediction(db, scope, subjectKey, modelKind) {
  return db.prepare("SELECT * FROM predictions WHERE scope = ? AND subject_key = ? AND model_kind = ?")
    .get(scope, String(subjectKey), modelKind);
}

export function predictionsFor(db, scope, subjectKey) {
  return db.prepare("SELECT * FROM predictions WHERE scope = ? AND subject_key = ? ORDER BY created_at ASC")
    .all(scope, String(subjectKey));
}

function scoreRow(db, row, outcome) {
  const probability = probabilityClamp(row.probability_a);
  const brier = (probability - outcome) ** 2;
  const loss = -(outcome * Math.log(probability) + (1 - outcome) * Math.log(1 - probability));
  db.prepare("UPDATE predictions SET resolved_at = ?, outcome = ?, brier = ?, log_loss = ? WHERE id = ?")
    .run(nowIso(), outcome, brier, loss, row.id);
}

/** Close out every prediction whose subject now has a result. */
export function resolvePredictions(db) {
  let resolved = 0;

  const openSeries = db.prepare(`SELECT p.* FROM predictions p WHERE p.resolved_at IS NULL AND p.scope = 'series'`).all();
  for (const row of openSeries) {
    const series = db.prepare("SELECT team_a_id, team_b_id, winner_id, status FROM series WHERE series_key = ?").get(row.subject_key);
    if (!series || series.status !== "finished" || !series.winner_id) continue;
    // side_a is stored as the team id the probability refers to.
    const outcome = String(series.winner_id) === String(row.side_a) ? 1 : 0;
    if (String(series.winner_id) !== String(row.side_a) && String(series.winner_id) !== String(row.side_b)) continue;
    scoreRow(db, row, outcome);
    resolved += 1;
  }

  const openMaps = db.prepare(`SELECT p.* FROM predictions p WHERE p.resolved_at IS NULL AND p.scope = 'map'`).all();
  for (const row of openMaps) {
    const map = db.prepare("SELECT radiant_team_id, dire_team_id, radiant_win FROM maps WHERE match_id = ?").get(Number(row.subject_key));
    if (!map || map.radiant_win === null || map.radiant_win === undefined) continue;
    const winnerId = map.radiant_win ? map.radiant_team_id : map.dire_team_id;
    if (String(winnerId) !== String(row.side_a) && String(winnerId) !== String(row.side_b)) continue;
    scoreRow(db, row, String(winnerId) === String(row.side_a) ? 1 : 0);
    resolved += 1;
  }

  return { resolved };
}

/** Accuracy over resolved predictions, optionally narrowed to one league. */
export function accuracySummary(db, { leagueId = null, modelKind = null, sinceDays = null } = {}) {
  const filters = ["resolved_at IS NOT NULL"];
  const params = [];
  if (leagueId != null) { filters.push("league_id = ?"); params.push(leagueId); }
  if (modelKind) { filters.push("model_kind = ?"); params.push(modelKind); }
  if (sinceDays) { filters.push("created_at >= ?"); params.push(new Date(Date.now() - sinceDays * 86_400_000).toISOString()); }
  const rows = db.prepare(`SELECT model_kind, scope, COUNT(*) AS n,
      AVG(brier) AS brier, AVG(log_loss) AS log_loss,
      AVG(CASE WHEN (probability_a >= 0.5 AND outcome = 1) OR (probability_a < 0.5 AND outcome = 0) THEN 1.0 ELSE 0.0 END) AS accuracy
    FROM predictions WHERE ${filters.join(" AND ")} GROUP BY model_kind, scope`).all(...params);
  return rows.map((row) => ({
    modelKind: row.model_kind,
    scope: row.scope,
    count: Number(row.n),
    brier: row.brier == null ? null : Number(row.brier),
    logLoss: row.log_loss == null ? null : Number(row.log_loss),
    accuracy: row.accuracy == null ? null : Number(row.accuracy),
  }));
}

/**
 * Freeze a pre-match number for every series of a league that has not finished
 * and does not have one yet.
 *
 * Finished series are deliberately excluded. A probability written after the
 * result exists is not a prediction: the ratings that produced it were fitted on
 * data that already contains that result. Scoring such rows would inflate the
 * published accuracy, so the ledger simply never gets them and the accuracy
 * figures start accumulating from the moment the system goes live.
 */
export function freezeUpcomingSeries(db, leagueId) {
  const ratings = loadRatings();
  if (!ratings) return { frozen: 0, reason: "no_ratings" };
  const rows = db.prepare(`SELECT s.* FROM series s
                           LEFT JOIN predictions p ON p.scope='series' AND p.subject_key = s.series_key AND p.model_kind='team_ratings'
                           WHERE s.league_id = ? AND p.id IS NULL
                             AND s.status != 'finished' AND s.winner_id IS NULL`).all(leagueId);
  let frozen = 0;
  for (const series of rows) {
    const prediction = predictSeries(db, { teamAId: series.team_a_id, teamBId: series.team_b_id, bestOf: series.best_of, ratings });
    if (prediction.confidence === "none") continue;
    const result = freezePrediction(db, {
      scope: "series", subjectKey: series.series_key, leagueId,
      modelKind: "team_ratings", modelId: prediction.modelId,
      sideA: series.team_a_id, sideB: series.team_b_id,
      probabilityA: prediction.probabilityA, bestOf: series.best_of,
      features: {
        mapProbabilityA: prediction.mapProbabilityA,
        confidence: prediction.confidence,
        // Series are discovered when their first map lands, so a few are first
        // seen mid-series. Recording the score at freeze time keeps that
        // visible instead of passing every row off as a pre-match call.
        scoreAtFreeze: `${series.score_a}-${series.score_b}`,
        mapsPlayedAtFreeze: Number(series.score_a || 0) + Number(series.score_b || 0),
        ...prediction.evidence,
      },
    });
    if (result.inserted) frozen += 1;
  }
  return { frozen };
}
