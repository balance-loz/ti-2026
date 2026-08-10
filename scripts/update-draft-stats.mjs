import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const API = "https://api.opendota.com/api";
const MATCH_CACHE = path.join(ROOT, "work", "opendota-cache", "matches");
const TEAM_STATS_FILE = path.join(ROOT, "public", "team-stats.json");
const OUTPUT = path.join(ROOT, "public", "draft-stats.json");
const STEAM_CDN = "https://cdn.cloudflare.steamstatic.com";
const PRO_PRIOR_GAMES = 30;
const PATCH_PRIOR_GAMES = 18;
const PAIR_PRIOR_GAMES = 8;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const pairKey = (a, b) => [Number(a), Number(b)].sort((left, right) => left - right).join("|");

function increment(record, key, won) {
  const row = record[key] ?? { games: 0, wins: 0 };
  row.games += 1;
  row.wins += won ? 1 : 0;
  record[key] = row;
}

function sidePlayers(match, radiant) {
  return (match.players ?? []).filter((player) => radiant ? player.player_slot < 128 : player.player_slot >= 128);
}

function teamSide(match, openDotaIds) {
  const ids = new Set(openDotaIds.map(Number));
  if (ids.has(Number(match.radiant_team_id))) return true;
  if (ids.has(Number(match.dire_team_id))) return false;
  return null;
}

async function fetchHeroStats() {
  const response = await fetch(`${API}/heroStats`, {
    headers: { "user-agent": "TI26Predictor/0.3 (local personal analytics)" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`OpenDota heroStats returned ${response.status}`);
  return response.json();
}

async function loadCachedMatches() {
  const files = await readdir(MATCH_CACHE);
  const matches = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const match = JSON.parse(await readFile(path.join(MATCH_CACHE, file), "utf8"));
      if (match?.match_id && Array.isArray(match.players) && match.players.length >= 10) matches.push(match);
    } catch {
      // A partial cache entry must not break the whole draft update.
    }
  }
  return matches;
}

function summarizeCurrentPatch(matches) {
  const patch = Math.max(...matches.map((match) => Number(match.patch || 0)));
  const current = matches.filter((match) => Number(match.patch || 0) === patch);
  const heroPerformance = {};
  const synergy = {};
  const counters = {};
  let radiantWins = 0;

  for (const match of current) {
    const radiantWon = Boolean(match.radiant_win);
    radiantWins += radiantWon ? 1 : 0;
    const radiant = sidePlayers(match, true).map((player) => Number(player.hero_id)).filter(Boolean);
    const dire = sidePlayers(match, false).map((player) => Number(player.hero_id)).filter(Boolean);

    for (const heroId of radiant) increment(heroPerformance, heroId, radiantWon);
    for (const heroId of dire) increment(heroPerformance, heroId, !radiantWon);

    for (const [heroes, won] of [[radiant, radiantWon], [dire, !radiantWon]]) {
      for (let i = 0; i < heroes.length; i += 1) {
        for (let j = i + 1; j < heroes.length; j += 1) increment(synergy, pairKey(heroes[i], heroes[j]), won);
      }
    }
    for (const radiantHero of radiant) {
      for (const direHero of dire) {
        increment(counters, `${radiantHero}|${direHero}`, radiantWon);
        increment(counters, `${direHero}|${radiantHero}`, !radiantWon);
      }
    }
  }

  return {
    patch,
    matches: current,
    radiantWinRate: current.length ? radiantWins / current.length : 0.5,
    heroPerformance,
    synergy,
    counters,
  };
}

function teamHeroSamples(teamStats, patchMatches) {
  const output = {};
  const matchById = new Map(patchMatches.map((match) => [Number(match.match_id), match]));

  for (const [teamId, team] of Object.entries(teamStats.teams)) {
    const allowedIds = new Set();
    for (const tournament of team.tournaments ?? []) {
      if (tournament.rosterStatus !== "current" && tournament.rosterStatus !== "proxy") continue;
      for (const series of tournament.series ?? []) {
        for (const map of series.maps ?? []) allowedIds.add(Number(map.matchId));
      }
    }

    const heroes = {};
    let maps = 0;
    for (const matchId of allowedIds) {
      const match = matchById.get(matchId);
      if (!match) continue;
      const radiant = teamSide(match, team.openDotaIds ?? [team.openDotaId]);
      if (radiant === null) continue;
      const won = radiant === Boolean(match.radiant_win);
      maps += 1;
      for (const player of sidePlayers(match, radiant)) increment(heroes, Number(player.hero_id), won);
    }
    output[teamId] = { maps, heroes };
  }
  return output;
}

