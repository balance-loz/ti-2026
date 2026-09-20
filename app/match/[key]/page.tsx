"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- vinext uses native navigation here. */

import { useCallback } from "react";
import { api, formatDateTime, probabilityPercent, relativeTime, type SeriesDetail, type SeriesMap } from "../../lib/api";
import { useLastPathSegment, usePolled } from "../../lib/hooks";
import { Badge, EmptyState, ErrorState, Footer, HeroStrip, Panel, ProbabilityBar, Team, TopBar } from "../../components/shell";

const clockFromSeconds = (seconds: number | null) =>
  seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "—";

function MapCard({ map, detail }: { map: SeriesMap; detail: SeriesDetail }) {
  const prediction = map.draftPrediction;
  const radiantWon = map.radiantWin;
  return (
    <article className="dp-live-card">
      <header>
        <Team team={map.radiant} compact />
        <span className="dp-live-score">
          {radiantWon === null ? "—" : radiantWon ? "1 : 0" : "0 : 1"}
        </span>
        <Team team={map.dire} compact />
      </header>

      <div className="dp-live-status">
        <Badge tone="neutral">{clockFromSeconds(map.duration)}</Badge>
        {map.patch ? <span className="dp-muted dp-small">патч {map.patch}</span> : null}
        <span className="dp-muted dp-small">{formatDateTime(map.startTime)}</span>
      </div>

      <div className="dp-live-picks">
        <HeroStrip picks={map.radiantPicks} side="radiant" heroes={detail.heroCatalog} />
        <HeroStrip picks={map.direPicks} side="dire" heroes={detail.heroCatalog} />
      </div>

      {prediction ? (
        <>
          <ProbabilityBar probabilityA={prediction.probabilityRadiant} />
          <dl className="dp-live-numbers">
            <div><dt>по драфту за Radiant</dt><dd>{probabilityPercent(prediction.probabilityRadiant)}</dd></div>
            {typeof prediction.features?.prior === "number" ? (
              <div><dt>до драфта</dt><dd>{probabilityPercent(prediction.features.prior as number)}</dd></div>
            ) : null}
            {typeof prediction.features?.draftDelta === "number" ? (
              <div>
                <dt>вклад пиков</dt>
                <dd>{(prediction.features.draftDelta as number) >= 0 ? "+" : ""}{(((prediction.features.draftDelta as number)) * 100).toFixed(1)} п.п.</dd>
              </div>
            ) : null}
            <div>
              <dt>итог</dt>
              <dd>{prediction.correct === null ? "—" : prediction.correct ? "✓" : "✗"}</dd>
            </div>
          </dl>
          <p className="dp-muted dp-small">
            зафиксировано {relativeTime(prediction.capturedAt)}
            {prediction.modelId ? ` · ${prediction.modelId}` : null}
          </p>
        </>
      ) : (
        <p className="dp-muted dp-small">Карта сыграна до того, как система её застала — прогноза по драфту нет.</p>
      )}
    </article>
  );
}

