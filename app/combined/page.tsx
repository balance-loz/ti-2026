"use client";
/* eslint-disable @next/next/no-html-link-for-pages, @next/next/no-img-element -- Vinext navigation and external Dota hero art use native elements. */

import { useEffect, useMemo, useState } from "react";

type Timeliness = { status: "actionable" | "late" | "after_start" | "unverified"; leadMinutes: number | null; eligible: boolean };
type Match = { id: number; stage: "swiss" | "playin" | "playoff"; round: number; team_a: string; team_b: string; winner: string | null; score_a: number | null; score_b: number | null; scheduled_at: string | null; predicted_probability: number | null };
type ExactScore = { score: string; probability: number };
type DisplayExactScore = { score: string; probability: number | null };
type LiveEstimate = {
  probabilityA?: number | null;
  probabilityRadiant?: number | null;
  frozenProbabilityA?: number | null;
  draftProbabilityA?: number | null;
  observedProbabilityA?: number | null;
  generatedAt?: string | null;
  source?: string | null;
  stale?: boolean;
};
type SeriesRow = {
  match: Match;
  seriesId: string | null;
  main: { probabilityA: number; exactScores: ExactScore[]; variant: "static" | "adaptive" };
  forecast: { probabilityA: number; baseMapProbabilityA: number; currentMapProbabilityA: number | null; winsA: number; winsB: number; exactScores: ExactScore[] };
  decision: { probabilityA: number | null; fallbackProbabilityA: number; capturedAt: string | null; timeliness: Timeliness | null; predictedWinner: string; predictedExactScore: string | null; predictedExactScoreProbability: number | null; predictionCorrect: boolean | null; exactScoreCorrect: boolean | null; historicalProbabilityA: number | null; historicalWinner: string | null; historicalExactScore: string | null; historicalExactScoreProbability: number | null; historicalSource: "snapshot" | "prematch" | null; historicalSnapshotId: number | null; historicalCapturedAt: string | null };
  latest: { probabilityA: number; generatedAt: string };
  live: null | { matchId: string; seriesId?: string | null; phase: "draft" | "game"; radiantTeam: string; direTeam: string; gameTime: number; radiantScore: number; direScore: number; liveEstimate?: LiveEstimate | null; source?: string | null; stale?: boolean };
  liveEstimate?: LiveEstimate | null;
  sources: { draftApplied: boolean; liveStateApplied: boolean };
};
type DraftPrediction = { probabilityRadiant: number; modelId: string | null; capturedAt: string; predictedWinner: string; timeliness: Timeliness; predictionCorrect: boolean | null };
type MapRow = { matchId: string; seriesId: string; radiantTeam: string; direTeam: string; winner: string | null; startTime: number | null; duration: number | null; picks: null | { radiant: number[]; dire: number[] }; draftPrediction: DraftPrediction | null };
type BracketNode = { label: string; lane: "upper" | "lower" | "final"; column: number; a: string; b: string; bestOf: number; winner: string; predictedWinner: string; actualWinner: string | null; latestProbabilityA: number; lockedProbabilityA: number | null; decisionProbabilityA: number; exactScore: string | null; exactScoreProbability: number | null; exactScores?: ExactScore[]; topExactScores?: ExactScore[]; actualScore: string | null; predictionCorrect: boolean | null; status: "completed" | "scheduled" | "projected"; matchId: number | null };
type BetLock = { id: number; scope: "series" | "map"; subjectId: string; teamA: string; teamB: string; probabilityA: number; recommendedWinner: string; exactScore: string | null; source: string; opinionWeight: number; snapshotId: number | null; modelId: string | null; createdAt: string; winner: string | null; actualScore: string | null; predictionCorrect: boolean | null; exactScoreCorrect: boolean | null };
type LockRequest = { scope: "series" | "map"; subjectId: string; probabilityA: number; recommendedWinner: string; exactScore?: string | null; evidence?: Record<string, unknown> };
type ModelScore = { count: number; correct: number; brier: number | null; logLoss: number | null };
type ProjectionMatch = { id: string; stage: "swiss" | "playin"; round: number; teamA: string; teamB: string; pairProbability: number; probabilityA: number; predictedWinner: string; exactScore: string | null; exactScoreProbability: number | null; exactScores?: ExactScore[]; occurrences: number };
type SimulationTeam = { id: string; qualify: number; direct: number; playin: number; viaPlayin: number; playinLoss: number; swissOut: number; champion: number };
type SimulationScenario = { rank: number; probability: number; occurrences: number; direct40: string[]; direct41: string[]; via: string[] };
type SimulationState = { iterations: number; requestedIterations: number; uniqueSwissOutcomes: number; uniqueTournamentPaths: number; teams: SimulationTeam[]; scenarios: SimulationScenario[]; swissMatchups?: Array<{ round: number; a: string; b: string; probability: number; aWinProbability: number; occurrences: number }>; playinMatchups: Array<{ a: string; b: string; probability: number; aWinProbability: number }>; convergence?: { converged: boolean; stopReason: string; maxSamplingMarginPp: number } };
type CombinedState = { generatedAt: string; opinionWeight: number; isAdmin: boolean; mainSnapshot: null | { id: number; baselineId: number; baselineCreatedAt: string; requested: boolean; createdAt: string; completedMatchCount: number; mode: string; opinionWeight: number }; modelComparison: null | { rootId: number; static: ModelScore; adaptive: ModelScore; selected: "static" | "adaptive"; reason: string }; simulation: SimulationState | null; projections: { swiss: ProjectionMatch[]; playins: ProjectionMatch[] }; series: SeriesRow[]; maps: MapRow[]; betLocks: BetLock[]; bracket: { qualifiers: string[]; nodes: BracketNode[]; champion: string | null }; live: { error: string | null } };
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
const isLowConfidence = (probabilityForWinner: number | null) => probabilityForWinner !== null && probabilityForWinner < .58;

function Team({ id }: { id: string }) {
  const item = team(id);
  return <span className="fusion-team">{item.logo ? <img src={item.logo} alt={`Логотип команды ${item.name}`} /> : null}<b>{item.name}</b></span>;
}

function Grade({ correct, eligible = true }: { correct: boolean | null; eligible?: boolean }) {
  if (!eligible) return <span className="fusion-grade fusion-grade--late">ТОЛЬКО АНАЛИЗ</span>;
  if (correct === null) return <span className="fusion-grade">ЖДЁМ РЕЗУЛЬТАТ</span>;
  return <span className={`fusion-grade ${correct ? "is-correct" : "is-wrong"}`}>{correct ? "УГАДАН" : "НЕ УГАДАН"}</span>;
}

function RouletteRisk({ label = false }: { label?: boolean }) {
  return <span className={`fusion-roulette-risk ${label ? "has-label" : ""}`} title="Низкая уверенность: вероятность близка к 50/50" aria-label="Рулетка: низкая уверенность прогноза"><i aria-hidden="true" />{label ? <small>RISK</small> : null}</span>;
}

function HeroPicks({ ids, heroes }: { ids: number[]; heroes: Map<number, Hero> }) {
  return <span className="fusion-heroes">{ids.map((id, index) => { const hero = heroes.get(id); return hero ? <img key={`${id}-${index}`} src={hero.image} alt={hero.name} title={hero.name} /> : <i key={`${id}-${index}`} title={`Hero ${id}`}>{id}</i>; })}</span>;
}

