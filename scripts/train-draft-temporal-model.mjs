import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const DB_PATH = path.resolve(process.env.DRAFT_TRAINING_DB || path.join(ROOT, "work", "draft-training.sqlite"));
const OUTPUT = path.resolve(process.env.DRAFT_TEMPORAL_MODEL || path.join(ROOT, "public", "draft-temporal-model.json"));
const PATCH_FEATURES = path.resolve(process.env.DRAFT_PATCH_FEATURES || path.join(ROOT, "config", "patch-features.json"));
const DRAFT_STATS = path.join(ROOT, "public", "draft-stats.json");
const EPOCHS = Math.max(2, Number(process.env.DRAFT_TRAINING_EPOCHS || 7));
const LEARNING_RATE = Number(process.env.DRAFT_TRAINING_RATE || 0.055);
const L2 = Number(process.env.DRAFT_TRAINING_L2 || 0.0008);
const MIN_PAIR_GAMES = Math.max(3, Number(process.env.DRAFT_MIN_PAIR_GAMES || 6));

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const sigmoid = (value) => 1 / (1 + Math.exp(-clamp(value, -12, 12)));
const pairKey = (a, b) => [Number(a), Number(b)].sort((left, right) => left - right).join("|");
const roleKey = (heroId, role) => `${heroId}@${role || 0}`;
const safeLogLoss = (prediction, outcome) => -(outcome * Math.log(clamp(prediction, .001, .999)) + (1 - outcome) * Math.log(clamp(1 - prediction, .001, .999)));

async function optionalJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

function freshState() {
  return { radiantBias: 0, hero: new Map(), role: new Map(), synergy: new Map(), counter: new Map(), team: new Map() };
}

function cloneAndTransfer(previous, magnitude = 1) {
  if (!previous) return freshState();
  const heroCarry = Math.exp(-.13 * magnitude);
  const pairCarry = Math.exp(-.22 * magnitude);
  const state = freshState();
  state.radiantBias = previous.radiantBias * .9;
  for (const [key, value] of previous.hero) state.hero.set(key, value * heroCarry);
  for (const [key, value] of previous.role) state.role.set(key, value * heroCarry * .92);
  for (const [key, value] of previous.synergy) state.synergy.set(key, value * pairCarry);
  for (const [key, value] of previous.counter) state.counter.set(key, value * pairCarry);
  for (const [key, value] of previous.team) state.team.set(key, value * .72);
  return state;
}

function addFeature(features, group, key, value) {
  if (!value) return;
  features.push({ group, key: String(key), value });
}

function matchFeatures(match) {
  const features = [];
  addFeature(features, "bias", "radiant", 1);
  for (const player of match.radiant) {
    addFeature(features, "hero", player.heroId, .2);
    addFeature(features, "role", roleKey(player.heroId, player.role), .08);
  }
  for (const player of match.dire) {
    addFeature(features, "hero", player.heroId, -.2);
    addFeature(features, "role", roleKey(player.heroId, player.role), -.08);
  }
  if (match.radiantTeamId) addFeature(features, "team", match.radiantTeamId, 1);
  if (match.direTeamId) addFeature(features, "team", match.direTeamId, -1);
  for (const [players, sign] of [[match.radiant, 1], [match.dire, -1]]) {
    for (let i = 0; i < players.length; i += 1) for (let j = i + 1; j < players.length; j += 1) addFeature(features, "synergy", pairKey(players[i].heroId, players[j].heroId), .04 * sign);
  }
  for (const radiant of match.radiant) for (const dire of match.dire) {
    addFeature(features, "counter", `${radiant.heroId}>${dire.heroId}`, .02);
    addFeature(features, "counter", `${dire.heroId}>${radiant.heroId}`, -.02);
  }
  return features;
}

function parameter(state, feature) {
  if (feature.group === "bias") return state.radiantBias;
  return state[feature.group].get(feature.key) ?? 0;
}

function setParameter(state, feature, value) {
  const safe = clamp(value, -2.5, 2.5);
  if (feature.group === "bias") state.radiantBias = safe;
  else state[feature.group].set(feature.key, safe);
}

function score(state, match) {
  return matchFeatures(match).reduce((sum, feature) => sum + parameter(state, feature) * feature.value, 0);
}