function withBayesRate(row, priorRate, priorGames) {
  return (row.wins + priorRate * priorGames) / (row.games + priorGames);
}

async function main() {
  const [rawHeroes, teamStats, cachedMatches] = await Promise.all([
    fetchHeroStats(),
    readFile(TEAM_STATS_FILE, "utf8").then(JSON.parse),
    loadCachedMatches(),
  ]);
  const patchStats = summarizeCurrentPatch(cachedMatches);
  const teamHeroes = teamHeroSamples(teamStats, patchStats.matches);

  const rankedTotals = rawHeroes.reduce((sum, hero) => ({
    picks: sum.picks + Number(hero["7_pick"] || 0),
    wins: sum.wins + Number(hero["7_win"] || 0),
  }), { picks: 0, wins: 0 });
  const rankedBaseline = rankedTotals.picks ? rankedTotals.wins / rankedTotals.picks : 0.5;

  const heroes = rawHeroes
    .filter((hero) => hero.localized_name && hero.cm_enabled !== false)
    .map((hero) => {
      const rankedPicks = Number(hero["7_pick"] || 0);
      const rankedWins = Number(hero["7_win"] || 0);
      const rankedRate = rankedPicks ? rankedWins / rankedPicks : rankedBaseline;
      const proPicks = Number(hero.pro_pick || 0);
      const proWins = Number(hero.pro_win || 0);
      const liveRate = (proWins + rankedRate * PRO_PRIOR_GAMES) / (proPicks + PRO_PRIOR_GAMES);
      const patchRow = patchStats.heroPerformance[hero.id] ?? { games: 0, wins: 0 };
      const patchRate = withBayesRate(patchRow, liveRate, PATCH_PRIOR_GAMES);
      return {
        id: Number(hero.id),
        name: String(hero.localized_name),
        slug: String(hero.name).replace("npc_dota_hero_", ""),
        image: `${STEAM_CDN}${String(hero.img).replace(/\?$/, "")}`,
        icon: `${STEAM_CDN}${String(hero.icon).replace(/\?$/, "")}`,
        primaryAttribute: hero.primary_attr,
        attackType: hero.attack_type,
        roles: hero.roles ?? [],
        proPicks,
        proBans: Number(hero.pro_ban || 0),
        proWinRate: Math.round((proPicks ? proWins / proPicks : rankedRate) * 1000) / 10,
        rankedPicks,
        rankedWinRate: Math.round(rankedRate * 1000) / 10,
        patchSample: patchRow.games,
        modelWinRate: Math.round(clamp(patchRate, 0.4, 0.6) * 1000) / 10,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const heroRate = Object.fromEntries(heroes.map((hero) => [hero.id, hero.modelWinRate / 100]));
  const compactPairs = (rows, directional) => Object.fromEntries(Object.entries(rows)
    .filter(([, row]) => row.games >= 2)
    .map(([key, row]) => {
      const [a, b] = key.split("|").map(Number);
      const priorRate = directional ? 0.5 + ((heroRate[a] ?? 0.5) - (heroRate[b] ?? 0.5)) / 2 : 0.5;
      return [key, {
        games: row.games,
        winRate: Math.round(withBayesRate(row, priorRate, PAIR_PRIOR_GAMES) * 1000) / 10,
      }];
    }));

  for (const team of Object.values(teamHeroes)) {
    team.heroes = Object.fromEntries(Object.entries(team.heroes).map(([heroId, row]) => [heroId, {
      games: row.games,
      winRate: Math.round(withBayesRate(row, heroRate[heroId] ?? 0.5, 6) * 1000) / 10,
    }]));
  }

  const output = {
    generatedAt: new Date().toISOString(),
    provider: "OpenDota heroStats + locally cached professional match details",
    methodology: {
      latestOpenDotaPatchId: patchStats.patch,
      cachedPatchMaps: patchStats.matches.length,
      proPriorGames: PRO_PRIOR_GAMES,
      patchPriorGames: PATCH_PRIOR_GAMES,
      pairPriorGames: PAIR_PRIOR_GAMES,
      caveat: "Draft features are regularized toward neutral because the local current-patch professional sample is still small.",
    },
    radiantWinRate: Math.round(patchStats.radiantWinRate * 1000) / 10,
    heroes,
    synergy: compactPairs(patchStats.synergy, false),
    counters: compactPairs(patchStats.counters, true),
    teams: teamHeroes,
  };

  await writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Saved ${OUTPUT}: ${heroes.length} heroes, patch ${patchStats.patch}, ${patchStats.matches.length} cached maps.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
