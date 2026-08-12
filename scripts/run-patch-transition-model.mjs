import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const DB_PATH = path.resolve(process.env.DRAFT_TRAINING_DB || path.join(ROOT, "work", "draft-training.sqlite"));
const TIMELINE_PATH = path.resolve(process.env.DRAFT_PATCH_TIMELINE || path.join(ROOT, "work", "patch-timeline.json"));
const COVERAGE_PATH = path.resolve(process.env.DRAFT_COVERAGE_REPORT || path.join(ROOT, "work", "draft-coverage.json"));
const REPORT_PATH = path.join(ROOT, "work", "patch-transition-backtest.json");
const ARTIFACT_PATH = path.join(ROOT, "public", "patch-transition-model.json");
const HERO_PRIOR = 40;
const PAIR_PRIOR = 20;
const LAMBDAS = [.1, 1, 10, 100];
const NO_NOTES_FEATURES = [0, 1, 10, 11];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const logit = (p) => Math.log(clamp(p, .02, .98) / (1 - clamp(p, .02, .98)));
const pairKey = (a, b) => [Number(a), Number(b)].sort((x, y) => x - y).join("|");

function solve(matrix, vector) {
  const n = vector.length; const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col; for (let row = col + 1; row < n; row += 1) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const divisor = Math.abs(a[col][col]) < 1e-10 ? 1e-10 : a[col][col];
    for (let j = col; j <= n; j += 1) a[col][j] /= divisor;
    for (let row = 0; row < n; row += 1) if (row !== col) { const factor = a[row][col]; for (let j = col; j <= n; j += 1) a[row][j] -= factor * a[col][j]; }
  }
  return a.map((row) => row[n]);
}

function fitRidge(rows, lambda) {
  const width = rows[0].x.length; const means = Array(width).fill(0); const scales = Array(width).fill(0);
  for (const row of rows) row.x.forEach((value, i) => { means[i] += value / rows.length; });
  for (const row of rows) row.x.forEach((value, i) => { scales[i] += (value - means[i]) ** 2 / rows.length; });
  for (let i = 0; i < width; i += 1) scales[i] = Math.sqrt(scales[i]) || 1;
  const dim = width + 1; const xtx = Array.from({ length: dim }, () => Array(dim).fill(0)); const xty = Array(dim).fill(0);
  for (const row of rows) {
    const x = [1, ...row.x.map((value, i) => (value - means[i]) / scales[i])]; const weight = Math.sqrt(Math.min(1000, Math.max(1, row.weight ?? 1)));
    for (let i = 0; i < dim; i += 1) { xty[i] += x[i] * row.y * weight; for (let j = 0; j < dim; j += 1) xtx[i][j] += x[i] * x[j] * weight; }
  }
  for (let i = 1; i < dim; i += 1) xtx[i][i] += lambda;
  return { lambda, means, scales, beta: solve(xtx, xty) };
}

function predict(model, x) { return model.beta[0] + x.reduce((sum, value, i) => sum + model.beta[i + 1] * (value - model.means[i]) / model.scales[i], 0); }

function noteFeatures(details, heroId) {
  const hero = (details.heroes ?? []).find((value) => Number(value.hero_id) === Number(heroId));
  const groups = [hero?.hero_notes ?? [], hero?.talent_notes ?? [], ...(hero?.abilities ?? []).map((ability) => ability.ability_notes ?? [])];
  const notes = groups.flat().map((entry) => String(entry.note ?? "").toLowerCase());
  const count = (pattern) => notes.filter((note) => pattern.test(note)).length;
  const abilityNotes = (hero?.abilities ?? []).flatMap((ability) => ability.ability_notes ?? []).length;
  const talentNotes = (hero?.talent_notes ?? []).length;
  return {
    changed: Number(notes.length > 0), notes: notes.length, numeric: count(/\d/), increases: count(/increas|improv|gain|bonus|rescal|stronger/),
    decreases: count(/decreas|reduc|lower|weaker/), reworks: count(/rework|replac|removed|new |no longer|now /), abilityNotes, talentNotes,
  };
}

