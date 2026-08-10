import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { completedSeriesFromMaps } from "../server/live-series.mjs";

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
  assert.deepEqual(series[0], { seriesId: "99", teamA: "1w", teamB: "nigma", winsA: 2, winsB: 0, startTime: 100, mapIds: [1, 2] });
});

test("Ubuntu deployment documents automatic live sync", async () => {
  const guide = await readFile("docs/UBUNTU_DEPLOY.md", "utf8");
  const compose = await readFile("docker-compose.yml", "utf8");
  assert.match(guide, /TI_LEAGUE_ID=19719/);
  assert.match(guide, /ssh -L 8080/);
  assert.match(compose, /LIVE_SYNC_INTERVAL_MINUTES/);
});
