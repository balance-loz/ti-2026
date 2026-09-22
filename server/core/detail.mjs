// Read models for the detail pages: one team, one series, one model's record.
//
// Everything here is assembled from what is already stored — no model is run,
// no probability is recomputed. A page must show the number that was actually
// published at the time, not a fresh one that would quietly look better.
import { loadRatings } from "./ratings.mjs";
import { heroCatalog } from "./heroes.mjs";
import { explainSeries, explainDraft, teamLineup } from "./explain.mjs";
import { rosterEras } from "./rosters.mjs";
import { predictSeries } from "./predictions.mjs";
import { nowIso } from "./db.mjs";

const parseJson = (value, fallback = null) => {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};

function teamIndex(db) {
  return new Map(db.prepare("SELECT team_id, name, tag, logo_url FROM teams").all()
    .map((row) => [String(row.team_id), { id: String(row.team_id), name: row.name || row.tag || `Team ${row.team_id}`, logoUrl: row.logo_url }]));
}

const namedTeam = (index, teamId) => index.get(String(teamId))
  ?? { id: String(teamId ?? ""), name: teamId ? `Team ${teamId}` : "—", logoUrl: null };

/** Where a team sits among every rated team. */
function ratingStanding(artifact, teamId) {
  const ratings = artifact?.ratings ?? {};
  const own = ratings[String(teamId)];
  if (!own) return null;
  const ordered = Object.entries(ratings).sort((a, b) => b[1].rating - a[1].rating);
  const rank = ordered.findIndex(([id]) => id === String(teamId)) + 1;
  return { rating: own.rating, series: own.series, rank, of: ordered.length };
}

/** Heroes a team actually picks, and how those maps went. */
function heroRecord(db, teamId, { limit = 12 } = {}) {
  const rows = db.prepare(`SELECT radiant_team_id, dire_team_id, radiant_win, radiant_picks_json, dire_picks_json
                           FROM maps
                           WHERE (radiant_team_id = ? OR dire_team_id = ?)
                             AND radiant_picks_json IS NOT NULL AND radiant_win IS NOT NULL
                           ORDER BY start_time DESC LIMIT 400`).all(teamId, teamId);
  const tally = new Map();
  for (const row of rows) {
    const isRadiant = String(row.radiant_team_id) === String(teamId);
    const picks = parseJson(isRadiant ? row.radiant_picks_json : row.dire_picks_json, []);
    const won = isRadiant ? row.radiant_win === 1 : row.radiant_win === 0;
    for (const heroId of picks) {
      const entry = tally.get(heroId) ?? { heroId, games: 0, wins: 0 };
      entry.games += 1;
      if (won) entry.wins += 1;
      tally.set(heroId, entry);
    }
  }
  return [...tally.values()]
    .sort((a, b) => b.games - a.games || b.wins - a.wins)
    .slice(0, limit)
    .map((entry) => ({ ...entry, winRate: entry.games ? entry.wins / entry.games : null }));
}

/** Series a team played, newest first, with whatever we predicted at the time. */
function teamSeries(db, teamId, index, { limit = 40 } = {}) {
  const rows = db.prepare(`SELECT s.*, t.name AS tournament_name, t.slug AS tournament_slug
                           FROM series s LEFT JOIN tournaments t ON t.league_id = s.league_id
                           WHERE (s.team_a_id = ? OR s.team_b_id = ?) AND s.status IN ('finished','live')
                           ORDER BY COALESCE(s.end_time, s.start_time) DESC LIMIT ?`)
    .all(teamId, teamId, limit);

  return rows.map((row) => {
    const isA = String(row.team_a_id) === String(teamId);
    const opponent = namedTeam(index, isA ? row.team_b_id : row.team_a_id);
    const prediction = db.prepare(`SELECT probability_a, side_a, created_at, outcome, outcome_kind,
                                          predicted_score, actual_score, score_correct, model_id
                                   FROM predictions
                                   WHERE scope='series' AND subject_key=? AND model_kind='team_ratings'`)
      .get(row.series_key);
    const forUs = prediction
      ? (String(prediction.side_a) === String(teamId) ? prediction.probability_a : 1 - prediction.probability_a)
      : null;
    return {
      seriesKey: row.series_key,
      tournament: row.tournament_slug ? { slug: row.tournament_slug, name: row.tournament_name } : null,
      opponent,
      scoreFor: isA ? row.score_a : row.score_b,
      scoreAgainst: isA ? row.score_b : row.score_a,
      bestOf: row.best_of,
      startTime: row.start_time,
      status: row.status,
      isDraw: Number(row.is_draw) === 1,
      won: row.winner_id ? String(row.winner_id) === String(teamId) : null,
      prediction: prediction ? {
        probability: forUs,
        capturedAt: prediction.created_at,
        predictedScore: prediction.predicted_score,
        actualScore: prediction.actual_score,
        scoreCorrect: prediction.score_correct === null ? null : Boolean(prediction.score_correct),
        outcomeKind: prediction.outcome_kind,
        correct: prediction.outcome === null ? null : ((forUs >= 0.5) === (String(row.winner_id) === String(teamId))),
      } : null,
    };
  });
}

