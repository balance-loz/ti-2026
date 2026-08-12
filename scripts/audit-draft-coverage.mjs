import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const DB_PATH = path.resolve(process.env.DRAFT_TRAINING_DB || path.join(ROOT, "work", "draft-training.sqlite"));
const REPORT_PATH = path.resolve(process.env.DRAFT_COVERAGE_REPORT || path.join(ROOT, "work", "draft-coverage.json"));
const STATE_PATH = path.join(ROOT, "work", "opendota-bulk", "state.json");
const WINDOW_YEARS = Math.max(.25, Number(process.env.DRAFT_RESEARCH_WINDOW_YEARS || 2));
const collectorState = await readFile(STATE_PATH, "utf8").then(JSON.parse).catch(() => ({}));
const END_TIME = process.env.DRAFT_RESEARCH_END ? Math.floor(Date.parse(process.env.DRAFT_RESEARCH_END) / 1000) : Number(collectorState.windowEnd || Math.floor(Date.now() / 1000));
const START_TIME = process.env.DRAFT_RESEARCH_START ? Math.floor(Date.parse(process.env.DRAFT_RESEARCH_START) / 1000) : Number(collectorState.windowStart || Math.floor(END_TIME - WINDOW_YEARS * 365.2425 * 86400));
const THRESHOLDS = {
  maps: Math.max(100, Number(process.env.DRAFT_MIN_PATCH_MAPS || 1000)),
  series: Math.max(50, Number(process.env.DRAFT_MIN_PATCH_SERIES || 300)),
  leagues: Math.max(3, Number(process.env.DRAFT_MIN_PATCH_LEAGUES || 10)),
  teams: Math.max(10, Number(process.env.DRAFT_MIN_PATCH_TEAMS || 40)),
  heroGames: Math.max(5, Number(process.env.DRAFT_MIN_HERO_GAMES || 20)),
  heroCoverage: Math.min(1, Math.max(.5, Number(process.env.DRAFT_MIN_HERO_COVERAGE || .9))),
};
const VIABILITY_THRESHOLDS = {
  maps: Math.max(100, Number(process.env.DRAFT_MIN_VERSION_MAPS || 200)),
  series: Math.max(50, Number(process.env.DRAFT_MIN_VERSION_SERIES || 100)),
  leagues: Math.max(3, Number(process.env.DRAFT_MIN_VERSION_LEAGUES || 5)),
  teams: Math.max(10, Number(process.env.DRAFT_MIN_VERSION_TEAMS || 40)),
  heroGames: Math.max(3, Number(process.env.DRAFT_MIN_VERSION_HERO_GAMES || 5)),
  heroCoverage: Math.min(1, Math.max(.5, Number(process.env.DRAFT_MIN_VERSION_HERO_COVERAGE || .7))),
};

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const versions = db.prepare(`
  SELECT subpatch_id AS version, GROUP_CONCAT(DISTINCT patch_id) AS providerPatchIds, COUNT(*) AS maps, COUNT(DISTINCT series_id) AS series,
    COUNT(DISTINCT league_id) AS leagues, MIN(start_time) AS firstMatch, MAX(start_time) AS lastMatch
  FROM matches WHERE domain='pro' AND start_time>=? AND start_time<? AND subpatch_id IS NOT NULL
  GROUP BY subpatch_id ORDER BY firstMatch
`).all(START_TIME, END_TIME);
const heroUniverse = Number(db.prepare("SELECT COUNT(DISTINCT p.hero_id) AS heroes FROM players p JOIN matches m USING(match_id) WHERE m.domain='pro' AND m.start_time>=? AND m.start_time<?").get(START_TIME, END_TIME).heroes);
const heroGamesByVersion = new Map();
for (const row of db.prepare(`SELECT m.subpatch_id AS version,p.hero_id AS heroId,COUNT(*) AS games FROM matches m JOIN players p USING(match_id) WHERE m.domain='pro' AND m.start_time>=? AND m.start_time<? GROUP BY m.subpatch_id,p.hero_id`).all(START_TIME, END_TIME)) {
  const games = heroGamesByVersion.get(row.version) ?? [];
  games.push(Number(row.games)); heroGamesByVersion.set(row.version, games);
}
const teamsByVersion = new Map();
for (const row of db.prepare(`SELECT version,COUNT(DISTINCT teamId) AS teams FROM (SELECT subpatch_id AS version,radiant_team_id AS teamId FROM matches WHERE domain='pro' AND start_time>=? AND start_time<? AND radiant_team_id>0 UNION ALL SELECT subpatch_id AS version,dire_team_id AS teamId FROM matches WHERE domain='pro' AND start_time>=? AND start_time<? AND dire_team_id>0) GROUP BY version`).all(START_TIME, END_TIME, START_TIME, END_TIME)) teamsByVersion.set(row.version, Number(row.teams));
const audited = versions.map((version) => {
  const heroGames = (heroGamesByVersion.get(version.version) ?? []).sort((a, b) => a - b);
  const teams = teamsByVersion.get(version.version) ?? 0;
  const coveredHeroes = heroGames.filter((games) => games >= THRESHOLDS.heroGames).length;
  const viableHeroes = heroGames.filter((games) => games >= VIABILITY_THRESHOLDS.heroGames).length;
  const heroCoverage = heroUniverse ? coveredHeroes / heroUniverse : 0;
  const viableHeroCoverage = heroUniverse ? viableHeroes / heroUniverse : 0;
  const medianHeroGames = heroGames.length ? heroGames[Math.floor(heroGames.length / 2)] : 0;
  const checks = { maps: Number(version.maps) >= THRESHOLDS.maps, series: Number(version.series) >= THRESHOLDS.series, leagues: Number(version.leagues) >= THRESHOLDS.leagues, teams: teams >= THRESHOLDS.teams, heroCoverage: heroCoverage >= THRESHOLDS.heroCoverage };
  const viabilityChecks = { maps: Number(version.maps) >= VIABILITY_THRESHOLDS.maps, series: Number(version.series) >= VIABILITY_THRESHOLDS.series, leagues: Number(version.leagues) >= VIABILITY_THRESHOLDS.leagues, teams: teams >= VIABILITY_THRESHOLDS.teams, heroCoverage: viableHeroCoverage >= VIABILITY_THRESHOLDS.heroCoverage };
  return { ...version, teams, heroUniverse, heroesObserved: heroGames.length, coveredHeroes, heroCoverage, viableHeroes, viableHeroCoverage, medianHeroGames, checks, viabilityChecks, viable: Object.values(viabilityChecks).every(Boolean), sufficient: Object.values(checks).every(Boolean) };
});
if (audited.length) { audited[0].boundaryPartial = true; audited.at(-1).boundaryPartial = true; }
const completeVersions = audited.filter((row) => !row.boundaryPartial);
const viableCompleteVersions = completeVersions.filter((row) => row.viable);
const standaloneVersions = completeVersions.filter((row) => row.sufficient);
const coverage = {
  generatedAt: new Date().toISOString(), window: { years: WINDOW_YEARS, start: new Date(START_TIME * 1000).toISOString(), end: new Date(END_TIME * 1000).toISOString() }, thresholds: { standalone: THRESHOLDS, viability: VIABILITY_THRESHOLDS },
  policy: "Every complete exact version must pass the viability floor; standalone hero-effect evaluation uses the stronger threshold. Boundary-censored versions are retained for training but cannot fail the window.",
  totals: { maps: audited.reduce((sum, row) => sum + Number(row.maps), 0), versions: audited.length, completeVersions: completeVersions.length, viableCompleteVersions: viableCompleteVersions.length, sufficientVersions: standaloneVersions.length },
  versions: audited,
};
coverage.deployment = { sufficient: standaloneVersions.length >= 8 && viableCompleteVersions.length === completeVersions.length, status: standaloneVersions.length >= 8 && viableCompleteVersions.length === completeVersions.length ? "ready_for_training" : "insufficient_data", failedVersions: completeVersions.filter((row) => !row.viable).map((row) => row.version), standaloneVersions: standaloneVersions.map((row) => row.version), boundaryPartialVersions: audited.filter((row) => row.boundaryPartial).map((row) => row.version) };
db.close(); await mkdir(path.dirname(REPORT_PATH), { recursive: true }); await writeFile(REPORT_PATH, `${JSON.stringify(coverage, null, 2)}\n`);
console.log(`Coverage ${coverage.deployment.status}: ${coverage.totals.maps} maps; ${coverage.totals.viableCompleteVersions}/${coverage.totals.completeVersions} viable complete versions; ${coverage.totals.sufficientVersions} standalone evaluation versions.`);
if (process.env.DRAFT_REQUIRE_COVERAGE === "true" && !coverage.deployment.sufficient) process.exitCode = 2;
