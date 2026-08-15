"use client";
/* eslint-disable @next/next/no-img-element -- Dota hero icons are external model artifacts. */

import { useEffect, useMemo, useState } from "react";

type HeroRef = { id: number; name: string; icon: string | null };
type PairEvidence = { heroA: HeroRef; heroB: HeroRef; games: number; winRate: number };
type AssignmentRow = { accountId: number; player: string; heroId: number; hero: string; heroIcon: string | null; position: number | null; games: number; winRate: number };
type Assignment = { source: "observed" | "inferred" | "unavailable"; rows: AssignmentRow[] };
export type DraftEvidence = {
  sourceTeamProbability?: number;
  signals?: Array<{ key: string; label: string; contribution: number; sample: number }>;
  assignments?: { radiant: Assignment; dire: Assignment };
  counters?: PairEvidence[];
  synergies?: { radiant: PairEvidence[]; dire: PairEvidence[] };
};
type HistoryPoint = {
  observedAt: string;
  gameTime: number;
  liveEstimate?: { probabilityRadiant: number | null; availability?: string | null };
};
type HistoryResponse = { history: HistoryPoint[]; map?: { draftPrediction?: { evidence?: DraftEvidence | null } | null } | null };

const percentage = (value: number) => `${(value * 100).toFixed(1)}%`;
const sourceLabel = (source: Assignment["source"]) => source === "observed" ? "точно из live-feed" : source === "inferred" ? "гипотеза модели" : "нет данных";

function Timeline({ points, frozen }: { points: HistoryPoint[]; frozen: number | null }) {
  const valid = points.flatMap((point) => Number.isFinite(Number(point.liveEstimate?.probabilityRadiant))
    ? [{ time: Math.max(0, Number(point.gameTime)), probability: Number(point.liveEstimate?.probabilityRadiant), availability: point.liveEstimate?.availability }]
    : []);
  if (!valid.length) return <p className="fusion-story-empty">Live-оценка появится после валидного checkpoint модели.</p>;
  const maxTime = Math.max(1200, ...valid.map((point) => point.time));
  const coordinates = valid.map((point) => `${(point.time / maxTime) * 100},${100 - point.probability * 100}`).join(" ");
  return <div className="fusion-live-timeline">
    <div className="fusion-chart-labels"><span>100%</span><span>50%</span><span>0%</span></div>
    <svg viewBox="0 0 100 100" role="img" aria-label="Вероятность победы Radiant по времени карты" preserveAspectRatio="none">
      <line x1="0" y1="50" x2="100" y2="50" className="fusion-chart-midline" />
      {frozen !== null ? <line x1="0" y1={100 - frozen * 100} x2="100" y2={100 - frozen * 100} className="fusion-chart-frozen" /> : null}
      <polyline points={coordinates} className="fusion-chart-live" />
      {valid.map((point) => <circle key={`${point.time}-${point.probability}`} cx={(point.time / maxTime) * 100} cy={100 - point.probability * 100} r="1.8"><title>{Math.floor(point.time / 60)}:{String(point.time % 60).padStart(2, "0")} · Radiant {percentage(point.probability)} · {point.availability ?? "live"}</title></circle>)}
    </svg>
    <div className="fusion-chart-time"><span>0:00</span><span>{Math.floor(maxTime / 120)}:00</span><span>{Math.floor(maxTime / 60)}:00</span></div>
    <footer><span><i className="is-frozen" />Frozen после драфта</span><span><i className="is-live" />Live observation</span></footer>
  </div>;
}

function AssignmentList({ title, assignment }: { title: string; assignment?: Assignment }) {
  if (!assignment?.rows.length) return <section><header><b>{title}</b><small>нет player×hero evidence</small></header></section>;
  return <section><header><b>{title}</b><small>{sourceLabel(assignment.source)}</small></header>{assignment.rows.map((row) => <div key={`${row.accountId}-${row.heroId}`}><span>{row.heroIcon ? <img src={row.heroIcon} alt="" /> : null}<b>{row.player}</b><i>→</i><strong>{row.hero}</strong></span><small>позиция {row.position ?? "?"} · {row.games ? `${row.games} карт · ${row.winRate.toFixed(1)}%` : "нет выборки"}</small></div>)}</section>;
}