/** Head-to-head record against every opponent faced. */
function headToHead(db, teamId, index) {
  const rows = db.prepare(`SELECT team_a_id, team_b_id, winner_id, score_a, score_b, is_draw, status
                           FROM series
                           WHERE (team_a_id = ? OR team_b_id = ?) AND status = 'finished'`)
    .all(teamId, teamId);
  const tally = new Map();
  for (const row of rows) {
    const isA = String(row.team_a_id) === String(teamId);
    const opponentId = String(isA ? row.team_b_id : row.team_a_id);
    const entry = tally.get(opponentId) ?? { opponent: namedTeam(index, opponentId), wins: 0, losses: 0, draws: 0, mapsFor: 0, mapsAgainst: 0 };
    entry.mapsFor += isA ? row.score_a : row.score_b;
    entry.mapsAgainst += isA ? row.score_b : row.score_a;
    if (Number(row.is_draw) === 1) entry.draws += 1;
    else if (String(row.winner_id) === String(teamId)) entry.wins += 1;
    else entry.losses += 1;
    tally.set(opponentId, entry);
  }
  return [...tally.values()]
    .sort((a, b) => (b.wins + b.losses + b.draws) - (a.wins + a.losses + a.draws))
    .slice(0, 30);
}

// A spell shorter than this is a stand-in run, not a roster.
const MIN_ERA_MAPS = 3;

export function teamDetail(db, teamId) {
  const row = db.prepare("SELECT team_id, name, tag, logo_url FROM teams WHERE team_id = ?").get(teamId);
  if (!row) return null;
  const index = teamIndex(db);
  const artifact = loadRatings();

  const totals = db.prepare(`SELECT
      SUM(CASE WHEN winner_id = ? THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN winner_id IS NOT NULL AND winner_id != ? THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN is_draw = 1 THEN 1 ELSE 0 END) AS draws
    FROM series WHERE (team_a_id = ? OR team_b_id = ?) AND status = 'finished'`)
    .get(teamId, teamId, teamId, teamId);

  return {
    team: namedTeam(index, teamId),
    rating: ratingStanding(artifact, teamId),
    ratingsModelId: artifact?.modelId ?? null,
    record: {
      wins: Number(totals?.wins || 0),
      losses: Number(totals?.losses || 0),
      draws: Number(totals?.draws || 0),
    },
    lineup: teamLineup(db, teamId),
    // Brief stand-in spells are left out: a single substituted game is not a
    // roster change, and listing it as one would bury the real ones.
    rosterHistory: rosterEras(db, teamId)
      .filter((era) => era.maps >= MIN_ERA_MAPS)
      .reverse(),
    series: teamSeries(db, teamId, index),
    headToHead: headToHead(db, teamId, index),
    heroes: heroRecord(db, teamId),
    heroCatalog: heroCatalog(db),
  };
}

