import { readFile, writeFile, mkdir } from "node:fs/promises";

const source = JSON.parse(await readFile("public/team-stats.json", "utf8"));
const candidates = [45, 60, 75, 90, 120];
const ratingL2Penalty = source.methodology.ratingL2Penalty ?? 0.025;
const observations = [];
const seen = new Set();
for (const [teamId, team] of Object.entries(source.teams)) {
  for (const tournament of team.tournaments) {
    if (!tournament.rosterWeight || tournament.rosterWeight <= 0) continue;
    for (const series of tournament.series) {
      if (!series.opponentTiId) continue;
      const key = `${Math.min(...series.maps.map((map) => map.matchId))}`;
      if (seen.has(key)) continue;
      seen.add(key);
      observations.push({ a: teamId, b: series.opponentTiId, y: series.wins / (series.wins + series.losses), time: series.startTime, rosterWeight: tournament.rosterWeight });
    }
  }
}
observations.sort((a, b) => a.time - b.time);
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
function predictWithHistory(history, test, halfLife) {
  const ratings = Object.fromEntries(Object.keys(source.teams).map((id) => [id, 0]));
  for (let iteration = 0; iteration < 700; iteration += 1) {
    const gradient = Object.fromEntries(Object.keys(ratings).map((id) => [id, -ratingL2Penalty * ratings[id]]));
    for (const row of history) {
      const weight = row.rosterWeight * 0.5 ** (((test.time - row.time) / 86400) / halfLife);
      const error = weight * (row.y - sigmoid(ratings[row.a] - ratings[row.b]));
      gradient[row.a] += error; gradient[row.b] -= error;
    }
    const rate = 0.018 / Math.sqrt(1 + iteration / 120);
    for (const id of Object.keys(ratings)) ratings[id] += rate * gradient[id];
  }
  return sigmoid(ratings[test.a] - ratings[test.b]);
}
const results = candidates.map((halfLifeDays) => {
  let brier = 0; let logLoss = 0; let count = 0;
  for (let index = 8; index < observations.length; index += 1) {
    const row = observations[index];
    const p = Math.min(0.97, Math.max(0.03, predictWithHistory(observations.slice(0, index), row, halfLifeDays)));
    brier += (p - row.y) ** 2;
    logLoss += -(row.y * Math.log(p) + (1 - row.y) * Math.log(1 - p));
    count += 1;
  }
  return { halfLifeDays, samples: count, brier: brier / Math.max(1, count), logLoss: logLoss / Math.max(1, count) };
}).sort((a, b) => a.logLoss - b.logLoss);
const report = { generatedAt: new Date().toISOString(), method: "expanding-window walk-forward; every prediction uses only earlier series; optimizer and regularization match the production Bradley-Terry fit", ratingL2Penalty, chosenHalfLifeDays: results[0]?.halfLifeDays ?? 45, candidates: results };
await mkdir("work", { recursive: true });
await writeFile("work/model-calibration.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
