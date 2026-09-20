#!/usr/bin/env node
// Manual operations for the predictor. The server runs all of these on a
// schedule; this is for bootstrapping a fresh install and for poking at a
// running one.
//
//   node scripts/predictor.mjs status
//   node scripts/predictor.mjs discover
//   node scripts/predictor.mjs backfill [--pages 40]
//   node scripts/predictor.mjs collect
//   node scripts/predictor.mjs drafts [--limit 60]
//   node scripts/predictor.mjs rebuild
//   node scripts/predictor.mjs train [--ratings-only|--draft-only]
//   node scripts/predictor.mjs forecast [--slug <slug>]
//   node scripts/predictor.mjs live
//   node scripts/predictor.mjs bootstrap

import { openDb, closeDb, getJsonSetting } from "../server/core/db.mjs";
import { budgetStatus } from "../server/core/opendota.mjs";
import {
  discoverFromProMatches, activeTournaments, syncLeague, rebuildSeries,
  refreshTournamentAggregates, resolveTournamentNames, untrackOutOfScopeTournaments,
  upsertTournament, tournamentBySlug,
} from "../server/core/tournaments.mjs";
import { trainRatings, invalidateRatingsCache, loadRatings } from "../server/core/ratings.mjs";
import { trainDraftModel } from "../server/core/draft-model.mjs";
import { resolvePredictions, accuracySummary } from "../server/core/predictions.mjs";
import { syncLiveGames, currentLiveGames } from "../server/core/live.mjs";
import { backfillHistory, collectRecent, fetchMissingDrafts } from "../server/jobs/collect-history.mjs";
import { forecastActiveTournaments, forecastTournament, readForecast } from "../server/jobs/forecast.mjs";

const args = process.argv.slice(2);
const command = args[0] ?? "status";
const flag = (name) => args.includes(name);
const value = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const db = openDb();
const log = (label, payload) => console.log(`${label}: ${typeof payload === "string" ? payload : JSON.stringify(payload)}`);

function printStatus() {
  const counts = db.prepare(`SELECT
      (SELECT COUNT(*) FROM tournaments WHERE tracked=1) AS tournaments,
      (SELECT COUNT(*) FROM tournaments WHERE tracked=1 AND status='live') AS live,
      (SELECT COUNT(*) FROM maps) AS maps,
      (SELECT COUNT(*) FROM maps WHERE radiant_picks_json IS NOT NULL) AS maps_with_drafts,
      (SELECT COUNT(*) FROM series) AS series,
      (SELECT COUNT(*) FROM series WHERE status='finished') AS finished_series,
      (SELECT COUNT(*) FROM teams) AS teams,
      (SELECT COUNT(*) FROM predictions) AS predictions,
      (SELECT COUNT(*) FROM predictions WHERE resolved_at IS NOT NULL) AS resolved,
      (SELECT COUNT(*) FROM live_games WHERE closed_at IS NULL) AS live_games`).get();
  console.log("store:");
  for (const [key, count] of Object.entries(counts)) console.log(`  ${key.padEnd(18)} ${Number(count).toLocaleString("en-US")}`);

  const ratings = loadRatings();
  console.log(`\nratings model: ${ratings?.modelId ?? "none"} (${ratings ? Object.keys(ratings.ratings).length : 0} teams)`);
  if (ratings?.validation?.champion) {
    const champion = ratings.validation.champion;
    console.log(`  walk-forward: ${champion.modelId}, log loss ${champion.logLoss.toFixed(4)} vs coin flip ${Math.log(2).toFixed(4)}, accuracy ${(champion.accuracy * 100).toFixed(1)}%`);
  }

  const drafts = db.prepare("SELECT model_id, trained_at, samples, active FROM model_versions WHERE kind='draft' ORDER BY trained_at DESC LIMIT 1").get();
  console.log(`draft model: ${drafts?.model_id ?? "none"}${drafts ? ` (${drafts.active ? "active" : "gated out"})` : ""}`);

  console.log("\naccuracy (resolved predictions):");
  const rows = accuracySummary(db);
  if (!rows.length) console.log("  nothing resolved yet");
  for (const row of rows) {
    console.log(`  ${row.modelKind}/${row.scope}: ${row.count} predictions, accuracy ${((row.accuracy ?? 0) * 100).toFixed(1)}%, Brier ${row.brier?.toFixed(4) ?? "—"}, log loss ${row.logLoss?.toFixed(4) ?? "—"}`);
  }

  console.log("\nopendota budget:", JSON.stringify(budgetStatus(db)));
  const cursor = getJsonSetting(db, "history_backfill_cursor", null);
  if (cursor) {
    console.log(`backfill: ${cursor.done ? "complete" : "in progress"}, oldest stored ${cursor.oldestSeen ? new Date(cursor.oldestSeen * 1000).toISOString().slice(0, 10) : "—"}`);
  }

  const live = activeTournaments(db);
  console.log(`\nactive tournaments (${live.length}):`);
  for (const row of live.slice(0, 15)) {
    console.log(`  ${row.slug.padEnd(48)} ${String(row.series_count).padStart(4)} series  ${row.team_count ?? 0} teams`);
  }
}

