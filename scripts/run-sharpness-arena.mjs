import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sharpenProbability } from "../server/prediction-decision.mjs";

const ROOT = process.cwd();
const SOURCE = path.resolve(process.env.TEAM_OOF_PATH || path.join(ROOT, "work", "all-pro-team-oof.jsonl"));
const OUTPUT = path.join(ROOT, "work", "sharpness-arena.json");
const DEPLOYMENT = path.join(ROOT, "public", "decision-policy.json");
const temperatures = [.6, .7, .8, .9, 1, 1.1, 1.2];
const raw = await readFile(SOURCE, "utf8");
const all = raw.split(/\r?\n/).filter(Boolean).map(JSON.parse).filter((row) => Number.isFinite(row.finalStackOOF) && (row.outcome === 0 || row.outcome === 1));
const split = Math.floor(all.length * .8); const validation = all.slice(0, split); const test = all.slice(split);
const clamp = (p) => Math.min(.999, Math.max(.001, p));
function metrics(rows, temperature) {
  let ll = 0; let brier = 0; let correct = 0; let outside = 0;
  const bins = new Map();
  for (const row of rows) {
    const p = clamp(sharpenProbability(row.finalStackOOF * 100, temperature) / 100); const y = row.outcome;
    ll += -(y * Math.log(p) + (1 - y) * Math.log(1 - p)); brier += (p - y) ** 2; correct += Number((p >= .5) === Boolean(y)); outside += Number(p < .4 || p > .6);
    const bin = Math.min(9, Math.floor(p * 10)); const item = bins.get(bin) ?? { count: 0, probability: 0, outcome: 0 }; item.count++; item.probability += p; item.outcome += y; bins.set(bin, item);
  }
  const calibrationError = [...bins.values()].reduce((sum, bin) => sum + bin.count / rows.length * Math.abs(bin.probability / bin.count - bin.outcome / bin.count), 0);
  return { samples: rows.length, logLoss: ll / rows.length, brier: brier / rows.length, accuracy: correct / rows.length, outside40to60: outside / rows.length, calibrationError };
}
const validationArena = temperatures.map((temperature) => ({ temperature, ...metrics(validation, temperature) })).sort((a, b) => a.logLoss - b.logLoss || a.brier - b.brier);
const selected = validationArena[0]; const baselineTest = metrics(test, 1); const selectedTest = metrics(test, selected.temperature);
const activate = selected.temperature < 1 && selectedTest.logLoss <= baselineTest.logLoss && selectedTest.brier <= baselineTest.brier && selectedTest.calibrationError <= baselineTest.calibrationError + .005;
function selective(rows, temperature, margin) { const accepted = rows.filter((row) => Math.abs(sharpenProbability(row.finalStackOOF * 100, temperature) - 50) >= margin); return { marginPp: margin, accepted: accepted.length, coverage: accepted.length / rows.length, accuracy: accepted.length ? accepted.filter((row) => (row.finalStackOOF >= .5) === Boolean(row.outcome)).length / accepted.length : 0 }; }
const selectiveValidation = [3, 5, 7, 10, 12, 15].map((margin) => selective(validation, activate ? selected.temperature : 1, margin));
const selectedSelective = selectiveValidation.filter((row) => row.coverage >= .3).sort((a, b) => b.accuracy - a.accuracy || b.coverage - a.coverage)[0] ?? selectiveValidation[0];
const selectiveTest = selective(test, activate ? selected.temperature : 1, selectedSelective.marginPp);
const selectiveValidated = selectiveTest.coverage >= .3 && selectiveTest.accuracy > .6;
const report = { generatedAt: new Date().toISOString(), methodology: "temperature and selective margin chosen on chronological first 80% OOF block and evaluated once on final 20%; no synthetic confidence reward", dataset: { series: all.length, validation: validation.length, test: test.length }, validationArena, frozenTest: { baseline: baselineTest, selected: selectedTest }, selectedTemperature: selected.temperature, selectivePrediction: { validation: selectiveValidation, selected: selectedSelective, frozenTest: selectiveTest, validated: selectiveValidated }, deployment: { probabilitySharpness: activate ? "candidate" : "shadow", selectivePrediction: selectiveValidated ? "candidate" : "shadow", rule: "sharper temperature activates only if frozen log loss and Brier do not worsen and calibration error increases by at most 0.005; selective margin requires >=30% frozen coverage and >60% accuracy" } };
await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(DEPLOYMENT, `${JSON.stringify({ schemaVersion: 1, generatedAt: report.generatedAt, probabilityTemperature: activate ? selected.temperature : 1, source: "/work/sharpness-arena.json", status: { probabilitySharpness: report.deployment.probabilitySharpness, selectivePrediction: report.deployment.selectivePrediction }, selectivePrediction: { labels: ["pick", "pass", "even", "roulette"], minMarginPp: selectedSelective.marginPp, frozenCoverage: selectiveTest.coverage, frozenAccuracy: selectiveTest.accuracy } }, null, 2)}\n`);
console.log(`Sharpness arena: T=${selected.temperature} ${report.deployment.probabilitySharpness.toUpperCase()}; selective margin ${selectedSelective.marginPp}pp, frozen ${(100 * selectiveTest.accuracy).toFixed(1)}% accuracy at ${(100 * selectiveTest.coverage).toFixed(1)}% coverage`);
