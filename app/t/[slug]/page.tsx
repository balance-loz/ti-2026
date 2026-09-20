"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- vinext uses native navigation here. */

import { useCallback, useMemo } from "react";
import {
  api, clock, CONFIDENCE_LABELS, formatDateTime, FORMAT_LABELS, percent, probabilityPercent, relativeTime,
  type HeroCatalog, type LiveGame, type SeriesRow, type TournamentForecast,
} from "../../lib/api";
import { useLastPathSegment, usePolled } from "../../lib/hooks";
import { Badge, EmptyState, ErrorState, Footer, HeroStrip, Panel, ProbabilityBar, Team, TopBar } from "../../components/shell";

function LiveGameCard({ game, heroes }: { game: LiveGame; heroes: HeroCatalog }) {
  const probability = game.frozenDraftProbabilityRadiant ?? game.draft?.probabilityRadiant ?? null;
  const liveProbability = game.liveState?.liveProbabilityRadiant ?? null;
  return (
    <article className="dp-live-card">
      <header>
        <Team team={game.radiantTeam} compact />
        <span className="dp-live-score">{game.radiantScore} : {game.direScore}</span>
        <Team team={game.direTeam} compact />
      </header>
      <div className="dp-live-status">
        <Badge tone={game.phase === "draft" ? "warn" : "live"}>{game.phase === "draft" ? "драфт" : `${clock(game.gameTime)}`}</Badge>
        {game.radiantLead !== null ? <span className="dp-muted">золото {game.radiantLead > 0 ? "+" : ""}{game.radiantLead.toLocaleString("ru-RU")}</span> : null}
      </div>
      <div className="dp-live-picks">
        <HeroStrip picks={game.radiantPicks} side="radiant" heroes={heroes} />
        <HeroStrip picks={game.direPicks} side="dire" heroes={heroes} />
      </div>
      {probability === null ? (
        <p className="dp-muted">Пики ещё не завершены — прогноз появится, когда обе команды закроют драфт.</p>
      ) : (
        <>
          <ProbabilityBar probabilityA={probability} />
          <dl className="dp-live-numbers">
            <div><dt>по драфту</dt><dd>{probabilityPercent(probability)}</dd></div>
            {game.draft ? <div><dt>до драфта</dt><dd>{probabilityPercent(game.draft.priorProbabilityRadiant)}</dd></div> : null}
            {liveProbability !== null ? <div><dt>с учётом игры</dt><dd>{probabilityPercent(liveProbability)}</dd></div> : null}
          </dl>
          {game.draft && !game.draft.available ? (
            <p className="dp-muted dp-small">Draft-модель недоступна ({game.draft.reason}); показан рейтинговый прогноз.</p>
          ) : null}
        </>
      )}
    </article>
  );
}

