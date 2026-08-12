const finite = (value) => Number.isFinite(Number(value));

export function pearsonCorrelation(left, right) {
  const pairs = left.map((value, index) => [Number(value), Number(right[index])]).filter(([a, b]) => finite(a) && finite(b));
  if (pairs.length < 3) return null;
  const meanA = pairs.reduce((sum, [a]) => sum + a, 0) / pairs.length;
  const meanB = pairs.reduce((sum, [, b]) => sum + b, 0) / pairs.length;
  let covariance = 0; let varianceA = 0; let varianceB = 0;
  for (const [a, b] of pairs) { covariance += (a - meanA) * (b - meanB); varianceA += (a - meanA) ** 2; varianceB += (b - meanB) ** 2; }
  return varianceA > 0 && varianceB > 0 ? covariance / Math.sqrt(varianceA * varianceB) : null;
}

export function externalFeatureDecision({ correlations = [], logLossDelta = null, brierDelta = null, bootstrapUpper95 = null, temporalSafe = false, deduplicated = false, coverage = 0 } = {}) {
  const values = correlations.filter(finite).map((value) => Math.abs(Number(value)));
  const maxAbsCorrelation = values.length ? Math.max(...values) : null;
  const reasons = [];
  if (!temporalSafe) reasons.push("нет as-of snapshot: возможна утечка будущего");
  if (!deduplicated) reasons.push("карты не дедуплицированы по match_id");
  if (Number(coverage) < .8) reasons.push("покрытие ниже 80%");
  if (maxAbsCorrelation !== null && maxAbsCorrelation >= .98) reasons.push("признак почти дублирует существующий");
  if (!finite(logLossDelta) || Number(logLossDelta) >= 0) reasons.push("нет улучшения OOF log loss");
  if (!finite(brierDelta) || Number(brierDelta) >= 0) reasons.push("нет улучшения OOF Brier");
  if (!finite(bootstrapUpper95) || Number(bootstrapUpper95) >= 0) reasons.push("series-bootstrap не подтвердил добавочную ценность");
  return { activate: reasons.length === 0, status: reasons.length ? "shadow" : "candidate", maxAbsCorrelation, reasons };
}
