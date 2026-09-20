// Optional archive import.
//
// Drop a legacy draft archive into the import directory and the server picks it
// up by itself on the next pass: no command to remember, no order to get wrong.
// Each archive is imported once, tracked by size and mtime, so restarting the
// container does not re-import it and replacing the file does trigger a re-run.
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, getJsonSetting, setJsonSetting, nowIso } from "../core/db.mjs";
import { rebuildSeries, refreshTournamentAggregates, upsertTournament, resolveTournamentNames } from "../core/tournaments.mjs";

export const IMPORT_DIR = path.resolve(process.env.IMPORT_DIR || path.join(DATA_DIR, "import"));
const BATCH_SIZE = Math.max(500, Number(process.env.IMPORT_BATCH_SIZE || 5000));

// Extra paths checked besides the import directory, so a local checkout works
// without moving anything. Set IMPORT_EXTRA_PATHS to a comma-separated list to
// change them, or to an empty string to look only at the import directory.
const EXTRA_CANDIDATES = (process.env.IMPORT_EXTRA_PATHS ?? "work/draft-training.sqlite,import/draft-training.sqlite")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => path.resolve(entry));

const seriesTypeFromBestOf = (bestOf) => (bestOf === 5 ? 2 : bestOf === 3 ? 1 : bestOf === 1 ? 0 : null);
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

function archiveFingerprint(file) {
  const stats = statSync(file);
  return { size: stats.size, mtimeMs: Math.floor(stats.mtimeMs) };
}

// Keyed by content, not by name or path: the same archive reachable through two
// paths must import once, and a replaced file must import again. Keying on the
// basename would let two copies overwrite each other's marker and re-import on
// every pass.
function markerKey(file) {
  const { size, mtimeMs } = archiveFingerprint(file);
  // The version is part of the key: an importer that reads more out of the
  // same file must re-run over archives it has already seen.
  return `archive_import_v2_${size}_${mtimeMs}`;
}

/** Archives present on disk, one entry per distinct file. */
export function findArchives() {
  const paths = [];
  try {
    mkdirSync(IMPORT_DIR, { recursive: true });
    for (const name of readdirSync(IMPORT_DIR)) {
      if (/\.sqlite$/i.test(name)) paths.push(path.join(IMPORT_DIR, name));
    }
  } catch { /* import dir is optional */ }
  for (const candidate of EXTRA_CANDIDATES) if (existsSync(candidate)) paths.push(candidate);

  // The import directory and the local checkout usually hold the same archive,
  // and copying it changes the mtime, so size is what identifies it here. The
  // import directory wins: it is where the operator deliberately put the file.
  const bySize = new Map();
  for (const file of paths) {
    try {
      const { size } = archiveFingerprint(file);
      const inImportDir = file.startsWith(IMPORT_DIR);
      if (!bySize.has(size) || (inImportDir && !bySize.get(size).startsWith(IMPORT_DIR))) {
        bySize.set(size, file);
      }
    } catch { /* vanished between listing and stat */ }
  }
  return [...bySize.values()];
}

/** True when this exact content has already been imported. */
export function alreadyImported(db, file) {
  try {
    return getJsonSetting(db, markerKey(file), null) !== null;
  } catch { return false; }
}

/**
 * Recognise what an archive holds. Only the legacy draft schema is understood
 * today; anything else is skipped loudly rather than half-imported.
 */
function detectSchema(source) {
  const tables = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  if (tables.has("matches") && tables.has("players")) {
    const columns = new Set(source.prepare("PRAGMA table_info(matches)").all().map((row) => row.name));
    if (columns.has("radiant_team_id") && columns.has("radiant_win")) return "legacy_draft";
  }
  return null;
}

/**
 * Import one legacy draft archive. Yields between batches so the API keeps
 * answering while a large file is being read.
 */
