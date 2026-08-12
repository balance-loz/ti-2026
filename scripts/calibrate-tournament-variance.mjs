import { readFile, writeFile } from "node:fs/promises";

const rows = JSON.parse(await readFile("work/team-model-oof.json", "utf8"));
const teamModel = JSON.parse(await readFile("public/team-model.json", "utf8"));
const teamStats = JSON.parse(await readFile("public/team-stats.json", "utf8"));
const selected = teamModel.selected.id;
const clamp = (value) => Math.min(.999, Math.max(.001, value));
const logit = (value) => Math.log(clamp(value) / (1 - clamp(value)));
const sigmoid = (value) => 1 / (1 + Math.exp(-value));
const loss = (p, y) => -(y * Math.log(clamp(p)) + (1 - y) * Math.log(1 - clamp(p)));

const leagues = [...new Map(rows.map((row) => [row.leagueId, row.startTime])).entries()].sort((a, b) => a[1] - b[1]);
const holdoutIds = new Set(leagues.slice(Math.max(1, Math.floor(leagues.length * .8))).map(([id]) => id));
const inner = rows.filter((row) => !holdoutIds.has(row.leagueId)); const holdout = rows.filter((row) => holdoutIds.has(row.leagueId));

function evaluate(data, config) {
  const state = new Map(); let ll = 0; let brier = 0; const predictions = [];
  for (const row of data) {
    const league = state.get(row.leagueId) ?? { teams: new Map(), pairs: new Map() };
    const pair = [row.targetLineup, row.opponentLineup].sort().join("|"); const orientation = pair.startsWith(`${row.targetLineup}|`) ? 1 : -1;
    const teamA = league.teams.get(row.targetLineup) ?? 0; const teamB = league.teams.get(row.opponentLineup) ?? 0; const direct = orientation * (league.pairs.get(pair) ?? 0);
    const baseLogit = logit(row[selected]);
    const adjusted = sigmoid((baseLogit + config.liveGlobal * (teamA - teamB) + config.liveRematch * direct) / config.temperature);
    ll += loss(adjusted, row.outcome); brier += (adjusted - row.outcome) ** 2;
    predictions.push({ seriesId: row.seriesId, leagueId: row.leagueId, outcome: row.outcome, probability: adjusted });
    const surprise = row.outcome - clamp(row[selected]); league.teams.set(row.targetLineup, teamA + surprise); league.teams.set(row.opponentLineup, teamB - surprise); league.pairs.set(pair, (league.pairs.get(pair) ?? 0) + orientation * surprise); state.set(row.leagueId, league);
  }
  return { samples: data.length, logLoss: ll / data.length, brier: brier / data.length, predictions };
}

function clusterBootstrap(candidate, baseline, iterations = 5000) {
  const groups = new Map(); for (let index = 0; index < candidate.length; index++) { const key = `${candidate[index].leagueId}:${candidate[index].seriesId}`; groups.set(key, [...(groups.get(key) ?? []), { candidate: candidate[index], baseline: baseline[index] }]); }
  const ids = [...groups.keys()]; let seed = 0x6173ac; const random = () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let value = Math.imul(seed ^ seed >>> 15, 1 | seed); value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value; return ((value ^ value >>> 14) >>> 0) / 4294967296; }; const deltas = [];
  for (let iteration = 0; iteration < iterations; iteration++) { let delta = 0; let n = 0; for (let draw = 0; draw < ids.length; draw++) for (const pair of groups.get(ids[Math.floor(random() * ids.length)])) { delta += loss(pair.candidate.probability, pair.candidate.outcome) - loss(pair.baseline.probability, pair.baseline.outcome); n++; } deltas.push(delta / n); }
  deltas.sort((a, b) => a - b); return { lower95: deltas[Math.floor(iterations * .025)], upper95: deltas[Math.floor(iterations * .975)], iterations, cluster: "series_id", clusters: ids.length };
}

