"use client";
/* eslint-disable @next/next/no-html-link-for-pages, @next/next/no-img-element -- Vinext navigation and local team assets intentionally use native elements. */

import { useEffect, useMemo, useState } from "react";

type Match = { id: number; stage: "swiss" | "playin" | "playoff"; round: number; team_a: string; team_b: string; winner: string | null; score_a: number | null; score_b: number | null; scheduled_at: string | null; predicted_probability: number | null };
type ExactScore = { score: string; probability: number };
type SeriesRow = {
  match: Match; seriesId: string | null;
  forecast: { probabilityA: number; frozenSeriesProbabilityA: number; baseMapProbabilityA: number; currentMapProbabilityA: number | null; winsA: number; winsB: number; exactScores: ExactScore[] };
  live: null | { matchId: string; phase: "draft" | "game"; radiantTeam: string; direTeam: string; gameTime: number; radiantScore: number; direScore: number; radiantLead: number | null };
  liveEstimate: null | { liveProbabilityRadiant: number | null; availability: string; assessment: { status: string; settled: boolean; stale: boolean } };
  sources: { opinionWeight: number; statisticsWeight: number; onlineSeriesCount: number; draftApplied: boolean; liveStateApplied: boolean };
};
type MapRow = { matchId: string; seriesId: string; radiantTeam: string; direTeam: string; winner: string | null; startTime: number | null; duration: number | null; patch: number | null; firstPickTeam: string | null; picks: null | { radiant: number[]; dire: number[] }; bans: null | { radiant: number[]; dire: number[] }; players: unknown[] | null; draftPrediction: null | { probabilityRadiant: number; modelId: string | null; capturedAt: string } };
type CombinedState = { generatedAt: string; opinionWeight: number; policy: Record<string, string>; series: SeriesRow[]; maps: MapRow[]; live: { fetchedAt: string | null; error: string | null } };
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
const SWISS_GROUPS = {
  A: ["parivision", "nigma", "falcons", "og", "betboom", "lgd", "1w", "resilience"],
  B: ["yandex", "xtreme", "liquid", "vg", "aurora", "gamerlegion", "spirit", "l1ga"],
} as const;
const SWISS_GROUP_BY_TEAM = Object.fromEntries(Object.entries(SWISS_GROUPS).flatMap(([group, ids]) => ids.map((id) => [id, group]))) as Record<string, "A" | "B">;
const team = (id: string) => TEAMS[id] ?? { name: id, short: id.toUpperCase(), logo: "" };
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.max(0, seconds % 60)).padStart(2, "0")}`;

function Team({ id }: { id: string }) {
  const item = team(id);
  return <span className="fusion-team">{item.logo ? <img src={item.logo} alt="" /> : null}<b>{item.name}</b></span>;
}

function buildMatchStandings(rows: SeriesRow[]): StandingRow[] {
  const table = new Map<string, StandingRow>(Object.keys(TEAMS).map((teamId) => [teamId, { teamId, group: SWISS_GROUP_BY_TEAM[teamId], wins: 0, losses: 0, liveOpponent: null }]));
  for (const row of rows) {
    const a = table.get(row.match.team_a); const b = table.get(row.match.team_b);
    if (!a || !b) continue;
    if (row.match.winner) {
      if (row.match.winner === a.teamId) { a.wins += 1; b.losses += 1; }
      else { b.wins += 1; a.losses += 1; }
    } else if (row.live) {
      a.liveOpponent = b.teamId; b.liveOpponent = a.teamId;
    }
  }
  return [...table.values()].sort((a, b) => b.wins - a.wins || a.losses - b.losses || team(a.teamId).name.localeCompare(team(b.teamId).name, "ru"));
}

function MatchStandings({ rows }: { rows: SeriesRow[] }) {
  const standings = useMemo(() => buildMatchStandings(rows), [rows]);
  return <section className="fusion-panel fusion-standings"><header><div><span>ГРУППОВОЙ ЭТАП</span><h2>Положение по матчам</h2></div><b>{rows.filter((row) => row.match.winner).length}</b></header><div className="fusion-table-wrap"><table className="fusion-table fusion-standings-table"><thead><tr><th>#</th><th>Команда</th><th>Группа</th><th>Счёт по матчам</th><th>Сейчас</th></tr></thead><tbody>{standings.map((row) => { const place = standings.findIndex((item) => item.wins === row.wins && item.losses === row.losses) + 1; return <tr key={row.teamId}><td><strong>{place}</strong></td><td><Team id={row.teamId} /></td><td><span className={`fusion-group fusion-group--${row.group.toLowerCase()}`}>{row.group === "A" ? "A" : "Б"}</span></td><td><strong>{row.wins}–{row.losses}</strong><small>победы — поражения</small></td><td>{row.liveOpponent ? <span className="fusion-status fusion-status--live">LIVE · {team(row.liveOpponent).short}</span> : <span className="fusion-status">{row.wins + row.losses} сыграно</span>}</td></tr>; })}</tbody></table></div><p className="fusion-table-note">Рейтинг строится по победам и поражениям в сериях. При равном счёте команды делят место до применения официального тай-брейка; карты остаются детализацией конкретного матча.</p></section>;
}

function SeriesTable({ title, rows }: { title: string; rows: SeriesRow[] }) {
  return <section className="fusion-panel"><header><div><span>МАТЧИ</span><h2>{title}</h2></div><b>{rows.length}</b></header><div className="fusion-table-wrap"><table className="fusion-table"><thead><tr><th>Раунд / матч</th><th>Карты в матче</th><th>До пиков</th><th>Карта сейчас</th><th>Матч сейчас</th><th>Точный счёт карт</th><th>Статус</th></tr></thead><tbody>{rows.map((row) => {
    const { match, forecast } = row; const winnerA = forecast.probabilityA >= .5; const result = match.winner ? `${match.score_a}:${match.score_b}` : row.live ? `${forecast.winsA}:${forecast.winsB}` : "0:0";
    return <tr key={match.id} className={row.live ? "is-live" : match.winner ? "is-complete" : ""}><td><small>{match.stage === "swiss" ? "SW" : match.stage === "playin" ? "PI" : "PO"} R{match.round}</small><span className="fusion-matchup"><Team id={match.team_a} /><i>—</i><Team id={match.team_b} /></span></td><td><strong>{result}</strong>{match.winner ? <small>победа {team(match.winner).short}</small> : null}</td><td><strong>{percent(forecast.frozenSeriesProbabilityA)}</strong><small>{team(match.team_a).short} · team + online</small></td><td><strong>{forecast.currentMapProbabilityA === null ? percent(forecast.baseMapProbabilityA) : percent(forecast.currentMapProbabilityA)}</strong><small>{forecast.currentMapProbabilityA === null ? "prior карты" : row.sources.liveStateApplied ? "draft + live state" : "замороженный draft"}</small></td><td><strong>{percent(winnerA ? forecast.probabilityA : 1 - forecast.probabilityA)}</strong><small>{team(winnerA ? match.team_a : match.team_b).short}</small></td><td><div className="fusion-scores">{forecast.exactScores.slice(0, 4).map((score) => <span key={score.score}><b>{score.score}</b>{percent(score.probability)}</span>)}</div></td><td>{row.live ? <span className="fusion-status fusion-status--live">LIVE · {row.live.phase === "draft" ? "драфт" : clock(row.live.gameTime)}</span> : match.winner ? <span className="fusion-status">завершён</span> : <span className="fusion-status fusion-status--next">до матча</span>}<small>{match.scheduled_at ? new Date(match.scheduled_at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "время не объявлено"}</small></td></tr>;
  })}</tbody></table></div></section>;
}

export default function CombinedForecastPage() {
  const [opinionWeight, setOpinionWeight] = useState(10); const [state, setState] = useState<CombinedState | null>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => { let cancelled = false; const load = async () => { try { const response = await fetch(`/api/combined?opinionWeight=${opinionWeight}`, { cache: "no-store" }); if (!response.ok) throw new Error(`API ${response.status}`); const data = await response.json(); if (!cancelled) { setState(data); setError(null); } } catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); } }; void load(); const timer = window.setInterval(() => void load(), 10_000); return () => { cancelled = true; window.clearInterval(timer); }; }, [opinionWeight]);
  const group = useMemo(() => state?.series.filter((row) => row.match.stage === "swiss") ?? [], [state]);
  const playoff = useMemo(() => state?.series.filter((row) => row.match.stage !== "swiss") ?? [], [state]);
  const evaluatedMaps = useMemo(() => state?.maps.filter((map) => map.winner && map.draftPrediction) ?? [], [state]);
  const draftScore = useMemo(() => evaluatedMaps.length ? { correct: evaluatedMaps.filter((map) => (map.draftPrediction!.probabilityRadiant >= .5 ? map.radiantTeam : map.direTeam) === map.winner).length, brier: evaluatedMaps.reduce((sum, map) => { const outcome = map.winner === map.radiantTeam ? 1 : 0; return sum + (map.draftPrediction!.probabilityRadiant - outcome) ** 2; }, 0) / evaluatedMaps.length } : null, [evaluatedMaps]);
  return <main className="fusion-page"><header className="fusion-topbar"><a href="/" className="brand"><span className="brand-glyph">T</span><span>TI / PREDICTOR</span></a><nav><a href="/">Турнир</a><a href="/drafts">Пики</a><a href="/intel">Разведка</a><a className="active" href="/combined">Общий прогноз</a></nav><span className="live-pill"><i /> LIVE FUSION</span></header>
    <section className="fusion-hero"><div><p>TEAM · ONLINE · DRAFT · LIVE MAP</p><h1>Один прогноз.<br /><em>Каждый матч.</em></h1><span>Положение считается по победам и поражениям в матчах. Командный prior обновляется результатами TI ровно один раз; драфт и live-состояние уточняют текущую карту, но не подменяют матчевый счёт.</span></div><aside><label><span>ЛИЧНОЕ МНЕНИЕ</span><select value={opinionWeight} onChange={(event) => setOpinionWeight(Number(event.target.value))}><option value={0}>0% · только статистика</option><option value={10}>10% · рекомендуемая смесь</option><option value={20}>20% · заметное влияние</option><option value={30}>30% · агрессивно</option></select></label><div><span><b>{100 - opinionWeight}%</b>статистика</span><i>+</i><span><b>{opinionWeight}%</b>моя оценка</span><i>+</i><span><b>LIVE</b>драфт / карта</span></div><small>При смене веса пересчитывается отображение, но сохранённые pre-match и draft-снимки не переписываются.</small></aside></section>
    {error ? <p className="fusion-error">Не удалось загрузить общий прогноз: {error}</p> : null}
    <section className="fusion-metrics"><article><span>ЗАВЕРШЕНО</span><b>{state?.series.filter((row) => row.match.winner).length ?? "—"}</b><small>серий, online-учёт ровно один раз</small></article><article><span>КАРТЫ В БАЗЕ</span><b>{state?.maps.length ?? "—"}</b><small>результаты, стороны и драфты</small></article><article><span>DRAFT ПРОВЕРЕН</span><b>{draftScore ? `${draftScore.correct}/${evaluatedMaps.length}` : "—"}</b><small>Brier {draftScore?.brier.toFixed(3) ?? "ждёт сохранённых прогнозов"}</small></article><article><span>ОБНОВЛЕНО</span><b>{state ? new Date(state.generatedAt).toLocaleTimeString("ru-RU") : "—"}</b><small>{state?.live.error ? "live-feed с ошибкой" : "опрос каждые 10 секунд"}</small></article></section>
    <MatchStandings rows={group} />
    <SeriesTable title="Матчи группового этапа" rows={group} />
    <SeriesTable title="Стыки и плей-офф" rows={playoff} />
    <section className="fusion-panel"><header><div><span>КАРТЫ И ПРОВЕРКИ</span><h2>Сохранённые map-level прогнозы</h2></div><b>{state?.maps.length ?? 0}</b></header><div className="fusion-map-grid">{state?.maps.slice().reverse().map((map) => { const prediction = map.draftPrediction; const predicted = prediction ? (prediction.probabilityRadiant >= .5 ? map.radiantTeam : map.direTeam) : null; const correct = predicted && map.winner ? predicted === map.winner : null; return <article key={map.matchId}><header><span>MAP {map.matchId}</span><b>{map.duration ? `${Math.floor(map.duration / 60)}:${String(map.duration % 60).padStart(2, "0")}` : "—"}</b></header><div><Team id={map.radiantTeam} /><i>R</i><span>vs</span><i>D</i><Team id={map.direTeam} /></div><p>{prediction ? <><b>{percent(prediction.probabilityRadiant)}</b> Radiant · {prediction.modelId ?? "active combiner"}</> : "draft-прогноз не был сохранён"}</p><footer><span>{map.picks?.radiant.length ?? 0}+{map.picks?.dire.length ?? 0} пиков · {(map.bans?.radiant.length ?? 0) + (map.bans?.dire.length ?? 0)} банов</span>{correct === null ? <em>не оценено</em> : <em className={correct ? "is-correct" : "is-wrong"}>{correct ? "ВЕРНО" : "ОШИБКА"}</em>}</footer></article>; })}</div>{!state?.maps.length ? <p className="fusion-empty">Карты появятся после первого live-sync новой версии API. Исторические детали догружаются пакетами без блокировки прогноза.</p> : null}</section>
    <section className="fusion-policy"><article><b>1</b><h3>Frozen baseline</h3><p>История до TI не переучивается во время турнира. R1–R3 не могут попасть одновременно в baseline и online-слой.</p></article><article><b>2</b><h3>Online Bradley–Terry</h3><p>Серия учитывается один раз; 2:0 весит больше 2:1, сила соперников распространяется транзитивно.</p></article><article><b>3</b><h3>Draft snapshot</h3><p>Вероятность фиксируется после десяти пиков и затем проверяется по победителю карты.</p></article><article><b>4</b><h3>Live guard</h3><p>До 10:00 live-модель молчит. Состояние текущей карты никогда не меняет prior будущих карт.</p></article></section>
    <footer><div className="brand"><span className="brand-glyph">T</span><span>TI / PREDICTOR</span></div><p>Экспериментальная аналитика · вероятности, не обещания</p><a href="/drafts">Открыть Draft Lab →</a></footer>
  </main>;
}
