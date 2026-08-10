import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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
