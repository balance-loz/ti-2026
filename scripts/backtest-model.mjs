import { readFile, writeFile, mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { TEAM_MODEL_ARENA, bestOfProbability, createOnlineTeamModel, seriesInformation } from "../server/team-model.mjs";

const source = JSON.parse(await readFile("public/team-stats.json", "utf8"));
const teamIds = new Set(Object.keys(source.teams));
let provenance = new Map();
try {
  const db = new DatabaseSync("work/draft-training.sqlite", { readOnly: true });
  provenance = new Map(db.prepare("SELECT match_id,series_id,league_id FROM matches").all().map((row) => [Number(row.match_id), { seriesId: String(row.series_id), leagueId: Number(row.league_id) }]));
  db.close();
} catch { /* The production summary remains a runnable fallback. */ }

const observations = []; const seen = new Set();
for (const [teamId, team] of Object.entries(source.teams)) for (const tournament of team.tournaments ?? []) {
  if (!(Number(tournament.rosterWeight) > 0)) continue;
  for (const series of tournament.series ?? []) {
    const matchIds = (series.maps ?? []).map((map) => Number(map.matchId)).filter(Boolean);
    if (!matchIds.length) continue;
    const providerIds = [...new Set(matchIds.map((id) => provenance.get(id)?.seriesId).filter((id) => id && !id.startsWith("-")))];
    const seriesId = providerIds.length === 1 ? providerIds[0] : `synthetic:${Math.min(...matchIds)}`;
    if (seen.has(seriesId)) continue; seen.add(seriesId);
    const opponentLineup = series.opponentTiId && teamIds.has(series.opponentTiId) ? series.opponentTiId : `external:${series.opponentOpenDotaId || series.reportedName || "unknown"}:league:${tournament.leagueId}`;
    const wins = Number(series.wins || 0); const losses = Number(series.losses || 0);
    if (wins === losses) continue;
    observations.push({ seriesId, leagueId: Number(tournament.leagueId || provenance.get(matchIds[0])?.leagueId || 0), targetLineup: teamId, opponentLineup, wins, losses, bestOf: wins + losses >= 4 ? 5 : 3, targetScore: wins / (wins + losses), outcome: Number(wins > losses), startTime: Number(series.startTime), rosterWeight: Number(tournament.rosterWeight), seriesInformation: seriesInformation(wins, losses), targetIsTi: true, opponentIsTi: teamIds.has(opponentLineup) });
  }
}
observations.sort((a, b) => a.startTime - b.startTime || String(a.seriesId).localeCompare(String(b.seriesId)));

const clamp = (v) => Math.min(.999, Math.max(.001, Number(v)));
const loss = (p, y) => -(y * Math.log(clamp(p)) + (1 - y) * Math.log(1 - clamp(p)));
function metrics(rows, key) {
  if (!rows.length) return { samples: 0, logLoss: null, brier: null, accuracy: null, expectedCalibrationError: null, calibrationBins: [] };
  let ll = 0; let brier = 0; let correct = 0;
  for (const row of rows) { const p = clamp(row[key]); ll += loss(p, row.outcome); brier += (p - row.outcome) ** 2; correct += Number((p >= .5) === Boolean(row.outcome)); }
  const sorted = [...rows].sort((a, b) => a[key] - b[key]); const size = Math.max(1, Math.ceil(rows.length / 10)); const bins = [];
  for (let i = 0; i < sorted.length; i += size) { const bin = sorted.slice(i, i + size); bins.push({ samples: bin.length, predicted: bin.reduce((s, r) => s + r[key], 0) / bin.length, actual: bin.reduce((s, r) => s + r.outcome, 0) / bin.length }); }
  return { samples: rows.length, logLoss: ll / rows.length, brier: brier / rows.length, accuracy: correct / rows.length, expectedCalibrationError: bins.reduce((s, b) => s + b.samples / rows.length * Math.abs(b.predicted - b.actual), 0), calibrationBins: bins };
}
function randomGenerator(seed = 0x51f15e) { return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let v = Math.imul(seed ^ seed >>> 15, 1 | seed); v = v + Math.imul(v ^ v >>> 7, 61 | v) ^ v; return ((v ^ v >>> 14) >>> 0) / 4294967296; }; }
function clusterBootstrap(rows, candidate, baseline, iterations = 5000) {
  const groups = new Map(); for (const row of rows) groups.set(`${row.leagueId}:${row.seriesId}`, [...(groups.get(`${row.leagueId}:${row.seriesId}`) ?? []), row]);
  const ids = [...groups.keys()]; const random = randomGenerator(); const deltas = [];
  for (let iteration = 0; iteration < iterations; iteration++) { let delta = 0; let n = 0; for (let draw = 0; draw < ids.length; draw++) for (const row of groups.get(ids[Math.floor(random() * ids.length)])) { delta += loss(row[candidate], row.outcome) - loss(row[baseline], row.outcome); n++; } deltas.push(delta / n); }
  deltas.sort((a, b) => a - b); return { lower95: deltas[Math.floor(iterations * .025)], upper95: deltas[Math.floor(iterations * .975)], iterations, cluster: "series_id", clusters: ids.length };
}

