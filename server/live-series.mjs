export const OPENDOTA_TEAMS = new Map([
  [10182357, "1w"], [9467224, "aurora"], [8255888, "betboom"], [9247354, "falcons"],
  [9964962, "gamerlegion"], [10149530, "l1ga"], [10150538, "lgd"], [2163, "liquid"],
  [10136357, "nigma"], [2586976, "og"], [9572001, "parivision"], [9824702, "parivision"],
  [5017210, "resilience"], [7119388, "spirit"], [726228, "vg"], [8261500, "xtreme"],
  [9823272, "yandex"],
]);

export function completedSeriesFromMaps(maps, teams = OPENDOTA_TEAMS) {
  const grouped = new Map();
  for (const map of maps) {
    const radiantTeam = teams.get(Number(map.radiant_team_id));
    const direTeam = teams.get(Number(map.dire_team_id));
    if (!radiantTeam || !direTeam || radiantTeam === direTeam || !map.series_id) continue;
    const key = String(map.series_id);
    const series = grouped.get(key) || { seriesId: key, teamA: radiantTeam, teamB: direTeam, winsA: 0, winsB: 0, startTime: Number(map.start_time), mapIds: [] };
    const winner = map.radiant_win === true ? radiantTeam : direTeam;
    if (winner === series.teamA) series.winsA += 1; else series.winsB += 1;
    series.startTime = Math.min(series.startTime, Number(map.start_time));
    series.mapIds.push(Number(map.match_id));
    grouped.set(key, series);
  }
  return [...grouped.values()].filter((series) => Math.max(series.winsA, series.winsB) >= 2).sort((a, b) => a.startTime - b.startTime);
}
