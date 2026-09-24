// Draft model: hero, synergy and counter coefficients fitted by regularised
// logistic regression on every stored map with a complete pick/ban record.
// Produces the artifact shape that draft-inference.mjs already consumes, and is
// only published when it beats the side-bias-only baseline on a future holdout.
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { nowIso } from "./db.mjs";
import { createOnlineTeamModel } from "../team-model.mjs";
import { loadTrainingSeries, strengthPair, STRENGTH_CONFIG, MODERATION } from "./ratings.mjs";
import { attachSeriesLineups, currentFives, fitStrengthModel, loadSeriesLineups } from "./player-ratings.mjs";

const MODEL_PATH = path.resolve(process.env.DRAFT_TEMPORAL_MODEL || "models/draft-temporal-model.json");
const MIN_MAPS = Math.max(500, Number(process.env.DRAFT_MIN_MAPS || 1500));
const HOLDOUT_FRACTION = Math.min(0.4, Math.max(0.05, Number(process.env.DRAFT_HOLDOUT_FRACTION || 0.15)));
const VALIDATION_FRACTION = Math.min(0.3, Math.max(0.05, Number(process.env.DRAFT_VALIDATION_FRACTION || 0.15)));
const LEARNING_RATE = Math.max(0.001, Number(process.env.DRAFT_LEARNING_RATE || 0.08));

// Hero/synergy/counter features number in the tens of thousands while the
// signal in a draft is small, so the fit overfits violently if left alone.
// Hyperparameters are chosen on a validation slice and judged on a later test
// slice that selection never touched.
// patchHalfLife is in patches: 0 disables the decay entirely, which is one of
// the candidates so the holdout can reject the idea rather than have it assumed.
const SEARCH_GRID = [
  { l2: 0.05, epochs: 2, minPairGames: 1e9, patchHalfLife: 0 },
  { l2: 0.05, epochs: 2, minPairGames: 1e9, patchHalfLife: 6 },
  { l2: 0.05, epochs: 2, minPairGames: 1e9, patchHalfLife: 3 },
  { l2: 0.05, epochs: 2, minPairGames: 1e9, patchHalfLife: 1.5 },
  { l2: 0.15, epochs: 4, minPairGames: 1e9, patchHalfLife: 0 },
  { l2: 0.15, epochs: 4, minPairGames: 1e9, patchHalfLife: 3 },
  { l2: 0.05, epochs: 3, minPairGames: 400, patchHalfLife: 0 },
  { l2: 0.05, epochs: 3, minPairGames: 400, patchHalfLife: 3 },
  { l2: 0.1, epochs: 6, minPairGames: 200, patchHalfLife: 3 },
];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const sigmoid = (value) => 1 / (1 + Math.exp(-clamp(value, -20, 20)));
const logLoss = (probability, outcome) => {
  const p = clamp(probability, 1e-6, 1 - 1e-6);
  return -(outcome * Math.log(p) + (1 - outcome) * Math.log(1 - p));
};

/** Maps with ten locked heroes and a result, oldest first. */
export function loadDraftRows(db, { windowDays = Number(process.env.DRAFT_WINDOW_DAYS || 800), nowSeconds = Date.now() / 1000 } = {}) {
  const since = Math.floor(nowSeconds - windowDays * 86_400);
  const rows = db.prepare(`SELECT m.match_id, m.league_id, m.series_id, m.radiant_picks_json, m.dire_picks_json,
                                  m.radiant_win, m.start_time, m.patch, m.radiant_team_id, m.dire_team_id
                           FROM maps m LEFT JOIN tournaments t ON t.league_id = m.league_id
                           WHERE m.radiant_win IS NOT NULL AND m.radiant_picks_json IS NOT NULL AND m.dire_picks_json IS NOT NULL
                             AND COALESCE(t.tracked, 1) = 1 AND m.start_time >= ?
                           ORDER BY m.start_time ASC`).all(since);
  const parsed = [];
  for (const row of rows) {
    let radiant; let dire;
    try {
      radiant = JSON.parse(row.radiant_picks_json);
      dire = JSON.parse(row.dire_picks_json);
    } catch { continue; }
    if (!Array.isArray(radiant) || !Array.isArray(dire)) continue;
    if (radiant.length !== 5 || dire.length !== 5) continue;
    if (new Set([...radiant, ...dire]).size !== 10) continue;
    parsed.push({
      matchId: Number(row.match_id), radiant, dire,
      seriesKey: row.series_id != null ? `${row.league_id}:${row.series_id}` : `map:${row.match_id}`,
      win: row.radiant_win ? 1 : 0,
      startTime: Number(row.start_time), patch: row.patch,
      radiantTeamId: Number(row.radiant_team_id) || null,
      direTeamId: Number(row.dire_team_id) || null,
      offset: 0,
    });
  }
  return parsed;
}

