import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildForecastSource, runForecast, TEAMS } from "../server/forecast-engine.mjs";

const ROOT = process.cwd();
const TEAM_STATS = path.join(ROOT, "public", "team-stats.json");
const DRAFT_STATS = path.join(ROOT, "public", "draft-stats.json");
const MATCH_CACHE = path.join(ROOT, "work", "opendota-cache", "matches");
const OUTPUT = path.join(ROOT, "public", "intel-stats.json");
const DAY = 24 * 60 * 60;
const FORECAST_ITERATIONS = Math.max(10_000, Number(process.env.INTEL_FORECAST_ITERATIONS || 50_000));
const FORECAST_SEED = 0x54493236;
const ROLE_NAMES = { 1: "Керри", 2: "Мидер", 3: "Оффлейнер", 4: "Поддержка 4", 5: "Поддержка 5" };

const round = (value, digits = 1) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const quantileRank = (values, value) => values.length <= 1 ? 0.5 : values.filter((item) => item < value).length / (values.length - 1);
const matchFile = (matchId) => path.join(MATCH_CACHE, `${matchId}.json`);

async function json(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function maybeMatch(matchId, cache) {
  if (cache.has(matchId)) return cache.get(matchId);
  try {
    const match = await json(matchFile(matchId));
    cache.set(matchId, match);
    return match;
  } catch {
    cache.set(matchId, null);
    return null;
  }
}

function acceptedMaps(team) {
  const maps = new Map();
  for (const tournament of team.tournaments ?? []) {
    if (tournament.rosterStatus !== "current" && tournament.rosterStatus !== "proxy") continue;
    for (const series of tournament.series ?? []) for (const map of series.maps ?? []) {
      const row = {
        matchId: Number(map.matchId), startTime: Number(map.startTime), won: Boolean(map.won),
        opponentTiId: series.opponentTiId ?? null, rosterStatus: tournament.rosterStatus,
        rosterWeight: Number(tournament.rosterWeight ?? (tournament.rosterStatus === "current" ? 1 : 0.25)),
      };
      if (!maps.has(row.matchId) || maps.get(row.matchId).rosterWeight < row.rosterWeight) maps.set(row.matchId, row);
    }
  }
  return [...maps.values()].sort((a, b) => b.startTime - a.startTime);
}

function record(id, label, maps) {
  const wins = maps.filter((map) => map.won).length;
  const from = maps.length ? new Date(Math.min(...maps.map((map) => map.startTime)) * 1000).toISOString() : null;
  const to = maps.length ? new Date(Math.max(...maps.map((map) => map.startTime)) * 1000).toISOString() : null;
  return { id, label, maps: maps.length, wins, losses: maps.length - wins, winRate: maps.length ? round(100 * wins / maps.length) : null, from, to };
}

function sideFor(match, team) {
  const teamIds = new Set((team.openDotaIds ?? []).map(Number));
  if (teamIds.has(Number(match.radiant_team_id))) return true;
  if (teamIds.has(Number(match.dire_team_id))) return false;
  const roster = new Set((team.roster ?? []).map(Number));
  const radiant = (match.players ?? []).filter((player) => player.player_slot < 128).filter((player) => roster.has(Number(player.account_id))).length;
  const dire = (match.players ?? []).filter((player) => player.player_slot >= 128).filter((player) => roster.has(Number(player.account_id))).length;
  return radiant === dire ? null : radiant > dire;
}

function minuteValue(values, minute) {
  if (!Array.isArray(values) || !values.length) return null;
  return Number(values[Math.min(values.length - 1, Math.max(0, minute - 1))]);
}

function eventsBefore(players, field, seconds) {
  return players.reduce((sum, player) => sum + (Array.isArray(player[field]) ? player[field].filter((item) => Number(item.time) <= seconds).length : 0), 0);
}

function purchasesBefore(players, itemName, seconds) {
  return players.reduce((sum, player) => sum + (Array.isArray(player.purchase_log) ? player.purchase_log.filter((item) => item.key === itemName && Number(item.time) <= seconds).length : 0), 0);
}

function extractMapMetrics(match, team, metadata) {
  const radiant = sideFor(match, team);
  if (radiant === null) return null;
  const players = (match.players ?? []).filter((player) => Boolean(player.player_slot < 128) === radiant);
  const firstBlood = players.some((player) => Number(player.firstblood_claimed) > 0);
  const rawGold10 = minuteValue(match.radiant_gold_adv, 10);
  const roshanBefore30 = (match.objectives ?? []).some((event) => {
    if (event.type !== "CHAT_MESSAGE_ROSHAN_KILL" || Number(event.time) > 1800) return false;
    if (Number.isFinite(Number(event.team))) return Number(event.team) === (radiant ? 2 : 3);
    const slot = Number(event.player_slot ?? event.slot);
    return Number.isFinite(slot) && Boolean(slot < 128) === radiant;
  });
  return {
    ...metadata,
    patch: Number(match.patch || 0),
    duration: Number(match.duration || 0) / 60,
    gold10: rawGold10 === null ? null : rawGold10 * (radiant ? 1 : -1),
    firstBlood: firstBlood ? 1 : 0,
    roshanBefore30: roshanBefore30 ? 1 : 0,
    kills10: players.reduce((sum, player) => sum + (Array.isArray(player.kills_log) ? player.kills_log.filter((event) => Number(event.time) <= 600).length : 0), 0),
    obs20: eventsBefore(players, "obs_log", 1200),
    sentry20: eventsBefore(players, "sen_log", 1200),
    smokes20: purchasesBefore(players, "smoke_of_deceit", 1200),
    campsStacked: players.reduce((sum, player) => sum + Number(player.camps_stacked || 0), 0),
    stunSeconds: players.reduce((sum, player) => sum + Number(player.stuns || 0), 0),
    towerDamage: players.reduce((sum, player) => sum + Number(player.tower_damage || 0), 0),
    teamGpm: average(players.map((player) => Number(player.gold_per_min || 0))),
    teamXpm: average(players.map((player) => Number(player.xp_per_min || 0))),
    players,
  };
}

function metric(id, label, value, unit, higherIs, detail) {
  return { id, label, value: round(value), unit, higherIs, detail, percentile: 50 };
}

function styleFor(rows) {
  const validGold = rows.map((row) => row.gold10).filter(Number.isFinite);
  return {
    sampleMaps: rows.length,
    parsedMaps: rows.length,
    metrics: [
      metric("gold10", "Экономика к 10-й", average(validGold), "золота", "better", "Среднее преимущество по net worth к 10:00"),
      metric("kills10", "Убийства к 10-й", average(rows.map((row) => row.kills10)), "за карту", "context", "Темп ранних разменов"),
      metric("firstBlood", "Первая кровь", 100 * average(rows.map((row) => row.firstBlood)), "%", "better", "Доля карт с первой кровью"),
      metric("duration", "Длительность", average(rows.map((row) => row.duration)), "мин", "context", "Средняя длительность карты"),
      metric("roshan30", "Ранний Рошан", 100 * average(rows.map((row) => row.roshanBefore30)), "%", "context", "Доля карт с Рошаном команды до 30:00"),
      metric("vision20", "Варды к 20-й", average(rows.map((row) => row.obs20 + row.sentry20)), "за карту", "context", "Observer + sentry, поставленные до 20:00"),
      metric("smokes20", "Смоки к 20-й", average(rows.map((row) => row.smokes20)), "за карту", "context", "Покупки Smoke of Deceit до 20:00"),
      metric("stacks", "Стаки лагерей", average(rows.map((row) => row.campsStacked)), "за карту", "context", "Среднее число засчитанных стаков"),
      metric("towerDamage", "Урон строениям", average(rows.map((row) => row.towerDamage)), "за карту", "better", "Суммарный урон игроков по строениям"),
      metric("stuns", "Контроль", average(rows.map((row) => row.stunSeconds)), "сек", "context", "Суммарная длительность оглушений"),
    ],
  };
}

function playerProfiles(teamId, rows, draftStats) {
  const rosterPlayers = draftStats.teams?.[teamId]?.players ?? [];
  const names = new Map(rosterPlayers.map((player) => [Number(player.accountId), player.name]));
  const roster = new Set(rosterPlayers.map((player) => Number(player.accountId)));
  const stats = new Map([...roster].map((accountId) => [accountId, { accountId, games: 0, wins: 0, kills: 0, deaths: 0, assists: 0, gpm: 0, xpm: 0, roles: {}, heroes: {} }]));
  for (const row of rows) for (const player of row.players) {
    const accountId = Number(player.account_id);
    if (!stats.has(accountId)) continue;
    const item = stats.get(accountId);
    item.games++; item.wins += row.won ? 1 : 0;
    item.kills += Number(player.kills || 0); item.deaths += Number(player.deaths || 0); item.assists += Number(player.assists || 0);
    item.gpm += Number(player.gold_per_min || 0); item.xpm += Number(player.xp_per_min || 0);
    const position = Math.min(5, Math.max(1, Math.round(Number(player.position_est || 0))));
    if (position) item.roles[position] = (item.roles[position] ?? 0) + 1;
    const heroId = Number(player.hero_id || 0); if (heroId) item.heroes[heroId] = (item.heroes[heroId] ?? 0) + 1;
  }
  return [...stats.values()].map((item) => {
    const role = Number(Object.entries(item.roles).sort((a, b) => b[1] - a[1])[0]?.[0] || 0);
    const topHeroes = Object.entries(item.heroes).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([heroId, games]) => ({ heroId: Number(heroId), games }));
    return {
      accountId: item.accountId, name: names.get(item.accountId) || `Player ${item.accountId}`,
      role, roleName: ROLE_NAMES[role] ?? "Роль уточняется", games: item.games,
      winRate: item.games ? round(100 * item.wins / item.games) : null,
      kda: item.games ? round((item.kills + item.assists) / Math.max(1, item.deaths), 2) : null,
      gpm: item.games ? round(item.gpm / item.games) : null,
      xpm: item.games ? round(item.xpm / item.games) : null,
      heroPool: Object.keys(item.heroes).length, topHeroes,
    };
  }).sort((a, b) => (a.role || 99) - (b.role || 99));
}

