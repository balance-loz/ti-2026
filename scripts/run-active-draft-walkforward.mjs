import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createOnlineTeamModel } from "../server/team-model.mjs";

const ROOT = process.cwd();
const DB_PATH = path.resolve(process.env.DRAFT_TRAINING_DB || path.join(ROOT, "work", "draft-training.sqlite"));
const STATS_PATH = path.join(ROOT, "public", "draft-stats.json");
const TEAM_STATS_PATH = path.join(ROOT, "public", "team-stats.json");
const TEAM_MODEL_PATH = path.join(ROOT, "public", "team-model.json");
const REPORT_PATH = path.join(ROOT, "work", "active-draft-walkforward.json");
const OOF_PATH = path.join(ROOT, "work", "active-draft-oof.jsonl");
const COVERAGE_PATH = path.join(ROOT, "work", "draft-coverage.json");
const FEATURE_NAMES = ["teamPrior", "side", "hero", "draftPriority", "synergy", "counter", "teamPool", "playerPool", "roles"];
const PRIORS = { team: 12, side: 30, hero: 18, pair: 24, pool: 6, role: 12, priorityMaps: 24 };
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const sigmoid = (value) => 1 / (1 + Math.exp(-clamp(value, -12, 12)));
const logit = (probability) => Math.log(clamp(probability, 0.05, 0.95) / (1 - clamp(probability, 0.05, 0.95)));
const pairKey = (a, b) => [Number(a), Number(b)].sort((left, right) => left - right).join("|");

function row(map, key) { return map.get(String(key)) ?? { games: 0, wins: 0 }; }
function rate(map, key, priorGames, priorRate = 0.5) { const value = row(map, key); return (value.wins + priorGames * priorRate) / (value.games + priorGames); }
function add(map, key, won, weight = 1) { const value = row(map, key); value.games += weight; value.wins += weight * won; map.set(String(key), value); }
function residual(map, key, prior = PRIORS.pair) { const value = row(map, key); return value.wins / (value.games + prior); }
function addResidual(map, key, value, weight = 1) { const current = row(map, key); current.games += weight; current.wins += weight * value; map.set(String(key), current); }
function average(values, fallback = 0.5) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback; }
function priorityRow(state, heroId) { return state.heroPriority.get(String(heroId)) ?? { picks: 0, bans: 0, firstPhase: 0, roles: {} }; }
function priorityRates(state, heroId) {
  const value = priorityRow(state, heroId); const denominator = state.maps + PRIORS.priorityMaps;
  const pickRate = (value.picks + PRIORS.priorityMaps * .04) / denominator;
  const banRate = (value.bans + PRIORS.priorityMaps * .04) / denominator;
  const contestedRate = (value.picks + value.bans + PRIORS.priorityMaps * .08) / denominator;
  const firstPhaseRate = (value.firstPhase + PRIORS.priorityMaps * .04) / denominator;
  const roleCounts = Object.values(value.roles); const roleTotal = roleCounts.reduce((sum, count) => sum + count, 0);
  const flex = roleTotal ? 1 - Math.max(...roleCounts) / roleTotal : 0;
  const score = clamp(logit(clamp(contestedRate, .01, .85)) + .35 * logit(clamp(firstPhaseRate, .01, .6)) + .4 * flex, -4, 4);
  return { picks: value.picks, bans: value.bans, pickRate, banRate, contestedRate, firstPhaseRate, flex, score };
}

function freshState(teamModelDefinition) {
  return { maps: 0, radiantWins: 0, teamModel: createOnlineTeamModel(teamModelDefinition), hero: new Map(), heroPriority: new Map(), synergy: new Map(), counter: new Map(), teamHero: new Map(), playerHero: new Map(), heroRole: new Map(), playerRole: new Map() };
}