/**
 * Attach a pre-match team-strength offset to every row.
 *
 * The draft model must learn what the heroes add *beyond* team strength,
 * otherwise it just rediscovers that good teams win. The offset is produced by
 * walking an online rating model forward in time, so each map is scored by a
 * model that has only seen earlier maps — no future information enters.
 */
export function attachStrengthOffsets(rows, { definition = { id: "bt_offset", family: "bradley_terry", learningRate: 0.22, halfLifeDays: 45, l2: 0.004 } } = {}) {
  const model = createOnlineTeamModel(definition);
  let covered = 0;
  for (const row of rows) {
    if (!row.radiantTeamId || !row.direTeamId || row.radiantTeamId === row.direTeamId) {
      row.offset = 0;
      continue;
    }
    const evidence = model.evidence(row.radiantTeamId, row.direTeamId);
    if (evidence >= 4) {
      const probability = clamp(model.predict(row.radiantTeamId, row.direTeamId, row.startTime), 0.02, 0.98);
      row.offset = Math.log(probability / (1 - probability));
      covered += 1;
    } else {
      row.offset = 0;
    }
    model.update({
      targetLineup: String(row.radiantTeamId),
      opponentLineup: String(row.direTeamId),
      targetScore: row.win,
      startTime: row.startTime,
      rosterWeight: 1,
      seriesInformation: 0.6,
    });
  }
  return { covered, total: rows.length };
}

/**
 * Cross-fitted offsets from the same team+player strength model used in
 * production. Each block is scored by a fit whose cutoff precedes every map in
 * the block, so the draft validation measures the feature stack actually
 * served without leaking later roster/results into it.
 */
export function attachProductionStrengthOffsets(rows, db, { folds = 8 } = {}) {
  if (!rows.length) return { covered: 0, total: 0, folds: 0, kind: "production_strength_crossfit" };
  const allSeries = loadTrainingSeries(db, {
    nowSeconds: rows.at(-1).startTime + 1,
    windowDays: Number(process.env.DRAFT_WINDOW_DAYS || 800),
  });
  attachSeriesLineups(allSeries, db);
  for (const row of allSeries) row.playerTierWeight = 1;
  const lineups = loadSeriesLineups(db);
  const blockSize = Math.max(1, Math.ceil(rows.length / Math.max(2, folds)));
  let covered = 0; let fittedFolds = 0;
  for (let start = 0; start < rows.length; start += blockSize) {
    const block = rows.slice(start, start + blockSize);
    const asOf = block[0].startTime;
    const history = allSeries.filter((series) => series.startTime < asOf);
    if (history.length < 200) {
      for (const row of block) row.offset = 0;
      continue;
    }
    const fit = fitStrengthModel(history, { nowSeconds: asOf, config: STRENGTH_CONFIG });
    const fives = currentFives(db, { beforeSeconds: asOf, lineups });
    fittedFolds += 1;
    for (const row of block) {
      if (!row.radiantTeamId || !row.direTeamId || row.radiantTeamId === row.direTeamId) {
        row.offset = 0; continue;
      }
      const pair = strengthPair(fit, fives, row.radiantTeamId, row.direTeamId, MODERATION);
      if (Math.min(pair.evidenceA, pair.evidenceB) <= 0) { row.offset = 0; continue; }
      const probability = clamp(pair.probability, 0.02, 0.98);
      row.offset = Math.log(probability / (1 - probability));
      covered += 1;
    }
  }
  return { covered, total: rows.length, folds: fittedFolds, kind: "production_strength_crossfit" };
}


