// The shape of a double-elimination bracket, worked out from the rounds the
// organiser published.
//
// Liquipedia gives the slots and what each round is called, but not what feeds
// what. That structure is fixed once the round sizes are known, so it is derived
// rather than hardcoded per bracket type: an upper round halves into the next,
// its losers drop into the lower bracket, and the lower bracket alternates
// between taking those drops and playing itself down.

/**
 * Order a parsed bracket's sections into lanes, and work out where each match's
 * two entrants come from.
 *
 * Returns null when the rounds do not fit a double-elimination shape; a
 * projection built on a misread structure would be worse than none.
 */
export function buildTopology(bracket) {
  if (!bracket?.sections?.length) return null;

  const upper = bracket.sections.filter((section) => section.lane === "upper");
  const lower = bracket.sections.filter((section) => section.lane === "lower");
  const grand = bracket.sections.find((section) => section.lane === "final");
  if (!upper.length) return null;

  // Upper rounds must halve: 4, 2, 1. Anything else is not the shape we know.
  for (let index = 1; index < upper.length; index += 1) {
    if (upper[index].matches.length !== Math.ceil(upper[index - 1].matches.length / 2)) return null;
  }

  const nodes = new Map();
  const add = (slot, node) => nodes.set(slot, { slot, ...node });

  upper.forEach((section, round) => {
    section.matches.forEach((match, index) => {
      add(match.slot, {
        lane: "upper",
        round,
        column: round,
        section: section.name,
        bestOf: match.bestOf,
        startTime: match.startTime,
        // The first upper round is where qualifiers enter; later rounds take
        // the winners of the two matches beneath them.
        sources: round === 0
          ? [{ from: "seed" }, { from: "seed" }]
          : [
            { from: "winner", slot: upper[round - 1].matches[index * 2]?.slot },
            { from: "winner", slot: upper[round - 1].matches[index * 2 + 1]?.slot },
          ],
      });
    });
  });

  lower.forEach((section, round) => {
    // Lower rounds alternate: an even round plays the survivors against each
    // other, an odd round takes an upper round's losers on top of them.
    const isDropRound = round % 2 === 1;
    const previous = round === 0 ? null : lower[round - 1];
    const upperFeed = round === 0 ? upper[0] : upper[Math.floor((round + 1) / 2)];

    section.matches.forEach((match, index) => {
      let sources;
      if (round === 0) {
        // Losers of the first upper round, paired in the order they were drawn.
        sources = [
          { from: "loser", slot: upperFeed?.matches[index * 2]?.slot },
          { from: "loser", slot: upperFeed?.matches[index * 2 + 1]?.slot },
        ];
      } else if (isDropRound) {
        sources = [
          { from: "winner", slot: previous?.matches[index]?.slot },
          { from: "loser", slot: upperFeed?.matches[index]?.slot },
        ];
      } else {
        sources = [
          { from: "winner", slot: previous?.matches[index * 2]?.slot },
          { from: "winner", slot: previous?.matches[index * 2 + 1]?.slot },
        ];
      }
      add(match.slot, {
        lane: "lower",
        round,
        column: round,
        section: section.name,
        bestOf: match.bestOf,
        startTime: match.startTime,
        sources,
      });
    });
  });

  const lastUpper = upper.at(-1)?.matches[0]?.slot;
  const lastLower = lower.at(-1)?.matches[0]?.slot;
  if (grand?.matches?.length) {
    const match = grand.matches[0];
    add(match.slot, {
      lane: "final",
      round: Math.max(upper.length, lower.length),
      column: Math.max(upper.length, lower.length),
      section: grand.name,
      bestOf: match.bestOf,
      startTime: match.startTime,
      sources: [{ from: "winner", slot: lastUpper }, { from: "winner", slot: lastLower }],
    });
  }

  // Every non-seed source must point at a slot that exists.
  for (const node of nodes.values()) {
    for (const source of node.sources) {
      if (source.from !== "seed" && (!source.slot || !nodes.has(source.slot))) return null;
    }
  }

  const order = [...nodes.values()].sort((a, b) => a.column - b.column
    || (a.lane === b.lane ? 0 : a.lane === "upper" ? -1 : 1));

  return {
    type: bracket.type ?? null,
    seeds: upper[0].matches.length * 2,
    columns: Math.max(upper.length, lower.length) + (grand ? 1 : 0),
    nodes: order,
    bySlot: nodes,
  };
}

/**
 * Play one bracket through, given a seeding and a way to decide a series.
 * Returns which team ended up in each slot and who won there.
 */
export function playBracket(topology, seeds, decide) {
  const winners = new Map();
  const losers = new Map();
  const entrants = new Map();
  let seedIndex = 0;

  for (const node of topology.nodes) {
    const sides = node.sources.map((source) => {
      if (source.from === "seed") return seeds[seedIndex++] ?? null;
      return source.from === "winner" ? winners.get(source.slot) ?? null : losers.get(source.slot) ?? null;
    });
    entrants.set(node.slot, sides);
    const [a, b] = sides;
    if (!a || !b) continue;
    const winner = decide(a, b, node.bestOf ?? 3, node);
    winners.set(node.slot, winner);
    losers.set(node.slot, winner === a ? b : a);
  }

  return { entrants, winners, losers, champion: winners.get(topology.nodes.at(-1)?.slot) ?? null };
}
