import { spawn } from "node:child_process";

process.stdout._handle?.setBlocking?.(true);
process.stderr._handle?.setBlocking?.(true);

const STEPS = [
  "scripts/update-stats.mjs",
  "scripts/backtest-model.mjs",
  "scripts/update-draft-stats.mjs",
  "scripts/build-draft-dataset.mjs",
  "scripts/audit-draft-coverage.mjs",
  "scripts/run-active-draft-walkforward.mjs",
  "scripts/update-intel-stats.mjs",
];

function run(script, index, total) {
  process.stdout.write(`[refresh] ${index}/${total} start ${script}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd: process.cwd(), stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        process.stderr.write(`[refresh] ${index}/${total} failed ${script} code ${code}\n`);
        reject(new Error(`${script} exited with code ${code}`));
        return;
      }
      process.stdout.write(`[refresh] ${index}/${total} done ${script}\n`);
      resolve();
    });
  });
}

process.stdout.write(`[refresh] start ${STEPS.length} steps\n`);
for (const [index, script] of STEPS.entries()) await run(script, index + 1, STEPS.length);
process.stdout.write("[refresh] done\n");
