#!/usr/bin/env node
// Import a legacy draft archive by hand.
//
// The server does this on its own for anything dropped into the import
// directory, so this script is only for a one-off import from an arbitrary
// path. It shares the same code, so both routes behave identically.
//
//   node scripts/migrate-legacy-drafts.mjs [--source path] [--force]

import { existsSync } from "node:fs";
import path from "node:path";
import { openDb, closeDb } from "../server/core/db.mjs";
import { importArchive, alreadyImported, findArchives, IMPORT_DIR } from "../server/jobs/import-archive.mjs";
import { resolveTournamentNames } from "../server/core/tournaments.mjs";

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const explicit = argValue("--source", null);
const sources = explicit ? [path.resolve(explicit)] : findArchives();

if (!sources.length) {
  console.error("no archive found.");
  console.error(`drop a .sqlite archive into ${IMPORT_DIR} (the server imports it by itself),`);
  console.error("or pass one explicitly: node scripts/migrate-legacy-drafts.mjs --source path/to/archive.sqlite");
  process.exit(1);
}

const db = openDb();
try {
  for (const source of sources) {
    if (!existsSync(source)) {
      console.error(`not found: ${source}`);
      continue;
    }
    if (!args.includes("--force") && alreadyImported(db, source)) {
      console.log(`${path.basename(source)}: already imported, skipping (use --force to redo)`);
      continue;
    }
    console.log(`importing ${source}…`);
    const result = await importArchive(db, source, {
      onProgress: ({ processed, total, imported }) => console.log(`  ${processed}/${total} processed, ${imported} imported`),
    });
    console.log(`  ${JSON.stringify(result)}`);
  }

  console.log("resolving tournament names…");
  console.log(`  ${JSON.stringify(await resolveTournamentNames(db, { limit: 2000 }))}`);

  const counts = db.prepare(`SELECT
      (SELECT COUNT(*) FROM maps) AS maps,
      (SELECT COUNT(*) FROM maps WHERE radiant_picks_json IS NOT NULL) AS with_picks,
      (SELECT COUNT(*) FROM series) AS series,
      (SELECT COUNT(*) FROM tournaments) AS tournaments`).get();
  console.log("store now:", JSON.stringify(counts));
  console.log("next: node scripts/predictor.mjs train");
} finally {
  closeDb();
}
