"use client";

import { useCallback } from "react";
import { api, percent, relativeTime, type AccuracyRow, type Activity } from "../lib/api";
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
          <tr><th>Модель</th><th>Область</th><th>Прогнозов</th><th>Победитель</th><th>Brier</th><th>Log loss</th><th>Точный счёт</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.modelKind}-${row.scope}`}>
              <td>
                <a className="dp-link" href={`/model/${encodeURIComponent(row.modelKind)}`}>
                  <b>{KIND_LABELS[row.modelKind] ?? row.modelKind}</b>
                </a>
              </td>
              <td className="dp-muted">{SCOPE_LABELS[row.scope] ?? row.scope}</td>
              <td>
                {row.decided ?? row.count}
                {row.draws ? <span className="dp-muted dp-small"> +{row.draws} нич.</span> : null}
              </td>
              <td><b>{percent((row.accuracy ?? 0) * 100)}</b></td>
              <td>{row.brier?.toFixed(4) ?? "—"}</td>
              <td>{row.logLoss?.toFixed(4) ?? "—"}</td>
              <td>
                {row.exactScore?.count
                  ? <>{percent((row.exactScore.accuracy ?? 0) * 100)} <span className="dp-muted dp-small">({row.exactScore.count})</span></>
                  : <span className="dp-muted">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function duration(ms: number | null) {
  if (ms === null) return "идёт";
  if (ms < 1000) return `${ms} мс`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} с`;
  return `${Math.round(ms / 60_000)} мин`;
}

function ActivityPanel({ activity }: { activity: Activity | null }) {
  if (!activity) return <EmptyState title="Загрузка…" />;
  return (
    <>
      {activity.running.length ? (
        <div className="dp-running">
          {activity.running.map((job) => (
            <div key={job.job} className="dp-running-row">
              <span className="dp-spinner" />
              <b>{job.title}</b>
              <span className="dp-muted dp-small">{job.description}</span>
              <span className="dp-muted dp-small">{job.startedAt ? `с ${relativeTime(job.startedAt)}` : null}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="dp-muted dp-small">Сейчас ничего не выполняется — все задачи ждут своего интервала.</p>
      )}

      <div className="dp-table-wrap dp-activity-log">
        <table className="dp-table">
          <thead><tr><th>Когда</th><th>Задача</th><th>Длительность</th><th>Что сделано</th></tr></thead>
          <tbody>
            {activity.runs.map((run) => (
              <tr key={run.id}>
                <td className="dp-muted dp-small">{relativeTime(run.startedAt)}</td>
                <td><b>{run.title}</b></td>
                <td className="dp-mono dp-small">{duration(run.durationMs)}</td>
                <td className={run.status === "error" ? "dp-run-error" : undefined}>
                  {run.summary ?? (run.status === "running" ? "выполняется…" : "—")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function ModelPage() {
  const load = useCallback((signal: AbortSignal) => api.model(signal), []);
  const { data: status, error, reload } = usePolled(load, 30_000);
  const loadActivity = useCallback((signal: AbortSignal) => api.activity(signal), []);
  const { data: activity } = usePolled(loadActivity, 5_000);

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

      <Panel
        title="Что происходит прямо сейчас"
        subtitle="Сбор данных, переобучение и пересчёт идут сами — здесь видно, что именно и с каким результатом"
      >
        <ActivityPanel activity={activity} />
      </Panel>

      <Panel title="Точность за всё время" subtitle="Модели считаются раздельно — нажмите на название, чтобы увидеть каждый прогноз, матчи и пики">
        <AccuracyTable rows={status.accuracy} title="Всё время" />
      </Panel>

      <Panel title="Точность за 30 дней">
        <AccuracyTable rows={status.accuracy30d} title="30 дней" />
      </Panel>

      {/* The accuracy tables above disappear until a prediction resolves, and
          they used to hold the only link to a model's own history. This one is
          populated the moment anything trains, so the way through lives here. */}
      <Panel title="Версии моделей" subtitle="Активная версия отмечена — она и обслуживает прогнозы. Нажмите на тип, чтобы увидеть каждый прогноз этой модели">
        <div className="dp-table-wrap">
          <table className="dp-table">
            <thead><tr><th>Тип</th><th>Версия</th><th>Обучена</th><th>Примеров</th><th>Статус</th></tr></thead>
            <tbody>
              {status.versions.map((version) => {
                const state = versionStatus(version.active, version.metrics as VersionMetrics);
                return (
                  <tr key={`${version.kind}-${version.modelId}`}>
                    <td>
                      <a className="dp-link" href={`/model/${encodeURIComponent(version.kind)}`}>
                        <b>{KIND_LABELS[version.kind] ?? version.kind}</b>
                      </a>
                    </td>
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
