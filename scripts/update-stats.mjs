import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const API = "https://api.opendota.com/api";
const ROOT = process.cwd();
const CACHE = path.join(ROOT, "work", "opendota-cache");
const MATCH_CACHE = path.join(CACHE, "matches");
const OUTPUT = path.join(ROOT, "public", "team-stats.json");
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const HALF_LIFE_DAYS = 45;
const ROSTER_WEIGHTS = { 5: 1, 4: 0.25, 3: 0.07 };
const REQUEST_GAP_MS = 1100;

const ROSTER_PROJECTIONS = {
  lgd: {
    kind: "four_of_five_proxy",
    reliability: 0.65,
    replacementOut: { accountId: 1026694469, name: "TaiLung" },
    replacementIn: { accountId: 94054712, name: "Topson" },
    officialGames: 0,
    note: "No official games with Topson; historical matches use the other four LGD players as a proxy.",
  },
};

const TEAM_IDENTITY = {
  parivision: {
    canonicalName: "PARIVISION",
    alternateOpenDotaIds: [9824702],
    aliases: ["PARIVISION", "PARI VISION", "PVISION", "TEAM VISION"],
  },
  betboom: {
    canonicalName: "BETBOOM",
    alternateOpenDotaIds: [],
    aliases: ["BETBOOM", "BETBOOM TEAM", "BB TEAM", "BBT", "BOOMBOYS"],
  },
};

const DISPLAY_NAMES = {
  "1w": "1w", aurora: "Aurora", betboom: "BETBOOM", falcons: "Falcons",
  gamerlegion: "GamerLegion", l1ga: "L1ga", lgd: "LGD", liquid: "Liquid",
  nigma: "Nigma", og: "OG", parivision: "PARIVISION", resilience: "Resilience",
  spirit: "Spirit", vg: "VG", xtreme: "Xtreme", yandex: "Yandex",
};

const DEFAULT_ALIASES = {
  "1w": ["1W", "1WIN", "1WIN TEAM"],
  aurora: ["AURORA", "AURORA GAMING"],
  betboom: ["BETBOOM", "BETBOOM TEAM", "BB TEAM", "BBT", "BOOMBOYS"],
  falcons: ["FALCONS", "TEAM FALCONS"],
  gamerlegion: ["GAMERLEGION", "GAMER LEGION"],
  l1ga: ["L1GA", "L1GA TEAM"],
  lgd: ["LGD", "LGD GAMING"],
  liquid: ["LIQUID", "TEAM LIQUID"],
  nigma: ["NIGMA", "NIGMA GALAXY"],
  og: ["OG"],
  parivision: ["PARIVISION", "PARI VISION", "PVISION", "TEAM VISION"],
  resilience: ["RESILIENCE", "TEAM RESILIENCE"],
  spirit: ["SPIRIT", "TEAM SPIRIT"],
  vg: ["VG", "VICI GAMING"],
  xtreme: ["XTREME", "XTREME GAMING"],
  yandex: ["YANDEX", "YANDEX TEAM"],
};

