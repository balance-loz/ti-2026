// The main-event bracket is official tournament structure, not a model output.
// Keep it separate from probabilities so a noisy schedule page cannot rewrite
// the double-elimination topology.
export const TI_2026_PLAYOFF_OPENING_PAIRS = Object.freeze([
  Object.freeze(["1w", "spirit"]),
  Object.freeze(["parivision", "betboom"]),
  Object.freeze(["liquid", "yandex"]),
  Object.freeze(["nigma", "falcons"]),
]);

const canonicalPair = (a, b) => [a, b].sort().join("|");
const OFFICIAL_OPENING_KEYS = new Set(TI_2026_PLAYOFF_OPENING_PAIRS.map(([a, b]) => canonicalPair(a, b)));
const OFFICIAL_OPENING_TEAMS = new Set(TI_2026_PLAYOFF_OPENING_PAIRS.flat());

export function isTi2026OpeningPair(a, b) {
  return OFFICIAL_OPENING_KEYS.has(canonicalPair(a, b));
}

export function hasTi2026OfficialPlayoffEvidence(matches = []) {
  return matches.some((match) => match?.stage === "playoff"
    && OFFICIAL_OPENING_TEAMS.has(match.team_a)
    && OFFICIAL_OPENING_TEAMS.has(match.team_b));
}

export function playoffOpeningPairs(matches = [], fallbackPairs = []) {
  return hasTi2026OfficialPlayoffEvidence(matches)
    ? TI_2026_PLAYOFF_OPENING_PAIRS.map((pair) => [...pair])
    : fallbackPairs.map((pair) => [...pair]);
}
