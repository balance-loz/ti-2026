// Turn the organiser's own words about the format into the numbers the
// simulation needs.
//
// Inferring structure from results is a fallback that exists because the
// results feed carries nothing else. When the organiser has published the
// format, guessing from loss counts is strictly worse — and, worse than worse,
// it looks equally confident.

const text = (format) => [
  ...(format?.stages ?? []).flatMap((stage) => [stage.name, ...(stage.rules ?? [])]),
  format?.bracketType ?? "",
].join(" ").toLowerCase();

/**
 * Losses a team may take before it is out, read from the declared format.
 *
 * A bracket type carrying a lower bracket is double elimination whatever the
 * prose says; Liquipedia encodes that in ids like `8U4L2DSL1D`, where the `L`
 * sections are the lower bracket.
 */
export function declaredEliminationThreshold(format) {
  if (!format) return null;
  const body = text(format);
  if (/double[-\s]?elimination/.test(body)) return 2;
  if (/single[-\s]?elimination/.test(body)) return 1;
  const bracketType = String(format.bracketType || "");
  if (/\d+L/i.test(bracketType)) return 2;
  if (/^\d+SE/i.test(bracketType) || /^\d+U$/i.test(bracketType)) return 1;
  return null;
}

/** How many teams leave the group stage for the playoffs, if it was stated. */
export function declaredPlayoffSlots(format) {
  if (!format) return null;
  const words = {
    two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    ten: 10, twelve: 12, sixteen: 16,
  };
  for (const stage of format.stages ?? []) {
    for (const rule of stage.rules ?? []) {
      const lower = String(rule).toLowerCase();
      if (!/advance/.test(lower)) continue;
      const digits = /\btop\s+(\d{1,2})\b/.exec(lower) ?? /\b(\d{1,2})\s+teams?\s+advance/.exec(lower);
      if (digits) return Number(digits[1]);
      const named = /\btop\s+([a-z]+)\b/.exec(lower);
      if (named && words[named[1]]) return words[named[1]];
    }
  }
  // The bracket size is the slot count when the prose did not say.
  const bracketType = /^(\d+)U/i.exec(String(format.bracketType || ""));
  return bracketType ? Number(bracketType[1]) : null;
}

/** A short human label for the shape of the event. */
export function declaredShape(format) {
  if (!format) return null;
  const body = text(format);
  const parts = [];
  if (/swiss/.test(body)) parts.push("швейцарка");
  else if (/round[-\s]?robin/.test(body)) parts.push("круговой");
  else if (/group/.test(body)) parts.push("группы");
  if (/double[-\s]?elimination/.test(body)) parts.push("double elimination");
  else if (/single[-\s]?elimination/.test(body)) parts.push("single elimination");
  return parts.length ? parts.join(" + ") : null;
}

/**
 * Everything the simulation should take from a declared format, with the
 * inferred values kept as a fallback for whatever was not stated.
 */
export function resolveFormat(declared, inferred) {
  const threshold = declaredEliminationThreshold(declared);
  const slots = declaredPlayoffSlots(declared);
  const shape = declaredShape(declared);
  const hasDeclared = threshold != null || slots != null;

  return {
    ...inferred,
    // What the simulation actually uses, and where each number came from.
    eliminationThreshold: threshold ?? inferred.eliminationThreshold,
    playoffSlots: slots,
    shape,
    declared: hasDeclared,
    source: hasDeclared ? "organiser" : "inferred",
    bracketType: declared?.bracketType ?? null,
    stages: (declared?.stages ?? []).map((stage) => ({ name: stage.name, bestOf: stage.bestOf, rules: stage.rules })),
    // A declared format is known, not guessed, so it is not hedged.
    confidence: hasDeclared ? "declared" : inferred.confidence,
  };
}
