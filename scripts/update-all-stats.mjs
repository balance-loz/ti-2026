import { spawn } from "node:child_process";

function run(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd: process.cwd(), stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${script} exited with code ${code}`)));
  });
}

await run("scripts/update-stats.mjs");
await run("scripts/backtest-model.mjs");
await run("scripts/update-draft-stats.mjs");
await run("scripts/build-draft-dataset.mjs");
await run("scripts/audit-draft-coverage.mjs");
await run("scripts/run-active-draft-walkforward.mjs");
await run("scripts/update-intel-stats.mjs");