/**
 * Weight every map by how far its patch is from the current one.
 *
 * Heroes are rebalanced every patch, so a map from six patches ago describes a
 * game that no longer exists. Patches are ordered by when they first appear in
 * the data rather than by parsing version strings, because the feed mixes
 * formats — "7.41e" from match detail, a bare id like "60" from the match list.
 */
export function attachPatchWeights(rows, { halfLifePatches = 3 } = {}) {
  const firstSeen = new Map();
  for (const row of rows) {
    const patch = row.patch == null ? "" : String(row.patch);
    const seen = firstSeen.get(patch);
    if (seen === undefined || row.startTime < seen) firstSeen.set(patch, row.startTime);
  }
  const order = [...firstSeen.entries()].sort((a, b) => a[1] - b[1]).map(([patch]) => patch);
  const index = new Map(order.map((patch, position) => [patch, position]));
  const newest = order.length - 1;

  for (const row of rows) {
    const position = index.get(row.patch == null ? "" : String(row.patch));
    const distance = position === undefined ? newest : newest - position;
    // A half-life in patches, not days: a balance change matters regardless of
    // how long the patch happened to last.
    row.patchWeight = halfLifePatches > 0 ? 0.5 ** (distance / halfLifePatches) : 1;
  }
  return { patches: order.length, newest: order[newest] ?? null };
}

const pairKey = (a, b) => [Number(a), Number(b)].sort((left, right) => left - right).join("|");

/**
 * Build the sparse feature index. Rare pairs are dropped entirely so the fit is
 * not dominated by combinations seen a handful of times.
 */
function buildIndex(rows, minPairGames) {
  const heroCounts = new Map();
  const synergyCounts = new Map();
  const counterCounts = new Map();
  for (const row of rows) {
    for (const hero of [...row.radiant, ...row.dire]) heroCounts.set(hero, (heroCounts.get(hero) || 0) + 1);
    for (const side of [row.radiant, row.dire]) {
      for (let i = 0; i < side.length; i += 1) for (let j = i + 1; j < side.length; j += 1) {
        const key = pairKey(side[i], side[j]);
        synergyCounts.set(key, (synergyCounts.get(key) || 0) + 1);
      }
    }
    for (const r of row.radiant) for (const d of row.dire) {
      const key = pairKey(r, d);
      counterCounts.set(key, (counterCounts.get(key) || 0) + 1);
    }
  }
  // Heroes need far less evidence than pairs, so they use their own floor.
  const minHeroGames = Math.max(20, Math.min(200, Math.floor(rows.length / 200)));
  const heroes = [...heroCounts.entries()].filter(([, count]) => count >= minHeroGames).map(([hero]) => hero).sort((a, b) => a - b);
  const synergies = [...synergyCounts.entries()].filter(([, count]) => count >= minPairGames).map(([key]) => key);
  const counters = [...counterCounts.entries()].filter(([, count]) => count >= minPairGames).map(([key]) => key);
  return {
    heroes, synergies, counters,
    heroIndex: new Map(heroes.map((hero, index) => [hero, index])),
    synergyIndex: new Map(synergies.map((key, index) => [key, index])),
    counterIndex: new Map(counters.map((key, index) => [key, index])),
    heroCounts, synergyCounts, counterCounts,
  };
}

/** Sparse feature vector for one map, as [slot, value] pairs into one weight array. */
function featuresFor(row, index, offsets) {
  const features = [[offsets.bias, 1]];
  for (const hero of row.radiant) {
    const slot = index.heroIndex.get(hero);
    if (slot !== undefined) features.push([offsets.hero + slot, 1]);
  }
  for (const hero of row.dire) {
    const slot = index.heroIndex.get(hero);
    if (slot !== undefined) features.push([offsets.hero + slot, -1]);
  }
  for (const [side, sign] of [[row.radiant, 1], [row.dire, -1]]) {
    for (let i = 0; i < side.length; i += 1) for (let j = i + 1; j < side.length; j += 1) {
      const slot = index.synergyIndex.get(pairKey(side[i], side[j]));
      if (slot !== undefined) features.push([offsets.synergy + slot, sign]);
    }
  }
  for (const r of row.radiant) for (const d of row.dire) {
    const key = pairKey(r, d);
    const slot = index.counterIndex.get(key);
    if (slot === undefined) continue;
    // Sign convention: +1 when the lower hero id is on radiant.
    features.push([offsets.counter + slot, Number(r) < Number(d) ? 1 : -1]);
  }
  return features;
}

