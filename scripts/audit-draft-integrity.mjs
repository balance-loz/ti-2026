import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const db = new DatabaseSync(path.join(ROOT, "work", "draft-training.sqlite"), { readOnly: true });
const timeline = JSON.parse(await readFile(path.join(ROOT, "work", "patch-timeline.json"), "utf8"));
const totals = db.prepare("SELECT COUNT(*) AS maps,COUNT(DISTINCT match_id) AS uniqueMaps FROM matches").get();
const badPlayerMaps = Number(db.prepare("SELECT COUNT(*) AS maps FROM (SELECT match_id,COUNT(*) AS players,COUNT(DISTINCT hero_id) AS heroes FROM players GROUP BY match_id HAVING players!=10 OR heroes!=10)").get().maps);
const missing = db.prepare("SELECT SUM(series_id IS NULL) AS seriesId,SUM(series_id_source IS NULL OR series_id_source NOT IN ('provider','synthetic_match')) AS seriesIdSource,SUM(subpatch_id IS NULL) AS subpatch,SUM(source IS NULL OR source='') AS source,SUM(content_checksum IS NULL OR LENGTH(content_checksum)!=64) AS checksum FROM matches WHERE domain='pro'").get();
let boundaryErrors = 0;
const versionCounts = [];
for (const patch of timeline.versions.filter((row) => row.overlapsWindow)) {
  const row = db.prepare("SELECT COUNT(*) AS maps,SUM(start_time<? OR start_time>=?) AS outside FROM matches WHERE domain='pro' AND subpatch_id=?").get(Number(patch.timestamp), Number(patch.effectiveEnd), patch.version);
  boundaryErrors += Number(row.outside || 0); versionCounts.push({ version: patch.version, maps: Number(row.maps) });
}
const result = { maps: Number(totals.maps), uniqueMaps: Number(totals.uniqueMaps), badPlayerMaps, missing: Object.fromEntries(Object.entries(missing).map(([key, value]) => [key, Number(value || 0)])), boundaryErrors, exactVersions: versionCounts.length };
const playerQuality = db.prepare("SELECT COUNT(*) AS rows,SUM(account_id>0) AS knownAccounts,SUM(role BETWEEN 1 AND 5) AS knownRoles FROM players").get();
result.quality = {
  providerSeriesShare: Number(db.prepare("SELECT AVG(series_id_source='provider') AS value FROM matches WHERE domain='pro'").get().value),
  knownTeamShare: Number(db.prepare("SELECT AVG(radiant_team_id>0 AND dire_team_id>0) AS value FROM matches WHERE domain='pro'").get().value),
  knownAccountShare: Number(playerQuality.knownAccounts) / Number(playerQuality.rows),
  knownRoleShare: Number(playerQuality.knownRoles) / Number(playerQuality.rows),
};
db.close();
console.log(JSON.stringify(result, null, 2));
if (result.maps !== result.uniqueMaps || badPlayerMaps || Object.values(result.missing).some(Boolean) || boundaryErrors) process.exitCode = 2;
