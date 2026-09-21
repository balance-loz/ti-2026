// Live games, for any professional league rather than one hardcoded event.
// A game is predicted from its draft the moment all ten heroes are locked, and
// that first number is frozen into the ledger so the site cannot quietly
// improve its own record afterwards.
import { nowIso } from "./db.mjs";
import { opendota } from "./opendota.mjs";
import { upsertTeam } from "./tournaments.mjs";
import { loadRatings } from "./ratings.mjs";
import { predictDraftMap, predictLiveState, freezePrediction, loadDraftModel } from "./predictions.mjs";

const MAX_FEED_AGE_SECONDS = Math.max(120, Number(process.env.LIVE_MAX_AGE_SECONDS || 420));
const CLOSE_AFTER_SECONDS = Math.max(300, Number(process.env.LIVE_CLOSE_AFTER_SECONDS || 900));
export const DRAFT_FREEZE_MAX_SECONDS = Math.max(0, Number(process.env.DRAFT_FREEZE_MAX_SECONDS || 180));

const sideHeroes = (players, side) => (players || [])
  .filter((player) => Number(player.team) === side && Number(player.hero_id) > 0)
  .sort((a, b) => Number(a.team_slot) - Number(b.team_slot))
  .map((player) => Number(player.hero_id));

/** Normalise one /live row. Returns null for rows we cannot use. */
export function normalizeLiveRow(row, { nowSeconds = Date.now() / 1000 } = {}) {
  const matchId = Number(row?.match_id);
  if (!Number.isInteger(matchId) || matchId <= 0) return null;
  const radiantTeamId = Number(row.team_id_radiant || 0);
  const direTeamId = Number(row.team_id_dire || 0);
  if (!radiantTeamId || !direTeamId || radiantTeamId === direTeamId) return null;
  const lastUpdate = Number(row.last_update_time || 0);
  if (lastUpdate && nowSeconds - lastUpdate > MAX_FEED_AGE_SECONDS) return null;

  const radiantPicks = sideHeroes(row.players, 0);
  const direPicks = sideHeroes(row.players, 1);
  const gameTime = Number(row.game_time || 0);
  const picksComplete = radiantPicks.length === 5 && direPicks.length === 5;
  return {
    matchId,
    leagueId: Number(row.league_id || 0),
    seriesId: row.series_id != null ? String(row.series_id) : null,
    radiantTeamId, direTeamId,
    radiantName: row.team_name_radiant || null,
    direName: row.team_name_dire || null,
    radiantPicks, direPicks,
    gameTime,
    radiantLead: Number.isFinite(Number(row.radiant_lead)) ? Number(row.radiant_lead) : null,
    radiantScore: Number(row.radiant_score || 0),
    direScore: Number(row.dire_score || 0),
    spectators: Number(row.spectators || 0),
    delay: Number(row.delay || 0),
    lastUpdateAt: lastUpdate ? new Date(lastUpdate * 1000).toISOString() : null,
    phase: gameTime <= 0 || !picksComplete ? "draft" : "game",
    picksComplete,
  };
}

/**
 * Poll /live, store every professional game, and predict the ones whose draft is
 * finished. `leagueFilter` limits work to tracked tournaments; pass null to take
 * every game that carries a league id.
 */
