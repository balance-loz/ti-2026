"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- Vinext uses native navigation in this project. */

import { useEffect, useState, type FormEvent } from "react";

type Snapshot = { id: number; trigger: string; created_at: string; completed_match_count: number; iterations: number };
type AdminState = { isAdmin: boolean; answers: Record<string, number>; snapshots: Snapshot[]; refreshRunning: boolean; liveSync?: { running?: boolean; lastSync?: { updatedAt?: string; ok?: boolean } | null } };

async function requestJson(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `API ${response.status}`);
  return payload;
}

export default function AdminPage() {
  const [state, setState] = useState<AdminState | null>(null);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [answers, setAnswers] = useState("{}");
  const [message, setMessage] = useState("");
  const [hasError, setHasError] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const load = async () => {
    try {
      const next = await requestJson("/api/state", { cache: "no-store" }) as AdminState;
      setState(next); setAnswers(JSON.stringify(next.answers, null, 2));
    } catch (error) { setHasError(true); setMessage(error instanceof Error ? error.message : String(error)); }
  };
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, []);
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
  const saveAnswers = () => void run("Экспертные вероятности сохранены.", async () => {
    const parsed = JSON.parse(answers);
    return requestJson("/api/admin/answers", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers: parsed }) });
  });
  const startManualForecast = () => void run("Ручной прогон поставлен в серверную очередь.", () => requestJson("/api/forecast/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "manual", profile: { forecastMode: "stats", opinionWeight: 0, answers: {} }, simulation: { iterations: 250000, adaptive: true }, trigger: "admin_manual" }),
  }));
  return <main className="admin-page">
    <header><a href="/" className="brand"><span className="brand-glyph">T</span><span>TI / PREDICTOR</span></a><nav><a href="/">Главная</a><a href="/intel">Разведка</a></nav></header>
    <section className="admin-hero"><span>PRIVATE OPERATIONS</span><h1>Управление прогнозом</h1><p>Редкие и тяжёлые операции вынесены с публичной главной. API по-прежнему проверяет серверную сессию.</p></section>
    {message ? <p className={`admin-notice ${hasError ? "is-error" : ""}`}>{message}</p> : null}
    {!state?.isAdmin ? <form className="admin-login-card" onSubmit={login}><h2>Вход</h2><label>Логин<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></label><label>Пароль<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label><button disabled={isBusy}>Войти</button></form> : <>
      <section className="admin-actions-panel"><header><div><span>SERVER JOBS</span><h2>Синхронизация и пересчёт</h2></div><b>{state.liveSync?.running ? "RUNNING" : "READY"}</b></header><div>
        <button disabled={isBusy || state.liveSync?.running} onClick={() => void run("Результаты и расписание синхронизированы.", () => requestJson("/api/admin/live/sync", { method: "POST" }))}>Синхронизировать матчи</button>
        <button disabled={isBusy || state.refreshRunning} onClick={() => void run("Обновление model artifacts запущено.", () => requestJson("/api/admin/refresh", { method: "POST" }))}>Обновить статистику</button>
        <button disabled={isBusy} onClick={startManualForecast}>Monte Carlo 250K</button>
        <button disabled={isBusy} onClick={() => void run("Раунд 1 подготовлен.", () => requestJson("/api/admin/rounds/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ round: 1 }) }))}>Подготовить раунд 1</button>
        <button disabled={isBusy} onClick={() => void run("Сессия завершена.", () => requestJson("/api/logout", { method: "POST" }))}>Выйти</button>
      </div></section>
      <section className="admin-editor"><header><span>EXPERT PAIRWISE</span><h2>Канонические экспертные вероятности</h2><p>JSON сохраняется на сервере. Некорректный формат или значения будут отклонены API.</p></header><textarea value={answers} onChange={(event) => setAnswers(event.target.value)} spellCheck={false} /><button disabled={isBusy} onClick={saveAnswers}>Проверить и сохранить</button></section>
      <section className="admin-snapshots"><header><span>HISTORY</span><h2>Snapshots и diagnostics</h2></header><div>{state.snapshots.slice(0, 30).map((snapshot) => <article key={snapshot.id}><span>#{snapshot.id}</span><div><b>{snapshot.trigger}</b><small>{new Date(snapshot.created_at).toLocaleString("ru-RU")} · {snapshot.completed_match_count} результатов · {snapshot.iterations.toLocaleString("ru-RU")} итераций</small></div><a href={`/api/snapshots/${snapshot.id}/export`}>JSON</a></article>)}</div></section>
    </>}
  </main>;
}