function fit(rows, index, offsets, size, { l2, epochs }) {
  const weights = new Float64Array(size);
  const accumulated = new Float64Array(size).fill(1e-8);
  const prepared = rows.map((row) => ({
    features: featuresFor(row, index, offsets),
    win: row.win,
    offset: Number(row.offset) || 0,
    weight: Number(row.patchWeight ?? 1),
  }));
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    // Deterministic shuffle keeps the run reproducible across retrains.
    let state = (epoch + 1) * 2654435761;
    const order = prepared.map((_, position) => position);
    for (let i = order.length - 1; i > 0; i -= 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const j = state % (i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const position of order) {
      const { features, win, offset, weight } = prepared[position];
      // The team-strength offset is fixed, so the weights only ever explain the
      // part of the result that team strength did not already account for.
      let logit = offset;
      for (const [slot, value] of features) logit += weights[slot] * value;
      // An old-patch map still teaches, just less.
      const error = weight * (sigmoid(logit) - win);
      for (const [slot, value] of features) {
        const gradient = error * value + l2 * weights[slot];
        accumulated[slot] += gradient * gradient;
        weights[slot] -= LEARNING_RATE * gradient / Math.sqrt(accumulated[slot]);
      }
    }
  }
  return weights;
}

function evaluate(rows, index, offsets, weights) {
  let loss = 0; let brier = 0; let correct = 0;
  for (const row of rows) {
    let logit = Number(row.offset) || 0;
    for (const [slot, value] of featuresFor(row, index, offsets)) logit += weights[slot] * value;
    const probability = sigmoid(logit);
    loss += logLoss(probability, row.win);
    brier += (probability - row.win) ** 2;
    correct += (probability >= 0.5 ? 1 : 0) === row.win ? 1 : 0;
  }
  const n = Math.max(1, rows.length);
  return { samples: rows.length, logLoss: loss / n, brier: brier / n, accuracy: correct / n };
}

function pairedClusterInterval(rows, index, offsets, weights, { iterations = 500 } = {}) {
  const clusters = new Map();
  for (const row of rows) {
    let value = Number(row.offset) || 0;
    for (const [slot, feature] of featuresFor(row, index, offsets)) value += weights[slot] * feature;
    const delta = logLoss(sigmoid(value), row.win) - logLoss(sigmoid(Number(row.offset) || 0), row.win);
    const key = row.seriesKey || `map:${row.matchId}`;
    const current = clusters.get(key) || { sum: 0, n: 0 };
    current.sum += delta; current.n += 1; clusters.set(key, current);
  }
  const groups = [...clusters.values()];
  if (!groups.length) return null;
  let state = 0x5eed1234;
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sum = 0; let n = 0;
    for (let index = 0; index < groups.length; index += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const group = groups[state % groups.length];
      sum += group.sum; n += group.n;
    }
    samples.push(sum / Math.max(1, n));
  }
  samples.sort((a, b) => a - b);
  return {
    clusters: groups.length, iterations,
    lower95: samples[Math.floor(iterations * 0.025)],
    upper95: samples[Math.min(iterations - 1, Math.floor(iterations * 0.975))],
  };
}

/** Team strength alone, with no draft information: the bar the draft must clear. */
function evaluateOffsetOnly(rows) {
  let loss = 0; let brier = 0; let correct = 0;
  for (const row of rows) {
    const probability = sigmoid(Number(row.offset) || 0);
    loss += logLoss(probability, row.win);
    brier += (probability - row.win) ** 2;
    correct += (probability >= 0.5 ? 1 : 0) === row.win ? 1 : 0;
  }
  const n = Math.max(1, rows.length);
  return { samples: rows.length, logLoss: loss / n, brier: brier / n, accuracy: correct / n };
}

