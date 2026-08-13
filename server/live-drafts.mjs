import { OPENDOTA_TEAMS } from "./live-series.mjs";

const finite = (value) => Number.isFinite(Number(value));

export function liveDraftsFromOpenDota(rows, { leagueId = 19719, nowSeconds = Date.now() / 1000, maxAgeSeconds = 300, teams = OPENDOTA_TEAMS } = {}) {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (Number(row.league_id) !== Number(leagueId)) return [];
    if (finite(row.last_update_time) && nowSeconds - Number(row.last_update_time) > maxAgeSeconds) return [];
    const radiantTeam = teams.get(Number(row.team_id_radiant));
    const direTeam = teams.get(Number(row.team_id_dire));
    if (!radiantTeam || !direTeam || radiantTeam === direTeam) return [];
    const radiantPicks = (row.players ?? []).filter((player) => Number(player.team) === 0 && Number(player.hero_id) > 0)
      .sort((a, b) => Number(a.team_slot) - Number(b.team_slot)).map((player) => Number(player.hero_id)).slice(0, 5);
    const direPicks = (row.players ?? []).filter((player) => Number(player.team) === 1 && Number(player.hero_id) > 0)
      .sort((a, b) => Number(a.team_slot) - Number(b.team_slot)).map((player) => Number(player.hero_id)).slice(0, 5);
    return [{
      matchId: String(row.match_id), seriesId: String(row.series_id || ""), radiantTeam, direTeam, radiantPicks, direPicks,
      gameTime: Number(row.game_time || 0), delay: Number(row.delay || 0), radiantScore: Number(row.radiant_score || 0), direScore: Number(row.dire_score || 0),
      lastUpdateAt: finite(row.last_update_time) ? new Date(Number(row.last_update_time) * 1000).toISOString() : null,
      phase: Number(row.game_time || 0) <= 0 || radiantPicks.length + direPicks.length < 10 ? "draft" : "game",
    }];
  }).sort((a, b) => Date.parse(b.lastUpdateAt || "") - Date.parse(a.lastUpdateAt || ""));
}
