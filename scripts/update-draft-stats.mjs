import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const API = process.env.OPENDOTA_API_URL || "https://api.opendota.com/api";
const MATCH_CACHE = path.join(ROOT, "work", "opendota-cache", "matches");
const META_CACHE = path.join(ROOT, "work", "opendota-cache", "meta");
const TEAM_STATS_FILE = path.join(ROOT, "public", "team-stats.json");
const OUTPUT = path.join(ROOT, "public", "draft-stats.json");
const DATA_DIR = path.resolve(process.env.DATA_DIR || "data");
const DB_PATH = path.resolve(process.env.DRAFT_DB_PATH || path.join(DATA_DIR, "draft-model.sqlite"));
const STEAM_CDN = "https://cdn.cloudflare.steamstatic.com";
const PRO_PRIOR_GAMES = 30;
const PATCH_PRIOR_GAMES = 18;
const PAIR_PRIOR_GAMES = 8;
const PLAYER_PRIOR_GAMES = 6;
const REQUEST_GAP_MS = 1100;
const MAX_NEW_MATCHES = Math.max(0, Number(process.env.DRAFT_MAX_NEW_MATCHES || 0));
const TI_LEAGUE_ID = Number(process.env.TI_LEAGUE_ID || 19719);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const pairKey = (a, b) => [Number(a), Number(b)].sort((left, right) => left - right).join("|");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errorMessage = (error) => error instanceof Error ? error.message : String(error);
const asInteger = (value) => { const n = Number(value); return Number.isInteger(n) ? n : null; };
let nextRequestAt = 0;

function slimMatch(match) {
  const matchId = asInteger(match?.match_id);
  const patch = asInteger(match?.patch);
  if (matchId === null || patch === null) return null;
  const players = (match.players ?? []).map((player) => ({
    account_id: Number(player.account_id || 0),
    hero_id: Number(player.hero_id || 0),
    player_slot: Number(player.player_slot),
  }));
  if (players.length < 10) return null;
  return {
    match_id: matchId,
    patch,
    start_time: Number(match.start_time || 0),
    leagueid: Number(match.leagueid || 0),
    radiant_team_id: Number(match.radiant_team_id || 0),
    dire_team_id: Number(match.dire_team_id || 0),
    radiant_win: Boolean(match.radiant_win),
    players,
  };
}

function increment(record, key, won, startTime = 0) {
  const row = record[key] ?? { games: 0, wins: 0, lastPlayedAt: 0 };
  row.games += 1;
  row.wins += won ? 1 : 0;
  row.lastPlayedAt = Math.max(row.lastPlayedAt, Number(startTime || 0));
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

async function apiJson(endpoint) {
  const attempts = 8;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const wait = Math.max(0, nextRequestAt - Date.now());
    if (wait) await sleep(wait);
    nextRequestAt = Date.now() + REQUEST_GAP_MS;
    try {
      const response = await fetch(`${API}${endpoint}`, {
        headers: { "user-agent": "TI26Predictor/0.4 (local personal analytics)" },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return response.json();
      process.stderr.write(`OpenDota ${response.status} ${endpoint} attempt ${attempt + 1}/${attempts}\n`);
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const delayMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 8 * 2 ** attempt) * 1000;
        nextRequestAt = Date.now() + delayMs;
        continue;
      }
      if (response.status < 500) throw new Error(`${endpoint}: OpenDota returned ${response.status}`);
    } catch (error) {
      const message = errorMessage(error);
      process.stderr.write(`OpenDota error ${endpoint} attempt ${attempt + 1}/${attempts}: ${message}\n`);
      const returned = Number((message.match(/returned (\d+)/) || [])[1] || 0);
      if (attempt === attempts - 1 || (returned && returned !== 429 && returned < 500)) throw error;
    }
    await sleep(1000 * 2 ** Math.min(attempt, 5));
  }
  throw new Error(`${endpoint}: retry limit reached`);
}