function ForecastTable({ forecast }: { forecast: TournamentForecast }) {
  const alive = forecast.teams.filter((team) => !team.eliminated);
  const out = forecast.teams.filter((team) => team.eliminated);
  const rows = [...alive, ...out];
  return (
    <>
      <div className="dp-forecast-meta">
        <span><b>{FORMAT_LABELS[forecast.format.type] ?? forecast.format.type}</b></span>
        <span className="dp-muted">достоверность формата: {CONFIDENCE_LABELS[forecast.confidence] ?? forecast.confidence}</span>
        <span className="dp-muted">{forecast.iterations.toLocaleString("ru-RU")} симуляций</span>
      </div>
      <div className="dp-table-wrap">
        <table className="dp-table">
          <thead>
            <tr>
              <th>Команда</th>
              <th>Серии</th>
              <th>Карты</th>
              <th>Чемпион</th>
              <th>Финал</th>
              <th>Топ-4</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((team) => (
              <tr key={team.teamId} className={team.eliminated ? "dp-row-out" : undefined}>
                <td>
                  <Team team={{ id: team.teamId, name: team.name, logoUrl: team.logoUrl }} />
                  {team.eliminated ? <Badge tone="bad">вылет</Badge> : null}
                </td>
                <td>{team.seriesWins}–{team.seriesLosses}</td>
                <td className="dp-muted">{team.mapWins}–{team.mapLosses}</td>
                <td><b>{percent(team.champion)}</b></td>
                <td>{percent(team.final)}</td>
                <td>{percent(team.top4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="dp-caveat">{forecast.caveat}</p>
    </>
  );
}

function SeriesTable({ series }: { series: SeriesRow[] }) {
  return (
    <div className="dp-table-wrap">
      <table className="dp-table">
        <thead>
          <tr>
            <th>Матч</th>
            <th>Счёт</th>
            <th>Прогноз до матча</th>
            <th>Итог</th>
          </tr>
        </thead>
        <tbody>
          {series.map((row) => {
            const prediction = row.prediction;
            const probabilityA = prediction?.probabilityA ?? null;
            return (
              <tr key={row.seriesKey}>
                <td>
                  <div className="dp-match-teams">
                    <Team team={row.teamA} compact />
                    <span className="dp-vs">vs</span>
                    <Team team={row.teamB} compact />
                  </div>
                  <span className="dp-muted dp-small">
                    {formatDateTime(row.startTime)} · Bo{row.bestOf ?? "?"}
                  </span>
                </td>
                <td>
                  {row.status === "finished" ? <b>{row.scoreA} : {row.scoreB}</b> : <Badge tone={row.status === "live" ? "live" : "neutral"}>{row.status === "live" ? "идёт" : "ожидается"}</Badge>}
                </td>
                <td>
                  {probabilityA === null ? (
                    <span className="dp-muted dp-small">серия сыграна до запуска</span>
                  ) : (
                    <div className="dp-pred-cell">
                      <ProbabilityBar probabilityA={probabilityA} />
                      <span className="dp-muted dp-small">зафиксирован {relativeTime(prediction?.capturedAt)}</span>
                    </div>
                  )}
                </td>
                <td>
                  {prediction?.correct === null || prediction?.correct === undefined
                    ? <span className="dp-muted">—</span>
                    : prediction.correct ? <Badge tone="good">верно</Badge> : <Badge tone="bad">мимо</Badge>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function TournamentPage() {
  const slug = useLastPathSegment();

  const load = useCallback(
    (signal: AbortSignal) => (slug ? api.tournament(slug, signal) : Promise.reject(new Error("no_slug"))),
    [slug],
  );
  const { data: detail, error, reload } = usePolled(load, 30_000, slug);

  const accuracy = useMemo(() => ({
    seriesRow: detail?.accuracy.find((row) => row.scope === "series"),
    mapRow: detail?.accuracy.find((row) => row.scope === "map"),
  }), [detail]);

  if (error) {
    return (
      <main className="dp-page">
        <TopBar />
        <ErrorState error={error} onRetry={reload} />
        <Footer />
      </main>
    );
  }

  if (!detail) {
    return (
      <main className="dp-page">
        <TopBar />
        <EmptyState title="Загрузка турнира…" />
      </main>
    );
  }

  const { tournament, forecast, series, live } = detail;
  const finished = series.filter((row) => row.status === "finished");
  const upcoming = series.filter((row) => row.status !== "finished");

  return (
    <main className="dp-page">
      <TopBar live={live.length} />

      <section className="dp-hero dp-hero-tournament">
        <a className="dp-back" href="/">← все турниры</a>
        <h1>{tournament.name}</h1>
        <div className="dp-hero-meta">
          {tournament.playingNow ? <Badge tone="live">в эфире</Badge> : <Badge tone={tournament.status === "live" ? "good" : "neutral"}>{tournament.status === "live" ? "идёт" : "завершён"}</Badge>}
          {tournament.tier ? <span>{tournament.tier}</span> : null}
          <span>{tournament.teamCount ?? 0} команд</span>
          <span>{tournament.seriesCount} серий · {tournament.mapCount} карт</span>
          <span className="dp-muted">обновлено {relativeTime(tournament.lastSyncedAt)}</span>
        </div>
      </section>

      {live.length ? (
        <Panel title="Идут прямо сейчас" subtitle="Вероятность считается по десяти выбранным героям и рейтингам команд">
          <div className="dp-live-grid">
            {live.map((game) => <LiveGameCard key={game.matchId} game={game} heroes={detail.heroes ?? {}} />)}
          </div>
        </Panel>
      ) : null}

      <Panel
        title="Кто выиграет турнир"
        subtitle="Монте-Карло по текущему положению и рейтингам команд"
      >
        {forecast ? <ForecastTable forecast={forecast} /> : (
          <EmptyState title="Прогноз ещё не построен" hint="Нужно несколько сыгранных серий и обученная рейтинговая модель." />
        )}
      </Panel>

      {upcoming.length ? (
        <Panel title="Предстоящие и текущие серии" subtitle="Вероятность зафиксирована до начала матча">
          <SeriesTable series={upcoming} />
        </Panel>
      ) : null}

      <Panel
        title="Сыгранные серии"
        subtitle={accuracy.seriesRow
          ? `Точность на этом турнире: ${percent((accuracy.seriesRow.accuracy ?? 0) * 100)} на ${accuracy.seriesRow.count} сериях, Brier ${accuracy.seriesRow.brier?.toFixed(3) ?? "—"}`
          : "Прогноз записывается только до результата, поэтому у серий, сыгранных до запуска системы, его нет — точность начинает накапливаться с первого матча, который система застала."}
      >
        {finished.length ? <SeriesTable series={finished} /> : <EmptyState title="Пока нет сыгранных серий" />}
      </Panel>

      {accuracy.mapRow ? (
        <Panel title="Точность по драфтам" subtitle="Карты, предсказанные по пикам в прямом эфире">
          <dl className="dp-metrics">
            <div><dt>карт</dt><dd>{accuracy.mapRow.count}</dd></div>
            <div><dt>точность</dt><dd>{percent((accuracy.mapRow.accuracy ?? 0) * 100)}</dd></div>
            <div><dt>Brier</dt><dd>{accuracy.mapRow.brier?.toFixed(3) ?? "—"}</dd></div>
            <div><dt>log loss</dt><dd>{accuracy.mapRow.logLoss?.toFixed(3) ?? "—"}</dd></div>
          </dl>
        </Panel>
      ) : null}

      <Footer generatedAt={detail.generatedAt} />
    </main>
  );
}
