// Global team strength, fitted on every professional series we have stored.
// Nothing here is tournament specific: a team keeps one rating across events,
// which is what lets a brand new league be forecast on day one.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  createOnlineTeamModel,
  productionPairPrediction,
  seriesInformation,
  TEAM_MODEL_ARENA,
} from "../team-model.mjs";
import { nowIso } from "./db.mjs";
import {
  DEFAULT_STRENGTH_CONFIG, attachSeriesLineups, currentFives, fitStrengthModel, loadSeriesLineups,
} from "./player-ratings.mjs";

const DAY = 86_400;
// Trained here, never shipped: public/ holds the retired pipeline's artifacts.
export const RATINGS_PATH = path.resolve(process.env.TEAM_RATINGS_MODEL || "models/team-ratings.json");
const TRAINING_WINDOW_DAYS = Math.max(120, Number(process.env.RATINGS_WINDOW_DAYS || 540));
const MIN_SERIES_PER_TEAM = Math.max(1, Number(process.env.RATINGS_MIN_SERIES || 3));
const HOLDOUT_DAYS = Math.max(7, Number(process.env.RATINGS_HOLDOUT_DAYS || 45));
export const PLAYERS_PATH = path.resolve(process.env.PLAYER_RATINGS_MODEL
  || path.join(path.dirname(RATINGS_PATH), "player-ratings.json"));
// A player with less weight than this behind him is published as a number, not
// a rating; he still takes part in the fit.
const MIN_PLAYER_EVIDENCE = 0.5;

// Chosen on the rolling-origin evaluation below, not asserted. At these values
// it scores 0.6632 against 0.6851 for the team-only model it replaces, and
// 0.6731 against 0.7047 on thinly observed pairs, while picking the right
// winner 59.5% of the time against 55%.
export const STRENGTH_CONFIG = Object.freeze({
  ...DEFAULT_STRENGTH_CONFIG,
  halfLifeDays: Number(process.env.RATINGS_HALF_LIFE_DAYS || 180),
  teamL2: Number(process.env.RATINGS_TEAM_L2 || 1),
  playerL2: Number(process.env.RATINGS_PLAYER_L2 || 8),
});
export const MODERATION = Number(process.env.RATINGS_MODERATION || 4);
// Weight behind the thinner side, in the units the fit uses. A side of five
// established players carries far more than an organisation ever did alone, so
// these are not the old series counts under another name.
// Set from the observed spread: the median team carries 35, the upper quarter
// carries 183. A label has to mean something relative to the field.
const CONFIDENCE_HIGH = Number(process.env.RATINGS_CONFIDENCE_HIGH || 150);
const CONFIDENCE_MEDIUM = Number(process.env.RATINGS_CONFIDENCE_MEDIUM || 35);

// What a result is worth as evidence about professional strength, by the tier
// the source itself assigns the league. `excluded` is OpenDota's own label for
// events that are not professional play — open pub brackets, showmatches,
// national sides. They are kept rather than dropped, at a weight low enough that
// a run of wins there cannot build a rating: a player who moves up from that
// scene should not arrive as a complete unknown, which is the only thing this
// data is good for.
const TIER_WEIGHTS = Object.freeze({
  premium: 1,
  professional: 1,
  excluded: Math.max(0, Number(process.env.RATINGS_EXCLUDED_TIER_WEIGHT ?? 0.08)),
});
const DEFAULT_TIER_WEIGHT = Math.max(0, Number(process.env.RATINGS_UNKNOWN_TIER_WEIGHT ?? 0.25));

export const tierWeight = (tier) => TIER_WEIGHTS[String(tier || "")] ?? DEFAULT_TIER_WEIGHT;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const logLoss = (probability, outcome) => -(outcome * Math.log(clamp(probability, 1e-6, 1 - 1e-6)) + (1 - outcome) * Math.log(clamp(1 - probability, 1e-6, 1 - 1e-6)));