const [timeline, coverage] = await Promise.all([readFile(TIMELINE_PATH, "utf8").then(JSON.parse), readFile(COVERAGE_PATH, "utf8").then(JSON.parse)]);
const versions = timeline.versions.filter((patch) => patch.overlapsWindow).sort((a, b) => a.timestamp - b.timestamp);
const coverageByVersion = new Map(coverage.versions.map((row) => [row.version, row]));
const notesByVersion = new Map();
for (const patch of versions) notesByVersion.set(patch.version, JSON.parse(await readFile(path.join(ROOT, patch.detailsFile), "utf8")));

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const mapRows = db.prepare("SELECT match_id,subpatch_id,radiant_team_id,dire_team_id,radiant_win,start_time FROM matches WHERE domain='pro' ORDER BY start_time,match_id").all();
const playerRows = db.prepare("SELECT match_id,side,hero_id FROM players ORDER BY match_id,side,slot").all(); db.close();
const heroesByMap = new Map(); for (const player of playerRows) { const sides = heroesByMap.get(Number(player.match_id)) ?? [[], []]; sides[Number(player.side)].push(Number(player.hero_id)); heroesByMap.set(Number(player.match_id), sides); }
const stats = new Map(); const heroIds = new Set(); const teamRatings = new Map(); let sideGames = 0; let sideWins = 0;
const rating = (id) => teamRatings.get(String(id)) ?? 0;
for (const map of mapRows) {
  const heroes = heroesByMap.get(Number(map.match_id)); if (!heroes || heroes[0].length !== 5 || heroes[1].length !== 5) continue;
  const radiantId = Number(map.radiant_team_id) > 0 ? `od:${map.radiant_team_id}` : `unknown:${map.match_id}:r`;
  const direId = Number(map.dire_team_id) > 0 ? `od:${map.dire_team_id}` : `unknown:${map.match_id}:d`;
  const sideBias = logit((sideWins + 30 * .5) / (sideGames + 30)); const expected = 1 / (1 + Math.exp(-(rating(radiantId) - rating(direId) + sideBias)));
  const outcome = Number(map.radiant_win); const residual = outcome - expected; const version = String(map.subpatch_id); const versionStats = stats.get(version) ?? new Map();
  for (const heroId of heroes[0]) { const row = versionStats.get(heroId) ?? { games: 0, residualSum: 0 }; row.games++; row.residualSum += residual; versionStats.set(heroId, row); heroIds.add(heroId); }
  for (const heroId of heroes[1]) { const row = versionStats.get(heroId) ?? { games: 0, residualSum: 0 }; row.games++; row.residualSum -= residual; versionStats.set(heroId, row); heroIds.add(heroId); }
  stats.set(version, versionStats); const step = .08 / Math.sqrt(1 + sideGames / 500); teamRatings.set(radiantId, rating(radiantId) + step * residual); teamRatings.set(direId, rating(direId) - step * residual); sideGames++; sideWins += outcome;
}
const strength = (version, heroId) => { const row = stats.get(version)?.get(heroId) ?? { games: 0, residualSum: 0 }; return { ...row, wins: row.games * .5 + row.residualSum, value: 4 * row.residualSum / (row.games + HERO_PRIOR) }; };
const family = (version) => String(version).match(/^\d+\.\d+/)?.[0] ?? String(version);
const featureNames = ["previousStrength", "logPreviousGames", "changed", "logNotes", "numericNotes", "increaseWords", "decreaseWords", "reworkWords", "abilityNotes", "talentNotes", "majorPatch", "logGlobalNotes"];
const transitionRows = [];
for (let index = 1; index < versions.length; index += 1) {
  const previous = versions[index - 1]; const current = versions[index]; const details = notesByVersion.get(current.version); const globalNotes = (details.general_notes ?? []).length;
  for (const heroId of heroIds) {
    const before = strength(previous.version, heroId); const after = strength(current.version, heroId); const notes = noteFeatures(details, heroId);
    const x = [before.value, Math.log1p(before.games), notes.changed, Math.log1p(notes.notes), notes.numeric, notes.increases, notes.decreases, notes.reworks, notes.abilityNotes, notes.talentNotes, Number(family(previous.version) !== family(current.version)), Math.log1p(globalNotes)];
    transitionRows.push({ transitionIndex: index, from: previous.version, to: current.version, heroId, x, y: after.value - before.value, weight: Math.sqrt(Math.max(1, Math.min(before.games, after.games))), before: before.value, after: after.value, beforeGames: before.games, afterGames: after.games, changed: notes.changed });
  }
}

