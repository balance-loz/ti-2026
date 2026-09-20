"use client";

// The playoff bracket, drawn as a bracket: matches placed where the geometry
// puts them and lines running from each match into the one it feeds.
//
// The positions come from the server (`server/core/bracket-layout.mjs`), so this
// file only paints them. When that layout is unavailable — an unusual bracket
// shape the topology could not read — it falls back to plain columns rather than
// drawing something misleading.
import type { BracketBox, BracketEdge, BracketLayout, Projection, ProjectedSlot } from "../lib/api";
import { formatDateTime } from "../lib/api";
import { useMediaQuery } from "../lib/hooks";
import { Team } from "./shell";

const LANE_LABELS: Record<string, string> = {
  upper: "Верхняя сетка",
  lower: "Нижняя сетка",
  final: "Гранд-финал",
};

// Liquipedia labels its rounds in English. Translating the shapes it actually
// uses keeps the picture readable; anything unrecognised is shown as written
// rather than mangled by a guess.
const ROUND_LABELS: [RegExp, string][] = [
  [/grand\s*final/i, "Гранд-финал"],
  [/upper\s*bracket\s*semi-?finals?/i, "1/2 верхней сетки"],
  [/lower\s*bracket\s*semi-?finals?/i, "1/2 нижней сетки"],
  [/upper\s*bracket\s*quarter-?finals?/i, "1/4 верхней сетки"],
  [/lower\s*bracket\s*quarter-?finals?/i, "1/4 нижней сетки"],
  [/upper\s*bracket\s*final/i, "Финал верхней сетки"],
  [/lower\s*bracket\s*final/i, "Финал нижней сетки"],
  [/upper\s*bracket\s*round\s*(\d+)/i, "Верхняя сетка, раунд $1"],
  [/lower\s*bracket\s*round\s*(\d+)/i, "Нижняя сетка, раунд $1"],
  [/^\s*semi-?finals?\s*$/i, "Полуфинал"],
  [/^\s*quarter-?finals?\s*$/i, "Четвертьфинал"],
  [/^\s*finals?\s*$/i, "Финал"],
];

const roundLabel = (raw: string | null | undefined) => {
  if (!raw) return null;
  for (const [pattern, russian] of ROUND_LABELS) if (pattern.test(raw)) return raw.replace(pattern, russian);
  return raw;
};

/** An elbow: out of the source, across the gutter, into the target. */
const pathOf = (points: [number, number][]) =>
  points.map(([x, y], index) => `${index ? "L" : "M"} ${x} ${y}`).join(" ");

function Side({ team, probability, won }: {
  team: ProjectedSlot["teamA"];
  probability: number | null;
  won: boolean;
}) {
  return (
    <div className={won ? "dp-bracket-side dp-bracket-won" : "dp-bracket-side"}>
      {team
        ? <Team team={team} compact link={false} />
        : <span className="dp-muted dp-small">—</span>}
      {probability === null ? null : <span className="dp-bracket-odds">{(probability * 100).toFixed(0)}%</span>}
    </div>
  );
}

function MatchBox({ slot, box }: { slot: ProjectedSlot; box?: BracketBox }) {
  const aWins = Boolean(slot.winner && slot.teamA && slot.winner.id === slot.teamA.id);
  const bWins = Boolean(slot.winner && slot.teamB && slot.winner.id === slot.teamB.id);
  const body = (
    <>
      <Side team={slot.teamA} probability={slot.probabilityA} won={aWins} />
      <Side team={slot.teamB} probability={slot.probabilityA === null ? null : 1 - slot.probabilityA} won={bWins} />
      <div className="dp-bracket-meta">
        {slot.decided ? "сыграно" : slot.known ? "пара известна" : "прогноз"}
        {slot.bestOf ? ` · Bo${slot.bestOf}` : null}
        {slot.startTime ? ` · ${formatDateTime(slot.startTime)}` : null}
      </div>
    </>
  );

  const className = `dp-bracket-match${slot.decided ? " dp-bracket-played" : ""}`;
  const style = box
    ? { position: "absolute" as const, left: box.x, top: box.y, width: box.w, height: box.h }
    : undefined;

  // A played match opens its own explanation. The teams inside stop being links
  // so the box does not end up with an anchor inside an anchor.
  return slot.seriesKey
    ? <a className={className} style={style} href={`/match/${encodeURIComponent(slot.seriesKey)}`}>{body}</a>
    : <div className={className} style={style}>{body}</div>;
}