/** One series: its maps, their drafts, and what was predicted before each. */
export function seriesDetail(db, seriesKey) {
  const row = db.prepare(`SELECT s.*, t.name AS tournament_name, t.slug AS tournament_slug
                          FROM series s LEFT JOIN tournaments t ON t.league_id = s.league_id
                          WHERE s.series_key = ?`).get(seriesKey);
  if (!row) return null;
  const index = teamIndex(db);
  const teamA = namedTeam(index, row.team_a_id);
  const teamB = namedTeam(index, row.team_b_id);

  const seriesPrediction = db.prepare(`SELECT * FROM predictions
                                       WHERE scope='series' AND subject_key=? AND model_kind='team_ratings'`)
    .get(seriesKey);

  const mapIds = parseJson(row.map_ids_json, []);
  const maps = mapIds.map((matchId) => {
    const map = db.prepare(`SELECT match_id, radiant_team_id, dire_team_id, radiant_win, start_time, duration,
                                   patch, radiant_picks_json, dire_picks_json
                            FROM maps WHERE match_id = ?`).get(matchId);
    if (!map) return null;
    const draft = db.prepare(`SELECT probability_a, side_a, side_b, created_at, outcome, features_json, model_id
                              FROM predictions WHERE scope='map' AND subject_key=? AND model_kind='draft'`)
      .get(String(matchId));
    return {
      matchId: Number(map.match_id),
      radiant: namedTeam(index, map.radiant_team_id),
      dire: namedTeam(index, map.dire_team_id),
      radiantWin: map.radiant_win === null ? null : map.radiant_win === 1,
      startTime: map.start_time,
      duration: map.duration,
      patch: map.patch,
      radiantPicks: parseJson(map.radiant_picks_json, []),
      direPicks: parseJson(map.dire_picks_json, []),
      draftPrediction: draft ? {
        probabilityRadiant: Number(draft.probability_a),
        capturedAt: draft.created_at,
        modelId: draft.model_id,
        correct: draft.outcome === null ? null : Boolean(draft.outcome) === (map.radiant_win === 1),
        // The stored features are what the model saw; they explain the call.
        features: parseJson(draft.features_json, null),
      } : null,
      // Pick by pick, with the current draft model. Its coefficients are not
      // stored per prediction, so a call frozen under an older version is
      // explained by today's — flagged here rather than passed off as the same.
      explanation: (() => {
        const radiantPicks = parseJson(map.radiant_picks_json, []);
        const direPicks = parseJson(map.dire_picks_json, []);
        const explained = explainDraft(db, {
          radiantTeamId: map.radiant_team_id,
          direTeamId: map.dire_team_id,
          radiantPicks, direPicks,
        });
        const restated = Boolean(draft?.model_id && explained.modelId && draft.model_id !== explained.modelId);
        return {
          ...explained,
          basis: restated ? "current_model" : "frozen",
          notes: restated
            ? [...explained.notes, {
              key: "model_moved_on",
              text: `Прогноз фиксировала версия ${draft.model_id}, а разбор посчитан текущей ${explained.modelId}: `
                + "коэффициенты героев хранятся только для действующей модели.",
            }]
            : explained.notes,
        };
      })(),
    };
  }).filter(Boolean);

  // Rebuilt from whatever the frozen prediction recorded, so the explanation
  // describes the call that was graded rather than one made with hindsight.
  const frozenFeatures = seriesPrediction ? parseJson(seriesPrediction.features_json, null) : null;
  const explanation = explainSeries(db, {
    teamAId: row.team_a_id,
    teamBId: row.team_b_id,
    bestOf: row.best_of || 3,
    snapshot: frozenFeatures ? { ...frozenFeatures, modelId: seriesPrediction.model_id } : null,
  });

  return {
    seriesKey,
    tournament: row.tournament_slug ? { slug: row.tournament_slug, name: row.tournament_name } : null,
    teamA, teamB,
    scoreA: row.score_a,
    scoreB: row.score_b,
    bestOf: row.best_of,
    status: row.status,
    isDraw: Number(row.is_draw) === 1,
    winnerId: row.winner_id ? String(row.winner_id) : null,
    startTime: row.start_time,
    prediction: seriesPrediction ? {
      probabilityA: Number(seriesPrediction.probability_a),
      capturedAt: seriesPrediction.created_at,
      modelId: seriesPrediction.model_id,
      predictedScore: seriesPrediction.predicted_score,
      predictedScoreProbability: seriesPrediction.predicted_score_probability,
      drawProbability: seriesPrediction.draw_probability,
      actualScore: seriesPrediction.actual_score,
      scoreCorrect: seriesPrediction.score_correct === null ? null : Boolean(seriesPrediction.score_correct),
      outcomeKind: seriesPrediction.outcome_kind,
      features: parseJson(seriesPrediction.features_json, null),
    } : null,
    explanation,
    maps,
    heroCatalog: heroCatalog(db),
  };
}

