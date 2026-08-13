import { OPENDOTA_TEAMS } from "./live-series.mjs";

const finite = (value) => Number.isFinite(Number(value));

function seriesScore(leagueMaps, seriesId, radiantTeam, direTeam, teams) {
  let radiant = 0; let dire = 0; let seriesType = null;
  for (const map of leagueMaps ?? []) {
    if (String(map.series_id || "") !== String(seriesId || "") || typeof map.radiant_win !== "boolean") continue;
    const winner = teams.get(Number(map.radiant_win ? map.radiant_team_id : map.dire_team_id));
    if (winner === radiantTeam) radiant += 1;
    else if (winner === direTeam) dire += 1;
    if (finite(map.series_type)) seriesType = Number(map.series_type);
  }
  return { radiant, dire, bestOf: seriesType === 2 ? 5 : seriesType === 1 ? 3 : seriesType === 0 ? 1 : null };
}

export function liveDraftsFromOpenDota(rows, { leagueId = 19719, nowSeconds = Date.now() / 1000, maxAgeSeconds = 300, teams = OPENDOTA_TEAMS, leagueMaps = [] } = {}) {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (Number(row.league_id) !== Number(leagueId)) return [];
    if (finite(row.last_update_time) && nowSeconds - Number(row.last_update_time) > maxAgeSeconds) return [];
    const radiantTeam = teams.get(Number(row.team_id_radiant));
    const direTeam = teams.get(Number(row.team_id_dire));
    if (!radiantTeam || !direTeam || radiantTeam === direTeam) return [];
    const livePlayers = (side) => (row.players ?? []).filter((player) => Number(player.team) === side && Number(player.hero_id) > 0)
      .sort((a, b) => Number(a.team_slot) - Number(b.team_slot)).slice(0, 5)
      .map((player) => ({ accountId: Number(player.account_id || 0), heroId: Number(player.hero_id), name: player.name ? String(player.name) : null }));
    const radiantPlayers = livePlayers(0);
    const direPlayers = livePlayers(1);
    const radiantPicks = radiantPlayers.map((player) => player.heroId);
    const direPicks = direPlayers.map((player) => player.heroId);
    const score = seriesScore(leagueMaps, row.series_id, radiantTeam, direTeam, teams);
    return [{
      matchId: String(row.match_id), seriesId: String(row.series_id || ""), radiantTeam, direTeam, radiantPicks, direPicks,
      radiantPlayers, direPlayers,
      gameTime: Number(row.game_time || 0), delay: Number(row.delay || 0), radiantScore: Number(row.radiant_score || 0), direScore: Number(row.dire_score || 0),
      radiantLead: finite(row.radiant_lead) ? Number(row.radiant_lead) : null, spectators: finite(row.spectators) ? Number(row.spectators) : null,
      seriesScoreRadiant: score.radiant, seriesScoreDire: score.dire, seriesBestOf: score.bestOf,
      lastUpdateAt: finite(row.last_update_time) ? new Date(Number(row.last_update_time) * 1000).toISOString() : null,
      phase: Number(row.game_time || 0) <= 0 || radiantPicks.length + direPicks.length < 10 ? "draft" : "game",
    }];
  }).sort((a, b) => Date.parse(b.lastUpdateAt || "") - Date.parse(a.lastUpdateAt || ""));
}