function PairList({ title, rows }: { title: string; rows: PairEvidence[] }) {
  return <section><header><b>{title}</b><small>{rows.length ? `${rows.length} сочетаний` : "нет данных"}</small></header>{rows.slice(0, 8).map((row) => <div key={`${row.heroA.id}-${row.heroB.id}`}><span>{row.heroA.icon ? <img src={row.heroA.icon} alt="" /> : null}<b>{row.heroA.name}</b><i>vs</i>{row.heroB.icon ? <img src={row.heroB.icon} alt="" /> : null}<strong>{row.heroB.name}</strong></span><small>{row.games} карт · {row.winRate.toFixed(1)}%</small></div>)}</section>;
}

export default function LiveMapStory({ matchId, frozenProbabilityRadiant, evidence, autoLoad }: { matchId: string; frozenProbabilityRadiant: number | null; evidence?: DraftEvidence | null; autoLoad: boolean }) {
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);
  const load = async () => {
    if (isLoading) return;
    setIsLoading(true); setHasError(false);
    try {
      const response = await fetch(`/api/draft/live/history/${encodeURIComponent(matchId)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`history_${response.status}`);
      setData(await response.json());
    } catch { setHasError(true); }
    finally { setIsLoading(false); }
  };
  useEffect(() => {
    if (!autoLoad) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setIsLoading(true); setHasError(false);
      try {
        const response = await fetch(`/api/draft/live/history/${encodeURIComponent(matchId)}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`history_${response.status}`);
        const payload = await response.json();
        if (!cancelled) setData(payload);
      } catch { if (!cancelled) setHasError(true); }
      finally { if (!cancelled) setIsLoading(false); }
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [autoLoad, matchId]);
  const resolvedEvidence = evidence ?? data?.map?.draftPrediction?.evidence ?? null;
  const signals = useMemo(() => [...(resolvedEvidence?.signals ?? [])].sort((left, right) => Math.abs(right.contribution) - Math.abs(left.contribution)), [resolvedEvidence]);
  return <details className="fusion-map-story" open={autoLoad}>
    <summary onClick={() => { if (!data && !isLoading) void load(); }}><span>График и почему модель выбрала эту сторону</span><b>{isLoading ? "загрузка…" : data ? "готово" : "раскрыть"}</b></summary>
    {hasError ? <p className="fusion-story-empty">Историю карты загрузить не удалось. Повторите открытие блока.</p> : null}
    {data ? <Timeline points={data.history} frozen={frozenProbabilityRadiant} /> : null}
    {resolvedEvidence ? <div className="fusion-draft-explanation">
      <header><div><small>SERVER-FROZEN EVIDENCE</small><h4>Что изменило прогноз после пиков</h4></div><strong>База {resolvedEvidence.sourceTeamProbability === undefined ? "—" : percentage(resolvedEvidence.sourceTeamProbability)}</strong></header>
      <div className="fusion-signal-list">{signals.map((signal) => <span key={signal.key}><b>{signal.label}</b><i className={signal.contribution >= 0 ? "is-positive" : "is-negative"}>{signal.contribution >= 0 ? "+" : ""}{signal.contribution.toFixed(2)} п.п.</i><small>выборка {signal.sample || "—"}</small></span>)}</div>
      <details><summary>Игроки на героях</summary><div className="fusion-evidence-columns"><AssignmentList title="Radiant" assignment={resolvedEvidence.assignments?.radiant} /><AssignmentList title="Dire" assignment={resolvedEvidence.assignments?.dire} /></div></details>
      <details><summary>Контрпики и синергии</summary><div className="fusion-evidence-columns"><PairList title="Герой против героя" rows={resolvedEvidence.counters ?? []} /><PairList title="Синергии Radiant" rows={resolvedEvidence.synergies?.radiant ?? []} /><PairList title="Синергии Dire" rows={resolvedEvidence.synergies?.dire ?? []} /></div></details>
    </div> : data ? <p className="fusion-story-empty">Для этой старой карты подробное evidence ещё не сохранялось.</p> : null}
  </details>;
}
