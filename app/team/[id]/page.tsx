"use client";
/* eslint-disable @next/next/no-html-link-for-pages, @next/next/no-img-element -- vinext uses native navigation, and hero art is served from an external CDN. */

import { useCallback } from "react";
import {
  api, formatDate, formatDateTime, percent, probabilityPercent,
  type HeroCatalog, type Lineup, type RosterEra, type TeamSeriesRow,
} from "../../lib/api";
import { useLastPathSegment, usePolled } from "../../lib/hooks";
import { Badge, EmptyState, ErrorState, Footer, Panel, ProbabilityBar, Team, TopBar } from "../../components/shell";

function ResultBadge({ row }: { row: TeamSeriesRow }) {
  if (row.status !== "finished") return <Badge tone="neutral">идёт</Badge>;
  if (row.isDraw) return <Badge tone="warn">ничья</Badge>;
  return row.won ? <Badge tone="good">победа</Badge> : <Badge tone="bad">поражение</Badge>;
}

function SeriesTable({ rows }: { rows: TeamSeriesRow[] }) {
  return (
    <div className="dp-table-wrap">
      <table className="dp-table">
        <thead>
          <tr><th>Соперник</th><th>Счёт</th><th>Итог</th><th>Прогноз до матча</th><th>Турнир</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.seriesKey}>
              <td>
                <Team team={row.opponent} compact />
                <div className="dp-muted dp-small">
                  {formatDateTime(row.startTime)} · Bo{row.bestOf ?? "?"} ·{" "}
                  <a className="dp-link" href={`/match/${encodeURIComponent(row.seriesKey)}`}>разбор</a>
                </div>
              </td>
              <td><b>{row.scoreFor} : {row.scoreAgainst}</b></td>
              <td><ResultBadge row={row} /></td>
              <td>
                {row.prediction ? (
                  <div className="dp-pred-cell">
                    <span className="dp-mono">{probabilityPercent(row.prediction.probability)} за победу</span>
                    {row.prediction.correct === null
                      ? <span className="dp-muted dp-small">{row.prediction.outcomeKind === "draw" ? "ничья — победителя не было" : "ещё не закрыт"}</span>
                      : <span className="dp-small">{row.prediction.correct ? "✓ угадан" : "✗ мимо"}
                        {row.prediction.predictedScore ? ` · счёт ${row.prediction.predictedScore}${row.prediction.scoreCorrect ? " ✓" : ""}` : null}</span>}
                  </div>
                ) : <span className="dp-muted dp-small">сыграно до запуска</span>}
              </td>
              <td className="dp-muted dp-small">
                {row.tournament ? <a className="dp-link" href={`/t/${row.tournament.slug}`}>{row.tournament.name}</a> : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HeroTable({ heroes, catalog }: { heroes: { heroId: number; games: number; wins: number; winRate: number | null }[]; catalog: HeroCatalog }) {
  if (!heroes.length) return <EmptyState title="Нет карт с пиками" hint="Пики подтягиваются отдельно и появятся по мере сбора." />;
  return (
    <div className="dp-table-wrap">
      <table className="dp-table">
        <thead><tr><th>Герой</th><th>Игр</th><th>Побед</th><th>Винрейт</th></tr></thead>
        <tbody>
          {heroes.map((row) => {
            const hero = catalog[String(row.heroId)];
            return (
              <tr key={row.heroId}>
                <td>
                  <span className="dp-hero-chip">
                    {hero?.image ? <img src={hero.image} alt="" loading="lazy" /> : null}
                    {hero?.name ?? row.heroId}
                  </span>
                </td>
                <td>{row.games}</td>
                <td>{row.wins}</td>
                <td><b>{row.winRate === null ? "—" : percent(row.winRate * 100)}</b></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const names = (era: { players: { accountId: number; name: string | null }[] }) =>
  era.players.map((player) => player.name ?? `#${player.accountId}`);

/** "1 карта", "3 карты", "18 карт" — a bare count beside a noun reads as output. */
const maps = (count: number) => {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const form = mod10 === 1 && mod100 !== 11 ? "карта"
    : mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20) ? "карты"
      : "карт";
  return `${count} ${form}`;
};

/**
 * Who plays for this team, and who used to.
 *
 * Spells are cut where a map shares fewer than four players with the running
 * one, so a stand-in does not read as a transfer. Names come from the pro-player
 * list; the archived history stored account ids without them, so anyone outside
 * that list is shown by id rather than guessed at.
 */
function RosterPanel({ lineup, history }: { lineup: Lineup; history: RosterEra[] }) {
  if (!lineup) return <EmptyState title="Составы не сохранены" hint="Для этой команды в базе нет карт с идентификаторами игроков." />;
  const past = history.slice(1);
  return (
    <>
      <div className="dp-roster-now">
        <p className="dp-roster-five">{names(lineup).join(" · ")}</p>
        <p className="dp-muted dp-small">
          {lineup.unchangedThroughout
            ? `Состав не менялся за все ${maps(lineup.sampledMaps)} в базе.`
            : `Играет вместе ${maps(lineup.stableMaps)}${lineup.stableSince ? ` — с ${formatDate(lineup.stableSince)}` : ""}.`}
        </p>
      </div>

      {past.length ? (
        <>
          <h3 className="dp-subhead">Прежние составы</h3>
          <ul className="dp-roster-history">
            {past.map((era) => (
              <li key={`${era.from}-${era.to}`}>
                <span className="dp-roster-when">{formatDate(era.from)} — {formatDate(era.to)}</span>
                <span className="dp-roster-players">{names(era).join(" · ")}</span>
                <span className="dp-roster-maps">{maps(era.maps)}</span>
              </li>
            ))}
          </ul>
          <p className="dp-caveat">
            Короткие замены на одну-две карты не показаны — это не смена состава.
            Результаты, сыгранные прежними составами, при обучении получают меньший вес.
          </p>
        </>
      ) : null}
    </>
  );
}

export default function TeamPage() {
  const teamId = useLastPathSegment();
  const load = useCallback(
    (signal: AbortSignal) => (teamId ? api.team(teamId, signal) : Promise.reject(new Error("no_team"))),
    [teamId],
  );
  const { data, error, reload } = usePolled(load, 60_000, teamId);

  if (error) {
    return <main className="dp-page"><TopBar /><ErrorState error={error} onRetry={reload} /><Footer /></main>;
  }
  if (!data) {
    return <main className="dp-page"><TopBar /><EmptyState title="Загрузка команды…" /></main>;
  }

  const { team, rating, record, series, headToHead, heroes, heroCatalog } = data;
  const played = record.wins + record.losses + record.draws;

  return (
    <main className="dp-page">
      <TopBar />

      <section className="dp-hero dp-hero-tournament">
        <a className="dp-back" href="/">← все турниры</a>
        <h1>{team.name}</h1>
        <div className="dp-hero-stats">
          <div>
            <b>{rating ? `#${rating.rank}` : "—"}</b>
            <span>{rating ? `из ${rating.of} команд` : "нет рейтинга"}</span>
          </div>
          <div><b>{rating ? rating.rating.toFixed(2) : "—"}</b><span>рейтинг</span></div>
          <div><b>{record.wins}–{record.losses}{record.draws ? `–${record.draws}` : ""}</b><span>серий сыграно {played}</span></div>
          <div><b>{played ? percent((record.wins / played) * 100) : "—"}</b><span>доля побед</span></div>
        </div>
        {rating ? (
          <p className="dp-muted dp-small dp-hero-note">
            Рейтинг обучен на {rating.series} сериях этой команды. Чем их меньше, тем сильнее прогноз
            притягивается к равному.
          </p>
        ) : (
          <p className="dp-muted dp-small dp-hero-note">
            Команда сыграла слишком мало серий, чтобы получить рейтинг — её матчи прогнозируются как равные.
          </p>
        )}
      </section>

      <Panel title="Состав" subtitle="Кто играет сейчас и кто играл раньше — по картам, которые есть в базе">
        <RosterPanel lineup={data.lineup} history={data.rosterHistory} />
      </Panel>

      <Panel title="Матчи" subtitle="Прогноз показан тот, что был зафиксирован до матча">
        {series.length ? <SeriesTable rows={series} /> : <EmptyState title="Матчей пока нет" />}
      </Panel>

      <Panel title="Личные встречи" subtitle="По всем сохранённым турнирам">
        {headToHead.length ? (
          <div className="dp-table-wrap">
            <table className="dp-table">
              <thead><tr><th>Соперник</th><th>Серии</th><th>Карты</th><th>Баланс</th></tr></thead>
              <tbody>
                {headToHead.map((row) => {
                  const total = row.wins + row.losses + row.draws;
                  const share = total ? row.wins / total : 0;
                  return (
                    <tr key={row.opponent.id}>
                      <td><Team team={row.opponent} compact /></td>
                      <td><b>{row.wins}–{row.losses}{row.draws ? `–${row.draws}` : ""}</b></td>
                      <td className="dp-muted">{row.mapsFor}–{row.mapsAgainst}</td>
                      <td><ProbabilityBar probabilityA={share} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <EmptyState title="Нет завершённых встреч" />}
      </Panel>

      <Panel title="Герои" subtitle="Что команда берёт чаще всего и с каким результатом">
        <HeroTable heroes={heroes} catalog={heroCatalog} />
      </Panel>

      <Footer generatedAt={new Date().toISOString()} />
    </main>
  );
}