export async function importArchive(db, file, { onProgress = null } = {}) {
  const source = new DatabaseSync(file, { readOnly: true });
  try {
    const schema = detectSchema(source);
    if (schema !== "legacy_draft") {
      return { file, skipped: true, reason: "unrecognised_schema" };
    }

    const total = source.prepare("SELECT COUNT(*) AS n FROM matches").get().n;
    // Older archives predate the account_id column. Reading what is there
    // beats failing the whole import over a column that may not exist.
    const playerColumns = new Set(source.prepare("PRAGMA table_info(players)").all().map((row) => row.name));
    const hasAccounts = playerColumns.has("account_id");
    const playersFor = source.prepare(
      `SELECT side, slot, hero_id${hasAccounts ? ", account_id" : ""} FROM players WHERE match_id = ? ORDER BY slot ASC`,
    );
    const insert = db.prepare(`INSERT INTO maps(match_id, league_id, series_id, series_type, radiant_team_id, dire_team_id,
        radiant_win, start_time, duration, patch, radiant_picks_json, dire_picks_json, players_json, detail_fetched, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)
      ON CONFLICT(match_id) DO UPDATE SET
        league_id = CASE WHEN excluded.league_id > 0 THEN excluded.league_id ELSE maps.league_id END,
        series_id = COALESCE(maps.series_id, excluded.series_id),
        series_type = COALESCE(maps.series_type, excluded.series_type),
        radiant_picks_json = COALESCE(maps.radiant_picks_json, excluded.radiant_picks_json),
        dire_picks_json = COALESCE(maps.dire_picks_json, excluded.dire_picks_json),
        players_json = COALESCE(maps.players_json, excluded.players_json),
        patch = COALESCE(maps.patch, excluded.patch),
        detail_fetched = 1,
        updated_at = excluded.updated_at`);

    const rows = source.prepare(`SELECT match_id, league_id, series_id, series_best_of, radiant_team_id, dire_team_id,
                                        radiant_win, start_time, duration, subpatch_id, patch_id
                                 FROM matches
                                 WHERE radiant_team_id > 0 AND dire_team_id > 0 AND radiant_win IS NOT NULL
                                 ORDER BY start_time ASC`).all();

    const at = nowIso();
    const leagues = new Set();
    let imported = 0;
    let skipped = 0;

    db.exec("BEGIN");
    for (let index = 0; index < rows.length; index += 1) {
      const match = rows[index];
      const players = playersFor.all(match.match_id);
      const radiant = players.filter((row) => Number(row.side) === 0).map((row) => Number(row.hero_id)).filter(Boolean);
      const dire = players.filter((row) => Number(row.side) === 1).map((row) => Number(row.hero_id)).filter(Boolean);
      // Account ids are what make a lineup identifiable, so a squad that
      // changed players is not credited with the old squad's results.
      const roster = (hasAccounts ? players : [])
        .filter((row) => Number(row.account_id) > 0)
        .map((row) => ({ accountId: Number(row.account_id), heroId: Number(row.hero_id) || null, isRadiant: Number(row.side) === 0 }));
      if (radiant.length !== 5 || dire.length !== 5 || new Set([...radiant, ...dire]).size !== 10) {
        skipped += 1;
        continue;
      }
      const leagueId = Number(match.league_id || 0);
      insert.run(
        Number(match.match_id), leagueId,
        match.series_id ? String(match.series_id) : null,
        seriesTypeFromBestOf(Number(match.series_best_of)),
        Number(match.radiant_team_id), Number(match.dire_team_id),
        match.radiant_win ? 1 : 0,
        Number(match.start_time) || null, Number(match.duration) || null,
        match.subpatch_id ? String(match.subpatch_id) : (match.patch_id != null ? String(match.patch_id) : null),
        JSON.stringify(radiant), JSON.stringify(dire),
        roster.length ? JSON.stringify(roster) : null, at,
      );
      if (leagueId) leagues.add(leagueId);
      imported += 1;

      if (imported % BATCH_SIZE === 0) {
        db.exec("COMMIT");
        onProgress?.({ processed: index + 1, total, imported });
        await yieldToLoop();
        db.exec("BEGIN");
      }
    }
    db.exec("COMMIT");

    // Rebuild only what the archive touched.
    for (const leagueId of leagues) {
      upsertTournament(db, { leagueId, name: `League ${leagueId}` });
      rebuildSeries(db, leagueId);
      refreshTournamentAggregates(db, leagueId);
      await yieldToLoop();
    }

    setJsonSetting(db, markerKey(file), { ...archiveFingerprint(file), path: file, importedAt: nowIso(), imported, leagues: leagues.size });
    return { file, imported, skipped, leagues: leagues.size, total };
  } finally {
    source.close();
  }
}

/**
 * Scheduler entry point: import every archive that has not been imported yet.
 * Cheap to call when there is nothing to do.
 */
export async function importPendingArchives(db) {
  const archives = findArchives();
  const pending = archives.filter((file) => !alreadyImported(db, file));
  if (!pending.length) return { archives: archives.length, imported: 0, skipped: "nothing_new" };

  const results = [];
  for (const file of pending) {
    try {
      results.push(await importArchive(db, file));
    } catch (error) {
      results.push({ file, error: String(error?.message || error) });
    }
  }
  // Archives carry league ids only; give those leagues real names.
  try {
    await resolveTournamentNames(db, { limit: 2000 });
  } catch { /* naming needs the API and can wait for the next discover pass */ }

  const imported = results.reduce((sum, row) => sum + (Number(row.imported) || 0), 0);
  return { archives: archives.length, processed: results.length, imported, results };
}