function features(state, match) {
  const radiant = match.radiant; const dire = match.dire;
  const teamPrior = logit(state.teamModel.predict(match.radiantTeamId, match.direTeamId, match.startTime));
  const side = logit((state.radiantWins + PRIORS.side * 0.5) / (state.maps + PRIORS.side));
  const hero = logit(average(radiant.map((player) => rate(state.hero, player.heroId, PRIORS.hero))))
    - logit(average(dire.map((player) => rate(state.hero, player.heroId, PRIORS.hero))));
  const draftPriority = average(radiant.map((player) => priorityRates(state, player.heroId).score), 0)
    - average(dire.map((player) => priorityRates(state, player.heroId).score), 0);
  const synergyFor = (players) => {
    const values = [];
    for (let left = 0; left < players.length; left += 1) for (let right = left + 1; right < players.length; right += 1) values.push(residual(state.synergy, pairKey(players[left].heroId, players[right].heroId)));
    return average(values, 0);
  };
  const synergy = 4 * (synergyFor(radiant) - synergyFor(dire));
  const counters = [];
  for (const a of radiant) for (const b of dire) counters.push(residual(state.counter, `${a.heroId}>${b.heroId}`));
  const counter = 4 * average(counters, 0);
  const poolRate = (players, teamId) => average(players.map((player) => rate(state.teamHero, `${teamId}|${player.heroId}`, PRIORS.pool)));
  const teamPool = match.radiantTeamId && match.direTeamId ? logit(poolRate(radiant, match.radiantTeamId)) - logit(poolRate(dire, match.direTeamId)) : 0;
  const actualPlayerRate = (players) => average(players.map((player) => rate(state.playerHero, `${player.accountId}|${player.heroId}`, PRIORS.pool)));
  const playerPool = logit(actualPlayerRate(radiant)) - logit(actualPlayerRate(dire));
  const actualRoleRate = (players) => average(players.map((player) => player.role ? rate(state.heroRole, `${player.heroId}|${player.role}`, PRIORS.role) : .5));
  const roles = logit(actualRoleRate(radiant)) - logit(actualRoleRate(dire));
  return [teamPrior, side, hero, draftPriority, synergy, counter, teamPool, playerPool, roles];
}

function observe(state, match) {
  const outcome = match.radiantWin;
  const radiantHeroRate = average(match.radiant.map((player) => rate(state.hero, player.heroId, PRIORS.hero)));
  const direHeroRate = average(match.dire.map((player) => rate(state.hero, player.heroId, PRIORS.hero)));
  const sideLogit = logit((state.radiantWins + PRIORS.side * .5) / (state.maps + PRIORS.side));
  const radiantExpected = sigmoid(logit(radiantHeroRate) - logit(direHeroRate) + sideLogit);
  state.maps += 1; state.radiantWins += outcome;
  state.teamModel.update({ targetLineup: match.radiantTeamId, opponentLineup: match.direTeamId, targetScore: outcome, startTime: match.startTime, rosterWeight: 1, seriesInformation: 1 });
  for (const player of match.radiant) {
    add(state.hero, player.heroId, outcome);
    if (match.radiantTeamId) add(state.teamHero, `${match.radiantTeamId}|${player.heroId}`, outcome);
    if (player.accountId) add(state.playerHero, `${player.accountId}|${player.heroId}`, outcome);
    if (player.role) add(state.heroRole, `${player.heroId}|${player.role}`, outcome);
    if (player.role && player.accountId) add(state.playerRole, `${player.accountId}|${player.role}`, outcome);
  }
  for (const player of match.dire) {
    add(state.hero, player.heroId, 1 - outcome);
    if (match.direTeamId) add(state.teamHero, `${match.direTeamId}|${player.heroId}`, 1 - outcome);
    if (player.accountId) add(state.playerHero, `${player.accountId}|${player.heroId}`, 1 - outcome);
    if (player.role) add(state.heroRole, `${player.heroId}|${player.role}`, 1 - outcome);
    if (player.role && player.accountId) add(state.playerRole, `${player.accountId}|${player.role}`, 1 - outcome);
  }
  const pickedRoles = new Map([...match.radiant, ...match.dire].map((player) => [player.heroId, player.role]));
  for (const event of match.events) {
    const key = String(event.heroId); const value = priorityRow(state, key);
    if (event.isPick) value.picks += 1; else value.bans += 1;
    if (event.eventOrder < 8) value.firstPhase += 1;
    const role = pickedRoles.get(event.heroId); if (event.isPick && role) value.roles[role] = (value.roles[role] || 0) + 1;
    state.heroPriority.set(key, value);
  }
  for (const [players, won, expected] of [[match.radiant, outcome, radiantHeroRate], [match.dire, 1 - outcome, direHeroRate]]) {
    for (let left = 0; left < players.length; left += 1) for (let right = left + 1; right < players.length; right += 1) addResidual(state.synergy, pairKey(players[left].heroId, players[right].heroId), won - expected);
  }
  for (const a of match.radiant) for (const b of match.dire) {
    addResidual(state.counter, `${a.heroId}>${b.heroId}`, outcome - radiantExpected);
    addResidual(state.counter, `${b.heroId}>${a.heroId}`, (1 - outcome) - (1 - radiantExpected));
  }
}

