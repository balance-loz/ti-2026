// HTTP API for the multi-tournament predictor. Read-only for the public; the
// only privileged action is triggering a job by hand.
import { createServer } from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
import { openDb, nowIso } from "./core/db.mjs";
import { budgetStatus, OPENDOTA_API_KEY } from "./core/opendota.mjs";
import { tournamentBySlug, refreshTournamentAggregates, isPlayingNow } from "./core/tournaments.mjs";
import { currentLiveGames } from "./core/live.mjs";
import { heroCatalog } from "./core/heroes.mjs";
import { teamDetail, matchDetail, modelPredictions } from "./core/detail.mjs";
import { activitySnapshot } from "./core/activity.mjs";
import { scheduledMatches } from "./jobs/sync-structure.mjs";
import { storedBracket } from "./jobs/project-bracket.mjs";
import { buildTopology } from "./core/bracket-topology.mjs";
import { layoutBracket, BRACKET_LAYOUT, BRACKET_LAYOUT_COMPACT } from "./core/bracket-layout.mjs";
import { groupTable } from "./core/group-table.mjs";
import { accuracySummary, predictSeries, predictDraftMap, modelVersionBreakdown } from "./core/predictions.mjs";
import { loadRatings } from "./core/ratings.mjs";
import { readForecast, forecastTournament } from "./jobs/forecast.mjs";
import { createScheduler } from "./core/scheduler.mjs";

// Bumped whenever this API gains a field a page relies on. It is the one thing
// an open endpoint can say that answers "did my deploy actually land?" — the
// alternative was inferring it from when the model happened to retrain.
const API_VERSION = 3;
const STARTED_AT = nowIso();

const PORT = Number(process.env.API_PORT || 3001);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
// The whole site sits behind one password and this service is not published to
// the host, so a request that reached it through the proxy already carries the
// only credential there is. Off by default: it is only safe while nothing but
// the proxy can reach this port.
const ADMIN_VIA_PROXY = process.env.ADMIN_VIA_PROXY === "true";
const SCHEDULER_ENABLED = process.env.SCHEDULER_ENABLED !== "false";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "";

const db = openDb();
const scheduler = createScheduler(db, { enabled: SCHEDULER_ENABLED });

function json(res, status, body, { cacheSeconds = 0 } = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : "no-store",
    ...(CORS_ORIGIN ? { "Access-Control-Allow-Origin": CORS_ORIGIN } : {}),
  });
  res.end(payload);
}

function isAdmin(req) {
  // nginx sets this from $remote_user and, because proxy_set_header replaces
  // rather than appends, a client cannot supply its own.
  if (ADMIN_VIA_PROXY && String(req.headers["x-site-user"] || "").trim()) return true;
  if (!ADMIN_TOKEN) return false;
  const header = req.headers.authorization || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!provided) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(ADMIN_TOKEN).digest();
  return timingSafeEqual(a, b);
}

const teamNames = () => new Map(db.prepare("SELECT team_id, name, tag, logo_url FROM teams").all()
  .map((row) => [String(row.team_id), { name: row.name || row.tag || `Team ${row.team_id}`, logoUrl: row.logo_url }]));

function tournamentSummary(row, { nowSeconds = Date.now() / 1000 } = {}) {
  return {
    leagueId: Number(row.league_id),
    slug: row.slug,
    name: row.name,
    tier: row.tier,
    status: row.status,
    playingNow: isPlayingNow(row.last_match_time, nowSeconds),
    startTime: row.start_time,
    endTime: row.end_time,
    lastMatchTime: row.last_match_time,
    teamCount: row.team_count,
    mapCount: row.map_count,
    seriesCount: row.series_count,
    prizePool: row.prize_pool,
    lastSyncedAt: row.last_synced_at,
  };
}

function listTournaments({ status = null, limit = 100 } = {}) {
  const nowSeconds = Date.now() / 1000;
  const rows = status
    ? db.prepare("SELECT * FROM tournaments WHERE tracked = 1 AND status = ? ORDER BY last_match_time DESC LIMIT ?").all(status, limit)
    : db.prepare("SELECT * FROM tournaments WHERE tracked = 1 AND map_count > 0 ORDER BY (status='live') DESC, last_match_time DESC LIMIT ?").all(limit);
  return rows.map((row) => tournamentSummary(row, { nowSeconds }));
}