const configs = TEAM_MODEL_ARENA; const states = new Map(configs.map((config) => [config.id, createOnlineTeamModel(config)]));
const oof = []; const minimumHistory = Math.min(120, Math.max(20, Math.floor(observations.length * .12)));
let history = 0;
for (const observation of observations) {
  if (history >= minimumHistory && observation.opponentIsTi) {
    const row = { ...observation, neutral: .5 };
    for (const config of configs) row[config.id] = bestOfProbability(states.get(config.id).predict(observation.targetLineup, observation.opponentLineup, observation.startTime), observation.bestOf);
    oof.push(row);
  }
  for (const state of states.values()) state.update(observation);
  history++;
}

const leagues = [...new Map(oof.map((row) => [row.leagueId, { leagueId: row.leagueId, last: row.startTime }])).values()].sort((a, b) => a.last - b.last);
const holdoutLeagues = new Set(leagues.slice(Math.max(1, Math.floor(leagues.length * .8))).map((row) => row.leagueId));
const inner = oof.filter((row) => !holdoutLeagues.has(row.leagueId)); const holdout = oof.filter((row) => holdoutLeagues.has(row.leagueId));
const familyWinners = {}; const candidateMetrics = {};
for (const config of configs) candidateMetrics[config.id] = { family: config.family, inner: metrics(inner, config.id), holdout: metrics(holdout, config.id), config };
for (const family of [...new Set(configs.map((config) => config.family))]) familyWinners[family] = configs.filter((config) => config.family === family).sort((a, b) => candidateMetrics[a.id].inner.logLoss - candidateMetrics[b.id].inner.logLoss)[0].id;
const selectedId = Object.values(familyWinners).sort((a, b) => candidateMetrics[a].inner.logLoss - candidateMetrics[b].inner.logLoss)[0];
const outerRows = []; const outerFolds = [];
for (let leagueIndex = 5; leagueIndex < leagues.length; leagueIndex++) {
  const leagueId = leagues[leagueIndex].leagueId; const priorLeagueIds = new Set(leagues.slice(0, leagueIndex).map((row) => row.leagueId));
  const train = oof.filter((row) => priorLeagueIds.has(row.leagueId)); const test = oof.filter((row) => row.leagueId === leagueId); if (!train.length || !test.length) continue;
  const winners = {};
  for (const family of [...new Set(configs.map((config) => config.family))]) winners[family] = configs.filter((config) => config.family === family).sort((a, b) => metrics(train, a.id).logLoss - metrics(train, b.id).logLoss)[0].id;
  const winner = Object.values(winners).sort((a, b) => metrics(train, a).logLoss - metrics(train, b).logLoss)[0];
  for (const row of test) outerRows.push({ ...row, nested: row[winner], selectedModelId: winner });
  outerFolds.push({ leagueId, trainSeries: train.length, testSeries: test.length, familyWinners: winners, selectedId: winner, metrics: metrics(test.map((row) => ({ ...row, nested: row[winner] })), "nested") });
}
for (const row of oof) row.selected = row[selectedId];
const selected = configs.find((config) => config.id === selectedId); const neutral = metrics(holdout, "neutral"); const selectedHoldout = metrics(holdout, "selected");
const familyHoldout = Object.fromEntries(Object.entries(familyWinners).map(([family, id]) => [family, { id, ...metrics(holdout, id) }]));
const bestComparator = Object.values(familyWinners).filter((id) => id !== selectedId).sort((a, b) => metrics(holdout, a).logLoss - metrics(holdout, b).logLoss)[0];
const bootstrapVs50 = clusterBootstrap(holdout, "selected", "neutral");
const bootstrapVsRunnerUp = bestComparator ? clusterBootstrap(holdout, "selected", bestComparator) : null;
const validated = selectedHoldout.logLoss < neutral.logLoss && selectedHoldout.brier < neutral.brier && bootstrapVs50.upper95 < 0;

