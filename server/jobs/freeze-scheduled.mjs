// Freeze a prediction before a match starts, using the organiser's own start
// time.
//
// Series are otherwise discovered from their first played map, so the earliest
// a prediction could be written was after a game had already been decided. With
// a published schedule the call can be made while the outcome is genuinely
// unknown, which is the only kind of prediction worth grading.
import { nowIso } from "../core/db.mjs";
import { loadRatings } from "../core/ratings.mjs";
import { predictSeries, freezePrediction } from "../core/predictions.mjs";

// How long before the stated start a prediction is written. Early enough that
// it is unambiguously pre-match, late enough that the ratings are current.
const LEAD_MINUTES = Math.max(1, Number(process.env.FREEZE_LEAD_MINUTES || 90));
// A schedule entry whose time has long passed without a series appearing was
// cancelled or rescheduled; predicting it would be noise.
const STALE_HOURS = Math.max(1, Number(process.env.FREEZE_STALE_HOURS || 6));

export const scheduledSubjectKey = (leagueId, externalKey) => `sched:${leagueId}:${externalKey}`;

/**
 * Fill a still-TBD bracket slot from the series that actually started at its
 * official time. This is the fallback for the interval between OpenDota seeing
 * map one and the organiser updating the names inside the bracket template.
 * Assignment is one-to-one and nearest-time-first so one series cannot occupy
 * two slots.
 */
export function inferStartedBracketSlots(db, { nowSeconds = Date.now() / 1000, windowHours = 6 } = {}) {
  const window = windowHours * 3600;
  const slots = db.prepare(`SELECT * FROM scheduled_matches
                            WHERE series_key IS NULL AND slot IS NOT NULL
                              AND lane IN ('upper','lower','final')
                              AND (team_a_id IS NULL OR team_b_id IS NULL)
                              AND start_time IS NOT NULL AND start_time <= ?`).all(Math.floor(nowSeconds));
  if (!slots.length) return { inferred: 0, considered: 0 };

  const candidates = db.prepare(`SELECT s.series_key, s.league_id, s.team_a_id, s.team_b_id, s.start_time,
                                        ta.name AS team_a_name, tb.name AS team_b_name
                                 FROM series s
                                 LEFT JOIN teams ta ON ta.team_id=s.team_a_id
                                 LEFT JOIN teams tb ON tb.team_id=s.team_b_id
                                 WHERE s.start_time IS NOT NULL
                                   AND COALESCE(s.stage, 'playoff') != 'group'
                                   AND NOT EXISTS (SELECT 1 FROM scheduled_matches linked
                                                   WHERE linked.series_key=s.series_key)`).all();
  const edges = [];
  for (const slot of slots) {
    for (const series of candidates) {
      if (Number(series.league_id) !== Number(slot.league_id)) continue;
      const difference = Math.abs(Number(series.start_time) - Number(slot.start_time));
      if (difference > window) continue;
      const pair = new Set([String(series.team_a_id), String(series.team_b_id)]);
      if (slot.team_a_id && !pair.has(String(slot.team_a_id))) continue;
      if (slot.team_b_id && !pair.has(String(slot.team_b_id))) continue;
      edges.push({ slot, series, difference });
    }
  }
  edges.sort((a, b) => a.difference - b.difference || Number(a.slot.id) - Number(b.slot.id));

  const usedSlots = new Set();
  const usedSeries = new Set();
  const update = db.prepare(`UPDATE scheduled_matches
                             SET team_a_id=?, team_b_id=?, team_a_name=?, team_b_name=?, updated_at=?
                             WHERE id=? AND series_key IS NULL`);
  let inferred = 0;
  for (const edge of edges) {
    if (usedSlots.has(edge.slot.id) || usedSeries.has(edge.series.series_key)) continue;
    update.run(edge.series.team_a_id, edge.series.team_b_id,
      edge.series.team_a_name, edge.series.team_b_name, nowIso(), edge.slot.id);
    usedSlots.add(edge.slot.id);
    usedSeries.add(edge.series.series_key);
    inferred += 1;
  }
  return { inferred, considered: slots.length };
}

/**
 * Write pre-match predictions for scheduled matches that are about to start.
 *
 * Only entries with both teams resolved are usable: an unfilled bracket slot
 * has nobody to predict.
 */