function virtualSeriesDetail(db, key) {
  const index = teamIndex(db);
  let leagueId; let teamAId; let teamBId; let bestOf = 3; let startTime = null;
  let status = "scheduled"; let kind = "projected"; let frozen = null; let liveMap = null;

  const projected = key.match(/^projected:(\d+):(\d+):(\d+):(\d+)$/);
  const scheduled = key.match(/^sched:(\d+):(.+)$/);
  const live = key.match(/^live-map:(\d+)$/);
  if (projected) {
    leagueId = Number(projected[1]);
    teamAId = Number(projected[3]);
    teamBId = Number(projected[4]);
  } else if (scheduled) {
    leagueId = Number(scheduled[1]);
    const row = db.prepare("SELECT * FROM scheduled_matches WHERE league_id=? AND external_key=?").get(leagueId, scheduled[2]);
    if (!row?.team_a_id || !row?.team_b_id) return null;
    teamAId = Number(row.team_a_id); teamBId = Number(row.team_b_id);
    bestOf = Number(row.best_of) || 3; startTime = row.start_time ?? null; kind = "scheduled";
    frozen = db.prepare("SELECT * FROM predictions WHERE scope='series' AND subject_key=? AND model_kind='team_ratings'").get(key);
  } else if (live) {
    const row = db.prepare("SELECT * FROM live_games WHERE match_id=?").get(Number(live[1]));
    if (!row) return null;
    const payload = parseJson(row.payload_json, {});
    leagueId = Number(row.league_id); teamAId = Number(row.radiant_team_id); teamBId = Number(row.dire_team_id);
    status = "live"; kind = "live"; startTime = null;
    const scheduledRow = db.prepare(`SELECT best_of FROM scheduled_matches WHERE league_id=?
      AND ((team_a_id=? AND team_b_id=?) OR (team_a_id=? AND team_b_id=?))
      ORDER BY ABS(COALESCE(start_time,0) - strftime('%s','now')) LIMIT 1`)
      .get(leagueId, teamAId, teamBId, teamBId, teamAId);
    bestOf = Number(scheduledRow?.best_of) || 3;
    const draft = db.prepare("SELECT * FROM predictions WHERE scope='map' AND subject_key=? AND model_kind='draft'").get(String(row.match_id));
    const radiantPicks = parseJson(row.radiant_picks_json, payload.radiantPicks ?? []);
    const direPicks = parseJson(row.dire_picks_json, payload.direPicks ?? []);
    const draftProbability = draft ? Number(draft.probability_a) : Number(payload.draft?.probabilityRadiant);
    liveMap = {
      matchId: Number(row.match_id), radiant: namedTeam(index, teamAId), dire: namedTeam(index, teamBId),
      radiantWin: null, startTime: null, duration: Number(row.game_time) || null, patch: null,
      radiantPicks, direPicks,
      draftPrediction: Number.isFinite(draftProbability) ? {
        probabilityRadiant: draftProbability,
        capturedAt: draft?.created_at ?? row.last_seen_at,
        modelId: draft?.model_id ?? payload.draft?.modelId ?? null,
        correct: null,
        features: draft ? parseJson(draft.features_json, null) : {
          prior: payload.draft?.priorProbabilityRadiant ?? null,
          draftDelta: payload.draft?.draftDelta ?? null,
          liveProbabilityRadiant: payload.liveState?.liveProbabilityRadiant ?? null,
        },
      } : null,
      explanation: explainDraft(db, { radiantTeamId: teamAId, direTeamId: teamBId, radiantPicks, direPicks }),
    };
  } else return null;

  const tournamentRow = db.prepare("SELECT name, slug FROM tournaments WHERE league_id=?").get(leagueId);
  const ratings = loadRatings();
  const current = predictSeries(db, { teamAId, teamBId, bestOf, ratings });
  const snapshot = frozen ? parseJson(frozen.features_json, null) : null;
  const explanation = explainSeries(db, {
    teamAId, teamBId, bestOf, ratings,
    snapshot: snapshot ? { ...snapshot, modelId: frozen.model_id } : null,
  });
  const prediction = frozen ? {
    probabilityA: Number(frozen.probability_a), capturedAt: frozen.created_at, modelId: frozen.model_id,
    predictedScore: frozen.predicted_score, predictedScoreProbability: frozen.predicted_score_probability,
    drawProbability: frozen.draw_probability, actualScore: frozen.actual_score,
    scoreCorrect: frozen.score_correct === null ? null : Boolean(frozen.score_correct),
    outcomeKind: frozen.outcome_kind, features: snapshot, provisional: false,
  } : {
    probabilityA: current.probabilityA, capturedAt: nowIso(), modelId: current.modelId,
    predictedScore: current.exactScore?.score ?? null,
    predictedScoreProbability: current.exactScore?.probability ?? null,
    drawProbability: current.drawProbability ?? null, actualScore: null, scoreCorrect: null, outcomeKind: null,
    features: { projected: kind === "projected", currentModel: true }, provisional: true,
  };
  return {
    seriesKey: key, detailKind: kind,
    tournament: tournamentRow ? { slug: tournamentRow.slug, name: tournamentRow.name } : null,
    teamA: namedTeam(index, teamAId), teamB: namedTeam(index, teamBId),
    scoreA: 0, scoreB: 0, bestOf, status, isDraw: false, winnerId: null, startTime,
    prediction, explanation, maps: liveMap ? [liveMap] : [], heroCatalog: heroCatalog(db),
  };
}

