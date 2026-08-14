export function selectProductionVariant(staticScore, adaptiveScore, minimumMatches = 8) {
  const enough = Number(staticScore?.count) >= minimumMatches && Number(adaptiveScore?.count) === Number(staticScore?.count);
  const adaptiveWins = enough
    && Number(adaptiveScore.correct) >= Number(staticScore.correct)
    && Number(adaptiveScore.brier) < Number(staticScore.brier)
    && Number(adaptiveScore.logLoss) < Number(staticScore.logLoss);
  return {
    selected: adaptiveWins ? "adaptive" : "static",
    reason: adaptiveWins ? "adaptive_improves_accuracy_and_proper_scores" : enough ? "adaptive_failed_production_gate" : "insufficient_temporal_evidence",
  };
}