/** Columns without wires: the shape we fall back to when geometry is unavailable. */
function PlainBracket({ projection }: { projection: Projection }) {
  const columns = Math.max(1, projection.columns);
  return (
    <div className="dp-bracket-flow">
      {(["upper", "lower", "final"] as const).map((lane) => {
        const rows = projection.bracket.filter((slot) => slot.lane === lane);
        if (!rows.length) return null;
        return (
          <div key={lane} className={`dp-bracket-band dp-bracket-${lane}`}>
            <h3>{LANE_LABELS[lane]}</h3>
            <div className="dp-bracket-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(190px, 1fr))` }}>
              {Array.from({ length: columns }, (_, column) => {
                const inColumn = rows.filter((slot) => slot.column === column);
                return (
                  <div key={column} className="dp-bracket-column">
                    {inColumn.length ? <span className="dp-bracket-round-name">{roundLabel(inColumn[0].section)}</span> : null}
                    {inColumn.map((slot) => <MatchBox key={slot.slot} slot={slot} />)}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Wires({ layout }: { layout: BracketLayout }) {
  return (
    <svg
      className="dp-bracket-wires"
      width={layout.width}
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      aria-hidden="true"
    >
      {layout.dividers.map((y) => (
        <line key={`divider-${y}`} className="dp-bracket-divider" x1={0} x2={layout.width} y1={y} y2={y} />
      ))}
      {layout.edges.map((edge: BracketEdge) => (
        <path key={`${edge.from}>${edge.to}`} d={pathOf(edge.points)} />
      ))}
    </svg>
  );
}

export function ProjectedBracket({ projection }: { projection: Projection }) {
  // Two layouts rather than a scaled-down one: shrinking the geometry keeps the
  // text at its own size, where scaling would blur it.
  const narrow = useMediaQuery("(max-width: 720px)");
  const layout = (narrow ? projection.layoutCompact : projection.layout) ?? projection.layout ?? null;
  if (!layout) return <PlainBracket projection={projection} />;

  const bySlot = new Map(projection.bracket.map((slot) => [slot.slot, slot]));
  const twoLanes = layout.lanes.length > 1;

  return (
    <div
      className="dp-bracket-scroll"
      role="region"
      // A scrollable region has to be focusable or it cannot be scrolled from
      // the keyboard at all (WCAG 2.1.1). The rule does not know about that
      // exception, which jsx-a11y documents for exactly this case.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      aria-label="Сетка плей-офф, прокручивается по горизонтали"
    >
      <div className="dp-bracket-canvas" style={{ width: layout.width, height: layout.height }}>
        <Wires layout={layout} />

        {layout.headers.map((header) => (
          <span
            key={`${header.lane}-${header.column}`}
            className={`dp-bracket-head dp-bracket-${header.lane}`}
            style={{ left: header.x, top: header.y, width: header.w }}
          >
            {roundLabel(header.label)}
          </span>
        ))}

        {layout.boxes.map((box) => {
          const slot = bySlot.get(box.slot);
          return slot ? <MatchBox key={box.slot} slot={slot} box={box} /> : null;
        })}
      </div>

      <p className="dp-caveat">
        Линиями показан путь победителя{twoLanes ? "; верхняя и нижняя сетки сходятся в гранд-финале" : ""}.
        Проценты — вероятность выиграть матч. Пары, помеченные как «прогноз», ещё не определены:
        это ожидаемое развитие турнира, а не расписание, и отдельно оно не оценивается.
      </p>
    </div>
  );
}