function MapStrip({ maps, heroes, locks, isAdmin, locking, currentMapId, currentMapNumber, onLock }: { maps: MapRow[]; heroes: Map<number, Hero>; locks: BetLock[]; isAdmin: boolean; locking: string | null; currentMapId: string | null; currentMapNumber: number; onLock: (request: LockRequest) => void }) {
  if (!maps.length) return <p className="fusion-no-maps">Карты и пики появятся здесь после начала драфта.</p>;
  const numberedMaps = maps.map((map, index) => ({
    map,
    mapNumber: !map.winner && currentMapId === map.matchId ? Math.max(index + 1, currentMapNumber) : index + 1,
  }));
  const activeMap = numberedMaps.find(({ map }) => !map.winner) ?? null;
  const displayMaps = activeMap ? [activeMap, ...numberedMaps.filter(({ map }) => map.winner).reverse()] : [...numberedMaps].reverse();
  return <div className="fusion-series-maps">{displayMaps.map(({ map, mapNumber }) => {
    const prediction = map.draftPrediction;
    const predicted = prediction?.predictedWinner ?? null;
    const predictedProbability = prediction ? (predicted === map.radiantTeam ? prediction.probabilityRadiant : 1 - prediction.probabilityRadiant) : null;
    const betLock = locks.find((lock) => lock.scope === "map" && String(lock.subjectId) === String(map.matchId));
    const decisionWinner = betLock?.recommendedWinner ?? predicted;
    const decisionProbability = betLock ? (betLock.recommendedWinner === betLock.teamA ? betLock.probabilityA : 1 - betLock.probabilityA) : predictedProbability;
    const lowConfidence = isLowConfidence(decisionProbability);
    return <article key={map.matchId} className={`${map.winner ? "is-complete" : "is-active"} ${lowConfidence ? "has-risk" : ""}`}>
      <header><b>{map.winner ? `КАРТА ${mapNumber} · ЗАВЕРШЕНА` : `ТЕКУЩАЯ КАРТА ${mapNumber}`}</b>{lowConfidence ? <RouletteRisk label /> : null}<span>{map.duration ? clock(map.duration) : map.winner ? "завершена" : "идёт сейчас"}</span></header>
      <div className={`fusion-map-side ${map.winner === map.radiantTeam ? "is-winner" : ""}`}><Team id={map.radiantTeam} /><HeroPicks ids={map.picks?.radiant ?? []} heroes={heroes} /><span className="fusion-map-risk-slot">{lowConfidence && decisionWinner === map.radiantTeam ? <RouletteRisk /> : null}</span><em>{map.winner === map.radiantTeam ? "W" : map.winner ? "L" : "R"}</em></div>
      <div className={`fusion-map-side ${map.winner === map.direTeam ? "is-winner" : ""}`}><Team id={map.direTeam} /><HeroPicks ids={map.picks?.dire ?? []} heroes={heroes} /><span className="fusion-map-risk-slot">{lowConfidence && decisionWinner === map.direTeam ? <RouletteRisk /> : null}</span><em>{map.winner === map.direTeam ? "W" : map.winner ? "L" : "D"}</em></div>
      <footer>{betLock ? <><span><b>СТАВКА · {team(betLock.recommendedWinner).short} {percent(betLock.recommendedWinner === betLock.teamA ? betLock.probabilityA : 1 - betLock.probabilityA)}{lowConfidence ? <RouletteRisk /> : null}</b><small>зафиксирована {new Date(betLock.createdAt).toLocaleTimeString("ru-RU")}</small></span><Grade correct={betLock.predictionCorrect} /></> : prediction ? <><span><b>ПРОГНОЗ · {team(predicted!).short} {percent(predictedProbability!)}{lowConfidence ? <RouletteRisk /> : null}</b><small>{map.winner ? "заморожен до результата карты" : "draft-прогноз · ещё не ставка"}</small></span>{isAdmin && !map.winner ? <button className="fusion-bet-button" disabled={locking === `map:${map.matchId}`} onClick={() => onLock({ scope: "map", subjectId: map.matchId, probabilityA: prediction.probabilityRadiant, recommendedWinner: predicted!, evidence: { capturedAt: prediction.capturedAt, modelId: prediction.modelId } })}>{locking === `map:${map.matchId}` ? "Фиксирую…" : "Я поставил по рекомендации"}</button> : <Grade correct={prediction.predictionCorrect} />}</> : <span><b>Прогноза до старта не было</b><small>задним числом результат не оцениваем</small></span>}</footer>
    </article>;
  })}</div>;
}

function mapsForSeries(row: SeriesRow, maps: MapRow[]) {
  const canonicalSeriesId = row.live?.seriesId ?? row.seriesId;
  const chronologically = (a: MapRow, b: MapRow) => {
    const left = Number.isFinite(Number(a.startTime)) && Number(a.startTime) > 0 ? Number(a.startTime) : Number.POSITIVE_INFINITY;
    const right = Number.isFinite(Number(b.startTime)) && Number(b.startTime) > 0 ? Number(b.startTime) : Number.POSITIVE_INFINITY;
    return left - right || Number(a.matchId) - Number(b.matchId);
  };
  if (canonicalSeriesId) return maps.filter((map) => String(map.seriesId) === String(canonicalSeriesId)).sort(chronologically);
  if (row.live?.matchId) return maps.filter((map) => String(map.matchId) === String(row.live?.matchId)).sort(chronologically);
  return [];
}

function topExactScores(scores: ExactScore[], limit = 2) {
  return [...scores].filter((item) => item.score && Number.isFinite(item.probability)).sort((a, b) => b.probability - a.probability).slice(0, limit);
}