let best = { liveGlobal: 0, liveRematch: 0, temperature: 1, logLoss: Infinity };
for (const liveGlobal of [0, .1, .2, .3, .4]) for (const liveRematch of [0, .05, .1, .15, .2]) for (const temperature of [.8, .9, 1, 1.1, 1.2, 1.35]) {
  const metric = evaluate(inner, { liveGlobal, liveRematch, temperature }); if (metric.logLoss < best.logLoss) best = { liveGlobal, liveRematch, temperature, logLoss: metric.logLoss };
}
const baselineResult = evaluate(holdout, { liveGlobal: 0, liveRematch: 0, temperature: 1 }); const calibratedResult = evaluate(holdout, best);
const bootstrap = clusterBootstrap(calibratedResult.predictions, baselineResult.predictions);
const baseline = { samples: baselineResult.samples, logLoss: baselineResult.logLoss, brier: baselineResult.brier };
const calibrated = { samples: calibratedResult.samples, logLoss: calibratedResult.logLoss, brier: calibratedResult.brier };

// Estimate persistent tournament form from regularized team residuals. This is
// measured independently of the live-update grid and capped for safe simulation.
const effects = [];
for (const leagueId of new Set(inner.map((row) => row.leagueId))) {
  const sums = new Map();
  for (const row of inner.filter((value) => value.leagueId === leagueId)) {
    const residual = row.outcome - clamp(row[selected]);
    for (const [team, value] of [[row.targetLineup, residual], [row.opponentLineup, -residual]]) { const item = sums.get(team) ?? { sum: 0, games: 0 }; item.sum += value; item.games++; sums.set(team, item); }
  }
  for (const item of sums.values()) if (item.games >= 3) effects.push(item.sum / (item.games + 6));
}
const mean = effects.reduce((sum, value) => sum + value, 0) / Math.max(1, effects.length);
const empiricalSd = Math.sqrt(effects.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, effects.length - 1));
const formLogitSd = Math.min(.35, Math.max(0, 4 * empiricalSd));
const seriesNoiseLogitSd = 0;
const validated = calibrated.logLoss < baseline.logLoss && calibrated.brier <= baseline.brier && bootstrap.upper95 < 0;
const artifact = { schemaVersion: 2, generatedAt: new Date().toISOString(), sourceTeamModelId: selected, methodology: "nested tournament calibration: live coefficients and temperature selected on first 80% leagues; evaluated on untouched final 20%; persistent form SD estimated from regularized within-league team residuals; no extra per-series Gaussian shock because Bernoulli sampling already represents match-level aleatoric uncertainty", selected: { liveGlobal: best.liveGlobal, liveRematch: best.liveRematch, probabilityTemperature: best.temperature, formLogitSd, seriesNoiseLogitSd }, dataset: { series: rows.length, leagues: leagues.length, innerSeries: inner.length, holdoutSeries: holdout.length, formEffects: effects.length }, holdout: { baseline, calibrated, logLossDelta: calibrated.logLoss - baseline.logLoss, bootstrap }, validation: { status: validated ? "candidate" : "experimental", validated, formSdHitSafetyCap: formLogitSd === .35, note: "form SD is an empirical latent-variance estimate, not posterior uncertainty; per-series shock is disabled rather than guessed" } };
teamStats.tournamentCalibration = artifact;
for (const pair of Object.values(teamStats.pairwise ?? {})) pair.uncertainty = Number(seriesNoiseLogitSd.toFixed(4));
await Promise.all([writeFile("public/tournament-calibration.json", `${JSON.stringify(artifact, null, 2)}\n`), writeFile("work/tournament-calibration.json", `${JSON.stringify(artifact, null, 2)}\n`), writeFile("public/team-stats.json", `${JSON.stringify(teamStats, null, 2)}\n`)]);
console.log(`Tournament calibration: form SD ${formLogitSd.toFixed(4)}, live ${best.liveGlobal}/${best.liveRematch}, temperature ${best.temperature}; holdout delta ${(calibrated.logLoss - baseline.logLoss).toFixed(6)}; ${artifact.validation.status.toUpperCase()}`);
