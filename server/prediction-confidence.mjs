const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, Number(value) || 0));

/**
 * Evidence confidence is deliberately separate from win probability.
 * It measures whether the probability is supported by enough current-roster,
 * common-opponent and direct-match evidence, then discounts fragile 50/50 calls.
 */
export function assessPredictionConfidence(pair, probability) {
  if (!pair) return { score: 10, evidenceScore: 10, stabilityScore: 7, level: "low", roulette: true, reasons: ["нет статистического профиля пары"] };

  const effectiveGames = Math.max(0, Number(pair.modelEffectiveGames) || 0);
  const directGames = Math.max(0, Number(pair.directEffectiveGames) || 0);
  const rosterReliability = clamp(pair.rosterReliability ?? 1);
  const sample = 1 - Math.exp(-effectiveGames / 6);
  const direct = 1 - Math.exp(-directGames / 1.5);
  const evidenceScore = 100 * (.60 * sample + .10 * direct + .30 * rosterReliability);
  const margin = Math.abs((Number(probability) || 50) - 50);
  const decisiveness = clamp(margin / 15);
  const stabilityScore = evidenceScore * (.65 + .35 * decisiveness);
  const score = Math.round(stabilityScore);
  // Roulette is intentionally a stricter warning than the generic "low" band:
  // scarce/uncertain roster evidence, or a near coin-flip without a solid base.
  const roulette = evidenceScore < 43 || (margin < 4 && evidenceScore < 62);
  const level = roulette || score < 55 ? "low" : score < 75 ? "medium" : "high";
  const reasons = [];
  if (effectiveGames < 4) reasons.push(`только ${effectiveGames.toFixed(1)} эффективных серий`);
  if (rosterReliability < .8) reasons.push("состав подтверждён не полностью");
  if (directGames < .5) reasons.push("почти нет очных встреч");
  if (margin < 5) reasons.push("прогноз близок к 50/50");
  if (!reasons.length) reasons.push("достаточная историческая опора");
  return { score, evidenceScore: Math.round(evidenceScore), stabilityScore: Math.round(stabilityScore), level, roulette, reasons };
}