export async function syncLiveGames(db, { leagueFilter = null, nowSeconds = Date.now() / 1000 } = {}) {
  const rows = await opendota.live(db);
  if (!Array.isArray(rows)) return { seen: 0, stored: 0, predicted: 0 };

  const ratings = loadRatings();
  const draftModel = loadDraftModel();
  const at = nowIso();
  const seenIds = new Set();
  let stored = 0;
  let predicted = 0;
  const games = [];

  for (const raw of rows) {
    const game = normalizeLiveRow(raw, { nowSeconds });
    if (!game) continue;
    // A league id is the marker of an organised match; pubs carry 0.
    if (!game.leagueId) continue;
    if (leagueFilter && !leagueFilter.has(game.leagueId)) continue;

    seenIds.add(game.matchId);
    upsertTeam(db, { teamId: game.radiantTeamId, name: game.radiantName });
    upsertTeam(db, { teamId: game.direTeamId, name: game.direName });

    let draft = null;
    let liveState = null;
    if (game.picksComplete) {
      draft = predictDraftMap({
        radiantTeamId: game.radiantTeamId, direTeamId: game.direTeamId,
        radiantPicks: game.radiantPicks, direPicks: game.direPicks,
        ratings, draftModel,
      });
      const freezeOnTime = game.gameTime <= DRAFT_FREEZE_MAX_SECONDS;
      const frozen = freezeOnTime ? freezePrediction(db, {
        scope: "map", subjectKey: game.matchId, leagueId: game.leagueId,
        modelKind: "draft", modelId: draft.modelId,
        sideA: game.radiantTeamId, sideB: game.direTeamId,
        probabilityA: draft.probabilityRadiant, bestOf: 1,
        features: {
          radiantPicks: game.radiantPicks, direPicks: game.direPicks,
          prior: draft.priorProbabilityRadiant, draftDelta: draft.draftDelta,
          available: draft.available, gameTimeAtFreeze: game.gameTime,
        },
        evaluationEligible: true,
        timingClass: "draft_on_time",
      }) : { inserted: false, skipped: "draft_too_late" };
      if (frozen.inserted) predicted += 1;
      liveState = predictLiveState({ draftProbabilityRadiant: draft.probabilityRadiant, game });
      draft.freeze = freezeOnTime
        ? { eligible: true, timingClass: "draft_on_time" }
        : { eligible: false, timingClass: "draft_late", maxGameTimeSeconds: DRAFT_FREEZE_MAX_SECONDS };
    }

    const payload = { ...game, draft, liveState };
    db.prepare(`INSERT INTO live_games(match_id, league_id, series_id, radiant_team_id, dire_team_id, radiant_name, dire_name,
                  phase, game_time, radiant_lead, radiant_score, dire_score, radiant_picks_json, dire_picks_json,
                  payload_json, first_seen_at, last_seen_at, closed_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
                ON CONFLICT(match_id) DO UPDATE SET
                  phase=excluded.phase, game_time=excluded.game_time, radiant_lead=excluded.radiant_lead,
                  radiant_score=excluded.radiant_score, dire_score=excluded.dire_score,
                  radiant_picks_json=excluded.radiant_picks_json, dire_picks_json=excluded.dire_picks_json,
                  payload_json=excluded.payload_json, last_seen_at=excluded.last_seen_at, closed_at=NULL`)
      .run(game.matchId, game.leagueId, game.seriesId, game.radiantTeamId, game.direTeamId,
        game.radiantName, game.direName, game.phase, game.gameTime, game.radiantLead,
        game.radiantScore, game.direScore,
        JSON.stringify(game.radiantPicks), JSON.stringify(game.direPicks),
        JSON.stringify(payload), at, at);
    stored += 1;
    games.push(payload);
  }

  // Games that dropped out of the feed long enough ago are over.
  const cutoff = new Date(Date.now() - CLOSE_AFTER_SECONDS * 1000).toISOString();
  const closed = db.prepare("UPDATE live_games SET closed_at = ? WHERE closed_at IS NULL AND last_seen_at < ?").run(at, cutoff);

  return { seen: rows.length, stored, predicted, closed: Number(closed.changes), games };
}

/** Open live games with their stored prediction payload, newest first. */
export function currentLiveGames(db, { leagueId = null } = {}) {
  const rows = leagueId
    ? db.prepare("SELECT * FROM live_games WHERE closed_at IS NULL AND league_id = ? ORDER BY last_seen_at DESC").all(leagueId)
    : db.prepare("SELECT * FROM live_games WHERE closed_at IS NULL ORDER BY last_seen_at DESC").all();
  return rows.map((row) => {
    let payload = null;
    try { payload = JSON.parse(row.payload_json); } catch { payload = null; }
    const frozen = db.prepare("SELECT probability_a, model_id, created_at FROM predictions WHERE scope='map' AND subject_key=? AND model_kind='draft'")
      .get(String(row.match_id));
    return {
      ...(payload ?? {}),
      matchId: Number(row.match_id),
      leagueId: Number(row.league_id),
      lastSeenAt: row.last_seen_at,
      frozenDraftProbabilityRadiant: frozen ? Number(frozen.probability_a) : null,
      frozenAt: frozen?.created_at ?? null,
    };
  });
}

/**
 * Adaptive poll interval: fast while a draft is on screen, slow when nothing is
 * running. Keeps the free API tier usable around the clock.
 */
export function livePollIntervalSeconds(games, { remainingBudget = Infinity } = {}) {
  const open = games.filter((game) => !game.closedAt);
  const drafting = open.some((game) => game.phase === "draft");
  let interval = !open.length ? Number(process.env.LIVE_IDLE_INTERVAL_SECONDS || 300)
    : drafting ? Number(process.env.LIVE_DRAFT_INTERVAL_SECONDS || 20)
      : Number(process.env.LIVE_GAME_INTERVAL_SECONDS || 90);
  if (remainingBudget < 150) interval = Math.max(interval, 600);
  else if (remainingBudget < 400) interval = Math.max(interval, 300);
  return interval;
}
