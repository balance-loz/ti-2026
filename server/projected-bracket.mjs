import { combinedSeriesForecast, orientedProbability } from "./combined-forecast.mjs";

const finiteProbability = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Math.min(0.99, Math.max(0.01, Number(value))) : null;

export function predictionTimeliness(capturedAt, eventAt, minimumLeadMinutes = 5) {
  const captured = Date.parse(capturedAt || "");
  const event = Date.parse(eventAt || "");
  if (!Number.isFinite(captured) || !Number.isFinite(event)) return { status: "unverified", leadMinutes: null, eligible: false };
  const leadMinutes = (event - captured) / 60_000;
  return {
    status: leadMinutes >= minimumLeadMinutes ? "actionable" : leadMinutes >= 0 ? "late" : "after_start",
    leadMinutes,
    eligible: leadMinutes >= minimumLeadMinutes,
  };
}

export function mostLikelyExactScore(exactScores) {
  return [...(exactScores || [])].sort((a, b) => b.probability - a.probability || a.score.localeCompare(b.score))[0] ?? null;
}

export function projectedQualifiers(simulationResult) {
  const scenario = simulationResult?.scenarios?.[0];
  const fromScenario = scenario ? [...(scenario.direct40 || []), ...(scenario.direct41 || []), ...(scenario.via || [])] : [];
  if (fromScenario.length >= 8) return [...new Set(fromScenario)].slice(0, 8);
  return [...(simulationResult?.teams || [])].sort((a, b) => Number(b.qualify || 0) - Number(a.qualify || 0)).slice(0, 8).map((team) => team.id);
}

export function projectPlayoffBracket({ simulationResult, probabilities, matches = [], betLocks = [] }) {
  const qualifiers = projectedQualifiers(simulationResult);
  if (qualifiers.length < 8) return { qualifiers, nodes: [], champion: null };
  const actualPlayoff = matches.filter((match) => match.stage === "playoff");
  const usedActualIds = new Set();
  const actualFor = (a, b) => {
    const found = actualPlayoff.find((match) => !usedActualIds.has(match.id) && ((match.team_a === a && match.team_b === b) || (match.team_a === b && match.team_b === a)));
    if (found) usedActualIds.add(found.id);
    return found ?? null;
  };
  const node = (label, lane, column, a, b, bestOf = 3) => {
    const actual = actualFor(a, b);
    const latestProbabilityA = finiteProbability(orientedProbability(a, b, probabilities)) ?? 0.5;
    const betLock = actual ? betLocks.find((lock) => lock.scope === "series" && String(lock.subjectId) === String(actual.id)) : null;
    const lockedRaw = finiteProbability(betLock?.probabilityA);
    const lockedProbabilityA = lockedRaw === null ? null : betLock.teamA === a ? lockedRaw : 1 - lockedRaw;
    const decisionProbabilityA = lockedProbabilityA ?? latestProbabilityA;
    const lockedForecast = combinedSeriesForecast({ teamA: a, teamB: b, seriesProbabilityA: decisionProbabilityA, bestOf });
    const exact = mostLikelyExactScore(lockedForecast.exactScores);
    const predictedWinner = decisionProbabilityA >= 0.5 ? a : b;
    const actualWinner = actual?.winner === a || actual?.winner === b ? actual.winner : null;
    const winner = actualWinner ?? predictedWinner;
    return {
      label, lane, column, a, b, bestOf, winner, predictedWinner, actualWinner,
      latestProbabilityA, lockedProbabilityA, decisionProbabilityA,
      exactScore: exact?.score ?? null, exactScoreProbability: exact?.probability ?? null,
      actualScore: actual?.score_a === null || actual?.score_a === undefined ? null : actual.team_a === a ? `${actual.score_a}:${actual.score_b}` : `${actual.score_b}:${actual.score_a}`,
      predictionCorrect: actualWinner ? predictedWinner === actualWinner : null,
      status: actualWinner ? "completed" : actual ? "scheduled" : "projected",
      matchId: actual?.id ?? null,
    };
  };
  const openingPairs = actualPlayoff.filter((match) => Number(match.round) === 1).slice(0, 4);
  const pairs = openingPairs.length === 4
    ? openingPairs.map((match) => [match.team_a, match.team_b])
    : [[qualifiers[0], qualifiers[7]], [qualifiers[3], qualifiers[4]], [qualifiers[1], qualifiers[6]], [qualifiers[2], qualifiers[5]]];
  const uq = pairs.map(([a, b], index) => node(`UB QF ${index + 1}`, "upper", 1, a, b));
  const loser = (match) => match.winner === match.a ? match.b : match.a;
  const us = [node("UB SF 1", "upper", 2, uq[0].winner, uq[1].winner), node("UB SF 2", "upper", 2, uq[2].winner, uq[3].winner)];
  const lr1 = [node("LB R1 1", "lower", 2, loser(uq[0]), loser(uq[1])), node("LB R1 2", "lower", 2, loser(uq[2]), loser(uq[3]))];
  const lr2 = [node("LB R2 1", "lower", 3, lr1[0].winner, loser(us[1])), node("LB R2 2", "lower", 3, lr1[1].winner, loser(us[0]))];
  const uf = node("UB FINAL", "upper", 3, us[0].winner, us[1].winner);
  const ls = node("LB SF", "lower", 4, lr2[0].winner, lr2[1].winner);
  const lf = node("LB FINAL", "lower", 5, ls.winner, loser(uf));
  const gf = node("GRAND FINAL", "final", 6, uf.winner, lf.winner, 5);
  return { qualifiers, nodes: [...uq, ...us, uf, ...lr1, ...lr2, ls, lf, gf], champion: gf.winner };
}