const finalModel = createOnlineTeamModel(selected); for (const row of observations) finalModel.update(row);
const pairwise = {};
const ids = [...teamIds];
for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
  const a = ids[i]; const b = ids[j]; const key = [a, b].sort().join("|"); const first = key.split("|")[0];
  const mapProbability = finalModel.predict(first, key.split("|")[1], observations.at(-1)?.startTime);
  pairwise[key] = { mapProbabilityA: 100 * mapProbability, probabilityA: 100 * bestOfProbability(mapProbability, 3), probabilityBo3A: 100 * bestOfProbability(mapProbability, 3), probabilityBo5A: 100 * bestOfProbability(mapProbability, 5), modelId: selectedId };
}
const report = { generatedAt: new Date().toISOString(), method: "nested chronological tournament walk-forward; in every outer league fold each family hyperparameter and the family itself are selected only on earlier league predictions; final 20% tournament holdout additionally audits one frozen deployment choice", dataset: { allSeries: observations.length, evaluatedTiSeries: oof.length, innerSeries: inner.length, holdoutSeries: holdout.length, innerLeagues: new Set(inner.map((r) => r.leagueId)).size, holdoutLeagues: holdoutLeagues.size, minimumHistory }, arena: { configs: configs.length, candidateMetrics, familyWinners, selectedId, outerWalkForward: { folds: outerFolds.length, series: outerRows.length, metrics: metrics(outerRows, "nested"), neutral: metrics(outerRows, "neutral"), selections: Object.fromEntries(configs.map((config) => [config.id, outerRows.filter((row) => row.selectedModelId === config.id).length])), foldsDetail: outerFolds } }, holdout: { selected: selectedHoldout, neutral, families: familyHoldout, runnerUpId: bestComparator, bootstrapVs50, bootstrapVsRunnerUp }, deployment: { status: validated ? "candidate" : "experimental", validated, gate: "frozen family/config selection must beat 50% on untouched tournament holdout log loss and Brier with series-cluster bootstrap upper 95% below zero" } };
const artifact = { schemaVersion: 1, generatedAt: report.generatedAt, selected, validation: report.deployment, pairwise, training: { through: observations.at(-1)?.startTime, series: observations.length }, probabilityUnit: "map; explicit BO3/BO5 fields exported" };
source.validation = { generatedAt: report.generatedAt, status: report.deployment.status, experimental: !validated, samples: holdout.length, selected: selectedHoldout, neutral, comparators: familyHoldout };
source.methodology.teamPrior = { artifact: "/team-model.json", modelId: selectedId, selection: "nested walk-forward arena", status: report.deployment.status };
source.methodology.claim = validated ? "candidate team prior selected on nested walk-forward and validated on untouched tournaments" : "experimental team prior; nested walk-forward tournament holdout did not pass the full gate";
for (const [key, value] of Object.entries(pairwise)) source.pairwise[key] = { ...(source.pairwise[key] ?? {}), ...value, probabilityA: Number(value.probabilityA.toFixed(1)), mapProbabilityA: Number(value.mapProbabilityA.toFixed(1)), probabilityBo3A: Number(value.probabilityBo3A.toFixed(1)), probabilityBo5A: Number(value.probabilityBo5A.toFixed(1)), source: "nested_team_arena" };
await mkdir("work", { recursive: true });
await Promise.all([writeFile("work/model-calibration.json", `${JSON.stringify(report, null, 2)}\n`), writeFile("work/team-model-oof.json", `${JSON.stringify(oof, null, 2)}\n`), writeFile("public/team-model.json", `${JSON.stringify(artifact, null, 2)}\n`), writeFile("public/team-stats.json", `${JSON.stringify(source, null, 2)}\n`)]);
console.log(`Nested team arena: ${configs.length} configs, selected ${selectedId}; untouched ${holdout.length} series / ${holdoutLeagues.size} leagues; ${report.deployment.status.toUpperCase()}`);
