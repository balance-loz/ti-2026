import { buildForecastBase, TEAMS } from "./forecast-engine.mjs";
import { seriesEvidenceWeight, updateProbabilitiesWithLiveSeries } from "./live-team-update.mjs";

const pairKey = (a, b) => [a, b].sort().join("|");
const isFiniteValue = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const probabilityFor = (a, b, probabilities) => {
  const key = pairKey(a, b);
  if (!isFiniteValue(probabilities?.[key])) return null;
  const value = Number(probabilities[key]);
  return key.startsWith(`${a}|`) ? value : 100 - value;
};
const round = (value, digits = 6) => isFiniteValue(value) ? Number(Number(value).toFixed(digits)) : null;

function compactMatch(match) {
  return {
    id: Number(match.id),
    stage: match.stage,
    round: Number(match.round),
    teamA: match.team_a,
    teamB: match.team_b,
    winner: match.winner ?? null,
    scoreA: match.score_a ?? null,
    scoreB: match.score_b ?? null,
    scheduledAt: match.scheduled_at ?? null,
    predictedProbabilityA: isFiniteValue(match.predicted_probability) ? Number(match.predicted_probability) : null,
    createdAt: match.created_at ?? null,
    updatedAt: match.updated_at ?? null,
  };
}

export function buildSnapshotCalculationTrace({ snapshotId = null, createdAt, trigger, kind = "original", rootId = null, parentId = null, config, answers = {}, probabilities, result, stats, matches = [], exactAtSave = true }) {
  const mode = config.forecastMode || "stats";
  const opinionWeight = Number(config.opinionWeight || 0);
  const calibration = { liveGlobal: 0, liveRematch: 0, probabilityTemperature: 1, formLogitSd: 0, seriesNoiseLogitSd: .04, ...(stats?.tournamentCalibration?.selected ?? {}) };
  const completed = matches.filter((match) => match?.winner);
  const base = buildForecastBase({ answers, stats, mode, opinionWeight });
  const statistical = buildForecastBase({ answers: {}, stats, mode: "stats", opinionWeight: 0 });
  const personal = buildForecastBase({ answers, stats, mode: "personal", opinionWeight: 100 });
  const recomputed = updateProbabilitiesWithLiveSeries(base, completed, { liveGlobal: calibration.liveGlobal, seriesInformation: stats?.methodology?.seriesInformation });
  const withoutMatch = new Map(completed.map((match) => [
    Number(match.id),
    updateProbabilitiesWithLiveSeries(base, completed.filter((item) => Number(item.id) !== Number(match.id)), { liveGlobal: calibration.liveGlobal, seriesInformation: stats?.methodology?.seriesInformation }),
  ]));
  const teamNames = Object.fromEntries(TEAMS.map((team) => [team.id, team.name]));
  const pairs = Object.keys(probabilities || {}).sort().map((key) => {
    const [teamA, teamB] = key.split("|");
    const stat = stats?.pairwise?.[key] ?? null;
    const statProbability = Number(statistical[key]);
    const personalProbability = Number(personal[key]);
    const baseProbability = Number(base[key]);
    const finalProbability = Number(probabilities[key]);
    const recomputedProbability = Number(recomputed[key]);
    const feature = stat?.featureContributions ?? {};
    const namedFeatureSum = Number(feature.commonOpponentsPp || 0) + Number(feature.headToHeadPp || 0) + Number(feature.rosterPp || 0);
    const liveSeriesMarginal = completed.map((match) => {
      const without = Number(withoutMatch.get(Number(match.id))?.[key]);
      return {
        matchId: Number(match.id),
        match: `${teamNames[match.team_a] ?? match.team_a} — ${teamNames[match.team_b] ?? match.team_b}`,
        winner: match.winner,
        score: Number.isFinite(Number(match.score_a)) && Number.isFinite(Number(match.score_b)) ? `${match.score_a}:${match.score_b}` : null,
        evidenceWeight: round(seriesEvidenceWeight(match, stats?.methodology?.seriesInformation), 4),
        marginalPpForTeamA: round(recomputedProbability - without, 5),
      };
    }).sort((left, right) => Math.abs(right.marginalPpForTeamA || 0) - Math.abs(left.marginalPpForTeamA || 0));
    return {
      key,
      teamA: { id: teamA, name: teamNames[teamA] ?? teamA },
      teamB: { id: teamB, name: teamNames[teamB] ?? teamB },
      probabilities: {
        statisticalA: round(statProbability),
        personalA: round(personalProbability),
        blendedBeforeLiveA: round(baseProbability),
        savedFinalA: round(finalProbability),
        recomputedFinalA: round(recomputedProbability),
        liveLayerDeltaPp: round(finalProbability - baseProbability),
        traceResidualPp: round(finalProbability - recomputedProbability),
      },
      statisticalFeatures: stat ? {
        commonOpponentsPp: round(feature.commonOpponentsPp ?? 0),
        headToHeadPp: round(feature.headToHeadPp ?? 0),
        rosterPp: round(feature.rosterPp ?? 0),
        unlabelledResidualPp: round(statProbability - 50 - namedFeatureSum),
        directEffectiveGames: round(stat.directEffectiveGames),
        modelEffectiveGames: round(stat.modelEffectiveGames),
        rosterReliability: round(stat.rosterReliability),
        uncertaintyLogitSd: round(stat.uncertainty),
        source: stat.source,
        confidence: stat.confidence,
      } : null,
      liveSeriesMarginal,
    };
  });

  return {
    schema: "ti2026.forecast-calculation-trace",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    exactAtSave,
    provenanceNote: exactAtSave
      ? "Расчёт и признаки заморожены в момент сохранения прогона."
      : "Старый прогон: итоговые вероятности точны, но детализация признаков реконструирована по доступной версии модели.",
    snapshot: { id: snapshotId, createdAt, trigger, kind, rootId, parentId, mode, opinionWeight, iterations: result?.iterations ?? config.iterations, seed: result?.seed ?? null },
    model: {
      generatedAt: stats?.generatedAt ?? null,
      periodStart: stats?.periodStart ?? null,
      acceptedHistoricalGames: stats?.totals?.uniqueAcceptedGames ?? null,
      methodology: stats?.methodology ?? null,
      tournamentCalibration: stats?.tournamentCalibration ?? null,
    },
    inputs: {
      personalAnswers: answers,
      matches: matches.map(compactMatch),
      completedSeries: completed.length,
    },
    coefficientGuide: {
      statisticalFeatures: "Вклады в процентных пунктах для первой команды канонического ключа.",
      blendedBeforeLive: "STATIC-основа после смешивания статистики и личного мнения, до текущего TI.",
      liveLayerDelta: "Совместное online Bradley–Terry обновление по завершённым сериям TI; это не повторное обучение baseline.",
      liveSeriesMarginal: "Условный вклад серии: насколько изменилась бы вероятность без неё. Эти вклады коррелируют и не обязаны суммироваться в liveLayerDelta.",
      traceResidual: "savedFinal минус повторно рассчитанный final; около нуля означает полностью воспроизводимый trace.",
    },
    pairs,
    simulation: {
      iterations: result?.iterations ?? null,
      requestedIterations: result?.requestedIterations ?? null,
      seed: result?.seed ?? null,
      convergence: result?.convergence ?? null,
      uniqueBrackets: result?.uniqueBrackets ?? null,
      duplicateRate: result?.duplicateRate ?? null,
    },
  };
}

export function scoreDiagnosticMatch(match, probabilityA) {
  if (!match?.winner || !isFiniteValue(probabilityA)) return null;
  const probability = Math.min(.999, Math.max(.001, Number(probabilityA) / 100));
  const outcome = match.winner === match.team_a ? 1 : 0;
  const predicted = probability >= .5 ? match.team_a : match.team_b;
  return {
    probabilityA: round(100 * probability),
    predicted,
    winner: match.winner,
    correct: predicted === match.winner,
    brier: round((probability - outcome) ** 2),
    logLoss: round(-(outcome * Math.log(probability) + (1 - outcome) * Math.log(1 - probability))),
  };
}

export { probabilityFor };
