export const OPENDOTA_TEAMS = new Map([
  [10182357, "1w"], [10150413, "1w"], [8291895, "1w"], [9467224, "aurora"], [8255888, "betboom"], [9247354, "falcons"],
  [9964962, "gamerlegion"], [10149530, "l1ga"], [10150538, "lgd"], [2163, "liquid"],
  [10136357, "nigma"], [2586976, "og"], [9572001, "parivision"], [9824702, "parivision"],
  [5017210, "resilience"], [7119388, "spirit"], [726228, "vg"], [8261500, "xtreme"],
  [9823272, "yandex"],
]);

function groupedSeriesFromMaps(maps, teams) {
  const grouped = new Map();
  const activeByPair = new Map();
  const ordered = [...maps].sort((left, right) => Number(left.start_time || 0) - Number(right.start_time || 0) || Number(left.match_id || 0) - Number(right.match_id || 0));
  for (const map of ordered) {
    const radiantTeam = teams.get(Number(map.radiant_team_id));
    const direTeam = teams.get(Number(map.dire_team_id));
    if (!radiantTeam || !direTeam || radiantTeam === direTeam) continue;
    const pair = [radiantTeam, direTeam].sort().join("|");
    const start = Number(map.start_time) || 0;
    const explicitKey = map.series_id ? String(map.series_id) : null;
    const nearby = activeByPair.get(pair);
    const isNearby = nearby && start > 0 && nearby.lastStart > 0 && start - nearby.lastStart <= 12 * 60 * 60;
    let series = explicitKey ? grouped.get(explicitKey) : null;
    if (!series && isNearby && (!explicitKey || nearby.synthetic)) {
      series = nearby;
      if (explicitKey && series.synthetic) {
        grouped.delete(series.key);
        series.key = explicitKey;
        series.seriesId = explicitKey;
        series.synthetic = false;
        grouped.set(explicitKey, series);
      }
    }
    if (!series) {
      const key = explicitKey ?? `missing:${map.match_id}`;
      series = {
        key, seriesId: key, teamA: radiantTeam, teamB: direTeam, winsA: 0, winsB: 0,
        startTime: Number.POSITIVE_INFINITY, lastStart: 0, seriesType: Number(map.series_type || 1), mapIds: [], synthetic: !explicitKey,
      };
      grouped.set(key, series);
    }
    if (typeof map.radiant_win === "boolean") {
      const winner = map.radiant_win ? radiantTeam : direTeam;
      if (winner === series.teamA) series.winsA += 1;
      else series.winsB += 1;
    }
    if (Number.isFinite(start) && start > 0) series.startTime = Math.min(series.startTime, start);
    if (start > 0) series.lastStart = Math.max(series.lastStart, start);
    series.mapIds.push(Number(map.match_id));
    activeByPair.set(pair, series);
  }
  return [...grouped.values()].map((series) => ({
    seriesId: series.seriesId, teamA: series.teamA, teamB: series.teamB, winsA: series.winsA, winsB: series.winsB,
    startTime: Number.isFinite(series.startTime) && series.startTime !== Number.POSITIVE_INFINITY ? series.startTime : 0,
    seriesType: series.seriesType, mapIds: series.mapIds,
    bestOf: series.seriesType === 2 ? 5 : series.seriesType === 0 ? 1 : 3,
  }));
}

export function completedSeriesFromMaps(maps, teams = OPENDOTA_TEAMS) {
  return groupedSeriesFromMaps(maps, teams)
    .filter((series) => Math.max(series.winsA, series.winsB) >= Math.floor(series.bestOf / 2) + 1)
    .sort((a, b) => a.startTime - b.startTime);
}

export function inProgressSeriesFromMaps(maps, teams = OPENDOTA_TEAMS) {
  return groupedSeriesFromMaps(maps, teams)
    .filter((series) => series.winsA + series.winsB > 0 && Math.max(series.winsA, series.winsB) < Math.floor(series.bestOf / 2) + 1)
    .sort((a, b) => a.startTime - b.startTime);
}

function chronologicalMaps(left, right) {
  const startLeft = Number(left.startTime) > 0 ? Number(left.startTime) : Number.POSITIVE_INFINITY;
  const startRight = Number(right.startTime) > 0 ? Number(right.startTime) : Number.POSITIVE_INFINITY;
  return startLeft - startRight || Number(left.matchId) - Number(right.matchId);
}

function uniqueMaps(maps) {
  const seen = new Set();
  return maps.filter((map) => {
    const key = String(map.matchId);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mapsInScheduleWindow(maps, scheduledMs) {
  return maps.filter((map) => {
    if (!Number.isFinite(scheduledMs)) return true;
    const startMs = Number(map.startTime) * 1000;
    if (!Number.isFinite(startMs) || startMs <= 0) return true;
    return Math.abs(startMs - scheduledMs) <= 36 * 60 * 60 * 1000;
  });
}

function latestPairCluster(maps) {
  const sorted = [...maps].sort(chronologicalMaps);
  if (!sorted.length) return [];
  const latest = Number(sorted.at(-1).startTime) || 0;
  if (!latest) return sorted;
  return sorted.filter((map) => {
    const start = Number(map.startTime) || 0;
    return !start || latest - start <= 12 * 60 * 60;
  });
}

export function selectSeriesMaps(row, maps) {
  const seriesId = row.liveSeriesId || row.seriesId || "";
  const liveMatchId = row.liveMatchId ? String(row.liveMatchId) : "";
  const scheduledMs = Date.parse(row.scheduledAt || "");
  const samePair = (map) => {
    const sides = new Set([map.radiantTeam, map.direTeam]);
    return sides.has(row.teamA) && sides.has(row.teamB);
  };
  const bySeries = seriesId ? maps.filter((map) => String(map.seriesId || "") === String(seriesId)) : [];
  const byLive = liveMatchId ? maps.filter((map) => String(map.matchId) === liveMatchId) : [];
  const samePairMaps = maps.filter(samePair);
  const byPair = mapsInScheduleWindow(samePairMaps, scheduledMs);
  const pairMaps = byPair.length ? byPair : latestPairCluster(samePairMaps);
  return uniqueMaps([...bySeries, ...pairMaps, ...byLive]).sort(chronologicalMaps);
}

export function seriesWinsFromMaps(teamA, teamB, maps) {
  let winsA = 0;
  let winsB = 0;
  for (const map of maps) {
    if (!map.winner) continue;
    if (map.winner === teamA) winsA += 1;
    else if (map.winner === teamB) winsB += 1;
  }
  return { winsA, winsB };
}
