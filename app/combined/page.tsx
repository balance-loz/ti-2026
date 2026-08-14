"use client";
/* eslint-disable @next/next/no-html-link-for-pages, @next/next/no-img-element -- Vinext navigation and external Dota hero art use native elements. */

import { Fragment, useEffect, useMemo, useState } from "react";

type Timeliness = { status: "actionable" | "late" | "after_start" | "unverified"; leadMinutes: number | null; eligible: boolean };
type Match = { id: number; stage: "swiss" | "playin" | "playoff"; round: number; team_a: string; team_b: string; winner: string | null; score_a: number | null; score_b: number | null; scheduled_at: string | null; predicted_probability: number | null };
type ExactScore = { score: string; probability: number };
type SeriesRow = {
  match: Match;
  seriesId: string | null;
  forecast: { probabilityA: number; baseMapProbabilityA: number; currentMapProbabilityA: number | null; winsA: number; winsB: number; exactScores: ExactScore[] };
  decision: { probabilityA: number | null; fallbackProbabilityA: number; capturedAt: string | null; timeliness: Timeliness | null; predictedWinner: string; predictedExactScore: string | null; predictedExactScoreProbability: number | null; predictionCorrect: boolean | null; exactScoreCorrect: boolean | null };
  latest: { probabilityA: number; generatedAt: string };
  live: null | { matchId: string; phase: "draft" | "game"; radiantTeam: string; direTeam: string; gameTime: number; radiantScore: number; direScore: number };
  sources: { draftApplied: boolean; liveStateApplied: boolean };
};
type DraftPrediction = { probabilityRadiant: number; modelId: string | null; capturedAt: string; predictedWinner: string; timeliness: Timeliness; predictionCorrect: boolean | null };
type MapRow = { matchId: string; seriesId: string; radiantTeam: string; direTeam: string; winner: string | null; startTime: number | null; duration: number | null; picks: null | { radiant: number[]; dire: number[] }; draftPrediction: DraftPrediction | null };
type BracketNode = { label: string; lane: "upper" | "lower" | "final"; column: number; a: string; b: string; bestOf: number; winner: string; predictedWinner: string; actualWinner: string | null; latestProbabilityA: number; lockedProbabilityA: number | null; decisionProbabilityA: number; exactScore: string | null; exactScoreProbability: number | null; actualScore: string | null; predictionCorrect: boolean | null; status: "completed" | "scheduled" | "projected"; matchId: number | null };
type BetLock = { id: number; scope: "series" | "map"; subjectId: string; teamA: string; teamB: string; probabilityA: number; recommendedWinner: string; exactScore: string | null; source: string; opinionWeight: number; snapshotId: number | null; modelId: string | null; createdAt: string; winner: string | null; actualScore: string | null; predictionCorrect: boolean | null; exactScoreCorrect: boolean | null };
type LockRequest = { scope: "series" | "map"; subjectId: string; probabilityA: number; recommendedWinner: string; exactScore?: string | null; evidence?: Record<string, unknown> };
type CombinedState = { generatedAt: string; opinionWeight: number; isAdmin: boolean; mainSnapshot: null | { id: number; createdAt: string; completedMatchCount: number; mode: string; opinionWeight: number }; series: SeriesRow[]; maps: MapRow[]; betLocks: BetLock[]; bracket: { qualifiers: string[]; nodes: BracketNode[]; champion: string | null }; live: { error: string | null } };
type Hero = { id: number; name: string; image: string; icon?: string };
type StandingRow = { teamId: string; group: "A" | "B"; wins: number; losses: number; liveOpponent: string | null };