function ExactScoreList({ scores, empty = "нет сохранённого расчёта" }: { scores: DisplayExactScore[]; empty?: string }) {
  const options = [...scores].filter((item) => item.score).sort((a, b) => (b.probability ?? -1) - (a.probability ?? -1)).slice(0, 2);
  if (!options.length) return <span className="fusion-exact-empty">{empty}</span>;
  return <span className="fusion-exact-list">{options.map((option) => <span key={option.score}><b>{option.score}</b><small>{option.probability === null ? "доля не сохранена" : percent(option.probability)}</small></span>)}</span>;
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

function seriesPresentation(row: SeriesRow, locks: BetLock[]) {
  const betLock = locks.find((lock) => lock.scope === "series" && String(lock.subjectId) === String(row.match.id)) ?? null;
  const latestProbabilityA = row.live ? row.forecast.probabilityA : row.latest.probabilityA;
  const latestWinner = latestProbabilityA >= .5 ? row.match.team_a : row.match.team_b;
  const latestExactScores = topExactScores(row.live ? row.forecast.exactScores ?? [] : row.main.exactScores ?? []);
  const mainProbabilityA = row.main.probabilityA;
  const mainWinner = mainProbabilityA >= .5 ? row.match.team_a : row.match.team_b;
  const mainExactScores = topExactScores(row.main.exactScores ?? []);
  const mainExact = mainExactScores[0] ?? null;
  const scheduledAt = Date.parse(row.match.scheduled_at || "");
  const hasStarted = Boolean(row.match.winner || row.live || (Number.isFinite(scheduledAt) && scheduledAt <= Date.now()));
  const hasHistorical = hasStarted && row.decision.historicalProbabilityA !== null && Number.isFinite(row.decision.historicalProbabilityA);
  const source = betLock ? "bet" : hasHistorical ? "historical" : "main";
  const displayProbabilityA = betLock?.probabilityA ?? (hasHistorical ? row.decision.historicalProbabilityA! : mainProbabilityA);
  const displayWinner = betLock?.recommendedWinner ?? (hasHistorical ? row.decision.historicalWinner! : mainWinner);
  const displayExact = betLock?.exactScore ?? (hasHistorical ? row.decision.historicalExactScore : mainExact?.score) ?? null;
  const displayExactProbability = betLock ? null : hasHistorical ? row.decision.historicalExactScoreProbability : mainExact?.probability ?? null;
  const displayExactScores: DisplayExactScore[] = row.live
    ? latestExactScores
    : betLock?.exactScore
      ? [{ score: betLock.exactScore, probability: null }]
      : hasHistorical && row.decision.historicalExactScore
        ? [{ score: row.decision.historicalExactScore, probability: row.decision.historicalExactScoreProbability }]
        : mainExactScores;
  return { betLock, source, hasStarted, latestProbabilityA, latestWinner, latestExactScores, mainProbabilityA, mainWinner, mainExact, mainExactScores, mainVariant: row.main.variant, displayProbabilityA, displayWinner, displayExact, displayExactProbability, displayExactScores };
}

function SeriesDetail({ row, maps, heroes, locks, isAdmin, locking, onLock }: { row: SeriesRow; maps: MapRow[]; heroes: Map<number, Hero>; locks: BetLock[]; isAdmin: boolean; locking: string | null; onLock: (request: LockRequest) => void }) {
  const view = seriesPresentation(row, locks);
  const delta = (view.latestProbabilityA - view.displayProbabilityA) * 100;
  const seriesMaps = mapsForSeries(row, maps);
  const latestLabel = row.live ? "LIVE ESTIMATE" : "LATEST MODEL";
  const latestSource = row.sources.liveStateApplied ? "live observation" : row.sources.draftApplied ? "draft" : "model";
  return <div className="fusion-expanded-series" id={`series-detail-${row.match.id}`}>
    <div className="fusion-expanded-summary">
      <article><small>ПАРА · SW R{row.match.round}</small><span className="fusion-matchup"><Team id={row.match.team_a} /><i>—</i><Team id={row.match.team_b} /></span></article>
      <article><small>MAIN / СТАВКА</small>{view.betLock ? <><span className="fusion-lock">СТАВКА ЗАФИКСИРОВАНА</span><strong>{team(view.displayWinner).short} {percent(view.displayWinner === row.match.team_a ? view.displayProbabilityA : 1 - view.displayProbabilityA)}</strong><em>{new Date(view.betLock.createdAt).toLocaleString("ru-RU")} · профиль {view.betLock.opinionWeight}%</em></> : view.source === "historical" ? <><span className="fusion-lock fusion-lock--historical">{row.decision.historicalSource === "snapshot" ? `ИСТОРИЧЕСКИЙ SNAPSHOT #${row.decision.historicalSnapshotId}` : "ИСТОРИЧЕСКИЙ PRE-MATCH"}</span><strong>{team(view.displayWinner).short} {percent(view.displayWinner === row.match.team_a ? view.displayProbabilityA : 1 - view.displayProbabilityA)}</strong><em>{row.decision.historicalCapturedAt ? new Date(row.decision.historicalCapturedAt).toLocaleString("ru-RU") : "сохранён до матча"} · не переписывается</em></> : <><span className="fusion-lock fusion-lock--snapshot">MAIN · {view.mainVariant.toUpperCase()}</span><strong>{team(view.displayWinner).short} {percent(view.displayWinner === row.match.team_a ? view.displayProbabilityA : 1 - view.displayProbabilityA)}</strong>{isAdmin && !view.hasStarted ? <button className="fusion-bet-button" disabled={locking === `series:${row.match.id}`} onClick={() => onLock({ scope: "series", subjectId: String(row.match.id), probabilityA: view.mainProbabilityA, recommendedWinner: view.mainWinner, exactScore: view.mainExact?.score, evidence: { exactScores: row.main.exactScores, sources: row.sources, modelVariant: view.mainVariant } })}>{locking === `series:${row.match.id}` ? "Фиксирую…" : "Я поставил по рекомендации"}</button> : <em>основная модель выбрана по temporal backtest</em>}</>}</article>
      <article><small>{row.live ? "LIVE ТОЧНЫЙ СЧЁТ" : view.source === "main" ? "PRE-MATCH ТОЧНЫЙ СЧЁТ" : "LOCKED / HISTORICAL СЧЁТ"}</small><ExactScoreList scores={view.displayExactScores} /><em>{row.live ? "условные исходы с учётом текущего счёта; pre-match не подменяет live" : view.betLock ? "сохранён со ставкой" : view.source === "historical" ? "исторический pre-match, не переписывается" : `MAIN ${view.mainVariant.toUpperCase()}`}</em></article>
      <article><small>{latestLabel}</small><strong>{team(view.latestWinner).short} {percent(view.latestWinner === row.match.team_a ? view.latestProbabilityA : 1 - view.latestProbabilityA)}</strong><em className={Math.abs(delta) >= 5 ? "fusion-delta is-large" : "fusion-delta"}>{view.betLock || view.source === "historical" ? `${delta >= 0 ? "+" : ""}${delta.toFixed(1)} п.п. для ${team(row.match.team_a).short}` : "текущая незамороженная оценка"} · {latestSource}</em></article>
      <article><small>ФАКТ</small>{row.match.winner ? <><strong>{row.match.score_a}:{row.match.score_b} · {team(row.match.winner).short}</strong>{view.betLock ? <Grade correct={view.betLock.predictionCorrect} /> : view.source === "historical" ? <Grade correct={row.decision.predictionCorrect} /> : <span className="fusion-grade fusion-grade--late">НЕ БЫЛО PRE-MATCH</span>}</> : row.live ? <><strong>{row.forecast.winsA}:{row.forecast.winsB} · {clock(row.live.gameTime)}</strong><span className="fusion-status fusion-status--live">LIVE</span></> : <span className="fusion-status fusion-status--next">до матча</span>}</article>
    </div>
    <MapStrip maps={seriesMaps} heroes={heroes} locks={locks} isAdmin={isAdmin} locking={locking} currentMapId={row.live?.matchId ?? null} currentMapNumber={row.forecast.winsA + row.forecast.winsB + 1} onLock={onLock} />
  </div>;
}

function DraftSlots({ ids, heroes }: { ids: number[]; heroes: Map<number, Hero> }) {
  return <span className="fusion-live-picks">{Array.from({ length: 5 }, (_, index) => {
    const hero = heroes.get(ids[index]);
    return hero ? <img key={`${hero.id}-${index}`} src={hero.image} alt={`Пик ${index + 1}: ${hero.name}`} title={hero.name} /> : <i key={`empty-${index}`} aria-label={`Пик ${index + 1} ещё не выбран`}>{index + 1}</i>;
  })}</span>;
}

function LiveDraftRail({ rows, maps, heroes }: { rows: SeriesRow[]; maps: MapRow[]; heroes: Map<number, Hero> }) {
  const liveRows = rows.filter((row) => row.live && !row.match.winner);
  return <section className="fusion-panel fusion-live-rail" aria-labelledby="live-draft-title">
    <header><div><span>LIVE DRAFT RAIL</span><h2 id="live-draft-title">Текущие карты и серии</h2><p>Draft-прогноз заморожен после пиков; observation включается только после 10:00.</p></div><b>{liveRows.length}</b></header>
    {liveRows.length ? <div className="fusion-live-grid">{liveRows.map((row) => {
      const seriesMaps = mapsForSeries(row, maps);
      const activeMap = [...seriesMaps].reverse().find((map) => !map.winner) ?? seriesMaps.at(-1) ?? null;
      const estimate = row.liveEstimate ?? row.live?.liveEstimate ?? null;
      const draftRadiantProbability = activeMap?.draftPrediction?.probabilityRadiant ?? estimate?.probabilityRadiant ?? null;
      const draftProbabilityA = estimate?.frozenProbabilityA ?? estimate?.draftProbabilityA ?? (draftRadiantProbability === null ? null : row.live?.radiantTeam === row.match.team_a ? draftRadiantProbability : 1 - draftRadiantProbability);
      const observedProbabilityA = estimate?.observedProbabilityA ?? estimate?.probabilityA ?? row.forecast.probabilityA;
      const canShowObservation = (row.live?.gameTime ?? 0) >= 600;
      const source = estimate?.source ?? row.live?.source ?? (row.sources.liveStateApplied ? "live feed" : row.sources.draftApplied ? "draft model" : "series model");
      const isStale = Boolean(estimate?.stale ?? row.live?.stale);
      return <article key={row.match.id} className={isStale ? "is-stale" : ""}>
        <header><span className="fusion-status fusion-status--live">LIVE · SW R{row.match.round}</span><span>{clock(row.live?.gameTime ?? 0)} · {row.live?.radiantScore ?? 0}:{row.live?.direScore ?? 0}</span></header>
        <div className="fusion-live-side"><Team id={row.live?.radiantTeam ?? row.match.team_a} /><DraftSlots ids={activeMap?.picks?.radiant ?? []} heroes={heroes} /><b>R</b></div>
        <div className="fusion-live-side"><Team id={row.live?.direTeam ?? row.match.team_b} /><DraftSlots ids={activeMap?.picks?.dire ?? []} heroes={heroes} /><b>D</b></div>
        <div className="fusion-live-estimates">
          <span><small>POST-DRAFT · FROZEN</small><strong>{draftProbabilityA === null ? "ожидание 5×5" : `${team(draftProbabilityA >= .5 ? row.match.team_a : row.match.team_b).short} ${percent(Math.max(draftProbabilityA, 1 - draftProbabilityA))}`}</strong></span>
          <span><small>LIVE OBSERVATION</small><strong>{canShowObservation ? `${team(observedProbabilityA >= .5 ? row.match.team_a : row.match.team_b).short} ${percent(Math.max(observedProbabilityA, 1 - observedProbabilityA))}` : "после 10:00"}</strong></span>
        </div>
        <footer><span>series {row.live?.seriesId ?? row.seriesId ?? row.match.id}</span><span>source: {source} · {isStale ? "STALE" : "fresh"}</span></footer>
      </article>;
    })}</div> : <p className="fusion-empty">Сейчас нет активных live-серий. Блок заполнится автоматически после появления драфта.</p>}
  </section>;
}

function SwissMatrix({ rows, maps, heroes, locks, isAdmin, locking, onLock, expanded, onToggle }: { rows: SeriesRow[]; maps: MapRow[]; heroes: Map<number, Hero>; locks: BetLock[]; isAdmin: boolean; locking: string | null; onLock: (request: LockRequest) => void; expanded: Record<string, string>; onToggle: (matchId: number) => void }) {
  const standings = useMemo(() => buildMatchStandings(rows), [rows]);
  const [viewMode, setViewMode] = useState<"teams" | "rounds">("teams");
  const roundCount = Math.max(5, ...rows.map((row) => row.match.round));
  const rounds = Array.from({ length: roundCount }, (_, index) => index + 1);
  const completedCount = rows.filter((row) => row.match.winner).length;
  const openRows = rows.filter((row) => Boolean(expanded[String(row.match.id)]));
  return <section className="fusion-panel fusion-matrix"><header><div><span>SWISS · ДВА ПОНЯТНЫХ СРЕЗА</span><h2>История команд и матчи по раундам</h2><p>«По командам» собирает весь путь и проверку прогнозов в одной строке. «По раундам» показывает каждую серию один раз.</p></div><div className="fusion-matrix-progress"><b>{completedCount}</b><span>завершено</span><small>из {rows.length} матчей</small></div></header>
    <div className="fusion-view-switch" role="tablist" aria-label="Представление Swiss"><button role="tab" aria-selected={viewMode === "teams"} onClick={() => setViewMode("teams")}>По командам</button><button role="tab" aria-selected={viewMode === "rounds"} onClick={() => setViewMode("rounds")}>По раундам</button></div>
    {viewMode === "teams" ? <><div className="fusion-table-wrap fusion-scroll-hint" role="region" aria-label="История матчей каждой команды; на узком экране прокручивается горизонтально"><table className="fusion-table fusion-history-table"><thead><tr><th>#</th><th>Команда</th><th>Группа</th><th>Счёт</th>{rounds.map((round) => <th key={round}>Раунд {round}</th>)}<th>Статус</th></tr></thead><tbody>{standings.map((standing, index) => <tr key={standing.teamId}><td><strong>{index + 1}</strong></td><td><Team id={standing.teamId} /></td><td><span className={`fusion-group fusion-group--${standing.group.toLowerCase()}`}>{standing.group}</span></td><td><strong>{standing.wins}–{standing.losses}</strong></td>{rounds.map((round) => {
      const row = rows.find((candidate) => candidate.match.round === round && (candidate.match.team_a === standing.teamId || candidate.match.team_b === standing.teamId));
      if (!row) return <td key={round} className="fusion-empty-round">—</td>;
      const view = seriesPresentation(row, locks);
      const opponent = row.match.team_a === standing.teamId ? row.match.team_b : row.match.team_a;
      const didWin = row.match.winner === standing.teamId;
      const score = row.match.score_a === null || row.match.score_b === null ? null : row.match.team_a === standing.teamId ? `${row.match.score_a}:${row.match.score_b}` : `${row.match.score_b}:${row.match.score_a}`;
      const forecastProbability = view.displayWinner === row.match.team_a ? view.displayProbabilityA : 1 - view.displayProbabilityA;
      const predictionCorrect = view.betLock?.predictionCorrect ?? row.decision.predictionCorrect;
      const isOpen = Boolean(expanded[String(row.match.id)]);
      return <td key={round} className={row.live ? "is-live" : row.match.winner ? didWin ? "is-won" : "is-lost" : ""}><button className={`fusion-round-match ${isOpen ? "is-open" : ""}`} aria-expanded={isOpen} onClick={() => onToggle(row.match.id)}><span><Team id={opponent} /><span className="fusion-cell-forecast"><b>{team(view.displayWinner).short} {percent(forecastProbability)}</b><span className={`fusion-result-square ${predictionCorrect === true ? "is-correct" : predictionCorrect === false ? "is-wrong" : ""}`}><strong>{row.live ? "LIVE" : row.match.winner ? didWin ? "W" : "L" : "—"}</strong>{predictionCorrect !== null ? <i>{predictionCorrect ? "✓" : "×"}</i> : null}</span></span></span><small>{score ? `Факт ${score}` : row.live ? `Сейчас ${row.forecast.winsA}:${row.forecast.winsB}` : "Матч впереди"} · прогноз {team(view.displayWinner).short}</small><em className={`fusion-prediction-verdict ${predictionCorrect === true ? "is-correct" : predictionCorrect === false ? "is-wrong" : "is-pending"}`}>{predictionCorrect === true ? "ПРОГНОЗ СБЫЛСЯ" : predictionCorrect === false ? "ПРОГНОЗ НЕ СБЫЛСЯ" : "ЖДЁМ РЕЗУЛЬТАТ"}</em></button></td>;
    })}<td><span className={`fusion-outcome ${standing.wins >= 4 ? "is-qualified" : standing.losses >= 4 ? "is-eliminated" : ""}`}>{standing.wins >= 4 ? "НАПРЯМУЮ" : standing.losses >= 4 ? "ВЫЛЕТ" : standing.wins + standing.losses >= 5 ? "СТЫК" : standing.liveOpponent ? `LIVE vs ${team(standing.liveOpponent).short}` : "В ИГРЕ"}</span></td></tr>)}</tbody></table></div>
      {openRows.length ? <div className="fusion-history-details">{openRows.map((row) => <SeriesDetail key={row.match.id} row={row} maps={maps} heroes={heroes} locks={locks} isAdmin={isAdmin} locking={locking} onLock={onLock} />)}</div> : null}</> : <div className="fusion-swiss-layout fusion-swiss-layout--rounds">
      <div className="fusion-rounds">{rounds.map((round) => <section key={round} className="fusion-round-section"><header><h3>Раунд {round}</h3><span>{rows.filter((row) => row.match.round === round && row.match.winner).length}/{rows.filter((row) => row.match.round === round).length} завершено</span></header><div>{rows.filter((row) => row.match.round === round).map((row) => {
        const view = seriesPresentation(row, locks);
        const isOpen = Boolean(expanded[String(row.match.id)]);
        const winnerProbability = view.displayWinner === row.match.team_a ? view.displayProbabilityA : 1 - view.displayProbabilityA;
        const predictionCorrect = view.betLock?.predictionCorrect ?? row.decision.predictionCorrect;
        return <article key={row.match.id} className={`fusion-series-row ${row.live ? "is-live" : ""} ${row.match.winner ? "is-complete" : ""}`}><button aria-expanded={isOpen} aria-controls={`series-detail-${row.match.id}`} onClick={() => onToggle(row.match.id)}><span><Team id={row.match.team_a} /><b>{row.match.score_a ?? row.forecast.winsA}</b></span><i>—</i><span><b>{row.match.score_b ?? row.forecast.winsB}</b><Team id={row.match.team_b} /></span><em>{row.live ? `LIVE ${clock(row.live.gameTime)}` : predictionCorrect === true ? "ПРОГНОЗ СБЫЛСЯ" : predictionCorrect === false ? "НЕ СБЫЛСЯ" : row.match.winner ? "БЕЗ ОЦЕНКИ" : view.betLock ? "LOCKED" : "MAIN"}</em><strong>Прогноз: {team(view.displayWinner).short} {percent(winnerProbability)}</strong></button>{isOpen ? <SeriesDetail row={row} maps={maps} heroes={heroes} locks={locks} isAdmin={isAdmin} locking={locking} onLock={onLock} /> : null}</article>;
      })}</div></section>)}</div>
    </div>}
  </section>;
}

