"use client";

// The group stage: who played whom, in what order, and how it went.
//
// Colour is reserved for facts. A played cell is tinted by its result; a match
// still to come shows the model's number in plain grey, so an expectation can
// never be mistaken for something that happened.
import type { GroupCell, GroupStage } from "../lib/api";
import { formatDateTime } from "../lib/api";
import { Team } from "./shell";

const RESULT_CLASS: Record<string, string> = {
  win: "dp-group-win",
  loss: "dp-group-loss",
  draw: "dp-group-draw",
};

function Cell({ cell }: { cell: GroupCell | null }) {
  if (!cell) return <td className="dp-group-empty"><span className="dp-muted">—</span></td>;

  const played = cell.status === "finished";
  const body = (
    <>
      {/* Not a link of its own: the whole cell already is one. */}
      <Team team={cell.opponent} compact link={false} />
      {played
        ? <b className="dp-group-score">{cell.scoreFor}:{cell.scoreAgainst}</b>
        : (
          <span className="dp-group-odds" title={cell.probabilitySource === "frozen"
            ? "Прогноз зафиксирован до начала матча"
            : "Текущая оценка модели"}>
            {cell.probability === null ? "—" : `${(cell.probability * 100).toFixed(0)}%`}
          </span>
        )}
    </>
  );

  const className = [
    played ? RESULT_CLASS[cell.result ?? ""] ?? "" : "dp-group-upcoming",
    cell.status === "live" ? "dp-group-live" : "",
  ].filter(Boolean).join(" ");

  const title = played
    ? `${cell.opponent.name} · ${cell.scoreFor}:${cell.scoreAgainst}${cell.bestOf ? ` · Bo${cell.bestOf}` : ""}`
    : `${cell.opponent.name} · ${formatDateTime(cell.startTime)}`;

  return (
    <td className={className}>
      {cell.href
        ? <a className="dp-group-cell" href={cell.href} title={`${title} — открыть разбор`}>{body}</a>
        : <span className="dp-group-cell" title={title}>{body}</span>}
    </td>
  );
}

export function GroupStageTable({ stage }: { stage: GroupStage }) {
  const forecast = stage.rows.some((row) => row.qualifyChance !== null);

  return (
    <>
      <div className="dp-table-wrap">
        <table className="dp-table dp-group-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Команда</th>
              <th title="Сыграно серий">М</th>
              <th title="Победы">В</th>
              <th title="Поражения">П</th>
              <th title="Выигранные и проигранные карты">Карты</th>
              {stage.rounds.map((round) => (
                <th key={round.label} title={round.startTime ? formatDateTime(round.startTime) : undefined}>
                  {round.label}
                </th>
              ))}
              {forecast ? <th className="dp-group-forecast" title="Ожидаемое итоговое место">Место</th> : null}
              {forecast ? <th title="Вероятность попасть в плей-офф">Пройдёт</th> : null}
            </tr>
          </thead>
          <tbody>
            {stage.rows.map((row) => (
              <tr
                key={row.team.id}
                className={row.qualifying === null ? undefined : row.qualifying ? "dp-group-qualify" : "dp-group-out"}
              >
                <td className="dp-mono">{row.rank}</td>
                <td><Team team={row.team} compact /></td>
                <td className="dp-mono">{row.played}</td>
                <td className="dp-mono">{row.seriesWins}</td>
                <td className="dp-mono">{row.seriesLosses}</td>
                <td className="dp-mono dp-muted">{row.mapWins}–{row.mapLosses}</td>
                {row.cells.map((cell, index) => <Cell key={stage.rounds[index]?.label ?? index} cell={cell} />)}
                {forecast ? (
                  <td className="dp-mono dp-group-forecast">{row.expectedPlace === null ? "—" : row.expectedPlace.toFixed(1)}</td>
                ) : null}
                {forecast ? (
                  <td className="dp-mono">{row.qualifyChance === null ? "—" : `${row.qualifyChance.toFixed(0)}%`}</td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="dp-caveat">
        {stage.caveat}
        {stage.playoffSlots
          ? ` В плей-офф выходят ${stage.playoffSlots} — они отмечены зелёной полосой.`
          : " Организатор не объявил, сколько команд проходит дальше, поэтому никто не подсвечен."}
        {" У сыгранного матча показан счёт по картам, у предстоящего — оценка модели на эту команду."}
      </p>
    </>
  );
}
