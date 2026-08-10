import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { completedSeriesFromMaps } from "../server/live-series.mjs";
import { buildForecastSource, ROUND_ONE, runForecast, SWISS_GROUPS, SWISS_GROUP_BY_TEAM, swissBucketKey } from "../server/forecast-engine.mjs";

test("first three Swiss rounds are restricted to the revealed groups", () => {
  const participants = [...SWISS_GROUPS.A, ...SWISS_GROUPS.B];
  assert.equal(SWISS_GROUPS.A.length, 8);
  assert.equal(SWISS_GROUPS.B.length, 8);
  assert.equal(new Set(participants).size, 16);
  for (const [teamA, teamB] of ROUND_ONE) assert.equal(SWISS_GROUP_BY_TEAM[teamA], SWISS_GROUP_BY_TEAM[teamB]);
  assert.notEqual(swissBucketKey("1w", 1, 0, 2), swissBucketKey("aurora", 1, 0, 2));
  assert.equal(swissBucketKey("1w", 2, 1, 4), swissBucketKey("aurora", 2, 1, 4));
});

test("statistics contain every TI matchup and calibrated methodology", async () => {
  const stats = JSON.parse(await readFile("public/team-stats.json", "utf8"));
  assert.equal(Object.keys(stats.teams).length, 16);
  assert.equal(Object.keys(stats.pairwise).length, 120);
  assert.equal(stats.methodology.recencyHalfLifeDays, 45);
  assert.deepEqual(stats.methodology.rosterWeights, { 3: 0.07, 4: 0.25, 5: 1 });
  for (const pair of Object.values(stats.pairwise)) {
    assert.ok(pair.probabilityA >= 7 && pair.probabilityA <= 93);
    assert.ok(pair.uncertainty > 0);
  }
});

test("deployment files do not contain the administrator password", async () => {
  const compose = await readFile("docker-compose.yml", "utf8");
  const example = await readFile(".env.example", "utf8");
  assert.match(compose, /ADMIN_PASSWORD/);
  assert.match(example, /replace-with-a-long-random-password/);
  assert.doesNotMatch(compose, /test-password/);
});

test("OpenDota maps become a completed series only after two wins", () => {
  const maps = [
    { match_id: 1, series_id: 99, start_time: 100, radiant_team_id: 10182357, dire_team_id: 10136357, radiant_win: true },
    { match_id: 2, series_id: 99, start_time: 200, radiant_team_id: 10136357, dire_team_id: 10182357, radiant_win: false },
    { match_id: 3, series_id: 100, start_time: 300, radiant_team_id: 9467224, dire_team_id: 9964962, radiant_win: true },
  ];
  const series = completedSeriesFromMaps(maps);
  assert.equal(series.length, 1);
  assert.deepEqual(series[0], { seriesId: "99", teamA: "1w", teamB: "nigma", winsA: 2, winsB: 0, startTime: 100, seriesType: 1, mapIds: [1, 2] });
});

test("OpenDota BO5 is not completed at 2-0", () => {
  const maps = [1, 2].map((matchId) => ({ match_id: matchId, series_id: 7, series_type: 2, start_time: matchId, radiant_team_id: 10182357, dire_team_id: 10136357, radiant_win: true }));
  assert.equal(completedSeriesFromMaps(maps).length, 0);
  maps.push({ match_id: 3, series_id: 7, series_type: 2, start_time: 3, radiant_team_id: 10136357, dire_team_id: 10182357, radiant_win: false });
  assert.equal(completedSeriesFromMaps(maps).length, 1);
});

test("Ubuntu deployment documents automatic live sync", async () => {
  const guide = await readFile("docs/UBUNTU_DEPLOY.md", "utf8");
  const compose = await readFile("docker-compose.yml", "utf8");
  assert.match(guide, /TI_LEAGUE_ID=19719/);
  assert.match(guide, /ssh -L 8080/);
  assert.match(compose, /LIVE_SYNC_INTERVAL_MINUTES/);
});

test("all sixteen local team logos are present", async () => {
  const names = ["1w", "aurora", "betboom", "gamerlegion", "l1ga", "lgd", "liquid", "nigma", "og", "parivision", "resilience", "spirit", "vg", "xtreme", "yandex"];
  for (const name of names) assert.equal((await readFile(`public/team-logos/${name}.webp`)).subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal((await readFile("public/team-logos/falcons.jpg")).subarray(0, 2).toString("hex"), "ffd8");
});

test("server forecast can create an automatic snapshot payload", async () => {
  const stats = JSON.parse(await readFile("public/team-stats.json", "utf8"));
  const probabilities = buildForecastSource({ answers: {}, stats, matches: [], mode: "stats", opinionWeight: 0 });
  assert.equal(Object.keys(probabilities).length, 120);
  const result = runForecast(probabilities, 100, 123, { stats, matches: [] });
  assert.equal(result.teams.length, 16);
  assert.equal(result.iterations, 100);
  assert.equal(result.formatVersion, "hidden-groups-r1-r3-v1");
  assert.equal(result.teams.filter((team) => team.qualify > 0).length > 0, true);
});
