// The geometry of a bracket: where each match sits, and how the lines between
// them run.
//
// A bracket is not a list of rounds — it is a picture, and the picture is what
// makes it readable. A match sits level with the two matches that feed it, and
// a line runs from each of them into it; that is the whole convention, and
// without it the same data reads as three unrelated columns of boxes.
//
// The wiring is already known: `buildTopology` records, for every match, which
// slots its two entrants come from. Turning that into coordinates is pure
// arithmetic, so it happens here — once, server-side, where it can be tested —
// and the page renders numbers without knowing anything about brackets.

export const BRACKET_LAYOUT = Object.freeze({
  boxWidth: 214,
  boxHeight: 64,
  columnGap: 48,
  rowGap: 16,
  laneGap: 56,
  headerHeight: 22,
  padding: 10,
});

// Same picture, smaller: on a phone the geometry has to give way, and shrinking
// it is honest in a way that scaling the whole thing down is not — text stays at
// its own size instead of turning to mush.
export const BRACKET_LAYOUT_COMPACT = Object.freeze({
  ...BRACKET_LAYOUT,
  boxWidth: 158,
  boxHeight: 58,
  columnGap: 28,
  rowGap: 10,
  laneGap: 36,
});

const LANES = ["upper", "lower"];
const KNOWN_LANES = new Set([...LANES, "final"]);

/**
 * Place every match of a bracket and work out the lines between them.
 *
 * Returns null when the wiring cannot be used — an empty bracket, a node with
 * no recorded sources, a lane we do not know. The caller falls back to a plain
 * column list: a bracket drawn from a structure we misread would be worse than
 * one not drawn at all, which is the same judgement `buildTopology` makes.
 *
 * @param nodes [{ slot, lane, column, section, sources: [{ from, slot }] }]
 */