function loadMatches(teamIdByOpenDota) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const matchRows = db.prepare("SELECT * FROM matches WHERE domain='pro' ORDER BY start_time, match_id").all();
  const players = db.prepare("SELECT * FROM players ORDER BY match_id, side, slot").all();
  const events = db.prepare("SELECT * FROM draft_events ORDER BY match_id,event_order").all();
  const byMatch = new Map();
  const eventsByMatch = new Map();
  for (const value of players) {
    const target = byMatch.get(Number(value.match_id)) ?? { radiant: [], dire: [] };
    target[value.side === 0 ? "radiant" : "dire"].push({ heroId: Number(value.hero_id), role: Number(value.role), accountId: Number(value.account_id) });
    byMatch.set(Number(value.match_id), target);
  }
  for (const value of events) eventsByMatch.set(Number(value.match_id), [...(eventsByMatch.get(Number(value.match_id)) ?? []), { eventOrder: Number(value.event_order), side: Number(value.side), heroId: Number(value.hero_id), isPick: Boolean(value.is_pick) }]);
  const matches = matchRows.flatMap((value) => {
    const sides = byMatch.get(Number(value.match_id));
    if (!sides || sides.radiant.length !== 5 || sides.dire.length !== 5) return [];
    const radiantOpenDotaId = Number(value.radiant_team_id); const direOpenDotaId = Number(value.dire_team_id);
    return [{ matchId: Number(value.match_id), leagueId: Number(value.league_id), patchId: Number(value.patch_id), subpatchId: String(value.subpatch_id || value.patch_id), startTime: Number(value.start_time), seriesId: String(value.series_id || `match:${value.match_id}`), identityKnown: radiantOpenDotaId > 0 && direOpenDotaId > 0, radiantTeamId: teamIdByOpenDota.get(radiantOpenDotaId) ?? (radiantOpenDotaId > 0 ? `od:${radiantOpenDotaId}` : `unknown:${value.match_id}:radiant`), direTeamId: teamIdByOpenDota.get(direOpenDotaId) ?? (direOpenDotaId > 0 ? `od:${direOpenDotaId}` : `unknown:${value.match_id}:dire`), radiantWin: Number(value.radiant_win), events: eventsByMatch.get(Number(value.match_id)) ?? [], ...sides }];
  });
  db.close(); return matches;
}

function metrics(rows, key) {
  let logLoss = 0; let brier = 0; let correct = 0;
  for (const row of rows) { const p = clamp(row[key], 0.001, 0.999); logLoss += -(row.y * Math.log(p) + (1 - row.y) * Math.log(1 - p)); brier += (p - row.y) ** 2; correct += Number((p >= 0.5) === Boolean(row.y)); }
  return { matches: rows.length, logLoss: logLoss / rows.length, brier: brier / rows.length, accuracy: correct / rows.length };
}

function fitFrozenCombiner(rows, activeIndices = FEATURE_NAMES.map((_, index) => index)) {
  let fitted = FEATURE_NAMES.map((_, index) => activeIndices.includes(index) ? (index === 0 ? 1 : .15) : 0);
  for (let iteration = 0; iteration < 900; iteration += 1) {
    const gradient = Array(FEATURE_NAMES.length).fill(0);
    for (const row of rows) {
      const probability = sigmoid(row.x.reduce((sum, value, index) => sum + value * fitted[index], 0));
      for (const index of activeIndices) gradient[index] += ((probability - row.y) * row.x[index] + .002 * fitted[index]) / rows.length;
    }
    const learningRate = .4 / Math.sqrt(1 + iteration / 80);
    fitted = fitted.map((weight, index) => activeIndices.includes(index) ? clamp(weight - learningRate * gradient[index], FEATURE_NAMES[index] === "draftPriority" ? -.5 : 0, 2.5) : 0);
  }
  return fitted;
}

function probabilityWithWeights(row, fitted) { return sigmoid(row.x.reduce((sum, value, index) => sum + value * fitted[index], 0)); }

