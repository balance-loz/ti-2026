import { parentPort, workerData } from "node:worker_threads";
import { runForecast } from "./forecast-engine.mjs";

try {
  const { kind, probabilities, minimum, seed, matches, stats, adaptive, conditionalMatchId } = workerData;
  const total = kind === "conditional" ? minimum * 2 : adaptive?.maxIterations ?? minimum;
  parentPort.postMessage({ progress: { current: 0, total } });
  let result;
  if (kind === "conditional") {
    const target = matches.find((match) => Number(match.id) === Number(conditionalMatchId));
    if (!target || target.winner) throw new Error("conditional_match_unavailable");
    const branchMatches = (winner) => matches.map((match) => Number(match.id) === Number(conditionalMatchId) ? { ...match, winner } : match);
    const aWins = runForecast(probabilities, minimum, seed, { matches: branchMatches(target.team_a), stats });
    parentPort.postMessage({ progress: { current: minimum, total } });
    const bWins = runForecast(probabilities, minimum, seed, { matches: branchMatches(target.team_b), stats });
    result = { iterations: minimum, seed, aWins, bWins };
  } else {
    result = runForecast(probabilities, minimum, seed, { matches, stats, adaptive });
  }
  parentPort.postMessage({ progress: { current: total, total } });
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