function confidence(sample) {
  if (sample >= 45) return "high";
  if (sample >= 18) return "medium";
  return "low";
}

function quality(team, maps, parsed) {
  const exact = maps.filter((map) => map.rosterStatus === "current").length;
  const exactShare = maps.length ? exact / maps.length : 0;
  const parsedShare = maps.length ? parsed / maps.length : 0;
  const score = Math.round(100 * (.45 * Math.min(1, maps.length / 50) + .35 * exactShare + .2 * parsedShare));
  return { score, grade: score >= 85 ? "A" : score >= 70 ? "B" : score >= 50 ? "C" : "D", maps: maps.length, parsedMaps: parsed, exactRosterShare: round(100 * exactShare), parsedShare: round(100 * parsedShare), projection: Boolean(team.rosterProjection) };
}

function storylineTemplates(team, fieldStrength) {
  const result = [];
  const strengthAbs = Math.abs(fieldStrength);
  result.push({
    kind: fieldStrength >= 0 ? "model-up" : "model-down",
    title: fieldStrength >= 0 ? "Модель ставит выше среднего поля" : "Модель видит путь через апсет",
    detail: `Средняя вероятность серии против остальных участников: ${round(50 + fieldStrength)}%.`,
    metricId: "model", direction: fieldStrength >= 0 ? "up" : "down", impactPp: round(fieldStrength),
    score: Math.round(Math.min(100, 45 + strengthAbs * 4)), confidence: confidence(team.dataQuality.maps), causal: true,
  });
  const interesting = team.style.metrics.map((item) => {
    const surprise = Math.abs(item.percentile / 100 - .5) * 2;
    const sampleConfidence = Math.min(1, Math.sqrt(team.style.sampleMaps / 40));
    const rosterRelevance = team.dataQuality.exactRosterShare / 100;
    const interestingness = surprise * sampleConfidence * (.55 + .45 * rosterRelevance);
    return { item, interestingness };
  }).sort((a, b) => b.interestingness - a.interestingness).slice(0, 3);
  for (const { item, interestingness } of interesting) {
    const high = item.percentile >= 50;
    result.push({
      kind: "style", title: `${high ? "Высокий" : "Низкий"} показатель: ${item.label.toLowerCase()}`,
      detail: `${item.value ?? "—"}${item.unit === "%" ? "%" : ` ${item.unit}`} · ${Math.round(item.percentile)}-й перцентиль среди участников.`,
      metricId: item.id, direction: high ? "up" : "down", impactPp: null,
      score: Math.round(100 * interestingness), confidence: confidence(team.style.sampleMaps), causal: false,
    });
  }
  return result.sort((a, b) => b.score - a.score).slice(0, 3);
}