export function matchDetail(db, key) {
  return seriesDetail(db, key) ?? virtualSeriesDetail(db, key);
}

/** Every call one model has made, newest first, with how it turned out. */
export function modelPredictions(db, modelKind, { limit = 200, resolvedOnly = false, modelIds = null } = {}) {
  const index = teamIndex(db);
  const versionFilter = Array.isArray(modelIds) && modelIds.length
    ? `AND p.model_id IN (${modelIds.map(() => "?").join(",")})`
    : "";
  const rows = db.prepare(`SELECT p.*, t.name AS tournament_name, t.slug AS tournament_slug
                           FROM predictions p LEFT JOIN tournaments t ON t.league_id = p.league_id
                           WHERE p.model_kind = ? ${resolvedOnly ? "AND p.resolved_at IS NOT NULL" : ""} ${versionFilter}
                           ORDER BY p.created_at DESC LIMIT ?`)
    .all(modelKind, ...(modelIds ?? []), limit);

  return rows.map((row) => {
    const sideA = namedTeam(index, row.side_a);
    const sideB = namedTeam(index, row.side_b);
    const base = {
      id: row.id,
      scope: row.scope,
      subjectKey: row.subject_key,
      tournament: row.tournament_slug ? { slug: row.tournament_slug, name: row.tournament_name } : null,
      sideA, sideB,
      probabilityA: Number(row.probability_a),
      bestOf: row.best_of,
      capturedAt: row.created_at,
      modelId: row.model_id,
      resolvedAt: row.resolved_at,
      outcome: row.outcome,
      outcomeKind: row.outcome_kind,
      brier: row.brier,
      logLoss: row.log_loss,
      predictedScore: row.predicted_score,
      actualScore: row.actual_score,
      scoreCorrect: row.score_correct === null ? null : Boolean(row.score_correct),
      correct: row.outcome === null ? null
        : ((Number(row.probability_a) >= 0.5 ? 1 : 0) === Number(row.outcome)),
      features: parseJson(row.features_json, null),
    };
    if (row.scope !== "map") {
      // A series prediction has a date too — it just lives on the series rather
      // than on a map. Without it the whole column reads as dashes.
      const played = db.prepare("SELECT start_time FROM series WHERE series_key = ?").get(String(row.subject_key));
      return { ...base, startTime: played?.start_time ?? base.features?.scheduledStart ?? null };
    }
    const map = db.prepare("SELECT radiant_picks_json, dire_picks_json, patch, start_time FROM maps WHERE match_id = ?")
      .get(Number(row.subject_key));
    // The prediction was made from the picks the live feed showed, and those are
    // stored with it. The map row only gains its own copy once the per-match
    // detail is fetched, which can lag by hours — until then, show what the
    // model actually saw rather than an empty draft.
    const stored = map ? { radiant: parseJson(map.radiant_picks_json, []), dire: parseJson(map.dire_picks_json, []) } : null;
    const fromPrediction = Array.isArray(base.features?.radiantPicks) && Array.isArray(base.features?.direPicks)
      ? { radiant: base.features.radiantPicks, dire: base.features.direPicks }
      : null;
    const picks = stored?.radiant?.length ? stored : fromPrediction;
    return {
      ...base,
      picks,
      picksFrom: picks === fromPrediction && fromPrediction ? "prediction" : picks ? "map" : null,
      patch: map?.patch ?? null,
      startTime: map?.start_time ?? null,
    };
  });
}
