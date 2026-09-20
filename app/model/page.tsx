"use client";

import { useCallback } from "react";
import { api, percent, relativeTime, type AccuracyRow } from "../lib/api";
import { usePolled } from "../lib/hooks";
import { Badge, EmptyState, ErrorState, Footer, Panel, TopBar } from "../components/shell";

const KIND_LABELS: Record<string, string> = {
  team_ratings: "Рейтинги команд",
  draft: "Модель драфта",
  live_state: "Модель хода игры",
};

const SCOPE_LABELS: Record<string, string> = {
  series: "серии",
  map: "карты",
  tournament: "турниры",
};

type VersionMetrics = { gatePassed?: boolean; beatsCoinflip?: boolean } | null | undefined;

/**
 * An inactive version is not necessarily a failed one: most are simply older
 * models that a later retrain replaced. Only a version that lost to its
 * baseline was actually rejected.
 */
function versionStatus(active: boolean, metrics: VersionMetrics) {
  if (active) return { tone: "good" as const, label: "активна" };
  const passed = metrics?.gatePassed ?? metrics?.beatsCoinflip;
  if (passed === false) return { tone: "bad" as const, label: "не прошла отбор" };
  return { tone: "neutral" as const, label: "заменена" };
}

function AccuracyTable({ rows, title }: { rows: AccuracyRow[]; title: string }) {
  if (!rows.length) return <EmptyState title={`${title}: пока нет закрытых прогнозов`} />;
  return (
    <div className="dp-table-wrap">
      <table className="dp-table">
        <thead>
          <tr><th>Модель</th><th>Область</th><th>Прогнозов</th><th>Точность</th><th>Brier</th><th>Log loss</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.modelKind}-${row.scope}`}>
              <td><b>{KIND_LABELS[row.modelKind] ?? row.modelKind}</b></td>
              <td className="dp-muted">{SCOPE_LABELS[row.scope] ?? row.scope}</td>
              <td>{row.count}</td>
              <td><b>{percent((row.accuracy ?? 0) * 100)}</b></td>
              <td>{row.brier?.toFixed(4) ?? "—"}</td>
              <td>{row.logLoss?.toFixed(4) ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ModelPage() {
  const load = useCallback((signal: AbortSignal) => api.model(signal), []);
  const { data: status, error, reload } = usePolled(load, 30_000);

  if (error) {
    return (
      <main className="dp-page"><TopBar /><ErrorState error={error} onRetry={reload} /><Footer /></main>
    );
  }
  if (!status) {
    return <main className="dp-page"><TopBar /><EmptyState title="Загрузка…" /></main>;
  }

  const budgetShare = status.opendota.limit ? (status.opendota.used / status.opendota.limit) * 100 : 0;

  return (
    <main className="dp-page">
      <TopBar />

      <section className="dp-hero dp-hero-tournament">
        <h1>Состояние модели</h1>
        <p>
          Только статистика: рейтинги команд и модель драфта переобучаются автоматически на всех
          собранных про-матчах. Новая версия публикуется лишь после того, как обошла базовую
          на отложенной выборке из будущих матчей.
        </p>
      </section>

      <Panel title="Точность за всё время" subtitle="По зафиксированным до матча прогнозам">
        <AccuracyTable rows={status.accuracy} title="Всё время" />
      </Panel>

      <Panel title="Точность за 30 дней">
        <AccuracyTable rows={status.accuracy30d} title="30 дней" />
      </Panel>

      <Panel title="Версии моделей" subtitle="Активная версия отмечена — она и обслуживает прогнозы">
        <div className="dp-table-wrap">
          <table className="dp-table">
            <thead><tr><th>Тип</th><th>Версия</th><th>Обучена</th><th>Примеров</th><th>Статус</th></tr></thead>
            <tbody>
              {status.versions.map((version) => {
                const state = versionStatus(version.active, version.metrics as VersionMetrics);
                return (
                  <tr key={`${version.kind}-${version.modelId}`}>
                    <td>{KIND_LABELS[version.kind] ?? version.kind}</td>
                    <td className="dp-mono">{version.modelId}</td>
                    <td className="dp-muted">{relativeTime(version.trainedAt)}</td>
                    <td>{version.samples?.toLocaleString("ru-RU") ?? "—"}</td>
                    <td><Badge tone={state.tone}>{state.label}</Badge></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Фоновые задачи" subtitle="Сбор данных, переобучение и пересчёт прогнозов идут сами">
        <div className="dp-table-wrap">
          <table className="dp-table">
            <thead><tr><th>Задача</th><th>Что делает</th><th>Интервал</th><th>Последний запуск</th><th>Итог</th></tr></thead>
            <tbody>
              {status.scheduler.map((job) => (
                <tr key={job.job}>
                  <td className="dp-mono">{job.job}</td>
                  <td className="dp-muted">{job.description}</td>
                  <td>{job.intervalSeconds < 120 ? `${job.intervalSeconds} с` : `${Math.round(job.intervalSeconds / 60)} мин`}</td>
                  <td className="dp-muted">{relativeTime(job.lastRunAt)}</td>
                  <td>
                    {job.running ? <Badge tone="live">идёт</Badge>
                      : job.lastStatus === "ok" ? <Badge tone="good">ок</Badge>
                        : job.lastStatus === "error" ? <Badge tone="bad">ошибка</Badge>
                          : <Badge tone="neutral">не запускалась</Badge>}
                    {job.lastError ? <div className="dp-small dp-muted">{job.lastError}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Бюджет OpenDota" subtitle={`${status.opendota.used} из ${status.opendota.limit} запросов за ${status.opendota.day}`}>
        <div className="dp-budget">
          <div className="dp-budget-bar"><div style={{ width: `${Math.min(100, budgetShare)}%` }} /></div>
          <span className="dp-muted">осталось {status.opendota.remaining}</span>
        </div>
      </Panel>

      <Footer generatedAt={status.generatedAt} />
    </main>
  );
}
