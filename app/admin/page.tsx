"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- Vinext uses native navigation in this project. */

import { useEffect, useState, type FormEvent } from "react";

type Snapshot = { id: number; trigger: string; created_at: string; completed_match_count: number; iterations: number };
type RefreshStep = { id: string; label: string; status: "pending" | "running" | "done" | "error" };
type RefreshProgress = {
  running: boolean;
  startedAt?: string | null;
  finishedAt?: string | null;
  ok?: boolean | null;
  code?: number | null;
  stepIndex?: number;
  stepLabel?: string | null;
  detail?: string | null;
  log?: string;
  heartbeatAt?: string | null;
  steps?: RefreshStep[];
};
type AdminState = { isAdmin: boolean; answers: Record<string, number>; snapshots: Snapshot[]; refreshRunning: boolean; refreshProgress?: RefreshProgress | null; liveSync?: { running?: boolean; lastSync?: { updatedAt?: string; ok?: boolean } | null } | null };
type ForecastJob = { id: string; status: string; error?: string | null; snapshotId?: number | null; progress?: { current: number; total: number } };
type ForecastJob = { id: string; status: string; error?: string | null; snapshotId?: number | null; progress?: { current: number; total: number } };

const DEFAULT_OPINION_WEIGHT = 15;
const MANUAL_FORECAST_WEIGHTS = [
  { weight: 15, label: "Пересчитать 15% (основной)" },
  { weight: 0, label: "0% · только статистика" },
  { weight: 10, label: "10% мнения" },
  { weight: 20, label: "20% мнения" },
  { weight: 30, label: "30% мнения" },
] as const;

async function requestJson(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `API ${response.status}`);
  return payload;
}

function formatElapsed(startedAt?: string | null) {
  if (!startedAt) return "";
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return "";
  const totalSec = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours) return `${hours} ч ${minutes} мин`;
  if (minutes) return `${minutes} мин ${seconds} с`;
  return `${seconds} с`;
}

function stepMark(status: RefreshStep["status"]) {
  if (status === "done") return "✓";
  if (status === "running") return "●";
  if (status === "error") return "✕";
  return "○";
}

function RefreshProgressPanel({ progress, running }: { progress: RefreshProgress; running: boolean }) {
  const heartbeatAge = progress.heartbeatAt ? Date.now() - Date.parse(progress.heartbeatAt) : 0;
  const isStale = running && Number.isFinite(heartbeatAge) && heartbeatAge > 120_000;
  const logTail = (progress.log ?? "").trim().split(/\n/).slice(-12).join("\n");
  return <div className="admin-refresh-progress">
    <p>
      {running ? `Идёт шаг ${progress.stepIndex || "—"}/7` : progress.ok === false ? "Обновление упало" : progress.ok ? "Последнее обновление прошло" : "Последний прогон"}
      {progress.stepLabel ? ` · ${progress.stepLabel}` : ""}
      {progress.startedAt ? ` · ${formatElapsed(progress.startedAt)}` : ""}
    </p>
    {progress.detail ? <small>{progress.detail}</small> : null}
    {isStale ? <small className="is-stale">Нет новых строк больше 2 минут. Если в логе 429 — OpenDota режет лимит и процесс спит до следующей попытки.</small> : null}
    {progress.steps?.length ? <ol>{progress.steps.map((step) => <li key={step.id} className={`is-${step.status}`}><span>{stepMark(step.status)}</span><b>{step.label}</b></li>)}</ol> : null}
    {logTail ? <pre>{logTail}</pre> : null}
  </div>;
}