export default function MatchPage() {
  const key = useLastPathSegment();
  const load = useCallback(
    (signal: AbortSignal) => (key ? api.series(key, signal) : Promise.reject(new Error("no_series"))),
    [key],
  );
  const { data, error, reload } = usePolled(load, 30_000, key);

  if (error) {
    return <main className="dp-page"><TopBar /><ErrorState error={error} onRetry={reload} /><Footer /></main>;
  }
  if (!data) {
    return <main className="dp-page"><TopBar /><EmptyState title="Загрузка матча…" /></main>;
  }

  const { teamA, teamB, scoreA, scoreB, prediction, explanation, maps, tournament } = data;
  const winnerIsA = data.winnerId ? data.winnerId === teamA.id : null;

  return (
    <main className="dp-page">
      <TopBar />

      <section className="dp-hero dp-hero-tournament">
        {tournament ? <a className="dp-back" href={`/t/${tournament.slug}`}>← {tournament.name}</a> : <a className="dp-back" href="/">← все турниры</a>}
        <div className="dp-match-head">
          <Team team={teamA} />
          <span className="dp-match-score">{scoreA} : {scoreB}</span>
          <Team team={teamB} />
        </div>
        <div className="dp-hero-meta">
          <Badge tone={data.status === "finished" ? "good" : data.status === "live" ? "live" : "neutral"}>
            {data.isDraw ? "ничья" : data.status === "finished" ? (winnerIsA ? `победа ${teamA.name}` : `победа ${teamB.name}`) : data.status === "live" ? "идёт" : "не доиграна"}
          </Badge>
          <span>Bo{data.bestOf ?? "?"}</span>
          <span className="dp-muted">{formatDateTime(data.startTime)}</span>
        </div>
      </section>

      <Panel title="Что предсказала модель" subtitle="Число зафиксировано до результата и не переписывалось">
        {prediction ? (
          <>
            <ProbabilityBar probabilityA={prediction.probabilityA} />
            <dl className="dp-metrics">
              <div><dt>{teamA.name}</dt><dd>{probabilityPercent(prediction.probabilityA)}</dd></div>
              {prediction.drawProbability ? (
                <div><dt>ничья</dt><dd>{probabilityPercent(prediction.drawProbability)}</dd></div>
              ) : null}
              <div><dt>вероятнейший счёт</dt><dd>{prediction.predictedScore ?? "—"}</dd></div>
              {prediction.predictedScoreProbability ? (
                <div><dt>его вероятность</dt><dd>{probabilityPercent(prediction.predictedScoreProbability)}</dd></div>
              ) : null}
              <div>
                <dt>победитель</dt>
                <dd>{prediction.outcomeKind === "draw" ? "ничья" : prediction.outcomeKind ? (prediction.outcomeKind === "win" ? "✓" : "✗") : "—"}</dd>
              </div>
              <div>
                <dt>счёт</dt>
                <dd>{prediction.scoreCorrect === null ? "—" : prediction.scoreCorrect ? "✓" : "✗"}</dd>
              </div>
            </dl>
            <p className="dp-caveat">
              Зафиксировано {relativeTime(prediction.capturedAt)}
              {prediction.features?.scoreAtFreeze ? ` при счёте ${prediction.features.scoreAtFreeze as string}` : null}
              {prediction.modelId ? ` · модель ${prediction.modelId}` : null}.
              Счёт и победитель оцениваются отдельно: ошибиться в счёте гораздо легче, и это не должно
              портить показатель по победителю.
            </p>
          </>
        ) : (
          <EmptyState title="Прогноза нет" hint="Серия была сыграна до того, как система её застала." />
        )}
      </Panel>

      <Panel title="Почему так" subtitle="Из чего сложилась оценка">
        <dl className="dp-metrics">
          <div><dt>шанс на карте</dt><dd>{probabilityPercent(explanation.mapProbabilityA)}</dd></div>
          <div><dt>рейтинг {teamA.name}</dt><dd>{explanation.ratingA?.toFixed(2) ?? "—"}</dd></div>
          <div><dt>рейтинг {teamB.name}</dt><dd>{explanation.ratingB?.toFixed(2) ?? "—"}</dd></div>
          <div><dt>серий в основе</dt><dd>{explanation.seriesA} / {explanation.seriesB}</dd></div>
          <div><dt>уверенность</dt><dd>{explanation.confidence}</dd></div>
        </dl>
        <p className="dp-caveat">
          Вероятность серии выводится из шанса на одной карте: все точные счета считаются
          аналитически, поэтому они всегда в сумме дают вероятность победы и не могут ей противоречить.
        </p>
      </Panel>

      <Panel title="Карты и драфты" subtitle="По каждой карте — пики и прогноз, сделанный по ним">
        {maps.length ? (
          <div className="dp-live-grid">
            {maps.map((map) => <MapCard key={map.matchId} map={map} detail={data} />)}
          </div>
        ) : <EmptyState title="Карт не сохранено" />}
      </Panel>

      <Footer />
    </main>
  );
}