export function freezeScheduledMatches(db, { nowSeconds = Date.now() / 1000 } = {}) {
  const ratings = loadRatings();
  if (!ratings) return { frozen: 0, reason: "no_ratings" };

  const from = Math.floor(nowSeconds - STALE_HOURS * 3600);
  const until = Math.floor(nowSeconds + LEAD_MINUTES * 60);
  const rows = db.prepare(`SELECT s.* FROM scheduled_matches s
                           JOIN tournaments t ON t.league_id = s.league_id AND t.tracked = 1
                           LEFT JOIN predictions p
                             ON p.scope = 'series' AND p.model_kind = 'team_ratings'
                            AND p.subject_key = 'sched:' || s.league_id || ':' || s.external_key
                           WHERE s.team_a_id IS NOT NULL AND s.team_b_id IS NOT NULL
                             AND s.start_time IS NOT NULL
                             AND s.start_time BETWEEN ? AND ?
                             AND s.series_key IS NULL
                             AND p.id IS NULL`).all(from, until);

  let frozen = 0;
  for (const row of rows) {
    const prediction = predictSeries(db, {
      teamAId: row.team_a_id,
      teamBId: row.team_b_id,
      bestOf: row.best_of || 3,
      ratings,
    });
    if (prediction.confidence === "none") continue;

    const result = freezePrediction(db, {
      scope: "series",
      subjectKey: scheduledSubjectKey(row.league_id, row.external_key),
      leagueId: row.league_id,
      modelKind: "team_ratings",
      modelId: prediction.modelId,
      sideA: row.team_a_id,
      sideB: row.team_b_id,
      probabilityA: prediction.probabilityA,
      bestOf: row.best_of || 3,
      predictedScore: prediction.exactScore?.score ?? null,
      predictedScoreProbability: prediction.exactScore?.probability ?? null,
      drawProbability: prediction.drawProbability ?? null,
      features: {
        mapProbabilityA: prediction.mapProbabilityA,
        confidence: prediction.confidence,
        // The whole point of this path: the call was made before the match.
        frozenBeforeStart: true,
        scheduledStart: row.start_time,
        minutesBeforeStart: Math.round((row.start_time - nowSeconds) / 60),
        stage: row.stage,
        slot: row.slot,
        ...prediction.evidence,
      },
      evaluationEligible: true,
      timingClass: "pre_match",
    });
    if (result.inserted) frozen += 1;
  }
  return { frozen, considered: rows.length };
}

/**
 * Attach scheduled matches to the series that actually happened.
 *
 * Matching is by league, the pair of teams and proximity in time, because a
 * schedule entry carries no match id — it was written before the game existed.
 */
export function linkScheduledToSeries(db, { nowSeconds = Date.now() / 1000, windowHours = 12 } = {}) {
  const window = windowHours * 3600;
  const inferred = inferStartedBracketSlots(db, { nowSeconds, windowHours: Math.min(windowHours, 6) });
  const rows = db.prepare(`SELECT * FROM scheduled_matches
                           WHERE series_key IS NULL AND team_a_id IS NOT NULL AND team_b_id IS NOT NULL
                             AND start_time IS NOT NULL AND start_time <= ?`).all(Math.floor(nowSeconds));

  let linked = 0;
  for (const row of rows) {
    const series = db.prepare(`SELECT series_key, team_a_id, team_b_id, start_time FROM series
                               WHERE league_id = ?
                                 AND ((team_a_id = ? AND team_b_id = ?) OR (team_a_id = ? AND team_b_id = ?))
                                 AND ABS(start_time - ?) <= ?
                               ORDER BY ABS(start_time - ?) ASC LIMIT 1`)
      .get(row.league_id, row.team_a_id, row.team_b_id, row.team_b_id, row.team_a_id,
        row.start_time, window, row.start_time);
    if (!series) continue;

    db.prepare("UPDATE scheduled_matches SET series_key = ?, updated_at = ? WHERE id = ?")
      .run(series.series_key, nowIso(), row.id);
    // The results feed never says which stage a series belonged to, but the
    // fixture we just matched it to does. Recording it here is the only moment
    // both facts are in hand. COALESCE keeps the first answer; rebuildSeries
    // does not list `stage` in its upsert, so a later resync cannot undo it.
    db.prepare("UPDATE series SET stage = COALESCE(stage, ?) WHERE series_key = ?")
      .run(row.lane === "group" ? "group" : "playoff", series.series_key);
    linked += 1;

    // Move the pre-match prediction onto the real series, unless that series
    // already has one — the earlier call wins, it was made with less knowledge.
    const subjectKey = scheduledSubjectKey(row.league_id, row.external_key);
    const pending = db.prepare(`SELECT id, side_a FROM predictions
                                WHERE scope='series' AND model_kind='team_ratings' AND subject_key = ?`)
      .get(subjectKey);
    if (!pending) continue;
    const existing = db.prepare(`SELECT id FROM predictions
                                 WHERE scope='series' AND model_kind='team_ratings' AND subject_key = ?`)
      .get(series.series_key);
    if (existing) {
      db.prepare("DELETE FROM predictions WHERE id = ?").run(pending.id);
      continue;
    }
    db.prepare("UPDATE predictions SET subject_key = ? WHERE id = ?").run(series.series_key, pending.id);
  }
  return { linked, considered: rows.length, inferred: inferred.inferred };
}

/** Scheduler entry: link what has been played, then freeze what is coming. */
export function freezeAndLink(db) {
  const linked = linkScheduledToSeries(db);
  const frozen = freezeScheduledMatches(db);
  return { ...frozen, linked: linked.linked, inferred: linked.inferred };
}