const oof = [];
for (let transitionIndex = 1; transitionIndex < versions.length; transitionIndex += 1) {
  const train = transitionRows.filter((row) => row.transitionIndex < transitionIndex && row.afterGames >= 5);
  const test = transitionRows.filter((row) => row.transitionIndex === transitionIndex);
  const models = train.length >= 250 ? LAMBDAS.map((lambda) => fitRidge(train, lambda)) : [];
  const noNotesModels = train.length >= 250 ? LAMBDAS.map((lambda) => fitRidge(train.map((row) => ({ ...row, x: NO_NOTES_FEATURES.map((index) => row.x[index]) })), lambda)) : [];
  for (const row of test) {
    const candidates = models.map((model) => predict(model, row.x));
    const noNotesCandidates = noNotesModels.map((model) => predict(model, NO_NOTES_FEATURES.map((index) => row.x[index])));
    const ensemble = candidates.length ? candidates.reduce((sum, value) => sum + value, 0) / candidates.length : 0;
    const noNotes = noNotesCandidates.length ? noNotesCandidates.reduce((sum, value) => sum + value, 0) / noNotesCandidates.length : 0;
    oof.push({ ...row, baseline: 0, noNotes, ensemble, candidates });
  }
}

function metrics(rows, key) {
  let squared = 0; let absolute = 0; let weight = 0; let predictedMean = 0; let actualMean = 0;
  for (const row of rows) { const w = row.weight; const error = row[key] - row.y; squared += w * error ** 2; absolute += w * Math.abs(error); weight += w; predictedMean += w * row[key]; actualMean += w * row.y; }
  predictedMean /= weight; actualMean /= weight; let covariance = 0; let predictedVariance = 0; let actualVariance = 0;
  for (const row of rows) { const w = row.weight; covariance += w * (row[key] - predictedMean) * (row.y - actualMean); predictedVariance += w * (row[key] - predictedMean) ** 2; actualVariance += w * (row.y - actualMean) ** 2; }
  return { rows: rows.length, weightedRmse: Math.sqrt(squared / weight), weightedMae: absolute / weight, weightedCorrelation: covariance / Math.sqrt(Math.max(1e-12, predictedVariance * actualVariance)) };
}

function transitionClusterBootstrap(rows, candidate, baseline, iterations = 5000) {
  const groups = new Map(); for (const row of rows) groups.set(row.transitionIndex, [...(groups.get(row.transitionIndex) ?? []), row]);
  const ids = [...groups.keys()]; let seed = 0x3a7c91; const random = () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let value = Math.imul(seed ^ seed >>> 15, 1 | seed); value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value; return ((value ^ value >>> 14) >>> 0) / 4294967296; };
  const deltas = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let candidateSquared = 0; let baselineSquared = 0; let weight = 0;
    for (let draw = 0; draw < ids.length; draw += 1) for (const row of groups.get(ids[Math.floor(random() * ids.length)])) { candidateSquared += row.weight * (row[candidate] - row.y) ** 2; baselineSquared += row.weight * (row[baseline] - row.y) ** 2; weight += row.weight; }
    deltas.push(Math.sqrt(candidateSquared / weight) - Math.sqrt(baselineSquared / weight));
  }
  deltas.sort((a, b) => a - b);
  return { candidate, baseline, cluster: "exact_patch_transition", clusters: ids.length, iterations, lower95: deltas[Math.floor(iterations * .025)], upper95: deltas[Math.floor(iterations * .975)] };
}