const TEAMS = [
  ["1w", 10182357, [331855530, 346412363, 136829091, 93618577, 86698277]],
  ["aurora", 9467224, [256156323, 124801257, 320219866, 126842529, 301750126]],
  ["betboom", 8255888, [317880638, 480412663, 165564598, 196878136, 172099728]],
  ["falcons", 9247354, [25907144, 100058342, 10366616, 183719386, 898455820]],
  ["gamerlegion", 9964962, [160119017, 90423751, 191362875, 154974246, 206642367]],
  ["l1ga", 10149530, [140251702, 145065875, 92487440, 320017600, 123787715]],
  ["lgd", 10150538, [177203952, 1026694469, 292921272, 105045291, 81306398]],
  ["liquid", 2163, [152962063, 77490514, 201358612, 16497807, 97590558]],
  ["nigma", 10136357, [138880576, 152168157, 101356886, 111620041, 210053851]],
  ["og", 2586976, [355168766, 100594231, 324277900, 155494381, 132309493]],
  ["parivision", 9572001, [164199202, 106573901, 73401082, 1044002267, 195108598]],
  ["resilience", 5017210, [150961567, 145957968, 315272623, 249835593, 170896543]],
  ["spirit", 7119388, [321580662, 302214028, 106305042, 847565596, 218231587]],
  ["vg", 726228, [137129583, 320252024, 111114687, 118134220, 157475523]],
  ["xtreme", 8261500, [898754153, 129958758, 94296097, 101695162, 173978074]],
  ["yandex", 9823272, [312436974, 171262902, 93817671, 103735745, 56351509]],
].map(([id, openDotaId, roster]) => {
  const historicalRoster = roster.sort((a, b) => a - b);
  const projection = ROSTER_PROJECTIONS[id] ?? null;
  const identity = TEAM_IDENTITY[id] ?? null;
  const tiRoster = projection
    ? historicalRoster.filter((accountId) => accountId !== projection.replacementOut.accountId)
      .concat(projection.replacementIn.accountId)
      .sort((a, b) => a - b)
    : historicalRoster;
  return {
    id,
    openDotaId,
    openDotaIds: [openDotaId, ...(identity?.alternateOpenDotaIds ?? [])],
    canonicalName: identity?.canonicalName ?? DISPLAY_NAMES[id] ?? id,
    aliases: [...new Set([...(DEFAULT_ALIASES[id] ?? [id]), ...(identity?.aliases ?? [])])],
    roster: historicalRoster,
    tiRoster,
    rosterProjection: projection,
  };
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let nextRequestAt = 0;

async function cachedJson(file, maxAgeMs) {
  try {
    if (maxAgeMs !== Infinity) {
      const info = await stat(file);
      if (Date.now() - info.mtimeMs > maxAgeMs) return null;
    }
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function apiJson(endpoint, cacheFile, maxAgeMs = Infinity) {
  const cached = await cachedJson(cacheFile, maxAgeMs);
  if (cached) return cached;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const wait = Math.max(0, nextRequestAt - Date.now());
    if (wait) await sleep(wait);
    nextRequestAt = Date.now() + REQUEST_GAP_MS;
    let response;
    try {
      response = await fetch(`${API}${endpoint}`, {
        headers: { "user-agent": "TI26Predictor/0.2 (local personal analytics)" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (attempt === 4) throw error;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (response.ok) {
      const data = await response.json();
      await writeFile(cacheFile, JSON.stringify(data));
      return data;
    }
    if (response.status !== 429 && response.status < 500) {
      throw new Error(`${endpoint}: OpenDota returned ${response.status}`);
    }
    await sleep(1000 * 2 ** attempt);
  }
  throw new Error(`${endpoint}: retry limit reached`);
}

function sameIds(actual, expected) {
  return actual.length === expected.length && actual.every((id, index) => id === expected[index]);
}

function rosterOverlap(actual, expected) {
  const wanted = new Set(expected);
  return actual.filter((id) => wanted.has(id)).length;
}

function sideOf(detail, openDotaIds) {
  if (openDotaIds.includes(Number(detail.radiant_team_id))) return "radiant";
  if (openDotaIds.includes(Number(detail.dire_team_id))) return "dire";
  return null;
}

function normalizedTeamName(name) {
  return String(name ?? "").toLowerCase().replace(/[^a-zа-я0-9]/giu, "");
}

function resolveTargetTeam(opponentId, opponentName, targetByOpenDotaId, targetByAlias) {
  return targetByOpenDotaId.get(Number(opponentId))
    ?? targetByAlias.get(normalizedTeamName(opponentName))
    ?? null;
}

function lineup(detail, side) {
  return (detail.players ?? [])
    .filter((player) => side === "radiant" ? player.player_slot < 128 : player.player_slot >= 128)
    .map((player) => Number(player.account_id))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
}

function lineupKey(ids) {
  return ids.join("-");
}

async function mapLimit(items, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function tournamentName(match) {
  return match.league_name || match.name || `League ${match.leagueid}`;
}

async function getMatch(matchId) {
  return apiJson(`/matches/${matchId}`, path.join(MATCH_CACHE, `${matchId}.json`));
}

async function collectTeam(team, cutoffSeconds) {
  const lists = await Promise.all(team.openDotaIds.map((openDotaId) => {
    const listFile = path.join(CACHE, `team-${openDotaId}-matches.json`);
    return apiJson(`/teams/${openDotaId}/matches`, listFile, 6 * 60 * 60 * 1000);
  }));
  const all = [...new Map(lists.flat().map((match) => [Number(match.match_id), match])).values()];
  const recent = all.filter((match) => Number(match.start_time) >= cutoffSeconds);
  const groups = new Map();
  for (const match of recent) {
    const key = String(match.leagueid || 0);
    groups.set(key, [...(groups.get(key) ?? []), match]);
  }

  const accepted = [];
  const tournaments = [];
  const orderedGroups = [...groups.entries()].sort((a, b) =>
    Math.max(...b[1].map((match) => match.start_time)) - Math.max(...a[1].map((match) => match.start_time)),
  );

  await mapLimit(orderedGroups, 2, async ([leagueId, matches]) => {
    const ordered = [...matches].sort((a, b) => b.start_time - a.start_time);
    // One representative map is enough to qualify the team's whole tournament.
    // The newest map is deterministic and most likely to reflect the roster that
    // completed the event. All other results come from the cheap team-match list.
    let sample = null;
    let detail = null;
    for (const candidate of ordered.slice(0, 3)) {
      try {
        detail = await getMatch(candidate.match_id);
        sample = candidate;
        break;
      } catch (error) {
        process.stderr.write(`\nSample ${candidate.match_id} unavailable: ${error.message}\n`);
      }
    }
    const side = detail ? sideOf(detail, team.openDotaIds) : null;
    const actual = side ? lineup(detail, side) : [];
    const overlap = rosterOverlap(actual, team.tiRoster);
    const rosterWeight = ROSTER_WEIGHTS[overlap] ?? 0;
    const rejection = !sample || !side || rosterWeight === 0 ? {
      matchId: sample?.match_id ?? null,
      expected: team.roster,
      actual,
      reason: !sample ? "sample_unavailable" : !side ? "team_side_not_found" : "sample_roster_mismatch",
    } : null;

    if (rejection) {
      tournaments.push({ leagueId: Number(leagueId), name: tournamentName(matches[0]), included: false, games: matches.length, overlap, rosterWeight: 0, actual, ...rejection });
    } else {
      accepted.push(...matches.map((match) => ({ ...match, rosterWeight, sampledRoster: actual })));
      tournaments.push({
        leagueId: Number(leagueId),
        name: tournamentName(matches[0]),
        included: true,
        overlap,
        rosterWeight,
        actual,
        games: matches.length,
        sampleMatchId: Number(sample.match_id),
      });
    }
  });

  return { team, recentCount: recent.length, recent, accepted, tournaments };
}

function buildSeries(matches, team, leagueId, qualifiedTournament, targetByOpenDotaId, targetByAlias) {
  const ordered = [...matches].sort((a, b) => a.start_time - b.start_time);
  const series = [];
  for (const summary of ordered) {
    const opponentId = Number(summary.opposing_team_id || 0);
    const opponentTarget = resolveTargetTeam(opponentId, summary.opposing_team_name, targetByOpenDotaId, targetByAlias);
    const opponentRosterStatus = opponentTarget
      ? (qualifiedTournament.has(`${opponentTarget.id}|${leagueId}`)
        ? (opponentTarget.rosterProjection ? "proxy" : "current")
        : "different")
      : "unverified";
    const won = Boolean(summary.radiant) === Boolean(summary.radiant_win);
    const previous = series.at(-1);
    const sameSeries = previous
      && previous.opponentOpenDotaId === opponentId
      && Number(summary.start_time) - previous.lastMapTime <= 8 * 60 * 60;
    const target = sameSeries ? previous : {
      opponentOpenDotaId: opponentId,
      opponentName: opponentTarget?.canonicalName ?? summary.opposing_team_name ?? "Unknown team",
      reportedName: summary.opposing_team_name ?? "Unknown team",
      opponentTiId: opponentTarget?.id ?? null,
      opponentRosterStatus,
      startTime: Number(summary.start_time),
      lastMapTime: Number(summary.start_time),
      wins: 0,
      losses: 0,
      maps: [],
    };
    target.lastMapTime = Number(summary.start_time);
    target[won ? "wins" : "losses"] += 1;
    target.maps.push({ matchId: Number(summary.match_id), startTime: Number(summary.start_time), won });
    if (!sameSeries) series.push(target);
  }
  return series.sort((a, b) => b.startTime - a.startTime);
}

function collapseToSeries(games) {
  const ordered = [...games].sort((a, b) => a.startTime - b.startTime);
  const groups = [];
  for (const game of ordered) {
    const previous = groups.at(-1);
    const same = previous && previous.leagueId === game.leagueId
      && previous.targetLineup === game.targetLineup && previous.opponentLineup === game.opponentLineup
      && game.startTime - previous.lastMapTime <= 8 * 60 * 60;
    const series = same ? previous : { ...game, lastMapTime: game.startTime, wins: 0, losses: 0, mapWeights: [] };
    series.lastMapTime = game.startTime;
    series[game.targetWon ? "wins" : "losses"] += 1;
    series.mapWeights.push(game.rosterWeight ?? 1);
    if (!same) groups.push(series);
  }
  return groups.map((series) => {
    const maps = series.wins + series.losses;
    const decisive = Math.abs(series.wins - series.losses) / Math.max(1, maps);
    return {
      ...series,
      targetScore: series.wins / Math.max(1, maps),
      rosterWeight: series.mapWeights.reduce((sum, value) => sum + value, 0) / series.mapWeights.length,
      seriesInformation: maps === 1 ? 0.6 : 0.72 + 0.28 * decisive,
    };
  });
}

function fitBradleyTerry(seriesList, targetLineups) {
  const nodes = new Set(targetLineups);
  seriesList.forEach((series) => { nodes.add(series.targetLineup); nodes.add(series.opponentLineup); });
  const ratings = Object.fromEntries([...nodes].map((node) => [node, 0]));
  const nowSeconds = Date.now() / 1000;
  const weighted = seriesList.map((series) => ({
    ...series,
    weight: (series.rosterWeight ?? 1) * series.seriesInformation
      * 0.5 ** (((nowSeconds - series.startTime) / 86400) / HALF_LIFE_DAYS),
  }));

  for (let iteration = 0; iteration < 700; iteration += 1) {
    const gradient = Object.fromEntries([...nodes].map((node) => [node, -0.025 * ratings[node]]));
    for (const game of weighted) {
      const a = game.targetLineup;
      const b = game.opponentLineup;
      const expected = 1 / (1 + Math.exp(-(ratings[a] - ratings[b])));
      const error = game.weight * (game.targetScore - expected);
      gradient[a] += error;
      gradient[b] -= error;
    }
    const rate = 0.018 / Math.sqrt(1 + iteration / 120);
    for (const node of nodes) ratings[node] += rate * gradient[node];
  }
  return { ratings, weighted };
}

function confidenceLabel(effectiveGames, directGames) {
  if (directGames >= 3 && effectiveGames >= 12) return "high";
  if (effectiveGames >= 7) return "medium";
  return "low";
}

async function main() {
  await mkdir(MATCH_CACHE, { recursive: true });
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  const cutoffSeconds = Math.floor((Date.now() - YEAR_MS) / 1000);
  const results = [];

  for (const team of TEAMS) {
    process.stdout.write(`Checking ${team.id}... `);
    const result = await collectTeam(team, cutoffSeconds);
    results.push(result);
    const included = result.tournaments.filter((item) => item.included).length;
    const excluded = result.tournaments.length - included;
    process.stdout.write(`${result.accepted.length} weighted-roster maps, ${included} tournaments kept, ${excluded} rejected\n`);
  }

  const targetLineups = Object.fromEntries(TEAMS.map((team) => [team.id, lineupKey(team.tiRoster)]));
  const targetByOpenDotaId = new Map(TEAMS.flatMap((team) => team.openDotaIds.map((openDotaId) => [Number(openDotaId), team])));
  const targetByAlias = new Map(TEAMS.flatMap((team) => team.aliases.map((alias) => [normalizedTeamName(alias), team])));
  const qualifiedTournament = new Set(results.flatMap((result) =>
    result.tournaments.filter((item) => item.included).map((item) => `${result.team.id}|${item.leagueId}`),
  ));
  const uniqueGames = new Map();

  for (const result of results) {
    for (const summary of result.accepted) {
      const opponentId = Number(summary.opposing_team_id);
      const opponentTarget = resolveTargetTeam(opponentId, summary.opposing_team_name, targetByOpenDotaId, targetByAlias);
      if (opponentTarget && !qualifiedTournament.has(`${opponentTarget.id}|${Number(summary.leagueid || 0)}`)) {
        continue;
      }
      const targetIsRadiant = Boolean(summary.radiant);
      const game = {
        matchId: Number(summary.match_id),
        leagueId: Number(summary.leagueid || 0),
        leagueName: tournamentName(summary),
        startTime: Number(summary.start_time),
        targetId: result.team.id,
        targetWon: targetIsRadiant === Boolean(summary.radiant_win),
        rosterWeight: summary.rosterWeight ?? 1,
        targetLineup: targetLineups[result.team.id],
        opponentLineup: opponentTarget
          ? targetLineups[opponentTarget.id]
          : `external:${opponentId || summary.opposing_team_name || "unknown"}:league:${Number(summary.leagueid || 0)}`,
      };
      if (!uniqueGames.has(game.matchId)) uniqueGames.set(game.matchId, game);
    }
  }
  const games = [...uniqueGames.values()];
  const series = collapseToSeries(games);
  const { ratings, weighted } = fitBradleyTerry(series, Object.values(targetLineups));
  const pairwise = {};

  for (let i = 0; i < TEAMS.length; i += 1) {
    for (let j = i + 1; j < TEAMS.length; j += 1) {
      const a = TEAMS[i];
      const b = TEAMS[j];
      const lineupA = targetLineups[a.id];
      const lineupB = targetLineups[b.id];
      const indirectMap = 1 / (1 + Math.exp(-(ratings[lineupA] - ratings[lineupB])));
      const indirectSeriesProbability = indirectMap * indirectMap * (3 - 2 * indirectMap);
      let directWins = 0;
      let directGames = 0;
      for (const game of weighted) {
        const isForward = game.targetLineup === lineupA && game.opponentLineup === lineupB;
        const isReverse = game.targetLineup === lineupB && game.opponentLineup === lineupA;
        if (!isForward && !isReverse) continue;
        directGames += game.weight;
        directWins += game.weight * (isForward ? game.targetScore : 1 - game.targetScore);
      }
      const priorGames = 6;
      const mapProbability = (indirectMap * priorGames + directWins) / (priorGames + directGames);
      const seriesProbability = mapProbability * mapProbability * (3 - 2 * mapProbability);
      const sampleA = weighted.filter((game) => game.targetLineup === lineupA).reduce((sum, game) => sum + game.weight, 0);
      const sampleB = weighted.filter((game) => game.targetLineup === lineupB).reduce((sum, game) => sum + game.weight, 0);
      const effectiveGames = Math.min(sampleA, sampleB);
      const rosterProjection = a.rosterProjection ?? b.rosterProjection;
      const adjustedSeriesProbability = rosterProjection
        ? 0.5 + (seriesProbability - 0.5) * rosterProjection.reliability
        : seriesProbability;
      pairwise[`${a.id}|${b.id}`] = {
        probabilityA: Math.round(Math.min(0.93, Math.max(0.07, adjustedSeriesProbability)) * 1000) / 10,
        mapProbabilityA: Math.round(mapProbability * 1000) / 10,
        directEffectiveGames: Math.round(directGames * 10) / 10,
        modelEffectiveGames: Math.round(effectiveGames * 10) / 10,
        source: rosterProjection ? "roster_proxy" : directGames >= 0.75 ? "head_to_head_and_indirect" : "indirect",
        confidence: rosterProjection ? "low" : confidenceLabel(effectiveGames, directGames),
        rosterReliability: rosterProjection?.reliability ?? 1,
        uncertainty: Math.round(Math.min(0.18, 0.04 + 0.32 / Math.sqrt(4 + effectiveGames)) * 1000) / 1000,
        featureContributions: {
          commonOpponentsPp: Math.round((indirectSeriesProbability - 0.5) * 1000) / 10,
          headToHeadPp: Math.round((seriesProbability - indirectSeriesProbability) * 1000) / 10,
          rosterPp: Math.round((adjustedSeriesProbability - seriesProbability) * 1000) / 10,
        },
      };
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    provider: "OpenDota",
    periodStart: new Date(cutoffSeconds * 1000).toISOString(),
    methodology: {
      exactRosterOnly: false,
      rosterWeights: ROSTER_WEIGHTS,
      tournamentRosterCheck: "newest map sampled once per team and tournament",
      tournamentRejectedBelowThreeOfFive: true,
      recencyHalfLifeDays: HALF_LIFE_DAYS,
      model: "series-level recency-weighted Bradley-Terry; 5/5, 4/5 and 3/5 roster evidence; regularized direct matchup residual; Bo3 conversion; uncertainty exported for Monte Carlo",
      rosterProjection: "When a TI roster has no official games, a four-player historical core is shrunk toward 50% by its reliability coefficient.",
    },
    totals: { uniqueAcceptedGames: games.length, uniqueAcceptedSeries: series.length, apiMatchFilesCached: "local work/opendota-cache/matches" },
    teams: Object.fromEntries(results.map((result) => [result.team.id, {
      openDotaId: result.team.openDotaId,
      openDotaIds: result.team.openDotaIds,
      aliases: result.team.aliases,
      roster: result.team.tiRoster,
      historicalRoster: result.team.roster,
      rosterProjection: result.team.rosterProjection,
      matchesInPeriod: result.recentCount,
      exactRosterGames: result.accepted.filter((game) => game.rosterWeight === 1).length,
      proxyRosterGames: result.accepted.filter((game) => game.rosterWeight < 1).length,
      includedTournaments: result.tournaments.filter((item) => item.included),
      excludedTournaments: result.tournaments.filter((item) => !item.included),
      tournaments: result.tournaments
        .map((tournament) => ({
          leagueId: tournament.leagueId,
          name: tournament.name,
          rosterStatus: tournament.included
            ? (tournament.overlap === 5 ? "current" : "proxy")
            : "different",
          rosterOverlap: tournament.overlap ?? 0,
          rosterWeight: tournament.rosterWeight ?? 0,
          sampleMatchId: tournament.sampleMatchId ?? tournament.matchId ?? null,
          expectedRoster: tournament.expected ?? result.team.roster,
          sampledRoster: tournament.actual ?? result.team.roster,
          reason: tournament.reason ?? null,
          series: buildSeries(
            result.recent.filter((match) => Number(match.leagueid || 0) === tournament.leagueId),
            result.team,
            tournament.leagueId,
            qualifiedTournament,
            targetByOpenDotaId,
            targetByAlias,
          ),
        }))
        .sort((a, b) => (b.series[0]?.startTime ?? 0) - (a.series[0]?.startTime ?? 0)),
    }])),
    pairwise,
  };
  await writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Saved ${OUTPUT} (${games.length} unique accepted games).`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