function ProjectionMatchCard({ match }: { match: ProjectionMatch }) {
  const winnerProbability = match.predictedWinner === match.teamA ? match.probabilityA : 1 - match.probabilityA;
  return <article className="fusion-projection-card">
    <header><span>{match.stage === "swiss" ? `SWISS · РАУНД ${match.round}` : "СТЫК"}</span><b>{match.pairProbability.toFixed(match.pairProbability < 10 ? 1 : 0)}%</b></header>
    <div><span className={match.predictedWinner === match.teamA ? "is-favorite" : ""}><Team id={match.teamA} /><b>{percent(match.probabilityA)}</b></span><i>—</i><span className={match.predictedWinner === match.teamB ? "is-favorite" : ""}><Team id={match.teamB} /><b>{percent(1 - match.probabilityA)}</b></span></div>
    <footer><span><small>MAIN-ПОБЕДИТЕЛЬ</small><b>{team(match.predictedWinner).name}</b></span><span><small>ДВА ВЕРОЯТНЫХ СЧЁТА</small><ExactScoreList scores={match.exactScores?.length ? match.exactScores : match.exactScore ? [{ score: match.exactScore, probability: match.exactScoreProbability }] : []} /></span>{isLowConfidence(winnerProbability) ? <RouletteRisk label /> : null}</footer>
    <p>Пара появляется в {match.pairProbability.toFixed(1)}% прогонов · прогноз обновится после нового результата</p>
  </article>;
}