async function readMetaCache(name, maxAgeMs) {
  try {
    const parsed = JSON.parse(await readFile(path.join(META_CACHE, `${name}.json`), "utf8"));
    if (Date.now() - Date.parse(parsed.fetchedAt) <= maxAgeMs && parsed.body != null) return parsed.body;
  } catch {
    // Missing or stale cache is a normal first-run path.
  }
  return null;
}

async function writeMetaCache(name, body) {
  await mkdir(META_CACHE, { recursive: true });
  await writeFile(path.join(META_CACHE, `${name}.json`), `${JSON.stringify({ fetchedAt: new Date().toISOString(), body })}\n`);
}

async function apiJsonCached(endpoint, name, { preferAgeMs, staleAgeMs }) {
  const fresh = await readMetaCache(name, preferAgeMs);
  if (fresh != null) return fresh;
  try {
    const body = await apiJson(endpoint);
    await writeMetaCache(name, body);
    return body;
  } catch (error) {
    const stale = await readMetaCache(name, staleAgeMs);
    if (stale != null) {
      process.stderr.write(`OpenDota ${endpoint} failed (${errorMessage(error)}); using stale cache ${name}\n`);
      return stale;
    }
    throw error;
  }
}

async function apiJsonArray(endpoint, name, cache) {
  const payload = name ? await apiJsonCached(endpoint, name, cache) : await apiJson(endpoint);
  if (!Array.isArray(payload)) throw new Error(`${endpoint}: expected an array, got ${typeof payload}`);
  return payload;
}

function eligiblePatchMaps(teamStats, patchStartSeconds) {
  const byTeam = {};
  const all = new Set();
  for (const [teamId, team] of Object.entries(teamStats.teams)) {
    const ids = new Set();
    for (const tournament of team.tournaments ?? []) {
      if (tournament.rosterStatus !== "current" && tournament.rosterStatus !== "proxy") continue;
      for (const series of tournament.series ?? []) {
        for (const map of series.maps ?? []) {
          if (Number(map.startTime) < patchStartSeconds) continue;
          ids.add(Number(map.matchId));
          all.add(Number(map.matchId));
        }
      }
    }
    byTeam[teamId] = ids;
  }
  return { byTeam, all };
}

function addLiveTournamentMaps(eligible, teamStats, leagueMaps, patchStartSeconds) {
  const teamByOpenDotaId = new Map();
  for (const [teamId, team] of Object.entries(teamStats.teams)) {
    for (const openDotaId of team.openDotaIds ?? [team.openDotaId]) teamByOpenDotaId.set(Number(openDotaId), teamId);
  }
  let added = 0;
  for (const map of leagueMaps) {
    const matchId = Number(map.match_id);
    if (!matchId || Number(map.start_time) < patchStartSeconds) continue;
    if (!eligible.all.has(matchId)) added += 1;
    eligible.all.add(matchId);
    for (const openDotaId of [map.radiant_team_id, map.dire_team_id]) {
      const teamId = teamByOpenDotaId.get(Number(openDotaId));
      if (teamId) {
        if (!eligible.byTeam[teamId]) eligible.byTeam[teamId] = new Set();
        eligible.byTeam[teamId].add(matchId);
      }
    }
  }
  return added;
}

async function downloadMissingMatches(matchIds) {
  await mkdir(MATCH_CACHE, { recursive: true });
  const cached = new Set((await readdir(MATCH_CACHE)).filter((file) => file.endsWith(".json")).map((file) => Number(file.replace(".json", ""))));
  const missing = [...matchIds].filter((matchId) => !cached.has(matchId));
  const queue = MAX_NEW_MATCHES ? missing.slice(0, MAX_NEW_MATCHES) : missing;
  if (!queue.length) return { missing: missing.length, downloaded: 0, failed: 0 };
  process.stdout.write(`Draft details: ${missing.length} missing, downloading ${queue.length} carefully...\n`);
  let downloaded = 0;
  let failed = 0;
  for (const matchId of queue) {
    try {
      const detail = await apiJson(`/matches/${matchId}`);
      await writeFile(path.join(MATCH_CACHE, `${matchId}.json`), JSON.stringify(detail));
      downloaded += 1;
    } catch (error) {
      failed += 1;
      process.stderr.write(`Match ${matchId} skipped: ${errorMessage(error)}\n`);
    }
    if (downloaded + failed === 1 || (downloaded + failed) % 5 === 0 || downloaded + failed === queue.length) {
      process.stdout.write(`Draft details: ${downloaded + failed}/${queue.length} processed (${failed} failed)\n`);
    }
  }
  return { missing: missing.length, downloaded, failed };
}

