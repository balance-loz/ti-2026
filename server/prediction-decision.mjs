import { assessPredictionConfidence } from "./prediction-confidence.mjs";

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value)));

export function sharpenProbability(probability, temperature = 1) {
  const p = clamp(Number(probability) / 100, .001, .999);
  const safeTemperature = clamp(temperature, .55, 1.5);
  return 100 / (1 + Math.exp(-Math.log(p / (1 - p)) / safeTemperature));
}

export function predictionDecision(pair, probability, { temperature = 1, minMarginPp = 5 } = {}) {
  const calibratedProbability = sharpenProbability(probability, temperature);
  const confidence = assessPredictionConfidence(pair, calibratedProbability);
  const margin = Math.abs(calibratedProbability - 50);
  const disagreementPp = Math.abs(Number(pair?.featureContributions?.commonOpponentsPp || 0) - Number(pair?.featureContributions?.headToHeadPp || 0));
  const intervalHalfWidth = clamp(17 - confidence.evidenceScore * .11 + disagreementPp * .22, 4, 20);
  const favoriteProbability = Math.max(calibratedProbability, 100 - calibratedProbability);
  const lowerFavorite = clamp(favoriteProbability - intervalHalfWidth, 50, 99);
  let status; let label;
  if (confidence.roulette) { status = "roulette"; label = "РУЛЕТКА · PASS"; }
  else if (margin < minMarginPp) { status = "even"; label = "РАВНЫЙ МАТЧ · PASS"; }
  else if (lowerFavorite <= 50 || confidence.score < 55) { status = "pass"; label = "НЕТ НАДЁЖНОГО ПЕРЕВЕСА"; }
  else { status = "pick"; label = "ПРОГНОЗ ДОПУСТИМ"; }
  return { probability: calibratedProbability, confidence, interval: { low: clamp(calibratedProbability - intervalHalfWidth, 1, 99), high: clamp(calibratedProbability + intervalHalfWidth, 1, 99) }, favoriteLowerBound: lowerFavorite, status, label };
}