function evaluate(state, matches) {
  let brier = 0; let logLoss = 0; let correct = 0; let predicted = 0; let actual = 0;
  for (const match of matches) {
    const probability = sigmoid(score(state, match)); const outcome = match.radiantWin;
    brier += (probability - outcome) ** 2; logLoss += safeLogLoss(probability, outcome);
    correct += Number((probability >= .5) === Boolean(outcome)); predicted += probability; actual += outcome;
  }
  const count = matches.length || 1;
  return { matches: matches.length, brier: brier / count, logLoss: logLoss / count, accuracy: correct / count, predictedRadiantRate: predicted / count, actualRadiantRate: actual / count };
}

function fitPatch(state, matches, counts) {
  for (let epoch = 0; epoch < EPOCHS; epoch += 1) {
    const offset = epoch % Math.max(1, matches.length);
    for (let step = 0; step < matches.length; step += 1) {
      const match = matches[(step + offset) % matches.length];
      const features = matchFeatures(match); const probability = sigmoid(features.reduce((sum, feature) => sum + parameter(state, feature) * feature.value, 0));
      const error = match.radiantWin - probability;
      const rate = LEARNING_RATE / Math.sqrt(1 + epoch * .55);
      for (const feature of features) {
        const current = parameter(state, feature);
        setParameter(state, feature, current + rate * (error * feature.value - L2 * current));
        if (epoch === 0 && feature.group !== "bias") counts[feature.group].set(feature.key, (counts[feature.group].get(feature.key) ?? 0) + 1);
      }
    }
  }
  const meanHero = state.hero.size ? [...state.hero.values()].reduce((sum, value) => sum + value, 0) / state.hero.size : 0;
  for (const [key, value] of state.hero) state.hero.set(key, value - meanHero);
  return state;
}

function compactMap(values, counts, minimum = 1) {
  return Object.fromEntries([...values.entries()].filter(([key]) => (counts.get(key) ?? 0) >= minimum).sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([key, coefficient]) => [key, { coefficient: Number(coefficient.toFixed(5)), games: counts.get(key) ?? 0 }]));
}

function roundedMetrics(metrics) {
  return Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, typeof value === "number" ? Number(value.toFixed(5)) : value]));
}