async function loadCachedMatches(matchIds, patchId) {
  const matches = [];
  const seen = new Set();
  for (const matchId of matchIds) {
    try {
      const match = slimMatch(JSON.parse(await readFile(path.join(MATCH_CACHE, `${matchId}.json`), "utf8")));
      if (!match || match.patch !== patchId || seen.has(match.match_id)) continue;
      seen.add(match.match_id);
      matches.push(match);
    } catch {
      // A missing or partial cache entry remains resumable on the next update.
    }
  }
  return matches;
}

async function loadAllCachedProMatches(patchId) {
  const matches = [];
  const seen = new Set();
  for (const file of await readdir(MATCH_CACHE)) {
    if (!file.endsWith(".json")) continue;
    try {
      const match = slimMatch(JSON.parse(await readFile(path.join(MATCH_CACHE, file), "utf8")));
      if (!match || match.patch !== patchId || match.leagueid <= 0 || seen.has(match.match_id)) continue;
      seen.add(match.match_id);
      matches.push(match);
    } catch {
      // Corrupt or partial cache files are excluded and reported by the training manifest.
    }
  }
  return matches;
}

function summarizeCurrentPatch(matches) {
  const heroPerformance = {};
  const synergy = {};
  const counters = {};
  const lineups = {};
  let radiantWins = 0;
  for (const match of matches) {
    const radiantWon = Boolean(match.radiant_win);
    radiantWins += radiantWon ? 1 : 0;
    const radiant = sidePlayers(match, true).map((player) => Number(player.hero_id)).filter(Boolean);
    const dire = sidePlayers(match, false).map((player) => Number(player.hero_id)).filter(Boolean);
    for (const heroId of radiant) increment(heroPerformance, heroId, radiantWon, match.start_time);
    for (const heroId of dire) increment(heroPerformance, heroId, !radiantWon, match.start_time);
    for (const [heroes, won] of [[radiant, radiantWon], [dire, !radiantWon]]) {
      increment(lineups, [...heroes].sort((a, b) => a - b).join("-"), won, match.start_time);
      for (let i = 0; i < heroes.length; i += 1) for (let j = i + 1; j < heroes.length; j += 1) {
        increment(synergy, pairKey(heroes[i], heroes[j]), won, match.start_time);
      }
    }
    for (const radiantHero of radiant) for (const direHero of dire) {
      increment(counters, `${radiantHero}|${direHero}`, radiantWon, match.start_time);
      increment(counters, `${direHero}|${radiantHero}`, !radiantWon, match.start_time);
    }
  }
  return { radiantWinRate: matches.length ? radiantWins / matches.length : 0.5, heroPerformance, synergy, counters, lineups };
}

function teamAndPlayerSamples(teamStats, matches, eligibleByTeam, proPlayers) {
  const output = {};
  const matchById = new Map(matches.map((match) => [Number(match.match_id), match]));
  const proById = new Map(proPlayers.map((player) => [Number(player.account_id), player]));
  for (const [teamId, team] of Object.entries(teamStats.teams)) {
    const heroes = {};
    const roster = new Set((team.roster ?? []).map(Number));
    const playerRows = Object.fromEntries([...roster].map((accountId) => [accountId, { accountId, name: proById.get(accountId)?.name || proById.get(accountId)?.personaname || `Player ${accountId}`, games: 0, heroes: {} }]));
    let maps = 0;
    for (const matchId of eligibleByTeam[teamId] ?? []) {
      const match = matchById.get(matchId);
      if (!match) continue;
      const radiant = teamSide(match, team.openDotaIds ?? [team.openDotaId]);
      if (radiant === null) continue;
      const won = radiant === Boolean(match.radiant_win);
      maps += 1;
      for (const player of sidePlayers(match, radiant)) {
        const accountId = Number(player.account_id);
        const heroId = Number(player.hero_id);
        increment(heroes, heroId, won, match.start_time);
        if (!roster.has(accountId)) continue;
        playerRows[accountId].games += 1;
        increment(playerRows[accountId].heroes, heroId, won, match.start_time);
      }
    }
    output[teamId] = { maps, heroes, players: Object.values(playerRows) };
  }
  return output;
}