export function layoutBracket(nodes, options = {}) {
  if (!Array.isArray(nodes) || !nodes.length) return null;
  if (nodes.some((node) => !node || !Array.isArray(node.sources) || !KNOWN_LANES.has(node.lane))) return null;
  if (nodes.some((node) => !Number.isFinite(Number(node.column)))) return null;

  const layout = { ...BRACKET_LAYOUT, ...options };
  const pitch = layout.boxHeight + layout.rowGap;
  const byId = new Map(nodes.map((node) => [node.slot, node]));
  // Stable sort, so matches drawn in the same column keep the order the
  // organiser listed them in.
  const ordered = [...nodes].sort((a, b) => Number(a.column) - Number(b.column));
  const columnX = (column) => layout.padding + Number(column) * (layout.boxWidth + layout.columnGap);

  // --- vertical placement, one lane at a time -------------------------------
  //
  // One pass suffices: a winner always comes from a strictly earlier column, so
  // by the time a match is placed both of its feeders already have a height.
  const laneCentre = new Map();
  const laneHeight = new Map();
  for (const lane of LANES) {
    let stacked = 0;
    let bottom = 0;
    for (const node of ordered) {
      if (node.lane !== lane) continue;
      const feeders = node.sources
        .filter((source) => source.from === "winner"
          && byId.get(source.slot)?.lane === lane
          && laneCentre.has(source.slot))
        .map((source) => laneCentre.get(source.slot));

      let centre;
      if (feeders.length >= 2) {
        centre = (Math.min(...feeders) + Math.max(...feeders)) / 2;
      } else if (feeders.length === 1) {
        // A lower-bracket round that takes a loser from above: its only
        // same-lane feeder decides its height, which is how a real lower
        // bracket is drawn — it runs level with the survivor it continues.
        centre = feeders[0];
      } else {
        // Where entrants come in from outside: the first round of either lane.
        centre = layout.boxHeight / 2 + (stacked++) * pitch;
      }
      laneCentre.set(node.slot, centre);
      bottom = Math.max(bottom, centre + layout.boxHeight / 2);
    }
    laneHeight.set(lane, bottom);
  }

  const hasLower = nodes.some((node) => node.lane === "lower");
  const upperTop = layout.padding + layout.headerHeight;
  const upperHeight = laneHeight.get("upper") || 0;
  const lowerTop = hasLower ? upperTop + upperHeight + layout.laneGap + layout.headerHeight : upperTop;
  const lowerHeight = laneHeight.get("lower") || 0;

  const centres = new Map();
  for (const node of ordered) {
    if (node.lane === "final") continue;
    centres.set(node.slot, laneCentre.get(node.slot) + (node.lane === "lower" ? lowerTop : upperTop));
  }

  // The grand final belongs to neither lane. Both its entrants come from the
  // other side of the picture, so it sits between the two finals it takes —
  // which is exactly where the eye expects the two paths to meet.
  ordered.filter((node) => node.lane === "final").forEach((node, index) => {
    const feeders = node.sources.map((source) => centres.get(source.slot)).filter(Number.isFinite);
    const middle = feeders.length
      ? (Math.min(...feeders) + Math.max(...feeders)) / 2
      : (upperTop + lowerTop + lowerHeight) / 2;
    // A bracket reset is a second final, stacked under the first.
    centres.set(node.slot, middle + index * pitch);
  });

  const boxes = ordered.map((node) => ({
    slot: node.slot,
    lane: node.lane,
    column: Number(node.column),
    x: columnX(node.column),
    y: centres.get(node.slot) - layout.boxHeight / 2,
    w: layout.boxWidth,
    h: layout.boxHeight,
  }));
  const boxBySlot = new Map(boxes.map((box) => [box.slot, box]));

  // --- the lines ------------------------------------------------------------
  //
  // Only the path a winner takes is drawn. Loser drops and seedings would add a
  // line to almost every match and turn a bracket into a mesh; no published
  // bracket draws them either.
  const edges = [];
  for (const node of ordered) {
    const target = boxBySlot.get(node.slot);
    if (!target) continue;
    for (const source of node.sources) {
      if (source.from !== "winner") continue;
      const from = boxBySlot.get(source.slot);
      if (!from) continue;
      const startY = from.y + from.h / 2;
      const endY = target.y + target.h / 2;
      // Anchored to the target, not the source: the upper final reaches the
      // grand final across a skipped column, and that line should run long and
      // straight at its own height, turning only just before it arrives. Two
      // lines into one match share this x and each draws half the vertical,
      // meeting at the target — the join draws itself.
      const midX = target.x - layout.columnGap / 2;
      edges.push({
        from: source.slot,
        to: node.slot,
        points: [[from.x + from.w, startY], [midX, startY], [midX, endY], [target.x, endY]],
      });
    }
  }

  // A round name belongs over the topmost match of its column.
  const topOfColumn = new Map();
  for (const box of boxes) {
    const key = `${box.lane}:${box.column}`;
    const current = topOfColumn.get(key);
    if (!current || box.y < current.y) topOfColumn.set(key, box);
  }
  const headers = [...topOfColumn.values()].map((box) => ({
    lane: box.lane,
    column: box.column,
    label: byId.get(box.slot)?.section ?? null,
    x: box.x,
    y: box.y - layout.headerHeight,
    w: box.w,
  }));

  const lanes = [{ lane: "upper", y: upperTop, height: upperHeight }];
  if (hasLower) lanes.push({ lane: "lower", y: lowerTop, height: lowerHeight });

  return {
    width: Math.max(...boxes.map((box) => box.x + box.w)) + layout.padding,
    height: Math.max(...boxes.map((box) => box.y + box.h)) + layout.padding,
    columns: Math.max(...boxes.map((box) => box.column)) + 1,
    boxes,
    edges,
    headers,
    lanes,
    dividers: hasLower ? [upperTop + upperHeight + layout.laneGap / 2] : [],
    metrics: { ...layout },
  };
}