async function rebuildEverything() {
  const leagues = db.prepare("SELECT DISTINCT league_id FROM maps WHERE league_id > 0").all();
  let series = 0;
  for (const row of leagues) {
    upsertTournament(db, { leagueId: Number(row.league_id), name: `League ${row.league_id}` });
    series += rebuildSeries(db, Number(row.league_id)).series;
    refreshTournamentAggregates(db, Number(row.league_id));
  }
  const named = await resolveTournamentNames(db, { limit: 2000 });
  const scoped = untrackOutOfScopeTournaments(db);
  return { leagues: leagues.length, series, named, scoped };
}

function trainAll() {
  const result = {};
  if (!flag("--draft-only")) {
    result.ratings = trainRatings(db);
    invalidateRatingsCache();
  }
  if (!flag("--ratings-only")) {
    result.draft = trainDraftModel(db);
  }
  return result;
}

try {
  switch (command) {
    case "status":
      printStatus();
      break;

    case "discover": {
      log("discover", await discoverFromProMatches(db, { pages: Number(value("--pages", "3")) }));
      log("names", await resolveTournamentNames(db, { limit: 500 }));
      log("scope", untrackOutOfScopeTournaments(db));
      break;
    }

    case "backfill":
      log("backfill", await backfillHistory(db, { pages: Number(value("--pages", "40")) }));
      break;

    case "collect":
      log("collect", await collectRecent(db));
      break;

    case "drafts":
      log("drafts", await fetchMissingDrafts(db, { limit: Number(value("--limit", "60")) }));
      break;

    case "sync": {
      const leagues = activeTournaments(db);
      for (const league of leagues) log(`sync ${league.slug}`, await syncLeague(db, Number(league.league_id)));
      break;
    }

    case "rebuild":
      log("rebuild", await rebuildEverything());
      break;

    case "train":
      log("train", trainAll());
      break;

    case "resolve":
      log("resolve", resolvePredictions(db));
      break;

    case "forecast": {
      const slug = value("--slug");
      if (slug) {
        const row = tournamentBySlug(db, slug);
        if (!row) throw new Error(`tournament not found: ${slug}`);
        log("forecast", forecastTournament(db, Number(row.league_id), { force: true }));
        const forecast = readForecast(db, Number(row.league_id));
        for (const team of (forecast?.teams ?? []).slice(0, 10)) {
          console.log(`  ${team.champion.toFixed(1).padStart(5)}%  ${`${team.seriesWins}-${team.seriesLosses}`.padEnd(6)} ${team.eliminated ? "OUT " : "    "} ${team.name}`);
        }
      } else {
        log("forecast", await forecastActiveTournaments(db, { force: flag("--force") }));
      }
      break;
    }

    case "live": {
      const result = await syncLiveGames(db);
      log("live", { seen: result.seen, stored: result.stored, predicted: result.predicted, closed: result.closed });
      for (const game of currentLiveGames(db)) {
        const probability = game.frozenDraftProbabilityRadiant;
        console.log(`  ${game.radiantName ?? game.radiantTeamId} vs ${game.direName ?? game.direTeamId} — ${game.phase}${probability === null ? "" : `, radiant ${(probability * 100).toFixed(1)}%`}`);
      }
      break;
    }

    // Everything a fresh install needs, in the right order.
    case "bootstrap": {
      log("discover", await discoverFromProMatches(db, { pages: 3 }));
      log("collect", await collectRecent(db));
      log("backfill", await backfillHistory(db, { pages: Number(value("--pages", "60")) }));
      log("rebuild", await rebuildEverything());
      log("train", trainAll());
      log("forecast", await forecastActiveTournaments(db, { force: true }));
      log("live", await syncLiveGames(db).then((result) => ({ stored: result.stored, predicted: result.predicted })));
      console.log("\n--- status ---");
      printStatus();
      break;
    }

    default:
      console.error(`unknown command: ${command}`);
      console.error("commands: status discover backfill collect drafts sync rebuild train resolve forecast live bootstrap");
      process.exitCode = 1;
  }
} finally {
  closeDb();
}