export default function AdminPage() {
  const [state, setState] = useState<AdminState | null>(null);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [answers, setAnswers] = useState("{}");
  const [message, setMessage] = useState("");
  const [hasError, setHasError] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const load = async (opts?: { silent?: boolean }) => {
    try {
      const next = await requestJson("/api/state", { cache: "no-store" }) as AdminState;
      setState(next);
      if (!opts?.silent) setAnswers(JSON.stringify(next.answers, null, 2));
    } catch (error) { setHasError(true); setMessage(error instanceof Error ? error.message : String(error)); }
  };
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, []);
  useEffect(() => {
    if (!state?.refreshRunning && !state?.refreshProgress?.running) return;
    const timer = window.setInterval(() => void load({ silent: true }), 2000);
    return () => window.clearInterval(timer);
  }, [state?.refreshRunning, state?.refreshProgress?.running]);
  const run = async (label: string, action: () => Promise<unknown>) => {
    setIsBusy(true); setHasError(false); setMessage("");
    try { await action(); setMessage(label); await load(); }
    catch (error) { setHasError(true); setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setIsBusy(false); }
  };
  const login = (event: FormEvent) => {
    event.preventDefault();
    void run("Админский режим включён.", () => requestJson("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) }));
  };
  const parsedAnswers = () => {
    const parsed = JSON.parse(answers) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Нужен JSON-объект пар команд");
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, Number(value)]));
  };
  const saveAnswers = () => void run("Экспертные вероятности сохранены. Автопересчёт пойдёт только для смеси 15%.", async () => {
    return requestJson("/api/admin/answers", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers: parsedAnswers(), replace: true }) });
  });
  const waitForJob = async (jobId: string) => {
    for (;;) {
      const payload = await requestJson(`/api/forecast/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" }) as { job?: ForecastJob; error?: string };
      const job = payload.job;
      if (!job) throw new Error(payload.error || "forecast_job_missing");
      if (job.status === "ready") return job;
      if (job.status === "error" || job.status === "canceled") throw new Error(job.error || job.status);
      const current = job.progress?.current ?? 0;
      const total = job.progress?.total ?? 0;
      setMessage(total ? `Считаем прогноз: ${current.toLocaleString("ru-RU")} / ${total.toLocaleString("ru-RU")}` : "Прогноз в серверной очереди…");
      await new Promise((resolve) => window.setTimeout(resolve, 800));
    }
  };
  const startForecast = async (weight: number) => {
    setIsBusy(true); setHasError(false); setMessage("");
    try {
      const parsed = parsedAnswers();
      const forecastMode = weight <= 0 ? "stats" : "mixed";
      const payload = await requestJson("/api/forecast/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "manual",
          profile: { forecastMode, opinionWeight: weight, answers: weight ? parsed : {} },
          simulation: { iterations: 250000, adaptive: true, maxIterations: 1000000, batchSize: 250000, tolerancePp: .1 },
          trigger: "admin_manual",
        }),
      }) as { job?: ForecastJob };
      if (!payload.job) throw new Error("forecast_job_missing");
      const completed = payload.job.status === "ready" ? payload.job : await waitForJob(payload.job.id);
      setMessage(`Новый прогноз готов${completed.snapshotId ? ` · snapshot #${completed.snapshotId}` : ""} · ${weight ? `смесь ${weight}% мнения` : "только статистика"}.`);
      await load();
    } catch (error) {
      setHasError(true);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setIsBusy(false); }
  };
  return <main className="admin-page">
    <header><a href="/" className="brand"><span className="brand-glyph">T</span><span>TI / PREDICTOR</span></a><nav><a href="/">Главная</a><a href="/intel">Разведка</a></nav></header>
    <section className="admin-hero"><span>PRIVATE OPERATIONS</span><h1>Управление прогнозом</h1><p>Мнения по командам, смесь и ручной пересчёт живут здесь. На главной автоматически считается только смесь {DEFAULT_OPINION_WEIGHT}%.</p></section>
    {message ? <p className={`admin-notice ${hasError ? "is-error" : ""}`}>{message}</p> : null}
    {!state?.isAdmin ? <form className="admin-login-card" onSubmit={login}><h2>Вход</h2><label>Логин<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></label><label>Пароль<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label><button disabled={isBusy}>Войти</button></form> : <>
      <section className="admin-actions-panel"><header><div><span>SERVER JOBS</span><h2>Синхронизация и пересчёт</h2></div><b className={state.refreshRunning || state.liveSync?.running ? "is-busy" : ""}>{state.refreshRunning ? "REFRESH" : state.liveSync?.running ? "SYNC" : "READY"}</b></header>
        {state.refreshProgress ? <RefreshProgressPanel progress={state.refreshProgress} running={Boolean(state.refreshRunning || state.refreshProgress.running)} /> : null}
        <div className="admin-actions-grid">
        <button disabled={isBusy || state.liveSync?.running} onClick={() => void run("Результаты и расписание синхронизированы.", () => requestJson("/api/admin/live/sync", { method: "POST" }))}>Синхронизировать матчи</button>
        <button disabled={isBusy || state.refreshRunning} onClick={() => void run("Обновление model artifacts запущено.", () => requestJson("/api/admin/refresh", { method: "POST" }))}>Обновить статистику</button>
        <button disabled={isBusy} onClick={() => void startForecast(DEFAULT_OPINION_WEIGHT)}>Monte Carlo 250K · 15%</button>
        <button disabled={isBusy} onClick={() => void run("Раунд 1 подготовлен.", () => requestJson("/api/admin/rounds/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ round: 1 }) }))}>Подготовить раунд 1</button>
        <button disabled={isBusy} onClick={() => void run("Сессия завершена.", () => requestJson("/api/logout", { method: "POST" }))}>Выйти</button>
      </div></section>
      <section className="admin-editor"><header><span>EXPERT PAIRWISE</span><h2>Моё мнение по командам</h2><p>JSON сохраняется на сервере. После сохранения автоматически пересчитывается только смесь 15%. Остальные профили — кнопками ниже. Некорректный формат или значения будут отклонены API.</p></header><textarea value={answers} onChange={(event) => setAnswers(event.target.value)} spellCheck={false} aria-label="Экспертные вероятности JSON" /><button disabled={isBusy} onClick={saveAnswers}>Проверить и сохранить</button></section>
      <section className="admin-reforecast"><header><div><span>FORECAST MIX</span><h2>Пересчёт смеси</h2><p>Автоматически после новых результатов считается только 15% мнения. 0 / 10 / 20 / 30 — только если нажать здесь.</p></div></header>
        <div className="admin-reforecast-grid">{MANUAL_FORECAST_WEIGHTS.map((item) => <button key={item.weight} className={item.weight === DEFAULT_OPINION_WEIGHT ? "is-primary" : ""} disabled={isBusy} onClick={() => void startForecast(item.weight)}>{isBusy ? "Считаем…" : item.label}</button>)}</div>
      </section>
      <section className="admin-snapshots"><header><span>HISTORY</span><h2>Snapshots и diagnostics</h2></header><div>{state.snapshots.slice(0, 30).map((snapshot) => <article key={snapshot.id}><span>#{snapshot.id}</span><div><b>{snapshot.trigger}</b><small>{new Date(snapshot.created_at).toLocaleString("ru-RU")} · {snapshot.completed_match_count} результатов · {snapshot.iterations.toLocaleString("ru-RU")} итераций</small></div><a href={`/api/snapshots/${snapshot.id}/export`}>JSON</a></article>)}</div></section>
    </>}
  </main>;
}