function OfficialStageCard({ row, locks, isAdmin, locking, onLock }: { row: SeriesRow; locks: BetLock[]; isAdmin: boolean; locking: string | null; onLock: (request: LockRequest) => void }) {
  const view = seriesPresentation(row, locks);
  return <article className="fusion-projection-card is-official">
    <header><span>ОФИЦИАЛЬНАЯ ПАРА · СТЫК</span><b>100%</b></header>
    <div><span className={view.displayWinner === row.match.team_a ? "is-favorite" : ""}><Team id={row.match.team_a} /><b>{percent(view.displayProbabilityA)}</b></span><i>—</i><span className={view.displayWinner === row.match.team_b ? "is-favorite" : ""}><Team id={row.match.team_b} /><b>{percent(1 - view.displayProbabilityA)}</b></span></div>
    <footer><span><small>{view.betLock ? "СТАВКА" : "MAIN-ПОБЕДИТЕЛЬ"}</small><b>{team(view.displayWinner).name}</b></span><span><small>ДВА ВЕРОЯТНЫХ СЧЁТА</small><ExactScoreList scores={view.displayExactScores} /></span>{isAdmin && !view.betLock && !view.hasStarted ? <button className="fusion-bet-button" disabled={locking === `series:${row.match.id}`} onClick={() => onLock({ scope: "series", subjectId: String(row.match.id), probabilityA: view.mainProbabilityA, recommendedWinner: view.mainWinner, exactScore: view.mainExact?.score, evidence: { exactScores: row.main.exactScores, modelVariant: view.mainVariant, stage: "playin" } })}>Я поставил по рекомендации</button> : null}</footer>
    <p>{row.match.winner ? `Факт: ${row.match.score_a}:${row.match.score_b} · ${team(row.match.winner).name}` : view.betLock ? "Решение заморожено; LATEST продолжит обновляться" : "Пара объявлена официально; MAIN обновляется до фиксации ставки"}</p>
  </article>;
}

function EliminationRound({ state, actualPlayins, locking, onLock }: { state: CombinedState; actualPlayins: SeriesRow[]; locking: string | null; onLock: (request: LockRequest) => void }) {
  const usedTeams = new Set<string>();
  const official = actualPlayins.filter((row) => {
    if (usedTeams.has(row.match.team_a) || usedTeams.has(row.match.team_b)) return false;
    usedTeams.add(row.match.team_a); usedTeams.add(row.match.team_b);
    return true;
  }).slice(0, 5);
  const projected = state.projections.playins.filter((match) => {
    if (usedTeams.has(match.teamA) || usedTeams.has(match.teamB)) return false;
    usedTeams.add(match.teamA); usedTeams.add(match.teamB);
    return true;
  }).slice(0, Math.max(0, 5 - official.length));
  const slots = Array.from({ length: 5 }, (_, index) => ({ official: official[index] ?? null, projected: official[index] ? null : projected[index - official.length] ?? null }));
  return <section className="fusion-elimination" aria-labelledby="elimination-title">
    <header><div><span>ELIMINATION ROUND · 5 СЛОТОВ</span><h3 id="elimination-title">[3–2] против [2–3] → playoff</h3></div><small>Official заменяет projected по одному слоту; команды не дублируются.</small></header>
    <div>{slots.map((slot, index) => <section className="fusion-elimination-slot" key={index} aria-label={`Слот стыка ${index + 1}`}><span>СЛОТ {index + 1} · {slot.official ? "OFFICIAL" : slot.projected ? "PROJECTED" : "ОЖИДАНИЕ"}</span>{slot.official ? <OfficialStageCard row={slot.official} locks={state.betLocks} isAdmin={state.isAdmin} locking={locking} onLock={onLock} /> : slot.projected ? <ProjectionMatchCard match={slot.projected} /> : <article className="fusion-elimination-empty"><b>[3–2]</b><i>VS</i><b>[2–3]</b><small>Пара ещё не определена</small></article>}</section>)}</div>
  </section>;
}