const evaluable = oof.filter((row) => row.transitionIndex >= 3 && coverageByVersion.get(row.to)?.viable && row.afterGames >= 5);
const changed = evaluable.filter((row) => row.changed);
const perVersion = versions.slice(1).map((patch, index) => { const rows = evaluable.filter((row) => row.transitionIndex === index + 1); return { version: patch.version, viable: Boolean(coverageByVersion.get(patch.version)?.viable), maps: Number(coverageByVersion.get(patch.version)?.maps ?? 0), heroes: rows.length, baseline: rows.length ? metrics(rows, "baseline") : null, noNotes: rows.length ? metrics(rows, "noNotes") : null, ensemble: rows.length ? metrics(rows, "ensemble") : null }; });
const latest = versions.at(-1); const latestRows = oof.filter((row) => row.to === latest.version);
const predictedHeroes = Object.fromEntries(latestRows.map((row) => [row.heroId, { previousStrength: row.before, predictedDelta: row.ensemble, predictedStrength: row.before + row.ensemble, actualStrength: row.after, previousGames: row.beforeGames, currentGames: row.afterGames, changed: Boolean(row.changed) }]));
const exportHeroForecasts = Object.fromEntries(Object.entries(predictedHeroes).map(([heroId, row]) => [heroId, { previousStrength: row.previousStrength, predictedDelta: row.predictedDelta, predictedStrength: row.predictedStrength, previousGames: row.previousGames, changed: row.changed }]));
const baselineMetrics = metrics(evaluable, "baseline"); const noNotesMetrics = metrics(evaluable, "noNotes"); const ensembleMetrics = metrics(evaluable, "ensemble");
const bootstrapVsCarry = transitionClusterBootstrap(evaluable, "ensemble", "baseline"); const bootstrapVsNoNotes = transitionClusterBootstrap(evaluable, "ensemble", "noNotes");
const candidateMetrics = Object.fromEntries(LAMBDAS.map((lambda, index) => [`ridge_${lambda}`, metrics(evaluable.map((row) => ({ ...row, candidate: row.candidates[index] ?? 0 })), "candidate")]));
const report = {
  generatedAt: new Date().toISOString(), methodology: "strict patch-transition walk-forward: train only on earlier exact versions; target is regularized hero outcome residual after chronological team/opponent and Radiant expectation; official Valve patch-note features; no target-version games in a forecast", target: { name: "team_opponent_adjusted_hero_residual", formula: "4 * sum(sideOutcome - pre-map online team+side expectation) / (heroGames + 40)", leakageControl: "team and side state updated only after each map" }, featureNames, lambdas: LAMBDAS,
  dataset: { window: coverage.window, maps: coverage.totals.maps, exactVersions: versions.length, transitions: versions.length - 1, heroes: heroIds.size, evaluableRows: evaluable.length, changedHeroRows: changed.length },
  coverage: coverage.deployment, metrics: { all: { baseline: baselineMetrics, noNotes: noNotesMetrics, ensemble: ensembleMetrics, rmseImprovementVsCarry: baselineMetrics.weightedRmse - ensembleMetrics.weightedRmse, rmseImprovementFromNotes: noNotesMetrics.weightedRmse - ensembleMetrics.weightedRmse }, changedHeroes: { baseline: metrics(changed, "baseline"), noNotes: metrics(changed, "noNotes"), ensemble: metrics(changed, "ensemble") }, candidates: candidateMetrics }, bootstrap: { versusCarry: bootstrapVsCarry, versusNoNotes: bootstrapVsNoNotes }, perVersion,
  currentForecast: { version: latest.version, from: versions.at(-2).version, boundaryPartial: Boolean(coverageByVersion.get(latest.version)?.boundaryPartial), heroes: predictedHeroes },
};
const notesAddValue = ensembleMetrics.weightedRmse < noNotesMetrics.weightedRmse && bootstrapVsNoNotes.upper95 < 0;
const artifact = { schemaVersion: 2, modelId: createHash("sha256").update(JSON.stringify({ featureNames, lambdas: LAMBDAS, exportHeroForecasts, timeline: timeline.checksum })).digest("hex").slice(0, 16), generatedAt: report.generatedAt, sourceTimelineChecksum: timeline.checksum, researchWindow: coverage.window, deploymentStatus: coverage.deployment.sufficient && ensembleMetrics.weightedRmse < baselineMetrics.weightedRmse && notesAddValue ? "candidate" : "experimental", currentVersion: latest.version, previousVersion: versions.at(-2).version, target: report.target, featureNames, heroForecasts: exportHeroForecasts, pairForecastRule: { status: "disabled_until_direct_residual_transition_is_trained", synergy: "not inferred from hero deltas", counter: "not inferred from hero deltas", priorGames: PAIR_PRIOR }, validation: { notesAddValue, comparedWithCarryAndNoNotesAblation: true, targetOutcomesExcludedFromArtifact: true, teamOpponentAdjustedTarget: true }, backtest: report.metrics };
await Promise.all([writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`), writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`)]);
console.log(`Patch transition OOF: ${versions.length - 1} transitions, ${evaluable.length} hero rows; RMSE ${ensembleMetrics.weightedRmse.toFixed(6)} vs no-notes ${noNotesMetrics.weightedRmse.toFixed(6)} vs carry ${baselineMetrics.weightedRmse.toFixed(6)}; ${artifact.deploymentStatus.toUpperCase()}`);
