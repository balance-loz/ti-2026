import { createHash } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const DATA_DIR = path.resolve(process.env.DATA_DIR || "data");
const DB_PATH = path.join(DATA_DIR, "ti-predictor.sqlite");
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const output = path.resolve(process.env.CHECKPOINT_DIR || path.join(DATA_DIR, "checkpoints", stamp));
const expectedCompleted = Number(process.env.CHECKPOINT_EXPECT_COMPLETED || 24);
const modelFiles = ["team-stats.json", "team-model.json", "draft-stats.json", "draft-temporal-model.json", "live-map-model.json"];

await mkdir(output, { recursive: true });
const source = new DatabaseSync(DB_PATH, { readOnly: true });
const integrity = source.prepare("PRAGMA integrity_check").get().integrity_check;
const matches = source.prepare("SELECT * FROM matches ORDER BY stage,round,id").all();
const completed = matches.filter((match) => match.winner);
const duplicates = source.prepare("SELECT stage,round,MIN(team_a,team_b) lo,MAX(team_a,team_b) hi,COUNT(*) count,GROUP_CONCAT(id) ids FROM matches GROUP BY stage,round,lo,hi HAVING COUNT(*)>1").all();
const missingPrematch = completed.filter((match) => !Number.isFinite(Number(match.predicted_probability)));
const snapshots = source.prepare("SELECT id,trigger,forecast_mode,opinion_weight,iterations,seed,completed_match_count,model_generated_at,created_at FROM prediction_snapshots ORDER BY id").all();
if (integrity !== "ok" || duplicates.length || missingPrematch.length || completed.length !== expectedCompleted) {
  source.close();
  throw new Error(`Checkpoint refused: integrity=${integrity}, completed=${completed.length}/${expectedCompleted}, duplicates=${duplicates.length}, missingPrematch=${missingPrematch.length}`);
}
await backup(source, path.join(output, "ti-predictor.sqlite"));
source.close();

const models = [];
for (const file of modelFiles) {
  const from = path.join(ROOT, "public", file);
  const raw = await readFile(from);
  await copyFile(from, path.join(output, file));
  models.push({ file, sha256: createHash("sha256").update(raw).digest("hex") });
}
const report = {
  schema: "ti2026.production-checkpoint",
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  sourceDatabase: DB_PATH,
  integrity,
  completedMatches: completed.length,
  matches,
  duplicates,
  missingPrematch,
  snapshots,
  models,
  policy: "Frozen historical baseline; TI series are excluded from baseline training and enter once through the online Bradley-Terry layer.",
};
await writeFile(path.join(output, "checkpoint.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Production checkpoint saved: ${output}`);