function clusterBootstrap(rows, candidate = "model", baseline = "neutral", iterations = 1000) {
  const clusters = new Map(); for (const row of rows) clusters.set(row.seriesId, [...(clusters.get(row.seriesId) ?? []), row]);
  const ids = [...clusters.keys()]; let seed = 0x7da41; const random = () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let value = Math.imul(seed ^ seed >>> 15, 1 | seed); value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value; return ((value ^ value >>> 14) >>> 0) / 4294967296; };
  const deltas = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let model = 0; let neutral = 0; let count = 0;
    for (let draw = 0; draw < ids.length; draw += 1) for (const row of clusters.get(ids[Math.floor(random() * ids.length)])) {
      model += -(row.y * Math.log(clamp(row[candidate], .001, .999)) + (1 - row.y) * Math.log(clamp(1 - row[candidate], .001, .999)));
      neutral += -(row.y * Math.log(clamp(row[baseline], .001, .999)) + (1 - row.y) * Math.log(clamp(1 - row[baseline], .001, .999))); count += 1;
    }
    deltas.push((model - neutral) / count);
  }
  deltas.sort((a, b) => a - b);
  return { candidate, baseline, cluster: "series_id", clusters: ids.length, iterations, lower95: deltas[Math.floor(iterations * .025)], upper95: deltas[Math.floor(iterations * .975)] };
}

const [stats, teamStats, teamModelArtifact, coverage] = await Promise.all([
  readFile(STATS_PATH, "utf8").then(JSON.parse), readFile(TEAM_STATS_PATH, "utf8").then(JSON.parse),
  readFile(TEAM_MODEL_PATH, "utf8").then(JSON.parse),
  readFile(COVERAGE_PATH, "utf8").then(JSON.parse).catch(() => ({ deployment: { sufficient: false, status: "missing_coverage_audit" } })),
]);
const teamIdByOpenDota = new Map(Object.entries(teamStats.teams ?? {}).flatMap(([teamId, team]) => (team.openDotaIds ?? [team.openDotaId]).map((id) => [Number(id), teamId])));
const matches = loadMatches(teamIdByOpenDota); const state = freshState(teamModelArtifact.selected);
let weights = [1, .25, .25, 0, .12, .12, .08, .08, .08]; const rows = [];
let previousPatch = null; let seen = 0;
for (const match of matches) {
  if (previousPatch !== null && match.subpatchId !== previousPatch) {
    for (const map of [state.hero, state.synergy, state.counter, state.teamHero, state.playerHero, state.heroRole, state.playerRole]) for (const value of map.values()) { value.games *= .72; value.wins *= .72; }
    for (const value of state.heroPriority.values()) { value.picks *= .72; value.bans *= .72; value.firstPhase *= .72; for (const role of Object.keys(value.roles)) value.roles[role] *= .72; }
  }
  previousPatch = match.subpatchId;
  const x = features(state, match);
  const contributions = x.map((value, index) => value * weights[index]);
  const probability = sigmoid(contributions.reduce((sum, value) => sum + value, 0));
  const cumulative = Object.fromEntries(FEATURE_NAMES.map((name, index) => [`through_${name}`, sigmoid(contributions.slice(0, index + 1).reduce((sum, value) => sum + value, 0))]));
  const dropOne = Object.fromEntries(FEATURE_NAMES.map((name, index) => [`without_${name}`, sigmoid(contributions.reduce((sum, value, featureIndex) => sum + (featureIndex === index ? 0 : value), 0))]));
  if (seen >= 100) rows.push({ matchId: match.matchId, leagueId: match.leagueId, startTime: match.startTime, patchId: match.patchId, subpatchId: match.subpatchId, seriesId: match.seriesId, identityKnown: match.identityKnown, y: match.radiantWin, model: probability, neutral: .5, teamSide: cumulative.through_side, ...cumulative, ...dropOne, x });
  const error = probability - match.radiantWin; const rate = .045 / Math.sqrt(1 + seen / 350);
  weights = weights.map((weight, index) => clamp(weight - rate * (error * x[index] + .002 * weight), index === 0 || FEATURE_NAMES[index] !== "draftPriority" ? 0 : -.5, 2.5));
  observe(state, match); seen += 1;
}