function TournamentProjection({ state, actualPlayins, locking, onLock }: { state: CombinedState; actualPlayins: SeriesRow[]; locking: string | null; onLock: (request: LockRequest) => void }) {
  const simulation = state.simulation;
  if (!simulation) return <section className="fusion-panel fusion-simulation"><header><div><span>MONTE CARLO · ВЕСЬ ТУРНИР</span><h2>Готовим полный прогноз</h2></div></header></section>;
  const rounds = [...new Set(state.projections.swiss.map((match) => match.round))].sort((a, b) => a - b);
  return <section className="fusion-panel fusion-simulation">
    <header><div><span>MONTE CARLO · SWISS → СТЫКИ → PLAYOFF</span><h2>Как турнир развивается дальше</h2><p>Тот же полный прогон, что на главной. После каждого результата создаётся новая ревизия; зафиксированные ставки не переписываются.</p></div><div className="fusion-run-count"><b>{simulation.iterations.toLocaleString("ru-RU")}</b><span>полных турниров</span><small>snapshot #{state.mainSnapshot?.id ?? "—"} · после {state.mainSnapshot?.completedMatchCount ?? 0} результатов</small></div></header>
    <div className="fusion-simulation-stats"><span><b>{simulation.uniqueSwissOutcomes.toLocaleString("ru-RU")}</b><small>вариантов исхода Swiss</small></span><span><b>{simulation.uniqueTournamentPaths.toLocaleString("ru-RU")}</b><small>уникальных путей турнира</small></span><span><b>±{simulation.convergence?.maxSamplingMarginPp?.toFixed(2) ?? "—"} п.п.</b><small>максимальная ошибка выборки</small></span></div>
    <details className="fusion-collapsible"><summary>Топ-3 сценария турнира <span>раскрыть</span></summary><div className="fusion-scenario-grid">{simulation.scenarios.slice(0, 3).map((scenario, index) => <article key={`${scenario.rank}-${index}`}><header><span>СЦЕНАРИЙ {index + 1}</span><b>{scenario.probability < .1 ? scenario.probability.toFixed(3) : scenario.probability.toFixed(1)}%</b></header><small>{scenario.occurrences.toLocaleString("ru-RU")} из {simulation.iterations.toLocaleString("ru-RU")} прогонов</small><div><b>НАПРЯМУЮ</b><span>{[...scenario.direct40, ...scenario.direct41].map((id) => <Team key={id} id={id} />)}</span></div><div><b>ЧЕРЕЗ СТЫК</b><span>{scenario.via.map((id) => <Team key={id} id={id} />)}</span></div></article>)}</div></details>
    {!Array.isArray(simulation.swissMatchups) ? <div className="fusion-reforecast-status"><i /><span><b>Строится новая миллионная ревизия</b><small>Старый snapshot уже показывает исходы турнира, но распределение будущих пар появится после фонового перепрогона. Страница проверяет готовность каждые 10 секунд.</small></span></div> : rounds.length === 0 ? <div className="fusion-reforecast-status is-ready"><i /><span><b>Все ближайшие Swiss-пары уже объявлены</b><small>Новые варианты появятся после следующего результата и жеребьёвки.</small></span></div> : null}
    {rounds.map((round) => <div className="fusion-projection-stage" key={round}><header><div><span>БУДУЩИЕ ПАРЫ SWISS</span><h3>Раунд {round} · основные варианты</h3></div><small>частота пары рассчитана по всем {simulation.iterations.toLocaleString("ru-RU")} прогонам</small></header><div>{state.projections.swiss.filter((match) => match.round === round).map((match) => <ProjectionMatchCard key={match.id} match={match} />)}</div></div>)}
    <EliminationRound state={state} actualPlayins={actualPlayins} locking={locking} onLock={onLock} />
    <div className="fusion-simulation-table-wrap fusion-scroll-hint" role="region" aria-label="Таблица вероятностей квалификации; на узком экране прокручивается горизонтально"><table><thead><tr><th>Команда</th><th>Напрямую</th><th>Попадёт в стык</th><th>Пройдёт стык</th><th>Плей-офф</th><th>Чемпион</th></tr></thead><tbody>{simulation.teams.map((item) => <tr key={item.id}><td><Team id={item.id} /></td><td>{item.direct.toFixed(1)}%</td><td>{item.playin.toFixed(1)}%</td><td>{item.viaPlayin.toFixed(1)}%</td><td><b>{item.qualify.toFixed(1)}%</b></td><td><strong>{item.champion.toFixed(1)}%</strong></td></tr>)}</tbody></table></div>
  </section>;
}

function BracketCard({ node, series, locks, isAdmin, locking, onLock }: { node: BracketNode; series: SeriesRow[]; locks: BetLock[]; isAdmin: boolean; locking: string | null; onLock: (request: LockRequest) => void }) {
  const actualSeries = node.matchId === null ? null : series.find((row) => row.match.id === node.matchId) ?? null;
  const betLock = node.matchId === null ? null : locks.find((lock) => lock.scope === "series" && String(lock.subjectId) === String(node.matchId)) ?? null;
  const actualView = actualSeries ? seriesPresentation(actualSeries, locks) : null;
  const actualProbabilityA = actualView ? (actualSeries!.match.team_a === node.a ? actualView.displayProbabilityA : 1 - actualView.displayProbabilityA) : null;
  const probabilityA = actualProbabilityA ?? (betLock?.teamA === node.a ? betLock.probabilityA : betLock?.teamB === node.a ? 1 - betLock.probabilityA : node.latestProbabilityA);
  const predictedWinner = actualView?.displayWinner ?? betLock?.recommendedWinner ?? (probabilityA >= .5 ? node.a : node.b);
  const exactScores: DisplayExactScore[] = actualView?.displayExactScores
    ?? (betLock?.exactScore ? [{ score: betLock.exactScore, probability: null }] : node.topExactScores ?? node.exactScores ?? (node.exactScore ? [{ score: node.exactScore, probability: node.exactScoreProbability }] : []));
  return <article className={`fusion-bracket-card fusion-bracket-card--${node.status} ${betLock?.predictionCorrect === true ? "is-correct" : betLock?.predictionCorrect === false ? "is-wrong" : ""}`}>
    <header><span>{node.label}</span><b>BO{node.bestOf}</b></header>
    <div className={predictedWinner === node.a ? "is-winner" : ""}><Team id={node.a} /><em>{percent(probabilityA)}</em></div>
    <div className={predictedWinner === node.b ? "is-winner" : ""}><Team id={node.b} /><em>{percent(1 - probabilityA)}</em></div>
    <p><span>прогноз <ExactScoreList scores={exactScores} /></span>{node.actualScore ? <span>факт <b>{node.actualScore}</b></span> : <span>{betLock ? "ставка locked" : "main · обновляется"}</span>}</p>
    {node.actualWinner ? (betLock ? <Grade correct={betLock.predictionCorrect} /> : <span className="fusion-grade fusion-grade--late">СТАВКИ НЕ БЫЛО</span>) : betLock ? <small>ставка: {team(betLock.recommendedWinner).name}</small> : actualSeries && actualView && !actualView.hasStarted && isAdmin ? <button className="fusion-bet-button" disabled={locking === `series:${actualSeries.match.id}`} onClick={() => onLock({ scope: "series", subjectId: String(actualSeries.match.id), probabilityA: actualSeries.main.probabilityA, recommendedWinner: actualSeries.main.probabilityA >= .5 ? actualSeries.match.team_a : actualSeries.match.team_b, exactScore: [...actualSeries.main.exactScores].sort((a, b) => b.probability - a.probability)[0]?.score, evidence: { bracketLabel: node.label, modelVariant: actualSeries.main.variant } })}>Я поставил по рекомендации</button> : <small>{actualView?.hasStarted ? "lock закрыт после старта" : `→ дальше: ${team(node.winner).name}`}</small>}
  </article>;
}