async function main() {
  const [teamStats, draftStats] = await Promise.all([json(TEAM_STATS), json(DRAFT_STATS)]);
  const details = new Map();
  const teamRows = {};
  const now = Math.floor(Date.now() / 1000);

  for (const team of TEAMS) {
    const source = teamStats.teams[team.id];
    const maps = acceptedMaps(source);
    const rows = [];
    for (const map of maps) {
      const detail = await maybeMatch(map.matchId, details);
      if (!detail) continue;
      const parsed = extractMapMetrics(detail, source, map);
      if (parsed) rows.push(parsed);
    }
    const latestPatch = Math.max(0, ...rows.map((row) => row.patch));
    const contexts = [
      record("year", "12 месяцев", maps),
      record("days90", "Последние 90 дней", maps.filter((map) => map.startTime >= now - 90 * DAY)),
      record("current", "Текущая пятёрка", maps.filter((map) => map.rosterStatus === "current")),
      record("patch", latestPatch ? `Патч · ID ${latestPatch}` : "Текущий патч", rows.filter((row) => row.patch === latestPatch)),
      record("ti-field", "Против участников TI", maps.filter((map) => map.opponentTiId)),
    ];
    teamRows[team.id] = {
      id: team.id, name: team.name, contexts, latestPatch,
      style: styleFor(rows.filter((row) => row.startTime >= now - 180 * DAY)),
      players: playerProfiles(team.id, rows.filter((row) => row.startTime >= now - 180 * DAY), draftStats),
      dataQuality: quality(source, maps, rows.length),
      roster: source.roster,
      identity: { openDotaIds: source.openDotaIds, aliases: source.aliases, rosterAccounts: source.roster },
      sources: ["opendota-api", "opendota-replays", "ti-roster-registry"],
    };
  }

  const metricIds = teamRows[TEAMS[0].id].style.metrics.map((item) => item.id);
  for (const metricId of metricIds) {
    const values = Object.values(teamRows).map((team) => team.style.metrics.find((item) => item.id === metricId)?.value).filter(Number.isFinite);
    for (const team of Object.values(teamRows)) {
      const item = team.style.metrics.find((metric) => metric.id === metricId);
      item.percentile = Math.round(100 * quantileRank(values, item.value));
    }
  }

  const probabilities = buildForecastSource({ answers: {}, stats: teamStats, matches: [], mode: "stats", opinionWeight: 0 });
  const forecast = runForecast(probabilities, FORECAST_ITERATIONS, FORECAST_SEED, { stats: teamStats });
  const tournament = Object.fromEntries(forecast.teams.map((team) => [team.id, {
    qualify: round(team.qualify), top3: round(team.top3), final: round(team.final), champion: round(team.champion),
  }]));
  for (const team of TEAMS) {
    const againstField = TEAMS.filter((opponent) => opponent.id !== team.id).map((opponent) => {
      const key = [team.id, opponent.id].sort().join("|"); const stored = Number(teamStats.pairwise[key]?.probabilityA ?? 50);
      return key.startsWith(`${team.id}|`) ? stored : 100 - stored;
    });
    teamRows[team.id].storylines = storylineTemplates(teamRows[team.id], average(againstField) - 50);
  }

  const output = {
    version: 1, generatedAt: new Date().toISOString(), modelGeneratedAt: teamStats.generatedAt,
    sources: [
      { id: "opendota-api", label: "OpenDota API", url: "https://docs.opendota.com/", role: "Матчи, составы, лига и базовые результаты", retrievedAt: teamStats.generatedAt },
      { id: "opendota-replays", label: "OpenDota parsed replays", url: "https://github.com/odota/core", role: "Экономика по минутам, vision, objectives, player telemetry", retrievedAt: teamStats.generatedAt },
      { id: "valve-webapi", label: "Valve Steam WebAPI", url: "https://developer.valvesoftware.com/wiki/Steam_Web_API", role: "Первичный источник идентификаторов и результатов OpenDota", retrievedAt: teamStats.generatedAt },
      { id: "ti-roster-registry", label: "TI Predictor roster registry", url: null, role: "Нормализация team ID, алиасов и эпох составов", retrievedAt: teamStats.generatedAt },
    ],
    methodology: {
      acceptedMaps: teamStats.totals.uniqueAcceptedGames, parsedReplayFiles: [...details.values()].filter(Boolean).length,
      contexts: ["12 месяцев", "90 дней", "текущая пятёрка", "последний OpenDota patch ID", "только участники TI"],
      storylineFormula: "surprise × sample confidence × roster relevance × freshness",
      caveat: "Style metrics are descriptive and are not presented as causal forecast inputs. Only model storylines expose probability impact.",
    },
    matchPatches: Object.fromEntries([...details.entries()].filter(([, match]) => match).map(([matchId, match]) => [matchId, Number(match.patch || 0)])),
    tournament: { iterations: forecast.iterations, seed: forecast.seed, teams: tournament },
    teams: teamRows,
  };
  await writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Saved ${OUTPUT}: ${[...details.values()].filter(Boolean).length} parsed replay files, ${forecast.iterations} tournament simulations.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