function withBayesRate(row, priorRate, priorGames) {
  return (row.wins + priorRate * priorGames) / (row.games + priorGames);
}

function modelSample(row, priorRate, priorGames) {
  return {
    games: row.games,
    wins: row.wins,
    winRate: Math.round(withBayesRate(row, priorRate, priorGames) * 1000) / 10,
    lastPlayedAt: row.lastPlayedAt || 0,
  };
}

async function removeDraftDatabase() {
  await Promise.all([DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`].map((file) => unlink(file).catch(() => {})));
}

function writeDraftDatabase(output, matches) {
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS heroes (hero_id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL, primary_attribute TEXT, roles_json TEXT NOT NULL, pro_picks INTEGER NOT NULL, pro_bans INTEGER NOT NULL, model_win_rate REAL NOT NULL, patch_games INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS patch_matches (match_id INTEGER PRIMARY KEY, patch_id INTEGER NOT NULL, start_time INTEGER NOT NULL, radiant_team_id INTEGER, dire_team_id INTEGER, radiant_win INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS hero_patch (hero_id INTEGER PRIMARY KEY, games INTEGER NOT NULL, wins INTEGER NOT NULL, coefficient REAL NOT NULL, last_played_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS team_heroes (team_id TEXT NOT NULL, hero_id INTEGER NOT NULL, games INTEGER NOT NULL, wins INTEGER NOT NULL, coefficient REAL NOT NULL, last_played_at INTEGER NOT NULL, PRIMARY KEY(team_id, hero_id));
    CREATE TABLE IF NOT EXISTS player_heroes (team_id TEXT NOT NULL, account_id INTEGER NOT NULL, player_name TEXT NOT NULL, hero_id INTEGER NOT NULL, games INTEGER NOT NULL, wins INTEGER NOT NULL, coefficient REAL NOT NULL, last_played_at INTEGER NOT NULL, PRIMARY KEY(team_id, account_id, hero_id));
    CREATE TABLE IF NOT EXISTS hero_synergy (hero_a_id INTEGER NOT NULL, hero_b_id INTEGER NOT NULL, games INTEGER NOT NULL, wins INTEGER NOT NULL, coefficient REAL NOT NULL, last_played_at INTEGER NOT NULL, PRIMARY KEY(hero_a_id, hero_b_id));
    CREATE TABLE IF NOT EXISTS hero_matchups (hero_id INTEGER NOT NULL, opponent_hero_id INTEGER NOT NULL, games INTEGER NOT NULL, wins INTEGER NOT NULL, coefficient REAL NOT NULL, last_played_at INTEGER NOT NULL, PRIMARY KEY(hero_id, opponent_hero_id));
    CREATE TABLE IF NOT EXISTS hero_lineups (lineup_key TEXT PRIMARY KEY, games INTEGER NOT NULL, wins INTEGER NOT NULL, coefficient REAL NOT NULL, last_played_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_player_heroes_lookup ON player_heroes(account_id, hero_id);
    CREATE INDEX IF NOT EXISTS idx_matchups_opponent ON hero_matchups(opponent_hero_id, hero_id);
  `);
  db.exec("BEGIN");
  try {
    for (const table of ["metadata", "heroes", "patch_matches", "hero_patch", "team_heroes", "player_heroes", "hero_synergy", "hero_matchups", "hero_lineups"]) db.exec(`DELETE FROM ${table}`);
    const metadata = db.prepare("INSERT INTO metadata(key,value) VALUES (?,?)");
    for (const [key, value] of Object.entries({ generatedAt: output.generatedAt, patchId: output.methodology.latestOpenDotaPatchId, patchName: output.methodology.patchName, patchStart: output.methodology.patchStart, patchMaps: output.methodology.cachedPatchMaps })) metadata.run(key, String(value));
    const heroInsert = db.prepare("INSERT INTO heroes VALUES (?,?,?,?,?,?,?,?,?)");
    const patchInsert = db.prepare("INSERT INTO hero_patch VALUES (?,?,?,?,?)");
    for (const hero of output.heroes) {
      const heroId = asInteger(hero.id);
      if (heroId === null) continue;
      heroInsert.run(heroId, hero.name, hero.slug, hero.primaryAttribute ?? null, JSON.stringify(hero.roles ?? []), hero.proPicks, hero.proBans, hero.modelWinRate, hero.patchSample);
      const patch = output.heroPatch[String(hero.id)] ?? { games: 0, wins: 0, winRate: hero.modelWinRate, lastPlayedAt: 0 };
      patchInsert.run(heroId, patch.games, patch.wins, patch.winRate, patch.lastPlayedAt || 0);
    }
    const matchInsert = db.prepare("INSERT OR REPLACE INTO patch_matches VALUES (?,?,?,?,?,?)");
    for (const match of matches) {
      const matchId = asInteger(match.match_id);
      const patch = asInteger(match.patch);
      if (matchId === null || patch === null) continue;
      matchInsert.run(matchId, patch, Number(match.start_time || 0), Number(match.radiant_team_id || 0), Number(match.dire_team_id || 0), match.radiant_win ? 1 : 0);
    }
    const teamInsert = db.prepare("INSERT INTO team_heroes VALUES (?,?,?,?,?,?)");
    const playerInsert = db.prepare("INSERT INTO player_heroes VALUES (?,?,?,?,?,?,?,?)");
    for (const [teamId, team] of Object.entries(output.teams)) {
      for (const [heroId, row] of Object.entries(team.heroes)) {
        const id = asInteger(heroId);
        if (id === null) continue;
        teamInsert.run(teamId, id, row.games, row.wins, row.winRate, row.lastPlayedAt || 0);
      }
      for (const player of team.players) for (const [heroId, row] of Object.entries(player.heroes)) {
        const id = asInteger(heroId);
        const accountId = asInteger(player.accountId);
        if (id === null || accountId === null) continue;
        playerInsert.run(teamId, accountId, String(player.name || `Player ${accountId}`), id, row.games, row.wins, row.winRate, row.lastPlayedAt || 0);
      }
    }
    const synergyInsert = db.prepare("INSERT OR REPLACE INTO hero_synergy VALUES (?,?,?,?,?,?)");
    for (const [key, row] of Object.entries(output.synergy)) {
      const [a, b] = key.split("|").map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) continue;
      synergyInsert.run(a, b, row.games, row.wins, row.winRate, row.lastPlayedAt || 0);
    }
    const matchupInsert = db.prepare("INSERT OR REPLACE INTO hero_matchups VALUES (?,?,?,?,?,?)");
    for (const [key, row] of Object.entries(output.counters)) {
      const [a, b] = key.split("|").map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) continue;
      matchupInsert.run(a, b, row.games, row.wins, row.winRate, row.lastPlayedAt || 0);
    }
    const lineupInsert = db.prepare("INSERT OR REPLACE INTO hero_lineups VALUES (?,?,?,?,?)");
    for (const [key, row] of Object.entries(output.lineups)) lineupInsert.run(key, row.games, row.wins, row.winRate, row.lastPlayedAt || 0);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

async function persistDatabase(output, matches) {
  await mkdir(path.dirname(DB_PATH), { recursive: true });
  try {
    writeDraftDatabase(output, matches);
  } catch (error) {
    process.stderr.write(`Draft sqlite persist failed, rebuilding ${DB_PATH}: ${errorMessage(error)}\n`);
    await removeDraftDatabase();
    writeDraftDatabase(output, matches);
  }
}

async function main() {
  process.stdout.write("Draft details: fetching OpenDota metadata...\n");
  const teamStats = JSON.parse(await readFile(TEAM_STATS_FILE, "utf8"));
  const rawHeroes = await apiJsonArray("/heroStats", "heroStats", { preferAgeMs: 6 * 3600 * 1000, staleAgeMs: 7 * 24 * 3600 * 1000 });
  const proPlayers = await apiJsonArray("/proPlayers", "proPlayers", { preferAgeMs: 6 * 3600 * 1000, staleAgeMs: 7 * 24 * 3600 * 1000 });
  const patches = await apiJsonArray("/constants/patch", "patches", { preferAgeMs: 24 * 3600 * 1000, staleAgeMs: 30 * 24 * 3600 * 1000 });
  const currentPatch = [...patches].sort((a, b) => Number(b.id) - Number(a.id))[0];
  if (!currentPatch) throw new Error("OpenDota /constants/patch returned no patches");
  const patchStartSeconds = Math.floor(Date.parse(currentPatch.date) / 1000);
  const eligible = eligiblePatchMaps(teamStats, patchStartSeconds);
  let liveTournamentMaps = 0;
  try {
    const leagueMaps = await apiJsonArray(`/leagues/${TI_LEAGUE_ID}/matches`, `league-${TI_LEAGUE_ID}`, { preferAgeMs: 10 * 60 * 1000, staleAgeMs: 6 * 3600 * 1000 });
    liveTournamentMaps = addLiveTournamentMaps(eligible, teamStats, leagueMaps, patchStartSeconds);
  } catch (error) {
    process.stderr.write(`Live TI draft discovery skipped: ${errorMessage(error)}\n`);
  }
  process.stdout.write(`Draft details: ${eligible.all.size} eligible maps, ${liveTournamentMaps} live TI maps discovered\n`);
  const download = await downloadMissingMatches(eligible.all);
  process.stdout.write(`Draft details: reading cached pro maps for patch ${currentPatch.id}...\n`);
  const teamMatches = await loadCachedMatches(eligible.all, Number(currentPatch.id));
  const matches = await loadAllCachedProMatches(Number(currentPatch.id));
  process.stdout.write(`Draft details: ${matches.length} patch maps loaded, building artifact...\n`);
  const patchStats = summarizeCurrentPatch(matches);
  const teamHeroes = teamAndPlayerSamples(teamStats, teamMatches, eligible.byTeam, proPlayers);
  const rankedTotals = rawHeroes.reduce((sum, hero) => ({ picks: sum.picks + Number(hero["7_pick"] || 0), wins: sum.wins + Number(hero["7_win"] || 0) }), { picks: 0, wins: 0 });
  const rankedBaseline = rankedTotals.picks ? rankedTotals.wins / rankedTotals.picks : 0.5;
  const heroes = rawHeroes.filter((hero) => hero.localized_name && hero.cm_enabled !== false).map((hero) => {
    const rankedPicks = Number(hero["7_pick"] || 0);
    const rankedWins = Number(hero["7_win"] || 0);
    const rankedRate = rankedPicks ? rankedWins / rankedPicks : rankedBaseline;
    const proPicks = Number(hero.pro_pick || 0);
    const proWins = Number(hero.pro_win || 0);
    const liveRate = (proWins + rankedRate * PRO_PRIOR_GAMES) / (proPicks + PRO_PRIOR_GAMES);
    const patchRow = patchStats.heroPerformance[hero.id] ?? { games: 0, wins: 0 };
    const patchRate = withBayesRate(patchRow, liveRate, PATCH_PRIOR_GAMES);
    return { id: Number(hero.id), name: String(hero.localized_name), slug: String(hero.name).replace("npc_dota_hero_", ""), image: `${STEAM_CDN}${String(hero.img).replace(/\?$/, "")}`, icon: `${STEAM_CDN}${String(hero.icon).replace(/\?$/, "")}`, primaryAttribute: hero.primary_attr, attackType: hero.attack_type, roles: hero.roles ?? [], proPicks, proBans: Number(hero.pro_ban || 0), proWinRate: Math.round((proPicks ? proWins / proPicks : rankedRate) * 1000) / 10, rankedPicks, rankedWinRate: Math.round(rankedRate * 1000) / 10, patchSample: patchRow.games, modelWinRate: Math.round(clamp(patchRate, 0.4, 0.6) * 1000) / 10 };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const heroRate = Object.fromEntries(heroes.map((hero) => [hero.id, hero.modelWinRate / 100]));
  const heroPatch = Object.fromEntries(heroes.map((hero) => [hero.id, modelSample(patchStats.heroPerformance[hero.id] ?? { games: 0, wins: 0 }, hero.modelWinRate / 100, PATCH_PRIOR_GAMES)]));
  const compactPairs = (rows, directional) => Object.fromEntries(Object.entries(rows).filter(([, row]) => row.games >= 2).map(([key, row]) => {
    const [a, b] = key.split("|").map(Number);
    const priorRate = directional ? 0.5 + ((heroRate[a] ?? 0.5) - (heroRate[b] ?? 0.5)) / 2 : 0.5;
    return [key, modelSample(row, priorRate, PAIR_PRIOR_GAMES)];
  }));
  for (const team of Object.values(teamHeroes)) {
    team.heroes = Object.fromEntries(Object.entries(team.heroes).map(([heroId, row]) => [heroId, modelSample(row, heroRate[heroId] ?? 0.5, PLAYER_PRIOR_GAMES)]));
    for (const player of team.players) player.heroes = Object.fromEntries(Object.entries(player.heroes).map(([heroId, row]) => [heroId, modelSample(row, heroRate[heroId] ?? 0.5, PLAYER_PRIOR_GAMES)]));
  }
  const output = {
    generatedAt: new Date().toISOString(),
    provider: "OpenDota current-patch professional maps + heroStats",
    methodology: { latestOpenDotaPatchId: Number(currentPatch.id), patchName: currentPatch.name, patchStart: currentPatch.date, eligiblePatchMaps: eligible.all.size, cachedPatchMaps: matches.length, tiTeamPatchMaps: teamMatches.length, liveTournamentMapsAdded: liveTournamentMaps, liveTournamentLeagueId: TI_LEAGUE_ID, globalProPatchMaps: matches.length, globalHeroPool: "all cached professional matches on the current patch, not only TI participants", missingPatchMaps: download.failed + Math.max(0, download.missing - download.downloaded - download.failed), downloadedThisRun: download.downloaded, proPriorGames: PRO_PRIOR_GAMES, patchPriorGames: PATCH_PRIOR_GAMES, pairPriorGames: PAIR_PRIOR_GAMES, playerPriorGames: PLAYER_PRIOR_GAMES, caveat: "Experimental research coefficients. Global hero/pair evidence uses all cached pro maps; TI-specific pools use only the matching roster. Every coefficient is sample-size regularized." },
    radiantWinRate: Math.round(patchStats.radiantWinRate * 1000) / 10,
    heroes,
    heroPatch,
    synergy: compactPairs(patchStats.synergy, false),
    counters: compactPairs(patchStats.counters, true),
    lineups: Object.fromEntries(Object.entries(patchStats.lineups).map(([key, row]) => [key, modelSample(row, 0.5, 16)])),
    teams: teamHeroes,
  };
  process.stdout.write("Draft details: writing draft-stats.json...\n");
  await writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write("Draft details: persisting draft-model.sqlite...\n");
  try {
    await persistDatabase(output, matches);
  } catch (error) {
    process.stderr.write(`Draft sqlite persist skipped after JSON save: ${errorMessage(error)}\n`);
  }
  console.log(`Saved draft model: patch ${currentPatch.name}, ${matches.length}/${eligible.all.size} maps, ${heroes.length} heroes; database ${DB_PATH}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
