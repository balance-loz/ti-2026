import { parentPort, workerData } from "node:worker_threads";
import { runForecast } from "./forecast-engine.mjs";

try {
  const { probabilities, minimum, seed, matches, stats, adaptive } = workerData;
  const result = runForecast(probabilities, minimum, seed, { matches, stats, adaptive });
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
