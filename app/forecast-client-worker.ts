import { runForecast } from "../server/forecast-engine.mjs";

self.onmessage = (event: MessageEvent) => {
  try {
    const { answers, iterations, seed, matches, stats, adaptive } = event.data;
    const result = runForecast(answers, iterations, seed, { matches, stats, adaptive });
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