async function main() {
  const [patchFeatures, draftStats] = await Promise.all([optionalJson(PATCH_FEATURES, { patches: {} }), optionalJson(DRAFT_STATS, { heroes: [], methodology: {} })]);
  const names = new Map((draftStats.heroes ?? []).map((hero) => [Number(hero.id), hero.name]));
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const matchRows = db.prepare("SELECT * FROM matches ORDER BY start_time, match_id").all();
  const playerRows = db.prepare("SELECT * FROM players ORDER BY match_id, side, slot").all();
  const playersByMatch = new Map();
  for (const row of playerRows) {
    const id = Number(row.match_id); const players = playersByMatch.get(id) ?? { radiant: [], dire: [] };
    players[row.side === 0 ? "radiant" : "dire"].push({ heroId: Number(row.hero_id), role: Number(row.role || 0), accountId: Number(row.account_id || 0) });
    playersByMatch.set(id, players);
  }
  const matches = matchRows.flatMap((row) => {
    const players = playersByMatch.get(Number(row.match_id));
    if (!players || players.radiant.length !== 5 || players.dire.length !== 5) return [];
    return [{ matchId: Number(row.match_id), patchId: Number(row.patch_id), startTime: Number(row.start_time), domain: row.domain, radiantTeamId: Number(row.radiant_team_id || 0), direTeamId: Number(row.dire_team_id || 0), radiantWin: Number(row.radiant_win), ...players }];
  });
  db.close();
  if (!matches.length) throw new Error("Training dataset is empty. Run npm run draft:data first.");
  const grouped = new Map();
  for (const match of matches) grouped.set(match.patchId, [...(grouped.get(match.patchId) ?? []), match]);
  const patches = [...grouped.entries()].sort((a, b) => a[1][0].startTime - b[1][0].startTime);
  let posterior = null; const folds = []; let finalCounts = null;
  for (let index = 0; index < patches.length; index += 1) {
    const [patchId, patchMatches] = patches[index];
    const configured = patchFeatures.patches?.[String(patchId)] ?? {};
    const magnitude = Number(configured.magnitude ?? (configured.kind === "major" ? 2.4 : configured.kind === "letter" ? .55 : 1));
    const prior = cloneAndTransfer(posterior, magnitude);
    const modelMetrics = evaluate(prior, patchMatches); const neutralMetrics = evaluate(freshState(), patchMatches);
    folds.push({ patchId, firstMatch: new Date(patchMatches[0].startTime * 1000).toISOString(), matches: patchMatches.length, transitionMagnitude: magnitude, coldStart: index === 0, model: roundedMetrics(modelMetrics), neutral: roundedMetrics(neutralMetrics) });
    const counts = { hero: new Map(), role: new Map(), synergy: new Map(), counter: new Map(), team: new Map() };
    posterior = fitPatch(prior, patchMatches, counts); finalCounts = counts;
  }
  const [currentPatchId, currentMatches] = patches.at(-1);
  const heroIds = new Set(currentMatches.flatMap((match) => [...match.radiant, ...match.dire].map((player) => player.heroId)));
  const heroes = {};
  for (const heroId of [...heroIds].sort((a, b) => a - b)) {
    const roles = {};
    for (let role = 1; role <= 5; role += 1) {
      const key = roleKey(heroId, role); const games = finalCounts.role.get(key) ?? 0;
      if (games) roles[role] = { coefficient: Number((posterior.role.get(key) ?? 0).toFixed(5)), games };
    }
    const games = finalCounts.hero.get(String(heroId)) ?? finalCounts.hero.get(heroId) ?? 0;
    heroes[heroId] = { name: names.get(heroId) ?? `Hero ${heroId}`, coefficient: Number((posterior.hero.get(String(heroId)) ?? posterior.hero.get(heroId) ?? 0).toFixed(5)), games, uncertainty: Number(Math.min(.35, 1 / Math.sqrt(8 + games)).toFixed(4)), roles };
  }
  const eligibleFolds = folds.filter((fold) => !fold.coldStart);
  const aggregate = (source, key) => eligibleFolds.length ? eligibleFolds.reduce((sum, fold) => sum + fold[source][key] * fold.matches, 0) / eligibleFolds.reduce((sum, fold) => sum + fold.matches, 0) : null;
  const modelLogLoss = aggregate("model", "logLoss"); const neutralLogLoss = aggregate("neutral", "logLoss");
  const logLossDelta = modelLogLoss === null || neutralLogLoss === null ? null : modelLogLoss - neutralLogLoss;
  const recommendedWeight = logLossDelta !== null && logLossDelta < 0 ? Math.min(1, Math.max(.15, -logLossDelta / .015)) : 0;
  const artifact = {
    schemaVersion: 1, modelFamily: "temporal-logistic-draft-v1", trainedAt: new Date().toISOString(),
    trainingPolicy: "local-only; production receives this compact artifact and never the training database",
    dataset: { matches: matches.length, patches: patches.length, firstPatchId: patches[0][0], currentPatchId, currentPatchMatches: currentMatches.length, domains: Object.fromEntries([...new Set(matches.map((match) => match.domain))].map((domain) => [domain, matches.filter((match) => match.domain === domain).length])) },
    methodology: { split: "strict walk-forward by patch", epochs: EPOCHS, learningRate: LEARNING_RATE, l2: L2, transition: "previous posterior shrunk by configured patch magnitude", features: ["hero", "hero×role", "same-team pair", "directional counter", "team strength", "Radiant"] },
    backtest: { eligiblePatches: eligibleFolds.length, aggregate: { model: { brier: aggregate("model", "brier"), logLoss: modelLogLoss, accuracy: aggregate("model", "accuracy") }, neutral: { brier: aggregate("neutral", "brier"), logLoss: neutralLogLoss, accuracy: aggregate("neutral", "accuracy") }, logLossDelta }, folds },
    deployment: { status: recommendedWeight > 0 ? "candidate" : "shadow", recommendedWeight: Number(recommendedWeight.toFixed(3)), gate: "Temporal signal affects production only when strict future-patch log loss beats the neutral baseline." },
    inference: { heroScale: .2, roleScale: .08, synergyScale: .04, counterScale: .02, temperature: 1, radiantBias: Number(posterior.radiantBias.toFixed(5)) },
    heroes,
    synergy: compactMap(posterior.synergy, finalCounts.synergy, MIN_PAIR_GAMES),
    counters: compactMap(posterior.counter, finalCounts.counter, MIN_PAIR_GAMES),
  };
  const stableArtifact = { ...artifact };
  delete stableArtifact.trainedAt;
  artifact.modelId = createHash("sha256").update(JSON.stringify(stableArtifact)).digest("hex").slice(0, 16);
  await writeFile(OUTPUT, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`Temporal draft model ${artifact.modelId}: ${matches.length} matches, ${patches.length} patches, ${Object.keys(heroes).length} heroes; ${OUTPUT}`);
  if (patches.length < 3) console.warn("Only a small patch history is available. Add historical match adapters before treating walk-forward metrics as conclusive.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