const splitIndex = Math.max(1000, Math.floor(rows.length * .7)); const metaTrain = rows.slice(0, splitIndex); const metaTest = rows.slice(splitIndex);
const frozenWeights = fitFrozenCombiner(metaTrain); const frozenTeamSideWeights = fitFrozenCombiner(metaTrain, [0, 1]);
const priorityIndex = FEATURE_NAMES.indexOf("draftPriority");
const withoutPriorityIndices = FEATURE_NAMES.map((_, index) => index).filter((index) => index !== priorityIndex);
const frozenWithoutPriorityWeights = fitFrozenCombiner(metaTrain, withoutPriorityIndices);
for (const row of metaTest) { row.frozenModel = probabilityWithWeights(row, frozenWeights); row.frozenTeamSide = probabilityWithWeights(row, frozenTeamSideWeights); row.frozenWithoutPriority = probabilityWithWeights(row, frozenWithoutPriorityWeights); }
const modelMetrics = metrics(rows, "model"); const neutralMetrics = metrics(rows, "neutral"); const teamSideMetrics = metrics(rows, "teamSide");
const frozenModelMetrics = metrics(metaTest, "frozenModel"); const frozenTeamSideMetrics = metrics(metaTest, "frozenTeamSide");
const frozenWithoutPriorityMetrics = metrics(metaTest, "frozenWithoutPriority");
const bootstrapVsNeutral = clusterBootstrap(rows, "model", "neutral"); const bootstrapVsTeamSide = clusterBootstrap(rows, "model", "teamSide");
const frozenBootstrap = clusterBootstrap(metaTest, "frozenModel", "frozenTeamSide");
const priorityBootstrap = clusterBootstrap(metaTest, "frozenModel", "frozenWithoutPriority");
const priorityIncrementalGatePassed = frozenModelMetrics.logLoss < frozenWithoutPriorityMetrics.logLoss && frozenModelMetrics.brier < frozenWithoutPriorityMetrics.brier && priorityBootstrap.upper95 < 0;
const productionWeights = fitFrozenCombiner(rows, priorityIncrementalGatePassed ? FEATURE_NAMES.map((_, index) => index) : withoutPriorityIndices);
const layerMetrics = Object.fromEntries(FEATURE_NAMES.map((name) => [name, { cumulative: metrics(rows, `through_${name}`), dropOne: metrics(rows, `without_${name}`) }]));
const metricsByVersion = Object.fromEntries([...new Set(rows.map((row) => row.subpatchId))].map((version) => { const versionRows = rows.filter((row) => row.subpatchId === version); return [version, { maps: versionRows.length, model: metrics(versionRows, "model"), teamSide: metrics(versionRows, "teamSide") }]; }));
const knownIdentityRows = rows.filter((row) => row.identityKnown);
const prequentialGatePassed = modelMetrics.logLoss < teamSideMetrics.logLoss && modelMetrics.brier < teamSideMetrics.brier && bootstrapVsTeamSide.upper95 < 0;
const frozenHoldoutGatePassed = frozenModelMetrics.logLoss < frozenTeamSideMetrics.logLoss && frozenModelMetrics.brier < frozenTeamSideMetrics.brier && frozenBootstrap.upper95 < 0;
const statisticalGatePassed = prequentialGatePassed && frozenHoldoutGatePassed;
const validated = statisticalGatePassed && coverage.deployment?.sufficient === true;
const combiner = {
  version: 3, learnedFrom: "batch logistic combiner fitted only on chronological OOF map features; draft priority is prequential pick/ban/contested/first-phase/flex evidence; validated on a frozen final 30% time holdout", featureOrder: FEATURE_NAMES,
  weights: Object.fromEntries(FEATURE_NAMES.map((name, index) => [name, Number(productionWeights[index].toFixed(6))])),
  probabilityFloor: .08, probabilityCeiling: .92,
};
const deploymentStatus = validated ? "candidate" : coverage.deployment?.sufficient ? "experimental" : "insufficient_data";
const report = { generatedAt: new Date().toISOString(), methodology: "strict chronological map walk-forward by exact official subpatch; shared nested-arena team-model class is predicted and updated before/after each map; online prequential audit plus frozen 70/30 OOF meta-model holdout; series-cluster bootstrap", teamPrior: { modelId: teamModelArtifact.selected.id, definition: teamModelArtifact.selected, productionArtifact: "/team-model.json" }, dataset: { matches: matches.length, evaluatedMaps: rows.length, knownIdentityMaps: knownIdentityRows.length, metaTrainMaps: metaTrain.length, frozenHoldoutMaps: metaTest.length, patchFamilies: new Set(matches.map((match) => match.patchId)).size, exactVersions: new Set(matches.map((match) => match.subpatchId)).size }, features: FEATURE_NAMES, priors: PRIORS, metrics: { prequential: { model: modelMetrics, neutral: neutralMetrics, teamSide: teamSideMetrics, logLossDeltaVsNeutral: modelMetrics.logLoss - neutralMetrics.logLoss, logLossDeltaVsTeamSide: modelMetrics.logLoss - teamSideMetrics.logLoss }, knownTeamIdentity: { model: metrics(knownIdentityRows, "model"), teamSide: metrics(knownIdentityRows, "teamSide") }, frozenHoldout: { model: frozenModelMetrics, teamSide: frozenTeamSideMetrics, withoutDraftPriority: frozenWithoutPriorityMetrics, logLossDeltaVsTeamSide: frozenModelMetrics.logLoss - frozenTeamSideMetrics.logLoss, draftPriorityLogLossDelta: frozenModelMetrics.logLoss - frozenWithoutPriorityMetrics.logLoss, fittedWeights: Object.fromEntries(FEATURE_NAMES.map((name, index) => [name, Number(frozenWeights[index].toFixed(6))])), withoutDraftPriorityWeights: Object.fromEntries(FEATURE_NAMES.map((name, index) => [name, Number(frozenWithoutPriorityWeights[index].toFixed(6))])), baselineWeights: Object.fromEntries(FEATURE_NAMES.map((name, index) => [name, Number(frozenTeamSideWeights[index].toFixed(6))])) }, byExactVersion: metricsByVersion, layers: layerMetrics }, bootstrap: { versusNeutral: bootstrapVsNeutral, versusTeamSide: bootstrapVsTeamSide, frozenHoldoutVersusTeamSide: frozenBootstrap, draftPriorityIncremental: priorityBootstrap }, draftPriority: { status: priorityIncrementalGatePassed ? "active" : "shadow", incrementalGatePassed: priorityIncrementalGatePassed, productionWeight: Number(productionWeights[priorityIndex].toFixed(6)), candidateWeight: Number(frozenWeights[priorityIndex].toFixed(6)), feature: "prequential pick/ban/contested/first-phase/flex; all counts precede predicted map", gate: "must improve frozen log loss and Brier versus the same model without draftPriority and have series-cluster bootstrap upper 95% delta below zero" }, coverage: { status: coverage.deployment?.status, sufficient: coverage.deployment?.sufficient === true, window: coverage.window, totals: coverage.totals, failedVersions: coverage.deployment?.failedVersions ?? [] }, deployment: { status: deploymentStatus, validated, statisticalGatePassed, prequentialGatePassed, frozenHoldoutGatePassed, gate: "full formula must beat separately fitted team-prior+side on log loss and Brier with negative series-cluster bootstrap upper 95% in both prequential OOF and frozen final-30% temporal holdout, plus coverage" }, combiner: { ...combiner, researchOnly: !validated } };
const tiTeamIds = Object.keys(teamStats.teams ?? {});
const currentExactVersion = matches.at(-1)?.subpatchId ?? String(stats.methodology.patchName ?? stats.methodology.latestOpenDotaPatchId);
const currentVersionMatches = matches.filter((match) => match.subpatchId === currentExactVersion);
const currentPatchMaps = currentVersionMatches.length;
const currentTiTeamMaps = currentVersionMatches.filter((match) => tiTeamIds.includes(match.radiantTeamId) || tiTeamIds.includes(match.direTeamId)).length;
stats.methodology = {
  ...stats.methodology,
  patchName: currentExactVersion,
  cachedPatchMaps: currentPatchMaps,
  eligiblePatchMaps: currentPatchMaps,
  tiTeamPatchMaps: currentTiTeamMaps,
  globalProPatchMaps: currentPatchMaps,
  globalHeroPool: "all cached professional matches on the current patch, not only TI participants",
  caveat: "Experimental research coefficients. Global hero/pair evidence uses all cached pro maps; TI-specific pools use only matching rosters. Every coefficient is regularized.",
};
const sample = (map, key, priorGames) => { const value = row(map, key); return { games: Number(value.games.toFixed(3)), wins: Number(value.wins.toFixed(3)), winRate: Number((rate(map, key, priorGames) * 100).toFixed(3)) }; };
const residualSample = (map, key) => { const value = row(map, key); const coefficient = 4 * residual(map, key); return { games: Number(value.games.toFixed(3)), residualSum: Number(value.wins.toFixed(5)), coefficient: Number(coefficient.toFixed(6)), winRate: Number((sigmoid(coefficient) * 100).toFixed(3)) }; };
const currentAccounts = new Set(Object.values(stats.teams ?? {}).flatMap((team) => (team.players ?? []).map((player) => Number(player.accountId))));
const serialize = (map, priorGames, accept = () => true) => Object.fromEntries([...map.keys()].filter(accept).map((key) => [key, sample(map, key, priorGames)]));
const serializedPriority = Object.fromEntries([...state.heroPriority.keys()].map((key) => { const value = priorityRow(state, key); const rates = priorityRates(state, key); return [key, { maps: Number(state.maps.toFixed(3)), picks: Number(value.picks.toFixed(3)), bans: Number(value.bans.toFixed(3)), pickRate: Number((100 * rates.pickRate).toFixed(3)), banRate: Number((100 * rates.banRate).toFixed(3)), contestedRate: Number((100 * rates.contestedRate).toFixed(3)), firstPhaseRate: Number((100 * rates.firstPhaseRate).toFixed(3)), flex: Number(rates.flex.toFixed(4)), score: Number(rates.score.toFixed(6)) }]; }));
const playerPositions = Object.fromEntries([...currentAccounts].map((accountId) => {
  const candidates = [1, 2, 3, 4, 5].map((role) => ({ role, games: row(state.playerRole, `${accountId}|${role}`).games })).sort((a, b) => b.games - a.games);
  return [accountId, { role: candidates[0].games > 0 ? candidates[0].role : null, games: Number(candidates[0].games.toFixed(3)), distribution: Object.fromEntries(candidates.map((item) => [item.role, Number(item.games.toFixed(3))])) }];
}));
stats.activeSnapshot = {
  generatedAt: report.generatedAt, afterMatchId: matches.at(-1)?.matchId ?? null, featureContract: FEATURE_NAMES, priors: PRIORS,
  radiantWinRate: Number(((state.radiantWins + PRIORS.side * .5) / (state.maps + PRIORS.side) * 100).toFixed(3)),
  teamPairwise: Object.fromEntries(Object.entries(teamStats.pairwise ?? {}).map(([key, pair]) => [key, { probabilityA: Number(pair.mapProbabilityA ?? 50), modelId: pair.modelId ?? teamStats.methodology?.teamPrior?.modelId ?? null }])), hero: serialize(state.hero, PRIORS.hero), heroPriority: serializedPriority, synergy: Object.fromEntries([...state.synergy.keys()].map((key) => [key, residualSample(state.synergy, key)])), counter: Object.fromEntries([...state.counter.keys()].map((key) => [key, residualSample(state.counter, key)])),
  teamHero: serialize(state.teamHero, PRIORS.pool, (key) => tiTeamIds.some((teamId) => String(key).startsWith(`${teamId}|`))),
  playerHero: serialize(state.playerHero, PRIORS.pool, (key) => currentAccounts.has(Number(String(key).split("|")[0]))), heroRole: serialize(state.heroRole, PRIORS.role), playerPositions,
};
stats.validation = { ...(stats.validation ?? {}), activeFormula: report };
stats.combiner = { ...combiner, researchOnly: !validated };
const activeDraftOof = rows.map((value) => JSON.stringify({
  matchId: value.matchId,
  seriesId: value.seriesId,
  leagueId: value.leagueId,
  startTime: value.startTime,
  probabilityRadiant: value.model,
  outcomeObservedAfterPrediction: value.y,
  priorContract: "active formula prequential OOF; features and weights precede this map",
})).join("\n");
await Promise.all([
  writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`),
  writeFile(OOF_PATH, `${activeDraftOof}\n`),
  writeFile(STATS_PATH, `${JSON.stringify(stats, null, 2)}\n`),
]);
console.log(`Active draft walk-forward: ${rows.length} OOF maps, log loss ${modelMetrics.logLoss.toFixed(6)} vs team+side ${teamSideMetrics.logLoss.toFixed(6)} vs 50% ${neutralMetrics.logLoss.toFixed(6)}; ${report.deployment.status.toUpperCase()}`);