/**
 * Train and, if it passes the holdout gate, publish the draft artifact.
 * The baseline is a model that knows only the Radiant side advantage, so a
 * pass means the hero information itself carried predictive value.
 */
function offsetsFor(index) {
  return {
    bias: 0,
    hero: 1,
    synergy: 1 + index.heroes.length,
    counter: 1 + index.heroes.length + index.synergies.length,
  };
}

function trainCandidate(rows, candidate) {
  attachPatchWeights(rows, { halfLifePatches: candidate.patchHalfLife ?? 0 });
  const index = buildIndex(rows, candidate.minPairGames);
  const offsets = offsetsFor(index);
  const size = offsets.counter + index.counters.length;
  return { index, offsets, weights: fit(rows, index, offsets, size, candidate) };
}

export function trainDraftModel(db, { nowSeconds = Date.now() / 1000, outputPath = MODEL_PATH } = {}) {
  const rows = loadDraftRows(db, { nowSeconds });
  if (rows.length < MIN_MAPS) return { ok: false, reason: "insufficient_maps", maps: rows.length, required: MIN_MAPS };
  const offsetCoverage = attachProductionStrengthOffsets(rows, db, {
    folds: Math.max(2, Number(process.env.DRAFT_STRENGTH_FOLDS || 8)),
  });

  // Chronological three-way split. Validation picks the hyperparameters, the
  // test slice is only ever read once, for the publish gate.
  const testAt = Math.floor(rows.length * (1 - HOLDOUT_FRACTION));
  const validationAt = Math.floor(testAt * (1 - VALIDATION_FRACTION));
  const train = rows.slice(0, validationAt);
  const validation = rows.slice(validationAt, testAt);
  const test = rows.slice(testAt);
  if (test.length < 100 || validation.length < 100) {
    return { ok: false, reason: "insufficient_holdout", validation: validation.length, test: test.length };
  }

  const validationBaselineMetrics = evaluateOffsetOnly(validation);
  const validationBaseline = validationBaselineMetrics.logLoss;

  const search = [];
  let best = null;
  for (const candidate of SEARCH_GRID) {
    const fitted = trainCandidate(train, candidate);
    if (fitted.index.heroes.length < 50) continue;
    const metrics = evaluate(validation, fitted.index, fitted.offsets, fitted.weights);
    search.push({ ...candidate, validation: metrics, features: { heroes: fitted.index.heroes.length, synergies: fitted.index.synergies.length, counters: fitted.index.counters.length } });
    if (!best || metrics.logLoss < best.metrics.logLoss) best = { candidate, metrics };
  }
  if (!best) return { ok: false, reason: "insufficient_hero_coverage" };

  // Refit the winner on train+validation so the published model uses every row
  // available before the test slice.
  const fitRows = [...train, ...validation];
  const { index, offsets, weights } = trainCandidate(fitRows, best.candidate);

  const trainMetrics = evaluate(fitRows, index, offsets, weights);
  const holdoutMetrics = evaluate(test, index, offsets, weights);
  const refitRate = fitRows.reduce((sum, row) => sum + row.win, 0) / fitRows.length;
  // The gate compares against team strength alone on the same rows: publishing
  // requires the draft to add information, not merely to be better than a coin.
  const baselineMetrics = evaluateOffsetOnly(test);
  const baselineLoss = baselineMetrics.logLoss;
  const clusterInterval = pairedClusterInterval(test, index, offsets, weights);
  const gatePassed = holdoutMetrics.logLoss < baselineLoss
    && holdoutMetrics.brier < baselineMetrics.brier
    && Number(clusterInterval?.upper95) < 0;

  const fingerprint = createHash("sha256").update(JSON.stringify({
    through: rows.at(-1)?.startTime, rows: rows.length, candidate: best.candidate,
    features: [index.heroes.length, index.synergies.length, index.counters.length],
    metrics: holdoutMetrics,
  })).digest("hex").slice(0, 12);
  const modelId = `draft-${new Date(nowSeconds * 1000).toISOString().slice(0, 10)}-${fingerprint}`;
  const heroes = {};
  for (const [hero, slot] of index.heroIndex) {
    heroes[String(hero)] = { coefficient: Number(weights[offsets.hero + slot].toFixed(6)), games: index.heroCounts.get(hero) || 0, roles: {} };
  }
  const synergy = {};
  for (const [key, slot] of index.synergyIndex) {
    const value = weights[offsets.synergy + slot];
    if (Math.abs(value) < 1e-4) continue;
    synergy[key] = { coefficient: Number(value.toFixed(6)), games: index.synergyCounts.get(key) || 0 };
  }
  const counters = {};
  for (const [key, slot] of index.counterIndex) {
    const value = weights[offsets.counter + slot];
    if (Math.abs(value) < 1e-4) continue;
    const [low, high] = key.split("|");
    // One stored direction; inference reads counters[r>d] - counters[d>r].
    counters[`${low}>${high}`] = { coefficient: Number(value.toFixed(6)), games: index.counterCounts.get(key) || 0 };
  }

  const patches = new Set(rows.map((row) => row.patch).filter(Boolean));
  const artifact = {
    schemaVersion: 1,
    modelId,
    generatedAt: nowIso(),
    dataset: {
      matches: rows.length,
      train: train.length,
      validation: validation.length,
      holdout: test.length,
      patches: patches.size,
      currentPatchId: rows.at(-1)?.patch ?? null,
      earliest: rows[0]?.startTime ?? null,
      latest: rows.at(-1)?.startTime ?? null,
    },
    inference: {
      heroScale: 1, roleScale: 0, synergyScale: 1, counterScale: 1,
      radiantBias: Number(weights[offsets.bias].toFixed(6)),
      temperature: 1, dimensions: 0,
    },
    validation: {
      train: trainMetrics,
      holdout: holdoutMetrics,
      baselineLogLoss: baselineLoss,
      radiantBaseRate: refitRate,
      hyperparameters: best.candidate,
      validationBaseline,
      baselineMetrics,
      strengthOffsetCoverage: offsetCoverage,
      baselineDescription: "pre-match team strength only, no hero information",
      search: search.sort((a, b) => a.validation.logLoss - b.validation.logLoss),
      gatePassed,
      improvementNats: baselineLoss - holdoutMetrics.logLoss,
      pairedSeriesBootstrap: clusterInterval,
      gateCriteria: "candidate must improve log-loss and Brier; upper 95% series-cluster bootstrap bound must be below zero",
    },
    features: { heroes: index.heroes.length, synergies: Object.keys(synergy).length, counters: Object.keys(counters).length },
    heroes, synergy, counters,
  };

  const versionPath = path.join(path.dirname(outputPath), "versions", `${modelId}.json`);
  mkdirSync(path.dirname(versionPath), { recursive: true });
  if (!existsSync(versionPath)) writeFileSync(versionPath, JSON.stringify(artifact));

  db.prepare(`INSERT INTO model_versions(kind, model_id, trained_at, samples, metrics_json, artifact_path, active, notes)
              VALUES('draft',?,?,?,?,?,?,?)
              ON CONFLICT(kind, model_id) DO UPDATE SET trained_at=excluded.trained_at, samples=excluded.samples,
                metrics_json=excluded.metrics_json, active=excluded.active, notes=excluded.notes`)
    .run(modelId, nowIso(), rows.length, JSON.stringify(artifact.validation), versionPath, gatePassed ? 1 : 0,
      gatePassed ? `holdout logloss ${holdoutMetrics.logLoss.toFixed(4)} vs baseline ${baselineLoss.toFixed(4)}`
        : `gate failed: ${holdoutMetrics.logLoss.toFixed(4)} >= ${baselineLoss.toFixed(4)}`);

  if (!gatePassed) {
    return { ok: false, reason: "holdout_gate_failed", modelId, candidatePath: versionPath, validation: artifact.validation };
  }
  db.prepare("UPDATE model_versions SET active = 0 WHERE kind = 'draft' AND model_id != ?").run(modelId);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(artifact));
  return { ok: true, modelId, artifactPath: versionPath, maps: rows.length, validation: artifact.validation, features: artifact.features };
}