const UPPER_PLACEMENT: Record<string, { column: number; row: string }> = {
  "UB QF 1": { column: 1, row: "1 / span 2" }, "UB QF 2": { column: 1, row: "3 / span 2" }, "UB QF 3": { column: 1, row: "5 / span 2" }, "UB QF 4": { column: 1, row: "7 / span 2" },
  "UB SF 1": { column: 2, row: "2 / span 2" }, "UB SF 2": { column: 2, row: "6 / span 2" }, "UB FINAL": { column: 3, row: "4 / span 2" }, "GRAND FINAL": { column: 4, row: "4 / span 2" },
};
const LOWER_PLACEMENT: Record<string, { column: number; row: string }> = {
  "LB R1 1": { column: 1, row: "1 / span 2" }, "LB R1 2": { column: 1, row: "3 / span 2" }, "LB R2 1": { column: 2, row: "1 / span 2" }, "LB R2 2": { column: 2, row: "3 / span 2" }, "LB SF": { column: 3, row: "2 / span 2" }, "LB FINAL": { column: 4, row: "2 / span 2" },
};

function PlayoffBracket({ state, locking, onLock }: { state: CombinedState; locking: string | null; onLock: (request: LockRequest) => void }) {
  const track = (lane: "upper" | "lower") => {
    const placement = lane === "upper" ? UPPER_PLACEMENT : LOWER_PLACEMENT;
    const nodes = state.bracket.nodes.filter((node) => lane === "upper" ? node.lane === "upper" || node.lane === "final" : node.lane === "lower");
    const headings = lane === "upper" ? ["Четвертьфиналы", "Полуфиналы", "Финал верхней", "Гранд-финал"] : ["Раунд 1", "Раунд 2", "Полуфинал нижней", "Финал нижней"];
    return <section className={`fusion-bracket-track-wrap fusion-bracket-track-wrap--${lane}`}><h3>{lane === "upper" ? "ВЕРХНЯЯ СЕТКА" : "НИЖНЯЯ СЕТКА"}</h3><div className="fusion-bracket-rounds">{headings.map((heading) => <span key={heading}>{heading}</span>)}</div><div className={`fusion-bracket-track fusion-bracket-track--${lane}`}>{nodes.map((node) => { const slot = placement[node.label]; return slot ? <div key={node.label} className="fusion-bracket-slot" style={{ gridColumn: slot.column, gridRow: slot.row }}><BracketCard node={node} series={state.series} locks={state.betLocks} isAdmin={state.isAdmin} locking={locking} onLock={onLock} /></div> : null; })}</div></section>;
  };
  return <section className="fusion-panel fusion-bracket"><header><div><span>MAIN FORECAST · DOUBLE ELIMINATION</span><h2>Ровная сетка плей-офф</h2><p>Участники приходят из того же миллионного сценария Swiss и стыков. После каждого нового результата вся незамороженная ветка пересчитывается.</p></div><div className="fusion-bracket-champion"><span>MAIN-ЧЕМПИОН</span><b>{state.bracket.champion ? team(state.bracket.champion).name : "—"}</b></div></header>{state.bracket.nodes.length ? <div className="fusion-bracket-scroll fusion-scroll-hint" role="region" aria-label="Сетка плей-офф; на узком экране прокручивается горизонтально">{track("upper")}{track("lower")}</div> : <p className="fusion-empty">Сетка появится после сохранения основного Monte Carlo snapshot с восьмёркой участников.</p>}</section>;
}