const TEAMS: Record<string, { name: string; short: string; logo: string }> = {
  "1w": { name: "1w", short: "1W", logo: "/team-logos/1w.webp" }, aurora: { name: "Aurora", short: "AU", logo: "/team-logos/aurora.webp" },
  betboom: { name: "BETBOOM", short: "BB", logo: "/team-logos/betboom.webp" }, falcons: { name: "Falcons", short: "FL", logo: "/team-logos/falcons.jpg" },
  gamerlegion: { name: "GamerLegion", short: "GL", logo: "/team-logos/gamerlegion.webp" }, l1ga: { name: "L1ga", short: "L1", logo: "/team-logos/l1ga.webp" },
  lgd: { name: "LGD", short: "LG", logo: "/team-logos/lgd.webp" }, liquid: { name: "Liquid", short: "TL", logo: "/team-logos/liquid.webp" },
  nigma: { name: "Nigma", short: "NG", logo: "/team-logos/nigma.webp" }, og: { name: "OG", short: "OG", logo: "/team-logos/og.webp" },
  parivision: { name: "PARIVISION", short: "PV", logo: "/team-logos/parivision.webp" }, resilience: { name: "Resilience", short: "RS", logo: "/team-logos/resilience.webp" },
  spirit: { name: "Spirit", short: "TS", logo: "/team-logos/spirit.webp" }, vg: { name: "VG", short: "VG", logo: "/team-logos/vg.webp" },
  xtreme: { name: "Xtreme", short: "XG", logo: "/team-logos/xtreme.webp" }, yandex: { name: "Yandex", short: "YX", logo: "/team-logos/yandex.webp" },
};
const SWISS_GROUPS = { A: ["parivision", "nigma", "falcons", "og", "betboom", "lgd", "1w", "resilience"], B: ["yandex", "xtreme", "liquid", "vg", "aurora", "gamerlegion", "spirit", "l1ga"] } as const;
const SWISS_GROUP_BY_TEAM = Object.fromEntries(Object.entries(SWISS_GROUPS).flatMap(([group, ids]) => ids.map((id) => [id, group]))) as Record<string, "A" | "B">;
const team = (id: string) => TEAMS[id] ?? { name: id, short: id.toUpperCase(), logo: "" };
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.max(0, seconds % 60)).padStart(2, "0")}`;

function Team({ id }: { id: string }) {
  const item = team(id);
  return <span className="fusion-team">{item.logo ? <img src={item.logo} alt="" /> : null}<b>{item.name}</b></span>;
}

function Grade({ correct, eligible = true }: { correct: boolean | null; eligible?: boolean }) {
  if (!eligible) return <span className="fusion-grade fusion-grade--late">ТОЛЬКО АНАЛИЗ</span>;
  if (correct === null) return <span className="fusion-grade">ЖДЁМ РЕЗУЛЬТАТ</span>;
  return <span className={`fusion-grade ${correct ? "is-correct" : "is-wrong"}`}>{correct ? "УГАДАН" : "НЕ УГАДАН"}</span>;
}

function HeroPicks({ ids, heroes }: { ids: number[]; heroes: Map<number, Hero> }) {
  return <span className="fusion-heroes">{ids.map((id, index) => { const hero = heroes.get(id); return hero ? <img key={`${id}-${index}`} src={hero.image} alt={hero.name} title={hero.name} /> : <i key={`${id}-${index}`} title={`Hero ${id}`}>{id}</i>; })}</span>;
}

function MapStrip({ maps, heroes, locks, isAdmin, locking, onLock }: { maps: MapRow[]; heroes: Map<number, Hero>; locks: BetLock[]; isAdmin: boolean; locking: string | null; onLock: (request: LockRequest) => void }) {
  if (!maps.length) return <p className="fusion-no-maps">Карты и пики появятся здесь после начала драфта.</p>;
  return <div className="fusion-series-maps">{maps.map((map, index) => {
    const prediction = map.draftPrediction;
    const predicted = prediction?.predictedWinner ?? null;
    const predictedProbability = prediction ? (predicted === map.radiantTeam ? prediction.probabilityRadiant : 1 - prediction.probabilityRadiant) : null;
    const betLock = locks.find((lock) => lock.scope === "map" && String(lock.subjectId) === String(map.matchId));
    return <article key={map.matchId} className={map.winner ? "is-complete" : ""}>
      <header><b>КАРТА {index + 1}</b><span>{map.duration ? clock(map.duration) : map.winner ? "завершена" : "ожидание"}</span></header>
      <div className={`fusion-map-side ${map.winner === map.radiantTeam ? "is-winner" : ""}`}><Team id={map.radiantTeam} /><HeroPicks ids={map.picks?.radiant ?? []} heroes={heroes} /><em>{map.winner === map.radiantTeam ? "W" : map.winner ? "L" : "R"}</em></div>
      <div className={`fusion-map-side ${map.winner === map.direTeam ? "is-winner" : ""}`}><Team id={map.direTeam} /><HeroPicks ids={map.picks?.dire ?? []} heroes={heroes} /><em>{map.winner === map.direTeam ? "W" : map.winner ? "L" : "D"}</em></div>
      <footer>{betLock ? <><span><b>СТАВКА · {team(betLock.recommendedWinner).short} {percent(betLock.recommendedWinner === betLock.teamA ? betLock.probabilityA : 1 - betLock.probabilityA)}</b><small>зафиксирована {new Date(betLock.createdAt).toLocaleTimeString("ru-RU")}</small></span><Grade correct={betLock.predictionCorrect} /></> : prediction ? <><span><b>{team(predicted!).short} {percent(predictedProbability!)}</b><small>текущий draft-прогноз · ещё не ставка</small></span>{isAdmin && !map.winner ? <button className="fusion-bet-button" disabled={locking === `map:${map.matchId}`} onClick={() => onLock({ scope: "map", subjectId: map.matchId, probabilityA: prediction.probabilityRadiant, recommendedWinner: predicted!, evidence: { capturedAt: prediction.capturedAt, modelId: prediction.modelId } })}>{locking === `map:${map.matchId}` ? "Фиксирую…" : "Я поставил по рекомендации"}</button> : <Grade correct={null} />}</> : <span><b>Нет draft-прогноза</b><small>ставку задним числом не создаём</small></span>}</footer>
    </article>;
  })}</div>;
}

function mapsForSeries(row: SeriesRow, maps: MapRow[]) {
  if (row.seriesId) return maps.filter((map) => String(map.seriesId) === String(row.seriesId)).sort((a, b) => Number(a.startTime || 0) - Number(b.startTime || 0));
  return [];
}

function buildMatchStandings(rows: SeriesRow[]): StandingRow[] {
  const table = new Map<string, StandingRow>(Object.keys(TEAMS).map((teamId) => [teamId, { teamId, group: SWISS_GROUP_BY_TEAM[teamId], wins: 0, losses: 0, liveOpponent: null }]));
  for (const row of rows) {
    const a = table.get(row.match.team_a); const b = table.get(row.match.team_b);
    if (!a || !b) continue;
    if (row.match.winner === a.teamId) { a.wins += 1; b.losses += 1; }
    else if (row.match.winner === b.teamId) { b.wins += 1; a.losses += 1; }
    else if (row.live) { a.liveOpponent = b.teamId; b.liveOpponent = a.teamId; }
  }
  return [...table.values()].sort((a, b) => b.wins - a.wins || a.losses - b.losses || team(a.teamId).name.localeCompare(team(b.teamId).name, "ru"));
}

function MatchStandings({ rows }: { rows: SeriesRow[] }) {
  const standings = useMemo(() => buildMatchStandings(rows), [rows]);
  return <section className="fusion-panel fusion-standings"><header><div><span>SWISS</span><h2>Таблица по матчам</h2></div><b>{rows.filter((row) => row.match.winner).length}</b></header><div className="fusion-table-wrap"><table className="fusion-table fusion-standings-table"><thead><tr><th>#</th><th>Команда</th><th>Группа</th><th>Матчи</th><th>Сейчас</th></tr></thead><tbody>{standings.map((row) => { const place = standings.findIndex((item) => item.wins === row.wins && item.losses === row.losses) + 1; return <tr key={row.teamId}><td><strong>{place}</strong></td><td><Team id={row.teamId} /></td><td><span className={`fusion-group fusion-group--${row.group.toLowerCase()}`}>{row.group === "A" ? "A" : "Б"}</span></td><td><strong>{row.wins}–{row.losses}</strong><small>серии</small></td><td>{row.liveOpponent ? <span className="fusion-status fusion-status--live">LIVE · {team(row.liveOpponent).short}</span> : <span className="fusion-status">{row.wins + row.losses} сыграно</span>}</td></tr>; })}</tbody></table></div></section>;
}

function SeriesForecastTable({ title, rows, maps, heroes, locks, isAdmin, locking, onLock }: { title: string; rows: SeriesRow[]; maps: MapRow[]; heroes: Map<number, Hero>; locks: BetLock[]; isAdmin: boolean; locking: string | null; onLock: (request: LockRequest) => void }) {
  return <section className="fusion-panel"><header><div><span>ПАРЫ И КАРТЫ</span><h2>{title}</h2></div><b>{rows.length}</b></header><div className="fusion-table-wrap"><table className="fusion-table fusion-series-table"><thead><tr><th>Пара</th><th>MAIN / СТАВКА</th><th>Точный счёт</th><th>LATEST</th><th>Факт</th></tr></thead><tbody>{rows.map((row) => {
    const betLock = locks.find((lock) => lock.scope === "series" && String(lock.subjectId) === String(row.match.id));
    const latestProbabilityA = row.forecast.probabilityA;
    const latestWinner = latestProbabilityA >= .5 ? row.match.team_a : row.match.team_b;
    const latestExact = [...row.forecast.exactScores].sort((a, b) => b.probability - a.probability)[0] ?? null;
    const displayProbabilityA = betLock?.probabilityA ?? latestProbabilityA;
    const displayWinner = betLock?.recommendedWinner ?? latestWinner;
    const displayExact = betLock?.exactScore ?? latestExact?.score ?? null;
    const delta = (latestProbabilityA - displayProbabilityA) * 100;
    const seriesMaps = mapsForSeries(row, maps);
    return <Fragment key={row.match.id}>
      <tr className={row.live ? "is-live" : row.match.winner ? "is-complete" : ""}>
        <td><small>{row.match.stage === "swiss" ? "SW" : row.match.stage === "playin" ? "PI" : "PO"} R{row.match.round}</small><span className="fusion-matchup"><Team id={row.match.team_a} /><i>—</i><Team id={row.match.team_b} /></span></td>
        <td>{betLock ? <><span className="fusion-lock">СТАВКА ЗАФИКСИРОВАНА</span><strong>{team(displayWinner).short} {percent(displayWinner === row.match.team_a ? displayProbabilityA : 1 - displayProbabilityA)}</strong><small>{new Date(betLock.createdAt).toLocaleString("ru-RU")} · профиль {betLock.opinionWeight}%</small></> : <><span className="fusion-lock fusion-lock--snapshot">ТЕКУЩАЯ РЕКОМЕНДАЦИЯ</span><strong>{team(displayWinner).short} {percent(displayWinner === row.match.team_a ? displayProbabilityA : 1 - displayProbabilityA)}</strong>{isAdmin && !row.match.winner ? <button className="fusion-bet-button" disabled={locking === `series:${row.match.id}`} onClick={() => onLock({ scope: "series", subjectId: String(row.match.id), probabilityA: latestProbabilityA, recommendedWinner: latestWinner, exactScore: latestExact?.score, evidence: { exactScores: row.forecast.exactScores, sources: row.sources } })}>{locking === `series:${row.match.id}` ? "Фиксирую…" : "Я поставил по рекомендации"}</button> : <small>может обновляться до фиксации ставки</small>}</>}</td>
        <td><strong>{displayExact ?? "—"}</strong><small>{betLock ? "сохранено со ставкой" : latestExact ? `${percent(latestExact.probability)} сценариев · обновляется` : "нет расчёта"}</small></td>
        <td><strong>{team(latestWinner).short} {percent(latestWinner === row.match.team_a ? latestProbabilityA : 1 - latestProbabilityA)}</strong><small className={Math.abs(delta) >= 5 ? "fusion-delta is-large" : "fusion-delta"}>{betLock ? `${delta >= 0 ? "+" : ""}${delta.toFixed(1)} п.п. для ${team(row.match.team_a).short}` : "та же текущая рекомендация"}{row.sources.liveStateApplied ? " · LIVE" : row.sources.draftApplied ? " · DRAFT" : " · новые серии"}</small></td>
        <td>{row.match.winner ? <><strong>{row.match.score_a}:{row.match.score_b} · {team(row.match.winner).short}</strong>{betLock ? <Grade correct={betLock.predictionCorrect} /> : <span className="fusion-grade fusion-grade--late">СТАВКИ НЕ БЫЛО</span>}</> : row.live ? <><strong>{row.forecast.winsA}:{row.forecast.winsB} · {clock(row.live.gameTime)}</strong><span className="fusion-status fusion-status--live">LIVE</span></> : <span className="fusion-status fusion-status--next">до матча</span>}</td>
      </tr>
      <tr className="fusion-map-row"><td colSpan={5}><MapStrip maps={seriesMaps} heroes={heroes} locks={locks} isAdmin={isAdmin} locking={locking} onLock={onLock} /></td></tr>
    </Fragment>;
  })}</tbody></table></div></section>;
}

function BracketCard({ node, series, maps, heroes, locks, isAdmin, locking, onLock }: { node: BracketNode; series: SeriesRow[]; maps: MapRow[]; heroes: Map<number, Hero>; locks: BetLock[]; isAdmin: boolean; locking: string | null; onLock: (request: LockRequest) => void }) {
  const actualSeries = node.matchId === null ? null : series.find((row) => row.match.id === node.matchId) ?? null;
  const nodeMaps = actualSeries ? mapsForSeries(actualSeries, maps) : [];
  const betLock = node.matchId === null ? null : locks.find((lock) => lock.scope === "series" && String(lock.subjectId) === String(node.matchId)) ?? null;
  const probabilityA = betLock?.teamA === node.a ? betLock.probabilityA : betLock?.teamB === node.a ? 1 - betLock.probabilityA : node.latestProbabilityA;
  const predictedWinner = betLock?.recommendedWinner ?? (probabilityA >= .5 ? node.a : node.b);
  const exactScore = betLock?.exactScore ?? node.exactScore;
  return <article className={`fusion-bracket-card fusion-bracket-card--${node.status} ${betLock?.predictionCorrect === true ? "is-correct" : betLock?.predictionCorrect === false ? "is-wrong" : ""}`}>
    <header><span>{node.label}</span><b>BO{node.bestOf}</b></header>
    <div className={predictedWinner === node.a ? "is-winner" : ""}><Team id={node.a} /><em>{percent(probabilityA)}</em></div>
    <div className={predictedWinner === node.b ? "is-winner" : ""}><Team id={node.b} /><em>{percent(1 - probabilityA)}</em></div>
    <p><span>прогноз <b>{exactScore}</b></span>{node.actualScore ? <span>факт <b>{node.actualScore}</b></span> : <span>{betLock ? "ставка locked" : "main · обновляется"}</span>}</p>
    {node.actualWinner ? (betLock ? <Grade correct={betLock.predictionCorrect} /> : <span className="fusion-grade fusion-grade--late">СТАВКИ НЕ БЫЛО</span>) : betLock ? <small>ставка: {team(betLock.recommendedWinner).name}</small> : actualSeries && isAdmin ? <button className="fusion-bet-button" disabled={locking === `series:${actualSeries.match.id}`} onClick={() => onLock({ scope: "series", subjectId: String(actualSeries.match.id), probabilityA: actualSeries.forecast.probabilityA, recommendedWinner: actualSeries.forecast.probabilityA >= .5 ? actualSeries.match.team_a : actualSeries.match.team_b, exactScore: [...actualSeries.forecast.exactScores].sort((a, b) => b.probability - a.probability)[0]?.score, evidence: { bracketLabel: node.label } })}>Я поставил по рекомендации</button> : <small>→ дальше: {team(node.winner).name}</small>}
    {nodeMaps.length ? <MapStrip maps={nodeMaps} heroes={heroes} locks={locks} isAdmin={isAdmin} locking={locking} onLock={onLock} /> : null}
  </article>;
}

function PlayoffBracket({ state, heroes, locking, onLock }: { state: CombinedState; heroes: Map<number, Hero>; locking: string | null; onLock: (request: LockRequest) => void }) {
  const columns = [1, 2, 3, 4, 5, 6];
  const lane = (name: "upper" | "lower" | "final") => <div className={`fusion-bracket-lane fusion-bracket-lane--${name}`}>{columns.map((column) => <section key={`${name}-${column}`}><h4>{column === 6 ? "Гранд-финал" : name === "upper" ? `Верхняя · ${column}` : `Нижняя · ${column}`}</h4>{state.bracket.nodes.filter((node) => node.lane === name && node.column === column).map((node) => <BracketCard key={node.label} node={node} series={state.series} maps={state.maps} heroes={heroes} locks={state.betLocks} isAdmin={state.isAdmin} locking={locking} onLock={onLock} />)}</section>)}</div>;
  return <section className="fusion-panel fusion-bracket"><header><div><span>MAIN FORECAST · DOUBLE ELIMINATION</span><h2>Как развивается сетка</h2></div><b>{state.bracket.champion ? team(state.bracket.champion).short : "—"}</b></header>{state.bracket.nodes.length ? <div className="fusion-bracket-scroll">{lane("upper")}{lane("lower")}{lane("final")}</div> : <p className="fusion-empty">Сетка появится после сохранения основного Monte Carlo snapshot с восьмёркой участников.</p>}</section>;
}

export default function CombinedForecastPage() {
  const [opinionWeight, setOpinionWeight] = useState(10);
  const [state, setState] = useState<CombinedState | null>(null);
  const [heroes, setHeroes] = useState<Map<number, Hero>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [locking, setLocking] = useState<string | null>(null);
  const [lockMessage, setLockMessage] = useState<string | null>(null);
  useEffect(() => { fetch("/draft-stats.json").then((response) => response.json()).then((data) => setHeroes(new Map((data.heroes as Hero[]).map((hero) => [hero.id, hero])))).catch(() => undefined); }, []);
  useEffect(() => { let cancelled = false; const load = async () => { try { const response = await fetch(`/api/combined?opinionWeight=${opinionWeight}`, { cache: "no-store" }); if (!response.ok) throw new Error(`API ${response.status}`); const data = await response.json(); if (!cancelled) { setState(data); setError(null); } } catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); } }; void load(); const timer = window.setInterval(() => void load(), 10_000); return () => { cancelled = true; window.clearInterval(timer); }; }, [opinionWeight, refreshKey]);
  const lockBet = async (request: LockRequest) => {
    const key = `${request.scope}:${request.subjectId}`; setLocking(key); setLockMessage(null);
    try {
      const response = await fetch("/api/admin/bet-locks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...request, opinionWeight, snapshotId: state?.mainSnapshot?.id ?? null }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error === "admin_required" ? "Нужно войти в админский режим на главной странице." : payload.error === "bet_already_locked" ? "Эта ставка уже зафиксирована." : payload.error || `API ${response.status}`);
      setLockMessage("Ставка зафиксирована. Последующие live-обновления её не изменят."); setRefreshKey((value) => value + 1);
    } catch (reason) { setLockMessage(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLocking(null); }
  };
  const swiss = useMemo(() => state?.series.filter((row) => row.match.stage === "swiss") ?? [], [state]);
  const playins = useMemo(() => state?.series.filter((row) => row.match.stage === "playin") ?? [], [state]);
  const gradedSeriesBets = useMemo(() => state?.betLocks.filter((lock) => lock.scope === "series" && lock.winner) ?? [], [state]);
  const gradedMapBets = useMemo(() => state?.betLocks.filter((lock) => lock.scope === "map" && lock.winner) ?? [], [state]);
  const seriesCorrect = gradedSeriesBets.filter((lock) => lock.predictionCorrect).length;
  const draftCorrect = gradedMapBets.filter((lock) => lock.predictionCorrect).length;
  return <main className="fusion-page"><header className="fusion-topbar"><a href="/" className="brand"><span className="brand-glyph">T</span><span>TI / PREDICTOR</span></a><nav><a href="/">Турнир</a><a href="/drafts">Пики</a><a href="/intel">Разведка</a><a className="active" href="/combined">Общий прогноз</a></nav><span className="live-pill"><i /> LIVE FUSION</span></header>
    <section className="fusion-hero fusion-hero--compact"><div><p>TABLE · BRACKET · MAP DRAFT · RESULT</p><h1>Прогноз,<br /><em>который помнит.</em></h1><span>Пока ставки нет, рекомендация свободно обновляется после новых матчей, пиков и live-данных. Нажатие «Я поставил» создаёт неизменяемый снимок именно того прогноза, по которому принято решение.</span></div><aside><label><span>ОСНОВНОЙ ПРОФИЛЬ</span><select value={opinionWeight} onChange={(event) => setOpinionWeight(Number(event.target.value))}><option value={0}>0% · только статистика</option><option value={10}>10% · рекомендуемая смесь</option><option value={20}>20% · заметное влияние</option><option value={30}>30% · агрессивно</option></select></label><div><span><b>СТАВКИ НЕТ</b>можно обновлять</span><i>→</i><span><b>Я ПОСТАВИЛ</b>заморозить</span></div><small>{state?.isAdmin ? "Админский режим активен · кнопки фиксации доступны" : "Войдите в админский режим на главной странице, чтобы фиксировать ставки"}</small></aside></section>
    {error ? <p className="fusion-error">Не удалось загрузить общий прогноз: {error}</p> : null}
    {lockMessage ? <p className="fusion-lock-message">{lockMessage}</p> : null}
    <section className="fusion-decision-rule"><article><b>1</b><h3>Рекомендация</h3><p>Без ставки MAIN/LATEST может перепрогнозироваться сколько угодно.</p></article><article><b>2</b><h3>Нажал «Я поставил»</h3><p>Сохраняются победитель, вероятность, точный счёт, профиль, модель, пики и время.</p></article><article><b>3</b><h3>Пришёл результат</h3><p>Ставка получает «угадан/не угадан»; новые расчёты рядом не меняют историю.</p></article></section>
    <section className="fusion-metrics"><article><span>СТАВКИ НА СЕРИИ</span><b>{gradedSeriesBets.length ? `${seriesCorrect}/${gradedSeriesBets.length}` : "—"}</b><small>угадано из завершённых ставок</small></article><article><span>СТАВКИ ПОСЛЕ ПИКОВ</span><b>{gradedMapBets.length ? `${draftCorrect}/${gradedMapBets.length}` : "—"}</b><small>угадано карт из завершённых ставок</small></article><article><span>ВСЕГО ЗАФИКСИРОВАНО</span><b>{state?.betLocks.length ?? "—"}</b><small>неизменяемых решений</small></article><article><span>ОБНОВЛЕНО</span><b>{state ? new Date(state.generatedAt).toLocaleTimeString("ru-RU") : "—"}</b><small>{state?.live.error ? "live-feed с ошибкой" : "опрос каждые 10 секунд"}</small></article></section>
    <MatchStandings rows={swiss} />
    <SeriesForecastTable title="Матчи группового этапа" rows={swiss} maps={state?.maps ?? []} heroes={heroes} locks={state?.betLocks ?? []} isAdmin={Boolean(state?.isAdmin)} locking={locking} onLock={lockBet} />
    {playins.length ? <SeriesForecastTable title="Стыковые матчи" rows={playins} maps={state?.maps ?? []} heroes={heroes} locks={state?.betLocks ?? []} isAdmin={Boolean(state?.isAdmin)} locking={locking} onLock={lockBet} /> : null}
    {state ? <PlayoffBracket state={state} heroes={heroes} locking={locking} onLock={lockBet} /> : null}
    <footer><div className="brand"><span className="brand-glyph">T</span><span>TI / PREDICTOR</span></div><p>LOCKED оценивает решение · LATEST объясняет новую информацию</p><a href="/drafts">Открыть Draft Lab →</a></footer>
  </main>;
}