function tournamentDetail(slug) {
  const row = tournamentBySlug(db, slug);
  if (!row) return null;
  const leagueId = Number(row.league_id);
  const names = teamNames();
  const naming = (teamId) => names.get(String(teamId)) ?? { name: `Team ${teamId}`, logoUrl: null };

  const series = db.prepare(`SELECT * FROM series WHERE league_id = ? ORDER BY start_time DESC LIMIT 200`).all(leagueId)
    .map((item) => {
      const frozen = db.prepare("SELECT probability_a, model_id, created_at, outcome, brier FROM predictions WHERE scope='series' AND subject_key=? AND model_kind='team_ratings'")
        .get(item.series_key);
      const teamA = naming(item.team_a_id);
      const teamB = naming(item.team_b_id);
      const predictedWinner = frozen ? (Number(frozen.probability_a) >= 0.5 ? String(item.team_a_id) : String(item.team_b_id)) : null;
      return {
        seriesKey: item.series_key,
        teamA: { id: String(item.team_a_id), ...teamA },
        teamB: { id: String(item.team_b_id), ...teamB },
        bestOf: item.best_of,
        startTime: item.start_time,
        scoreA: item.score_a,
        scoreB: item.score_b,
        winnerId: item.winner_id ? String(item.winner_id) : null,
        status: item.status,
        mapIds: (() => { try { return JSON.parse(item.map_ids_json || "[]"); } catch { return []; } })(),
        prediction: frozen ? {
          probabilityA: Number(frozen.probability_a),
          modelId: frozen.model_id,
          capturedAt: frozen.created_at,
          predictedWinner,
          correct: frozen.outcome === null || frozen.outcome === undefined ? null
            : (predictedWinner === String(item.winner_id)),
        } : null,
      };
    });

  const forecast = readForecast(db, leagueId);
  const accuracy = accuracySummary(db, { leagueId });
  const live = currentLiveGames(db, { leagueId }).map((game) => ({
    ...game,
    radiantTeam: { id: String(game.radiantTeamId), ...naming(game.radiantTeamId) },
    direTeam: { id: String(game.direTeamId), ...naming(game.direTeamId) },
  }));

  // The organiser's own structure, when we managed to find it: stages, the
  // bracket and every slot's official start time.
  let format = null;
  try { format = row.format_json ? JSON.parse(row.format_json) : null; } catch { format = null; }
  const schedule = scheduledMatches(db, leagueId).map((item) => ({
    id: item.id,
    slot: item.slot,
    stage: item.stage,
    lane: item.lane,
    round: item.round ?? null,
    // Without this a played group fixture cannot be joined to its result, and
    // nothing on the page can link through to the explanation.
    seriesKey: item.series_key ?? null,
    startTime: item.start_time,
    bestOf: item.best_of,
    winnerSlot: item.winner_slot,
    teamA: item.team_a_id ? { id: String(item.team_a_id), ...naming(item.team_a_id) } : (item.team_a_name ? { id: "", name: item.team_a_name, logoUrl: null } : null),
    teamB: item.team_b_id ? { id: String(item.team_b_id), ...naming(item.team_b_id) } : (item.team_b_name ? { id: "", name: item.team_b_name, logoUrl: null } : null),
  }));

  // The bracket's geometry is computed on the way out rather than stored: the
  // forecast's cache key is keyed on data, not on code, so a released change to
  // the layout would never reach a payload written before it.
  const projection = forecast?.projection ?? null;
  if (projection?.bracket?.length) {
    const wiring = projection.bracket.every((slot) => Array.isArray(slot.sources))
      ? projection.bracket
      : buildTopology(storedBracket(db, leagueId) ?? { sections: [] })?.nodes ?? [];
    projection.layout = layoutBracket(wiring, BRACKET_LAYOUT);
    projection.layoutCompact = layoutBracket(wiring, BRACKET_LAYOUT_COMPACT);
  }

  let groupStage = null;
  try {
    groupStage = groupTable(db, leagueId, { projection, ratings: loadRatings() });
  } catch (error) {
    // A tournament whose group stage cannot be assembled still has a page.
    groupStage = null;
    console.error("[api] group table failed", leagueId, error?.message || error);
  }

  return {
    tournament: tournamentSummary(row),
    format,
    structure: {
      source: row.structure_source ?? null,
      page: row.liquipedia_page ?? null,
      syncedAt: row.structure_synced_at ?? null,
    },
    schedule,
    groupStage,
    forecast,
    series,
    live,
    heroes: heroCatalog(db),
    accuracy,
    generatedAt: nowIso(),
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "OPTIONS" && CORS_ORIGIN) {
      res.writeHead(204, { "Access-Control-Allow-Origin": CORS_ORIGIN, "Access-Control-Allow-Headers": "Authorization,Content-Type" });
      return res.end();
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      const counts = db.prepare(`SELECT
          (SELECT COUNT(*) FROM tournaments) AS tournaments,
          (SELECT COUNT(*) FROM tournaments WHERE status='live') AS live_tournaments,
          (SELECT COUNT(*) FROM maps) AS maps,
          (SELECT COUNT(*) FROM series) AS series,
          (SELECT COUNT(*) FROM predictions) AS predictions,
          (SELECT COUNT(*) FROM predictions WHERE resolved_at IS NOT NULL) AS resolved,
          (SELECT COUNT(*) FROM live_games WHERE closed_at IS NULL) AS live_games`).get();
      const ratings = loadRatings();
      return json(res, 200, {
        ok: true,
        at: nowIso(),
        apiVersion: API_VERSION,
        startedAt: STARTED_AT,
        counts,
        ratingsModelId: ratings?.modelId ?? null,
        ratingsGeneratedAt: ratings?.generatedAt ?? null,
        opendota: { ...budgetStatus(db), keyed: Boolean(OPENDOTA_API_KEY) },
        scheduler: SCHEDULER_ENABLED,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/tournaments") {
      const status = url.searchParams.get("status");
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 100)));
      return json(res, 200, { tournaments: listTournaments({ status, limit }), generatedAt: nowIso() }, { cacheSeconds: 30 });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/tournaments/")) {
      const slug = decodeURIComponent(url.pathname.slice("/api/tournaments/".length));
      const detail = tournamentDetail(slug);
      if (!detail) return json(res, 404, { error: "tournament_not_found", slug });
      return json(res, 200, detail, { cacheSeconds: 15 });
    }

    if (req.method === "GET" && url.pathname === "/api/live") {
      const names = teamNames();
      const naming = (teamId) => names.get(String(teamId)) ?? { name: `Team ${teamId}`, logoUrl: null };
      const leagueNames = new Map(db.prepare("SELECT league_id, name, slug FROM tournaments").all()
        .map((row) => [Number(row.league_id), { name: row.name, slug: row.slug }]));
      const games = currentLiveGames(db).map((game) => ({
        ...game,
        radiantTeam: { id: String(game.radiantTeamId), ...naming(game.radiantTeamId) },
        direTeam: { id: String(game.direTeamId), ...naming(game.direTeamId) },
        tournament: leagueNames.get(Number(game.leagueId)) ?? null,
      }));
      return json(res, 200, { games, heroes: heroCatalog(db), generatedAt: nowIso() }, { cacheSeconds: 5 });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/teams/")) {
      const teamId = Number(decodeURIComponent(url.pathname.slice("/api/teams/".length)));
      if (!Number.isInteger(teamId) || teamId <= 0) return json(res, 400, { error: "bad_team_id" });
      const detail = teamDetail(db, teamId);
      if (!detail) return json(res, 404, { error: "team_not_found", teamId });
      return json(res, 200, detail, { cacheSeconds: 30 });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/series/")) {
      const key = decodeURIComponent(url.pathname.slice("/api/series/".length));
      const detail = matchDetail(db, key);
      if (!detail) return json(res, 404, { error: "series_not_found", seriesKey: key });
      return json(res, 200, detail, { cacheSeconds: 15 });
    }

    if (req.method === "GET" && url.pathname === "/api/activity") {
      return json(res, 200, { ...activitySnapshot(db, scheduler), generatedAt: nowIso() });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/models/")) {
      const kind = decodeURIComponent(url.pathname.slice("/api/models/".length)).replace(/\/predictions$/, "");
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 200)));
      const resolvedOnly = url.searchParams.get("resolved") === "true";
      const versions = (url.searchParams.get("versions") || "").split(",").map((entry) => entry.trim()).filter(Boolean);
      const modelIds = versions.length ? versions : null;
      return json(res, 200, {
        modelKind: kind,
        accuracy: accuracySummary(db, { modelKind: kind, modelIds }),
        versions: modelVersionBreakdown(db, kind),
        selectedVersions: versions,
        predictions: modelPredictions(db, kind, { limit, resolvedOnly, modelIds }),
        heroes: heroCatalog(db),
        generatedAt: nowIso(),
      }, { cacheSeconds: 20 });
    }

    if (req.method === "GET" && url.pathname === "/api/model") {
      const versions = db.prepare("SELECT kind, model_id, trained_at, samples, metrics_json, active FROM model_versions ORDER BY trained_at DESC LIMIT 40").all()
        .map((row) => ({
          kind: row.kind, modelId: row.model_id, trainedAt: row.trained_at, samples: row.samples,
          active: Boolean(row.active),
          metrics: (() => { try { return JSON.parse(row.metrics_json || "null"); } catch { return null; } })(),
        }));
      const jobs = db.prepare(`SELECT job, MAX(started_at) AS last_started,
                               (SELECT status FROM job_runs j2 WHERE j2.job = j1.job ORDER BY started_at DESC LIMIT 1) AS last_status
                               FROM job_runs j1 GROUP BY job`).all();
      return json(res, 200, {
        versions,
        jobs,
        scheduler: scheduler.status(),
        accuracy: accuracySummary(db),
        accuracy30d: accuracySummary(db, { sinceDays: 30 }),
        opendota: budgetStatus(db),
        generatedAt: nowIso(),
      }, { cacheSeconds: 30 });
    }

    if (req.method === "GET" && url.pathname === "/api/accuracy") {
      return json(res, 200, {
        overall: accuracySummary(db),
        last30Days: accuracySummary(db, { sinceDays: 30 }),
        generatedAt: nowIso(),
      }, { cacheSeconds: 60 });
    }

    // Ad-hoc probability for any two teams, and optionally a hypothetical draft.
    if (req.method === "GET" && url.pathname === "/api/predict") {
      const teamA = url.searchParams.get("teamA");
      const teamB = url.searchParams.get("teamB");
      if (!teamA || !teamB) return json(res, 400, { error: "teamA_and_teamB_required" });
      const bestOf = Number(url.searchParams.get("bestOf") || 3);
      const parsePicks = (value) => String(value || "").split(",").map(Number).filter((id) => Number.isInteger(id) && id > 0);
      const radiantPicks = parsePicks(url.searchParams.get("radiantPicks"));
      const direPicks = parsePicks(url.searchParams.get("direPicks"));
      const series = predictSeries(db, { teamAId: teamA, teamBId: teamB, bestOf });
      const draft = radiantPicks.length === 5 && direPicks.length === 5
        ? predictDraftMap({ radiantTeamId: teamA, direTeamId: teamB, radiantPicks, direPicks })
        : null;
      return json(res, 200, { series, draft, generatedAt: nowIso() });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/admin/jobs/")) {
      if (!isAdmin(req)) return json(res, 401, { error: "unauthorized" });
      const name = url.pathname.slice("/api/admin/jobs/".length).replace(/\/run$/, "");
      try {
        const detail = await scheduler.run(name);
        return json(res, 200, { job: name, detail });
      } catch (error) {
        return json(res, 500, { job: name, error: String(error?.message || error) });
      }
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/admin/forecast/")) {
      if (!isAdmin(req)) return json(res, 401, { error: "unauthorized" });
      const slug = decodeURIComponent(url.pathname.slice("/api/admin/forecast/".length));
      const row = tournamentBySlug(db, slug);
      if (!row) return json(res, 404, { error: "tournament_not_found" });
      refreshTournamentAggregates(db, Number(row.league_id));
      return json(res, 200, forecastTournament(db, Number(row.league_id), { force: true }));
    }

    return json(res, 404, { error: "not_found", path: url.pathname });
  } catch (error) {
    return json(res, 500, { error: String(error?.message || error) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[api] listening on ${PORT}`);
  scheduler.start().catch((error) => console.error("[scheduler] start failed", error));
});

const shutdown = () => {
  scheduler.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

export { server, scheduler, db, listTournaments, tournamentDetail };
