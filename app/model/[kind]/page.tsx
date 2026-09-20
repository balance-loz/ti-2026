"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- vinext uses native navigation here. */

import { useCallback, useMemo, useState } from "react";
import { api, formatDateTime, percent, relativeTime, type HeroCatalog, type ModelPrediction } from "../../lib/api";
import { useLastPathSegment, usePolled } from "../../lib/hooks";
import { Badge, EmptyState, ErrorState, Footer, HeroStrip, Panel, ProbabilityBar, Team, TopBar } from "../../components/shell";

const KIND_TITLES: Record<string, { title: string; blurb: string }> = {
  draft: {
    title: "Модель драфта",
    blurb: "Предсказывает победителя одной карты по десяти выбранным героям поверх рейтингов команд. Оценивается только по картам.",
  },
  team_ratings: {
    title: "Рейтинги команд",
    blurb: "Предсказывает победителя серии по силе команд, до всякой информации о пиках. Победитель и точный счёт оцениваются отдельно.",
  },
};

function Outcome({ row }: { row: ModelPrediction }) {
  if (row.outcomeKind === "draw") return <Badge tone="warn">ничья</Badge>;
  if (row.correct === null) return <Badge tone="neutral">открыт</Badge>;
  return row.correct ? <Badge tone="good">верно</Badge> : <Badge tone="bad">мимо</Badge>;
}

function PredictionRow({ row, heroes }: { row: ModelPrediction; heroes: HeroCatalog }) {
  const link = row.scope === "series"
    ? `/match/${encodeURIComponent(row.subjectKey)}`
    : null;
  return (
    <tr>
      <td>
        <div className="dp-match-teams">
          <Team team={row.sideA} compact />
          <span className="dp-vs">vs</span>
          <Team team={row.sideB} compact />
        </div>
        <span className="dp-muted dp-small">
          {formatDateTime(row.startTime ?? null)}
          {row.tournament ? <> · <a className="dp-link" href={`/t/${row.tournament.slug}`}>{row.tournament.name}</a></> : null}
          {link ? <> · <a className="dp-link" href={link}>разбор</a></> : null}
        </span>
        {row.picks ? (
          <div className="dp-live-picks dp-picks-compact">
            <HeroStrip picks={row.picks.radiant} side="radiant" heroes={heroes} />
            <HeroStrip picks={row.picks.dire} side="dire" heroes={heroes} />
          </div>
        ) : null}
      </td>
      <td>
        <div className="dp-pred-cell">
          <ProbabilityBar probabilityA={row.probabilityA} />
          <span className="dp-muted dp-small">зафиксирован {relativeTime(row.capturedAt)}</span>
        </div>
      </td>
      <td><Outcome row={row} /></td>
      <td className="dp-muted dp-small">
        {row.predictedScore ? (
          <>
            {row.predictedScore}
            {row.actualScore ? <> → {row.actualScore} {row.scoreCorrect ? "✓" : "✗"}</> : null}
          </>
        ) : "—"}
      </td>
      <td className="dp-mono">{row.brier === null ? "—" : row.brier.toFixed(3)}</td>
    </tr>
  );
}

export default function ModelDetailPage() {
  const kind = useLastPathSegment();
  const [filter, setFilter] = useState<"all" | "resolved" | "wrong">("all");

  const load = useCallback(
    (signal: AbortSignal) => (kind ? api.modelDetail(kind, signal) : Promise.reject(new Error("no_model"))),
    [kind],
  );
  const { data, error, reload } = usePolled(load, 60_000, kind);

  const shown = useMemo(() => {
    const rows = data?.predictions ?? [];
    if (filter === "resolved") return rows.filter((row) => row.resolvedAt);
    if (filter === "wrong") return rows.filter((row) => row.correct === false);
    return rows;
  }, [data, filter]);

  if (error) {
    return <main className="dp-page"><TopBar /><ErrorState error={error} onRetry={reload} /><Footer /></main>;
  }
  if (!data) {
    return <main className="dp-page"><TopBar /><EmptyState title="Загрузка…" /></main>;
  }

  const meta = KIND_TITLES[kind] ?? { title: kind, blurb: "" };
  const summary = data.accuracy[0];

  return (
    <main className="dp-page">
      <TopBar />

      <section className="dp-hero dp-hero-tournament">
        <a className="dp-back" href="/model">← состояние моделей</a>
        <h1>{meta.title}</h1>
        <p>{meta.blurb}</p>
        {summary ? (
          <div className="dp-hero-stats">
            <div><b>{percent((summary.accuracy ?? 0) * 100)}</b><span>точность по победителю</span></div>
            <div><b>{summary.decided ?? summary.count}</b><span>оценённых прогнозов</span></div>
            {summary.draws ? <div><b>{summary.draws}</b><span>ничьих — вне оценки</span></div> : null}
            <div><b>{summary.brier?.toFixed(3) ?? "—"}</b><span>Brier</span></div>
            {summary.exactScore?.count ? (
              <div>
                <b>{percent((summary.exactScore.accuracy ?? 0) * 100)}</b>
                <span>точный счёт ({summary.exactScore.count})</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <Panel
        title="Каждый прогноз"
        subtitle="Ничьи не входят в точность по победителю: угадывать было нечего"
        actions={
          <div className="dp-filters">
            {([["all", "все"], ["resolved", "закрытые"], ["wrong", "ошибки"]] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={filter === value ? "dp-filter dp-filter-on" : "dp-filter"}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
        }
      >
        {shown.length ? (
          <div className="dp-table-wrap">
            <table className="dp-table">
              <thead>
                <tr><th>Матч</th><th>Прогноз</th><th>Итог</th><th>Счёт</th><th>Brier</th></tr>
              </thead>
              <tbody>
                {shown.map((row) => <PredictionRow key={row.id} row={row} heroes={data.heroes} />)}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title={filter === "wrong" ? "Ошибок пока нет" : "Прогнозов пока нет"}
            hint="Точность начинает накапливаться с первого матча, который система застала вживую."
          />
        )}
      </Panel>

      <Footer generatedAt={data.generatedAt} />
    </main>
  );
}