export default function CombinedForecastPage() {
  const [opinionWeight, setOpinionWeight] = useState(10);
  const [snapshotId, setSnapshotId] = useState<number | null>(null);
  const [queryReady, setQueryReady] = useState(false);
  const [state, setState] = useState<CombinedState | null>(null);
  const [heroes, setHeroes] = useState<Map<number, Hero>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [locking, setLocking] = useState<string | null>(null);
  const [lockMessage, setLockMessage] = useState<string | null>(null);
  const [lockHasError, setLockHasError] = useState(false);
  const [isStale, setIsStale] = useState(false);
  const [expandedMatches, setExpandedMatches] = useState<Record<string, string>>({});
  useEffect(() => { const timer = window.setTimeout(() => { const params = new URLSearchParams(window.location.search); const run = Number(params.get("run")); const weight = Number(params.get("opinionWeight")); if (Number.isInteger(run) && run > 0) setSnapshotId(run); if ([0, 10, 20, 30].includes(weight)) setOpinionWeight(weight); setQueryReady(true); }, 0); return () => window.clearTimeout(timer); }, []);
  useEffect(() => { fetch("/draft-stats.json").then((response) => response.json()).then((data) => setHeroes(new Map((data.heroes as Hero[]).map((hero) => [hero.id, hero])))).catch(() => undefined); }, []);
  useEffect(() => { if (!queryReady) return; let cancelled = false; const load = async () => { try { const run = snapshotId ? `&run=${snapshotId}` : ""; const response = await fetch(`/api/combined?opinionWeight=${opinionWeight}${run}`, { cache: "no-store" }); if (!response.ok) throw new Error(`API ${response.status}`); const data = await response.json(); if (!cancelled) { setState(data); setError(null); setIsStale(Date.now() - Date.parse(data.generatedAt) > 30_000); } } catch (reason) { if (!cancelled) { setError(reason instanceof Error ? reason.message : String(reason)); setIsStale(true); } } }; void load(); const timer = window.setInterval(() => void load(), 10_000); return () => { cancelled = true; window.clearInterval(timer); }; }, [opinionWeight, queryReady, refreshKey, snapshotId]);
  const selectProfile = (weight: number) => { setOpinionWeight(weight); setSnapshotId(null); const url = new URL(window.location.href); url.searchParams.delete("run"); url.searchParams.set("opinionWeight", String(weight)); window.history.replaceState({}, "", url); };
  const lockBet = async (request: LockRequest) => {
    const seriesRow = request.scope === "series" ? state?.series.find((row) => String(row.match.id) === String(request.subjectId)) ?? null : null;
    if (seriesRow && seriesPresentation(seriesRow, state?.betLocks ?? []).hasStarted) {
      setLockHasError(true); setLockMessage("Фиксация закрыта: серия уже началась."); return;
    }
    const mapRow = request.scope === "map" ? state?.maps.find((map) => String(map.matchId) === String(request.subjectId)) ?? null : null;
    const teamA = seriesRow?.match.team_a ?? mapRow?.radiantTeam ?? "";
    const recommendedProbability = request.recommendedWinner === teamA ? request.probabilityA : 1 - request.probabilityA;
    const scoreLabel = request.exactScore ? `\nТочный счёт: ${request.exactScore}` : "";
    if (!window.confirm(`Зафиксировать необратимую ставку?\nПобедитель: ${team(request.recommendedWinner).name}\nВероятность: ${percent(recommendedProbability)}${scoreLabel}\n\nПосле подтверждения решение нельзя изменить.`)) return;
    const key = `${request.scope}:${request.subjectId}`; setLocking(key); setLockMessage(null); setLockHasError(false);
    try {
      const response = await fetch("/api/admin/bet-locks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...request, opinionWeight, snapshotId: state?.mainSnapshot?.id ?? null }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error === "admin_required" ? "Нужно войти в админский режим на главной странице." : payload.error === "bet_already_locked" ? "Эта ставка уже зафиксирована." : payload.error || `API ${response.status}`);
      setLockHasError(false); setLockMessage("Ставка зафиксирована. Последующие live-обновления её не изменят."); setRefreshKey((value) => value + 1);
    } catch (reason) { setLockHasError(true); setLockMessage(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLocking(null); }
  };
  const swiss = useMemo(() => state?.series.filter((row) => row.match.stage === "swiss") ?? [], [state]);
  const playins = useMemo(() => state?.series.filter((row) => row.match.stage === "playin") ?? [], [state]);
  const gradedSeriesBets = useMemo(() => state?.betLocks.filter((lock) => lock.scope === "series" && lock.winner) ?? [], [state]);
  const gradedMapBets = useMemo(() => state?.betLocks.filter((lock) => lock.scope === "map" && lock.winner) ?? [], [state]);
  const seriesCorrect = gradedSeriesBets.filter((lock) => lock.predictionCorrect).length;
  const draftCorrect = gradedMapBets.filter((lock) => lock.predictionCorrect).length;
  const comparison = state?.modelComparison ?? null;
  const toggleMatch = (matchId: number) => setExpandedMatches((current) => { const next = { ...current }; if (next[String(matchId)]) delete next[String(matchId)]; else next[String(matchId)] = "open"; return next; });
  return <main className="fusion-page"><header className="fusion-topbar"><a href="/" className="brand"><span className="brand-glyph">T</span><span>TI / PREDICTOR</span></a><nav><a href="/">Турнир</a><a href="/drafts">Пики</a><a href="/intel">Разведка</a><a className="active" href="/combined">Общий прогноз</a></nav><span className="live-pill"><i /> LIVE FUSION</span></header>
    <section className="fusion-hero fusion-hero--compact"><div><p>TABLE · BRACKET · MAP DRAFT · RESULT</p><h1>Прогноз,<br /><em>который помнит.</em></h1><span>Пока ставки нет, рекомендация свободно обновляется после новых матчей, пиков и live-данных. Нажатие «Я поставил» создаёт неизменяемый снимок именно того прогноза, по которому принято решение.</span></div><aside><label><span>ОСНОВНОЙ ПРОФИЛЬ</span><select value={opinionWeight} onChange={(event) => selectProfile(Number(event.target.value))}><option value={0}>0% · только статистика</option><option value={10}>10% · рекомендуемая смесь</option><option value={20}>20% · заметное влияние</option><option value={30}>30% · агрессивно</option></select></label><div><span><b>СТАВКИ НЕТ</b>можно обновлять</span><i>→</i><span><b>Я ПОСТАВИЛ</b>заморозить</span></div><small>{state?.mainSnapshot?.requested ? `Открыт исторический snapshot #${state.mainSnapshot.baselineId} · значения синхронизированы с главной` : state?.isAdmin ? "Админский режим активен · кнопки фиксации доступны" : "Войдите в админский режим на главной странице, чтобы фиксировать ставки"}</small></aside></section>
    {error || state?.live.error || isStale ? <div className={`fusion-data-banner ${error || state?.live.error ? "is-error" : "is-stale"}`} role="alert"><b>{error ? "ОБНОВЛЕНИЕ НЕ УДАЛОСЬ" : state?.live.error ? "LIVE-FEED НЕДОСТУПЕН" : "ДАННЫЕ УСТАРЕЛИ"}</b><span>{error ?? state?.live.error ?? `Последнее обновление: ${state ? new Date(state.generatedAt).toLocaleTimeString("ru-RU") : "—"}. Показываем последний успешный snapshot.`}</span></div> : null}
    {lockMessage ? <p className={`fusion-lock-message ${lockHasError ? "is-error" : "is-success"}`} role="status">{lockMessage}</p> : null}
    <details className="fusion-decision-help"><summary>Как работает фиксация ставки? <span>справка</span></summary><section className="fusion-decision-rule"><article><b>1</b><h3>Рекомендация</h3><p>Без ставки MAIN/LATEST может перепрогнозироваться сколько угодно.</p></article><article><b>2</b><h3>Нажал «Я поставил»</h3><p>Сохраняются победитель, вероятность, точный счёт, профиль, модель, пики и время.</p></article><article><b>3</b><h3>Пришёл результат</h3><p>Ставка получает «угадан/не угадан»; новые расчёты рядом не меняют историю.</p></article></section></details>
    <section className="fusion-metrics"><article><span>СТАВКИ НА СЕРИИ</span><b>{gradedSeriesBets.length ? `${seriesCorrect}/${gradedSeriesBets.length}` : "—"}</b><small>угадано из завершённых ставок</small></article><article><span>СТАВКИ ПОСЛЕ ПИКОВ</span><b>{gradedMapBets.length ? `${draftCorrect}/${gradedMapBets.length}` : "—"}</b><small>угадано карт из завершённых ставок</small></article><article><span>ВСЕГО ЗАФИКСИРОВАНО</span><b>{state?.betLocks.length ?? "—"}</b><small>неизменяемых решений</small></article><article><span>ОБНОВЛЕНО</span><b>{state ? new Date(state.generatedAt).toLocaleTimeString("ru-RU") : "—"}</b><small>{state?.live.error ? "live-feed с ошибкой" : "опрос каждые 10 секунд"}</small></article></section>
    {comparison ? <details className="fusion-model-details"><summary>Model gate · MAIN = {comparison.selected.toUpperCase()} <span>метрики</span></summary><section className={`fusion-model-gate fusion-model-gate--${comparison.selected}`}><div><span>PRODUCTION GATE · TEMPORAL</span><h2>MAIN = {comparison.selected.toUpperCase()}</h2><p>{comparison.selected === "static" ? "Adaptive не прошёл проверку качества и остаётся только в колонке LATEST. Ставка фиксирует STATIC." : "Adaptive улучшил accuracy, Brier и log loss и допущен в MAIN."}</p></div><dl><div><dt>STATIC</dt><dd>{comparison.static.correct}/{comparison.static.count}</dd><small>Brier {comparison.static.brier?.toFixed(3) ?? "—"} · LL {comparison.static.logLoss?.toFixed(3) ?? "—"}</small></div><div><dt>ADAPTIVE</dt><dd>{comparison.adaptive.correct}/{comparison.adaptive.count}</dd><small>Brier {comparison.adaptive.brier?.toFixed(3) ?? "—"} · LL {comparison.adaptive.logLoss?.toFixed(3) ?? "—"}</small></div></dl></section></details> : null}
    {!state && !error ? <section className="fusion-loading" aria-live="polite" aria-busy="true"><span /><span /><span /><p>Загружаем standings, live и прогнозы…</p></section> : null}
    {state ? <><LiveDraftRail rows={swiss} maps={state.maps} heroes={heroes} /><SwissMatrix rows={swiss} maps={state.maps} heroes={heroes} locks={state.betLocks} isAdmin={state.isAdmin} locking={locking} onLock={lockBet} expanded={expandedMatches} onToggle={toggleMatch} /></> : null}
    {state ? <TournamentProjection state={state} actualPlayins={playins} locking={locking} onLock={lockBet} /> : null}
    {state ? <PlayoffBracket state={state} locking={locking} onLock={lockBet} /> : null}
    <footer><div className="brand"><span className="brand-glyph">T</span><span>TI / PREDICTOR</span></div><p>LOCKED оценивает решение · LATEST объясняет новую информацию</p><a href="/drafts">Открыть Draft Lab →</a></footer>
  </main>;
}