/** Finished series across all leagues, oldest first, as model rows. */
export function loadTrainingSeries(db, { nowSeconds = Date.now() / 1000, windowDays = TRAINING_WINDOW_DAYS } = {}) {
  const since = Math.floor(nowSeconds - windowDays * DAY);
  // Draws are kept. A level Bo2 says the two sides are close, which is real
  // evidence; dropping them would throw away every drawn group-stage series.
  const rows = db.prepare(`SELECT s.series_key, s.league_id, s.team_a_id, s.team_b_id, s.best_of, s.start_time,
                                  s.score_a, s.score_b, s.winner_id, s.is_draw, t.tier
                           FROM series s LEFT JOIN tournaments t ON t.league_id = s.league_id
                           WHERE s.status = 'finished' AND (s.winner_id IS NOT NULL OR s.is_draw = 1)
                             AND s.start_time >= ? AND s.team_a_id > 0 AND s.team_b_id > 0
                           ORDER BY s.start_time ASC, s.series_key ASC`).all(since);
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
    tier: row.tier ?? null,
    tierWeight: tierWeight(row.tier),
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

// --- honest evaluation of a rating configuration ----------------------------
//
// The arena above scores a single trailing slice and keeps only pairs where both
// sides are already well observed. That is the wrong shape twice over: the slice
// is small enough that a difference of a thousandth of a nat is noise, and the
// pairs it discards are precisely the ones that go wrong — a team with eight
// results is exactly where a rating is least trustworthy and most likely to be
// published as a certainty.
//
// This refits at several points in the history, scores everything that follows
// each one, and reports the thin pairs as their own number so a change cannot
// look good in aggregate while ruining them.

/**
 * Shrink a rating toward the middle by how much evidence stands behind it.
 *
 * `prior` is the weight of an imaginary even record every team starts with, so a
 * team whose whole history weighs less than that keeps under half of its fitted
 * rating. Shrinking the rating rather than the finished probability is what lets
 * one well-known side face one unknown side and land somewhere sensible.
 */
export const shrinkRating = (rating, weight, prior) =>
  (prior > 0 ? Number(rating) * (Number(weight) / (Number(weight) + prior)) : Number(rating));

/**
 * Rolling-origin evaluation: refit at several points in the history and score
 * what follows each one, with the rosters as they were known at that moment.
 *
 * Only the leagues the site publishes are scored. Pub brackets are training
 * input — they say who a player is — but measured on their own they sit at
 * 0.698, worse than a coin flip, so scoring on them would tune the model to fit
 * noise nobody ever asks it about.
 */
export function evaluateStrengthConfig(series, db, {
  config = STRENGTH_CONFIG,
  moderation = MODERATION,
  folds = 4,
  trainFraction = 0.5,
  thinEvidence = 6,
  gradeTiers = ["premium", "professional"],
  nowSeconds = Date.now() / 1000,
} = {}) {
  if (series.length < 400) return null;
  const start = Math.floor(series.length * trainFraction);
  const step = Math.floor((series.length - start) / folds);
  if (step < 25) return null;

  const lineups = loadSeriesLineups(db);
  const totals = { samples: 0, logLoss: 0, squared: 0, brier: 0, correct: 0 };
  const thin = { samples: 0, logLoss: 0, correct: 0 };

  for (let fold = 0; fold < folds; fold += 1) {
    const cut = start + fold * step;
    const until = fold === folds - 1 ? series.length : cut + step;
    if (!cut) continue;
    // Fitted as of the moment the fold opens, and using only the rosters known
    // by then: a test that peeks at who turned out to play is not a test.
    const asOf = series[cut]?.startTime ?? nowSeconds;
    const fit = fitStrengthModel(series.slice(0, cut), { nowSeconds: asOf, config });
    const fives = currentFives(db, { beforeSeconds: asOf, lineups });

    for (let index = cut; index < until; index += 1) {
      const row = series[index];
      if (row.isDraw) continue;
      if (gradeTiers && !gradeTiers.includes(String(row.tier || ""))) continue;
      const { probability, evidenceA, evidenceB } = strengthPair(fit, fives, row.targetLineup, row.opponentLineup, moderation);
      const loss = logLoss(probability, row.targetScore);
      const hit = (probability >= 0.5 ? 1 : 0) === row.targetScore ? 1 : 0;
      totals.samples += 1;
      totals.logLoss += loss;
      totals.squared += loss * loss;
      totals.brier += (probability - row.targetScore) ** 2;
      totals.correct += hit;
      if (Math.min(evidenceA, evidenceB) < thinEvidence) {
        thin.samples += 1;
        thin.logLoss += loss;
        thin.correct += hit;
      }
    }
  }

  if (!totals.samples) return null;
  const mean = totals.logLoss / totals.samples;
  const variance = Math.max(0, totals.squared / totals.samples - mean * mean);
  return {
    folds,
    samples: totals.samples,
    logLoss: mean,
    brier: totals.brier / totals.samples,
    accuracy: totals.correct / totals.samples,
    // Reported apart, because this is the segment that failed: a change that
    // improves the average while ruining thin pairs is not an improvement.
    thin: thin.samples
      ? { samples: thin.samples, logLoss: thin.logLoss / thin.samples, accuracy: thin.correct / thin.samples }
      : null,
    // A difference smaller than this is not a result. The old arena reported no
    // error at all and was read as though it had.
    standardError: Math.sqrt(variance / totals.samples),
  };
}

/** One pair through the published path: strength, moderation, probability. */
export function strengthPair(fit, fives, teamAId, teamBId, moderation = MODERATION) {
  const fiveA = fives.get(String(teamAId))?.players ?? [];
  const fiveB = fives.get(String(teamBId))?.players ?? [];
  const evidence = (teamId, five) => fit.teamWeight(teamId)
    + five.reduce((total, accountId) => total + fit.playerWeight(accountId), 0);
  const evidenceA = evidence(teamAId, fiveA);
  const evidenceB = evidence(teamBId, fiveB);
  const delta = fit.strength(teamAId, fiveA) - fit.strength(teamBId, fiveB);
  return { probability: moderate(delta, evidenceA, evidenceB, moderation), evidenceA, evidenceB };
}

/**
 * Damp a rating gap by how little stands behind it.
 *
 * Applied to the gap rather than to the finished probability: pulling a
 * probability toward even is a cosmetic gesture with no story behind it, and it
 * corrupts the best-of conversion downstream. Widening the gap's uncertainty is
 * the same statement made where it belongs.
 */
export const moderate = (delta, evidenceA, evidenceB, moderation = MODERATION) => {
  const variance = moderation * (1 / (1 + Math.max(0, evidenceA)) + 1 / (1 + Math.max(0, evidenceB)));
  return 1 / (1 + Math.exp(-delta / Math.sqrt(1 + variance)));
};

/** The player half of the fit, for the players page and for explanations. */
function writePlayerArtifact(db, strength, nowSeconds) {
  const names = new Map(db.prepare("SELECT account_id, name FROM players").all()
    .map((row) => [Number(row.account_id), row.name]));
  const players = {};
  for (const accountId of strength.playerIndex.keys()) {
    const weight = strength.playerWeight(accountId);
    if (weight < MIN_PLAYER_EVIDENCE) continue;
    players[String(accountId)] = {
      rating: Number(strength.playerRating(accountId).toFixed(5)),
      evidence: Number(weight.toFixed(3)),
      name: names.get(accountId) ?? null,
    };
  }
  try {
    mkdirSync(path.dirname(PLAYERS_PATH), { recursive: true });
    writeFileSync(PLAYERS_PATH, JSON.stringify({
      schemaVersion: 1,
      generatedAt: nowIso(),
      trainedThroughSeconds: Math.floor(nowSeconds),
      players,
    }));
  } catch { /* the team artifact is what the site needs; this one is extra */ }
}

export function trainRatings(db, { nowSeconds = Date.now() / 1000, forcePromotion = false } = {}) {
  const series = loadTrainingSeries(db, { nowSeconds });
  if (series.length < 200) {
    return { ok: false, reason: "insufficient_history", series: series.length };
  }

  // Who actually played. This is what lets the model tell a new organisation of
  // known players from an old one of strangers — the distinction that rating
  // team ids alone could not make.
  const lineupCoverage = attachSeriesLineups(series, db);
  // Two weights per series. A pub result barely moves an organisation's rating,
  // but it still says who a player is, so the player half keeps full credit: a
  // tier-2 player who joins a real team must not arrive as a blank.
  for (const row of series) row.playerTierWeight = 1;

  const strength = fitStrengthModel(series, { nowSeconds, config: STRENGTH_CONFIG });
  const fives = currentFives(db, { beforeSeconds: nowSeconds });

  // The old single-slice arena is kept only as a printed diagnostic. It scored
  // about two hundred series and discarded every thinly observed pair, which is
  // precisely the case that went wrong, so it decides nothing now.
  const arena = runRatingArena(series, { nowSeconds });
  const champion = arena[0] ?? null;
  const rolling = evaluateStrengthConfig(series, db, { nowSeconds, config: STRENGTH_CONFIG });
  const loadedIncumbent = loadRatings({ maxAgeMs: 0 });
  const activeVersion = db.prepare("SELECT model_id FROM model_versions WHERE kind='team_ratings' AND active=1 ORDER BY trained_at DESC LIMIT 1").get();
  // A loose file can be a fixture, a manually copied artifact or a remnant from
  // another database. It is an incumbent only when this database says it is.
  const incumbent = activeVersion && activeVersion.model_id === loadedIncumbent?.modelId ? loadedIncumbent : null;
  const incumbentRolling = incumbent?.validation?.rollingOrigin ?? null;
  const minimumImprovement = Math.max(0, Number(process.env.RATINGS_MIN_LOGLOSS_IMPROVEMENT || 0));
  const gatePassed = forcePromotion || Boolean(rolling && rolling.logLoss < COINFLIP_LOG_LOSS
    && (!incumbentRolling || (
      rolling.logLoss <= Number(incumbentRolling.logLoss) - minimumImprovement
      && rolling.brier <= Number(incumbentRolling.brier)
    )));

  const appearances = new Map();
  for (const row of series) {
    appearances.set(row.targetLineup, (appearances.get(row.targetLineup) || 0) + 1);
    appearances.set(row.opponentLineup, (appearances.get(row.opponentLineup) || 0) + 1);
  }

  const teamRows = db.prepare("SELECT team_id, name, tag FROM teams").all();
  const teamNames = new Map(teamRows.map((row) => [String(row.team_id), row.name || row.tag || `Team ${row.team_id}`]));

  const ratings = {};
  for (const teamId of strength.teamIndex.keys()) {
    const games = appearances.get(teamId) || 0;
    if (games < MIN_SERIES_PER_TEAM) continue;
    const five = fives.get(teamId);
    const players = five?.players ?? [];
    // `rating` keeps its meaning for every consumer: the number a probability is
    // computed from. It is now the five plus the organisation rather than the
    // organisation alone.
    const rating = strength.strength(teamId, players);
    const evidence = strength.teamWeight(teamId)
      + players.reduce((total, accountId) => total + strength.playerWeight(accountId), 0);
    ratings[teamId] = {
      rating: Number(rating.toFixed(5)),
      series: games,
      name: teamNames.get(teamId) || `Team ${teamId}`,
      evidence: Number(evidence.toFixed(3)),
      teamPart: Number(strength.teamRating(teamId).toFixed(5)),
      playerPart: Number((rating - strength.teamRating(teamId)).toFixed(5)),
      lineup: players.length ? {
        players: players.map((accountId) => ({ accountId, rating: Number(strength.playerRating(accountId).toFixed(5)) })),
        agreement: five?.agreement ?? null,
        seriesSampled: five?.seriesSampled ?? 0,
      } : null,
    };
  }

  const fingerprint = createHash("sha256").update(JSON.stringify({
    trainedThroughSeconds: Math.floor(nowSeconds), config: STRENGTH_CONFIG,
    dataset: [series.length, series[0]?.startTime, series.at(-1)?.startTime], ratings,
  })).digest("hex").slice(0, 12);
  const modelId = `ratings-${new Date(nowSeconds * 1000).toISOString().slice(0, 10)}-${fingerprint}`;
  const artifact = {
    // 2: `rating` is now a lineup's strength, and `evidence` carries the weight
    // behind it. Readers of version 1 fall back to the old shrink, so an
    // artifact written before this change still predicts the way it was made.
    schemaVersion: 2,
    modelId,
    generatedAt: nowIso(),
    trainedThroughSeconds: Math.floor(nowSeconds),
    config: { ...STRENGTH_CONFIG, moderation: MODERATION },
    dataset: {
      series: series.length,
      teams: Object.keys(ratings).length,
      leagues: new Set(series.map((row) => row.leagueId)).size,
      windowDays: TRAINING_WINDOW_DAYS,
      earliest: series[0]?.startTime ?? null,
      latest: series.at(-1)?.startTime ?? null,
    },
    validation: {
      coinflipLogLoss: COINFLIP_LOG_LOSS,
      // The number that decides anything: several refits across the history,
      // scored on the leagues the site actually publishes, with thinly observed
      // pairs kept in and reported on their own.
      rollingOrigin: rolling,
      beatsCoinflip: rolling ? rolling.logLoss < COINFLIP_LOG_LOSS : false,
      promotionGate: {
        passed: gatePassed,
        forced: forcePromotion,
        minimumImprovement,
        incumbentModelId: incumbent?.modelId ?? null,
        incumbent: incumbentRolling ? { logLoss: incumbentRolling.logLoss, brier: incumbentRolling.brier } : null,
        candidate: rolling ? { logLoss: rolling.logLoss, brier: rolling.brier } : null,
        reason: forcePromotion ? "forced_for_offline_analysis"
          : !rolling ? "rolling_origin_unavailable"
          : rolling.logLoss >= COINFLIP_LOG_LOSS ? "does_not_beat_coinflip"
            : incumbentRolling && rolling.logLoss > Number(incumbentRolling.logLoss) - minimumImprovement ? "logloss_not_better_than_incumbent"
              : incumbentRolling && rolling.brier > Number(incumbentRolling.brier) ? "brier_worse_than_incumbent"
                : "passed",
      },
      lineupCoverage,
      // Kept, clearly labelled, decides nothing. Two hundred samples cannot
      // separate models that differ by thousandths of a nat.
      legacyArena: {
        note: "диагностика: одна отложенная выборка, тонкие пары исключены — решения не принимает",
        holdoutDays: HOLDOUT_DAYS,
        samples: champion?.samples ?? 0,
        champion: champion ? { modelId: champion.modelId, family: champion.family, logLoss: champion.logLoss, accuracy: champion.accuracy } : null,
        arena: arena.slice(0, 5),
      },
    },
    ratings,
  };

  const versionPath = path.join(path.dirname(RATINGS_PATH), "versions", `${modelId}.json`);
  mkdirSync(path.dirname(versionPath), { recursive: true });
  if (!existsSync(versionPath)) writeFileSync(versionPath, JSON.stringify(artifact));

  db.prepare(`INSERT INTO model_versions(kind, model_id, trained_at, samples, metrics_json, artifact_path, active, notes)
              VALUES('team_ratings',?,?,?,?,?,?,?)
              ON CONFLICT(kind, model_id) DO UPDATE SET trained_at=excluded.trained_at, samples=excluded.samples,
                metrics_json=excluded.metrics_json, artifact_path=excluded.artifact_path,
                active=excluded.active, notes=excluded.notes`)
    .run(modelId, nowIso(), series.length, JSON.stringify(artifact.validation), versionPath, gatePassed ? 1 : 0,
      gatePassed ? "promotion gate passed" : `promotion gate failed: ${artifact.validation.promotionGate.reason}`);
  if (!gatePassed) {
    return { ok: false, reason: "promotion_gate_failed", modelId, candidatePath: versionPath,
      series: series.length, teams: Object.keys(ratings).length, validation: artifact.validation };
  }

  writePlayerArtifact(db, strength, nowSeconds);
  mkdirSync(path.dirname(RATINGS_PATH), { recursive: true });
  writeFileSync(RATINGS_PATH, JSON.stringify(artifact));
  db.prepare("UPDATE model_versions SET active = 0 WHERE kind = 'team_ratings' AND model_id != ?").run(modelId);
  invalidateRatingsCache();

  return { ok: true, modelId, artifactPath: versionPath, series: series.length, teams: Object.keys(ratings).length, validation: artifact.validation };
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
  const rawMapProbabilityA = 1 / (1 + Math.exp(-(ratingA - ratingB)));
  const seriesA = Number(a?.series ?? 0);
  const seriesB = Number(b?.series ?? 0);

  if (Number(artifact?.schemaVersion) >= 2) {
    // The gap is damped by how little stands behind it, measured in the same
    // weighted units the fit used. Counting raw series was the original mistake:
    // eight results in pub brackets counted as fully known.
    const evidenceA = Number(a?.evidence ?? 0);
    const evidenceB = Number(b?.evidence ?? 0);
    const moderation = Number(artifact?.config?.moderation ?? MODERATION);
    const least = Math.min(evidenceA, evidenceB);
    return {
      mapProbabilityA: clamp(moderate(ratingA - ratingB, evidenceA, evidenceB, moderation), 0.02, 0.98),
      rawMapProbabilityA,
      confidence: least >= CONFIDENCE_HIGH ? "high" : least >= CONFIDENCE_MEDIUM ? "medium" : "low",
      seriesA, seriesB, ratingA, ratingB,
      evidenceA: Number(evidenceA.toFixed(3)),
      evidenceB: Number(evidenceB.toFixed(3)),
      // What the strength is made of, so an explanation can say whether it is
      // the players or the organisation doing the work.
      teamPartA: a?.teamPart ?? null,
      teamPartB: b?.teamPart ?? null,
      playerPartA: a?.playerPart ?? null,
      playerPartB: b?.playerPart ?? null,
      lineupA: a?.lineup ?? null,
      lineupB: b?.lineup ?? null,
      shrinkMethod: "moderated",
    };
  }

  // Version 1 artifacts keep the arithmetic they were written with, so a frozen
  // prediction is always explained by the model that actually made it.
  const evidence = Math.min(seriesA, seriesB);
  const reliability = clamp(evidence / 8, 0.15, 1);
  const shrunk = 0.5 + (rawMapProbabilityA - 0.5) * reliability;
  return {
    mapProbabilityA: clamp(shrunk, 0.02, 0.98),
    rawMapProbabilityA,
    confidence: evidence >= 8 ? "high" : evidence >= 3 ? "medium" : "low",
    seriesA, seriesB, ratingA, ratingB,
    shrinkMethod: "legacy_min_series",
  };
}

/** Direct head-to-head aware variant, used when we have the fitted history. */
export function pairPredictionWithHistory(fit, teamAId, teamBId, options = {}) {
  // Thin wrapper so callers do not need to know the lineup keys are team ids.
  return productionPairPrediction(fit, String(teamAId), String(teamBId), options);
}
