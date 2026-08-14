"use client";
/* eslint-disable @next/next/no-html-link-for-pages, @next/next/no-img-element -- Vinext navigation and external Dota hero art use native elements. */

import { Fragment, useEffect, useMemo, useState } from "react";

type Timeliness = { status: "actionable" | "late" | "after_start" | "unverified"; leadMinutes: number | null; eligible: boolean };
type Match = { id: number; stage: "swiss" | "playin" | "playoff"; round: number; team_a: string; team_b: string; winner: string | null; score_a: number | null; score_b: number | null; scheduled_at: string | null; predicted_probability: number | null };
type ExactScore = { score: string; probability: number };
type SeriesRow = {
  match: Match;
  seriesId: string | null;
  main: { probabilityA: number; exactScores: ExactScore[]; variant: "static" | "adaptive" };
  forecast: { probabilityA: number; baseMapProbabilityA: number; currentMapProbabilityA: number | null; winsA: number; winsB: number; exactScores: ExactScore[] };
  decision: { probabilityA: number | null; fallbackProbabilityA: number; capturedAt: string | null; timeliness: Timeliness | null; predictedWinner: string; predictedExactScore: string | null; predictedExactScoreProbability: number | null; predictionCorrect: boolean | null; exactScoreCorrect: boolean | null; historicalProbabilityA: number | null; historicalWinner: string | null; historicalExactScore: string | null; historicalExactScoreProbability: number | null; historicalSource: "snapshot" | "prematch" | null; historicalSnapshotId: number | null; historicalCapturedAt: string | null };
  latest: { probabilityA: number; generatedAt: string };
  live: null | { matchId: string; phase: "draft" | "game"; radiantTeam: string; direTeam: string; gameTime: number; radiantScore: number; direScore: number };
  sources: { draftApplied: boolean; liveStateApplied: boolean };
};
type DraftPrediction = { probabilityRadiant: number; modelId: string | null; capturedAt: string; predictedWinner: string; timeliness: Timeliness; predictionCorrect: boolean | null };
type MapRow = { matchId: string; seriesId: string; radiantTeam: string; direTeam: string; winner: string | null; startTime: number | null; duration: number | null; picks: null | { radiant: number[]; dire: number[] }; draftPrediction: DraftPrediction | null };
type BracketNode = { label: string; lane: "upper" | "lower" | "final"; column: number; a: string; b: string; bestOf: number; winner: string; predictedWinner: string; actualWinner: string | null; latestProbabilityA: number; lockedProbabilityA: number | null; decisionProbabilityA: number; exactScore: string | null; exactScoreProbability: number | null; actualScore: string | null; predictionCorrect: boolean | null; status: "completed" | "scheduled" | "projected"; matchId: number | null };
type BetLock = { id: number; scope: "series" | "map"; subjectId: string; teamA: string; teamB: string; probabilityA: number; recommendedWinner: string; exactScore: string | null; source: string; opinionWeight: number; snapshotId: number | null; modelId: string | null; createdAt: string; winner: string | null; actualScore: string | null; predictionCorrect: boolean | null; exactScoreCorrect: boolean | null };
type LockRequest = { scope: "series" | "map"; subjectId: string; probabilityA: number; recommendedWinner: string; exactScore?: string | null; evidence?: Record<string, unknown> };
type ModelScore = { count: number; correct: number; brier: number | null; logLoss: number | null };
type ProjectionMatch = { id: string; stage: "swiss" | "playin"; round: number; teamA: string; teamB: string; pairProbability: number; probabilityA: number; predictedWinner: string; exactScore: string | null; exactScoreProbability: number | null; occurrences: number };
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
  return <span className="fusion-team">{item.logo ? <img src={item.logo} alt="" /> : null}<b>{item.name}</b></span>;
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

function MapStrip({ maps, heroes, locks, isAdmin, locking, onLock }: { maps: MapRow[]; heroes: Map<number, Hero>; locks: BetLock[]; isAdmin: boolean; locking: string | null; onLock: (request: LockRequest) => void }) {
  if (!maps.length) return <p className="fusion-no-maps">Карты и пики появятся здесь после начала драфта.</p>;
  return <div className="fusion-series-maps">{maps.map((map, index) => {
    const prediction = map.draftPrediction;
    const predicted = prediction?.predictedWinner ?? null;
    const predictedProbability = prediction ? (predicted === map.radiantTeam ? prediction.probabilityRadiant : 1 - prediction.probabilityRadiant) : null;
    const betLock = locks.find((lock) => lock.scope === "map" && String(lock.subjectId) === String(map.matchId));
    const decisionWinner = betLock?.recommendedWinner ?? predicted;
    const decisionProbability = betLock ? (betLock.recommendedWinner === betLock.teamA ? betLock.probabilityA : 1 - betLock.probabilityA) : predictedProbability;
    const lowConfidence = isLowConfidence(decisionProbability);
    return <article key={map.matchId} className={`${map.winner ? "is-complete" : ""} ${lowConfidence ? "has-risk" : ""}`}>
      <header><b>КАРТА {index + 1}</b>{lowConfidence ? <RouletteRisk label /> : null}<span>{map.duration ? clock(map.duration) : map.winner ? "завершена" : "ожидание"}</span></header>
      <div className={`fusion-map-side ${map.winner === map.radiantTeam ? "is-winner" : ""}`}><Team id={map.radiantTeam} /><HeroPicks ids={map.picks?.radiant ?? []} heroes={heroes} /><span className="fusion-map-risk-slot">{lowConfidence && decisionWinner === map.radiantTeam ? <RouletteRisk /> : null}</span><em>{map.winner === map.radiantTeam ? "W" : map.winner ? "L" : "R"}</em></div>
      <div className={`fusion-map-side ${map.winner === map.direTeam ? "is-winner" : ""}`}><Team id={map.direTeam} /><HeroPicks ids={map.picks?.dire ?? []} heroes={heroes} /><span className="fusion-map-risk-slot">{lowConfidence && decisionWinner === map.direTeam ? <RouletteRisk /> : null}</span><em>{map.winner === map.direTeam ? "W" : map.winner ? "L" : "D"}</em></div>
      <footer>{betLock ? <><span><b>СТАВКА · {team(betLock.recommendedWinner).short} {percent(betLock.recommendedWinner === betLock.teamA ? betLock.probabilityA : 1 - betLock.probabilityA)}{lowConfidence ? <RouletteRisk /> : null}</b><small>зафиксирована {new Date(betLock.createdAt).toLocaleTimeString("ru-RU")}</small></span><Grade correct={betLock.predictionCorrect} /></> : prediction ? <><span><b>{team(predicted!).short} {percent(predictedProbability!)}{lowConfidence ? <RouletteRisk /> : null}</b><small>текущий draft-прогноз · ещё не ставка</small></span>{isAdmin && !map.winner ? <button className="fusion-bet-button" disabled={locking === `map:${map.matchId}`} onClick={() => onLock({ scope: "map", subjectId: map.matchId, probabilityA: prediction.probabilityRadiant, recommendedWinner: predicted!, evidence: { capturedAt: prediction.capturedAt, modelId: prediction.modelId } })}>{locking === `map:${map.matchId}` ? "Фиксирую…" : "Я поставил по рекомендации"}</button> : <Grade correct={null} />}</> : <span><b>Нет draft-прогноза</b><small>ставку задним числом не создаём</small></span>}</footer>
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

function seriesPresentation(row: SeriesRow, locks: BetLock[]) {
  const betLock = locks.find((lock) => lock.scope === "series" && String(lock.subjectId) === String(row.match.id)) ?? null;
  const latestProbabilityA = row.forecast.probabilityA;
  const latestWinner = latestProbabilityA >= .5 ? row.match.team_a : row.match.team_b;
  const latestExact = [...row.forecast.exactScores].sort((a, b) => b.probability - a.probability)[0] ?? null;
  const mainProbabilityA = row.main.probabilityA;
  const mainWinner = mainProbabilityA >= .5 ? row.match.team_a : row.match.team_b;
  const mainExact = [...row.main.exactScores].sort((a, b) => b.probability - a.probability)[0] ?? null;
  const scheduledAt = Date.parse(row.match.scheduled_at || "");
  const hasStarted = Boolean(row.match.winner || row.live || (Number.isFinite(scheduledAt) && scheduledAt <= Date.now()));
  const hasHistorical = hasStarted && row.decision.historicalProbabilityA !== null && Number.isFinite(row.decision.historicalProbabilityA);
  const source = betLock ? "bet" : hasHistorical ? "historical" : "main";
  const displayProbabilityA = betLock?.probabilityA ?? (hasHistorical ? row.decision.historicalProbabilityA! : mainProbabilityA);
  const displayWinner = betLock?.recommendedWinner ?? (hasHistorical ? row.decision.historicalWinner! : mainWinner);
  const displayExact = betLock?.exactScore ?? (hasHistorical ? row.decision.historicalExactScore : mainExact?.score) ?? null;
  const displayExactProbability = betLock ? null : hasHistorical ? row.decision.historicalExactScoreProbability : mainExact?.probability ?? null;
  return { betLock, source, hasStarted, latestProbabilityA, latestWinner, latestExact, mainProbabilityA, mainWinner, mainExact, mainVariant: row.main.variant, displayProbabilityA, displayWinner, displayExact, displayExactProbability };
}

function SeriesDetail({ row, maps, heroes, locks, isAdmin, locking, onLock }: { row: SeriesRow; maps: MapRow[]; heroes: Map<number, Hero>; locks: BetLock[]; isAdmin: boolean; locking: string | null; onLock: (request: LockRequest) => void }) {
  const view = seriesPresentation(row, locks);
  const delta = (view.latestProbabilityA - view.displayProbabilityA) * 100;
  const seriesMaps = mapsForSeries(row, maps);
  return <div className="fusion-expanded-series">
    <div className="fusion-expanded-summary">
      <article><small>ПАРА · SW R{row.match.round}</small><span className="fusion-matchup"><Team id={row.match.team_a} /><i>—</i><Team id={row.match.team_b} /></span></article>
      <article><small>MAIN / СТАВКА</small>{view.betLock ? <><span className="fusion-lock">СТАВКА ЗАФИКСИРОВАНА</span><strong>{team(view.displayWinner).short} {percent(view.displayWinner === row.match.team_a ? view.displayProbabilityA : 1 - view.displayProbabilityA)}</strong><em>{new Date(view.betLock.createdAt).toLocaleString("ru-RU")} · профиль {view.betLock.opinionWeight}%</em></> : view.source === "historical" ? <><span className="fusion-lock fusion-lock--historical">{row.decision.historicalSource === "snapshot" ? `ИСТОРИЧЕСКИЙ SNAPSHOT #${row.decision.historicalSnapshotId}` : "ИСТОРИЧЕСКИЙ PRE-MATCH"}</span><strong>{team(view.displayWinner).short} {percent(view.displayWinner === row.match.team_a ? view.displayProbabilityA : 1 - view.displayProbabilityA)}</strong><em>{row.decision.historicalCapturedAt ? new Date(row.decision.historicalCapturedAt).toLocaleString("ru-RU") : "сохранён до матча"} · не переписывается</em></> : <><span className="fusion-lock fusion-lock--snapshot">MAIN · {view.mainVariant.toUpperCase()}</span><strong>{team(view.displayWinner).short} {percent(view.displayWinner === row.match.team_a ? view.displayProbabilityA : 1 - view.displayProbabilityA)}</strong>{isAdmin && !view.hasStarted ? <button className="fusion-bet-button" disabled={locking === `series:${row.match.id}`} onClick={() => onLock({ scope: "series", subjectId: String(row.match.id), probabilityA: view.mainProbabilityA, recommendedWinner: view.mainWinner, exactScore: view.mainExact?.score, evidence: { exactScores: row.main.exactScores, sources: row.sources, modelVariant: view.mainVariant } })}>{locking === `series:${row.match.id}` ? "Фиксирую…" : "Я поставил по рекомендации"}</button> : <em>основная модель выбрана по temporal backtest</em>}</>}</article>
      <article><small>Точный счёт</small><strong>{view.displayExact ?? "—"}</strong><em>{view.betLock ? "сохранён со ставкой" : view.source === "historical" ? `${view.displayExactProbability === null ? "" : `${percent(view.displayExactProbability)} · `}исторический pre-match` : view.mainExact ? `${percent(view.mainExact.probability)} сценариев · MAIN ${view.mainVariant.toUpperCase()}` : "нет расчёта"}</em></article>
      <article><small>LATEST</small><strong>{team(view.latestWinner).short} {percent(view.latestWinner === row.match.team_a ? view.latestProbabilityA : 1 - view.latestProbabilityA)}</strong><em className={Math.abs(delta) >= 5 ? "fusion-delta is-large" : "fusion-delta"}>{view.betLock ? `${delta >= 0 ? "+" : ""}${delta.toFixed(1)} п.п. для ${team(row.match.team_a).short}` : "совпадает с MAIN"}{row.sources.liveStateApplied ? " · LIVE" : row.sources.draftApplied ? " · DRAFT" : " · новые серии"}</em></article>
      <article><small>ФАКТ</small>{row.match.winner ? <><strong>{row.match.score_a}:{row.match.score_b} · {team(row.match.winner).short}</strong>{view.betLock ? <Grade correct={view.betLock.predictionCorrect} /> : <span className="fusion-grade fusion-grade--late">СТАВКИ НЕ БЫЛО</span>}</> : row.live ? <><strong>{row.forecast.winsA}:{row.forecast.winsB} · {clock(row.live.gameTime)}</strong><span className="fusion-status fusion-status--live">LIVE</span></> : <span className="fusion-status fusion-status--next">до матча</span>}</article>
    </div>
    <MapStrip maps={seriesMaps} heroes={heroes} locks={locks} isAdmin={isAdmin} locking={locking} onLock={onLock} />
  </div>;
}

function SwissMatrix({ rows, maps, heroes, locks, isAdmin, locking, onLock, expanded, onToggle }: { rows: SeriesRow[]; maps: MapRow[]; heroes: Map<number, Hero>; locks: BetLock[]; isAdmin: boolean; locking: string | null; onLock: (request: LockRequest) => void; expanded: Record<string, string>; onToggle: (matchId: number, teamId: string) => void }) {
  const standings = useMemo(() => buildMatchStandings(rows), [rows]);
  const roundCount = Math.max(5, ...rows.map((row) => row.match.round));
  const rounds = Array.from({ length: roundCount }, (_, index) => index + 1);
  const completedCount = rows.filter((row) => row.match.winner).length;
  return <section className="fusion-panel fusion-matrix"><header><div><span>SWISS · МАТЧИ, НЕ КАРТЫ</span><h2>Таблица по матчам</h2><p>Одна таблица — вся история. Нажмите на матч: прогноз, ставка, карты и пики раскроются под командой. Можно открыть несколько.</p></div><div className="fusion-matrix-progress"><b>{completedCount}</b><span>завершено</span><small>из {rows.length} матчей</small></div></header><div className="fusion-table-wrap"><table className="fusion-table fusion-history-table"><thead><tr><th>#</th><th>Команда</th><th>Группа</th><th>Счёт</th>{rounds.map((round) => <th key={round}>Раунд {round}</th>)}<th>Итог</th></tr></thead><tbody>{standings.map((standing, standingIndex) => {
    const teamRows = rows.filter((row) => row.match.team_a === standing.teamId || row.match.team_b === standing.teamId);
    const openRows = teamRows.filter((row) => expanded[String(row.match.id)] === standing.teamId).sort((a, b) => a.match.round - b.match.round);
    const place = standingIndex + 1;
    return <Fragment key={standing.teamId}><tr><td><strong>{place}</strong></td><td><Team id={standing.teamId} /></td><td><span className={`fusion-group fusion-group--${standing.group.toLowerCase()}`}>{standing.group === "A" ? "A" : "Б"}</span></td><td><strong>{standing.wins}–{standing.losses}</strong></td>{rounds.map((round) => {
      const row = teamRows.find((item) => item.match.round === round);
      if (!row) return <td key={round} className="fusion-empty-round">—</td>;
      const opponent = row.match.team_a === standing.teamId ? row.match.team_b : row.match.team_a;
      const view = seriesPresentation(row, locks);
      const teamProbability = standing.teamId === row.match.team_a ? view.displayProbabilityA : 1 - view.displayProbabilityA;
      const isOpen = expanded[String(row.match.id)] === standing.teamId;
      const won = row.match.winner ? row.match.winner === standing.teamId : null;
      const predictionCorrect = row.match.winner ? view.displayWinner === row.match.winner : null;
      const winnerProbability = view.displayWinner === row.match.team_a ? view.displayProbabilityA : 1 - view.displayProbabilityA;
      const lowConfidence = isLowConfidence(winnerProbability);
      return <td key={round} className={won === true ? "is-won" : won === false ? "is-lost" : row.live ? "is-live" : ""}><button className={`fusion-round-match ${isOpen ? "is-open" : ""}`} aria-expanded={isOpen} onClick={() => onToggle(row.match.id, standing.teamId)}><span><Team id={opponent} /><span className="fusion-cell-forecast">{lowConfidence ? <RouletteRisk /> : null}<b>{percent(teamProbability)}</b>{predictionCorrect !== null ? <span className={`fusion-result-square ${predictionCorrect ? "is-correct" : "is-wrong"}`} title={`${won ? "Победа" : "Поражение"}; ${predictionCorrect ? "прогноз угадан" : "прогноз не угадан"}`}><strong>{won ? "W" : "L"}</strong><i>{predictionCorrect ? "✓" : "×"}</i></span> : null}</span></span><small>{row.match.winner ? `${row.match.score_a}:${row.match.score_b}` : row.live ? "LIVE" : `${view.displayExact ?? "—"} · ${view.betLock ? "ставка" : "main"}`}</small>{predictionCorrect !== null ? <em className={`fusion-prediction-verdict ${predictionCorrect ? "is-correct" : "is-wrong"}`}>{predictionCorrect ? "ПРОГНОЗ УГАДАН" : "ПРОГНОЗ НЕ УГАДАН"}</em> : <em className="fusion-prediction-verdict is-pending">MAIN: {team(view.displayWinner).short} · {percent(winnerProbability)}</em>}</button></td>;
    })}<td><span className={`fusion-outcome ${standing.wins >= 4 ? "is-qualified" : standing.losses >= 4 ? "is-eliminated" : ""}`}>{standing.wins >= 4 ? "НАПРЯМУЮ" : standing.losses >= 4 ? "ВЫЛЕТ" : standing.wins + standing.losses >= 5 ? "СТЫК" : "В ИГРЕ"}</span></td></tr>{openRows.map((row) => <tr key={`open-${row.match.id}`} className="fusion-matrix-expanded"><td colSpan={rounds.length + 5}><SeriesDetail row={row} maps={maps} heroes={heroes} locks={locks} isAdmin={isAdmin} locking={locking} onLock={onLock} /></td></tr>)}</Fragment>;
  })}</tbody></table></div></section>;
}

function ProjectionMatchCard({ match }: { match: ProjectionMatch }) {
  const winnerProbability = match.predictedWinner === match.teamA ? match.probabilityA : 1 - match.probabilityA;
  return <article className="fusion-projection-card">
    <header><span>{match.stage === "swiss" ? `SWISS · РАУНД ${match.round}` : "СТЫК"}</span><b>{match.pairProbability.toFixed(match.pairProbability < 10 ? 1 : 0)}%</b></header>
    <div><span className={match.predictedWinner === match.teamA ? "is-favorite" : ""}><Team id={match.teamA} /><b>{percent(match.probabilityA)}</b></span><i>—</i><span className={match.predictedWinner === match.teamB ? "is-favorite" : ""}><Team id={match.teamB} /><b>{percent(1 - match.probabilityA)}</b></span></div>
    <footer><span><small>MAIN-ПОБЕДИТЕЛЬ</small><b>{team(match.predictedWinner).name}</b></span><span><small>ТОЧНЫЙ СЧЁТ</small><b>{match.exactScore ? `${match.exactScore} · ${match.exactScoreProbability === null ? "—" : percent(match.exactScoreProbability)}` : "—"}</b></span>{isLowConfidence(winnerProbability) ? <RouletteRisk label /> : null}</footer>
    <p>Пара появляется в {match.pairProbability.toFixed(1)}% прогонов · прогноз обновится после нового результата</p>
  </article>;
}

function OfficialStageCard({ row, locks, isAdmin, locking, onLock }: { row: SeriesRow; locks: BetLock[]; isAdmin: boolean; locking: string | null; onLock: (request: LockRequest) => void }) {
  const view = seriesPresentation(row, locks);
  return <article className="fusion-projection-card is-official">
    <header><span>ОФИЦИАЛЬНАЯ ПАРА · СТЫК</span><b>100%</b></header>
    <div><span className={view.displayWinner === row.match.team_a ? "is-favorite" : ""}><Team id={row.match.team_a} /><b>{percent(view.displayProbabilityA)}</b></span><i>—</i><span className={view.displayWinner === row.match.team_b ? "is-favorite" : ""}><Team id={row.match.team_b} /><b>{percent(1 - view.displayProbabilityA)}</b></span></div>
    <footer><span><small>{view.betLock ? "СТАВКА" : "MAIN-ПОБЕДИТЕЛЬ"}</small><b>{team(view.displayWinner).name}</b></span><span><small>ТОЧНЫЙ СЧЁТ</small><b>{view.displayExact ? `${view.displayExact}${view.displayExactProbability === null ? "" : ` · ${percent(view.displayExactProbability)}`}` : "—"}</b></span>{isAdmin && !view.betLock && !view.hasStarted ? <button className="fusion-bet-button" disabled={locking === `series:${row.match.id}`} onClick={() => onLock({ scope: "series", subjectId: String(row.match.id), probabilityA: view.mainProbabilityA, recommendedWinner: view.mainWinner, exactScore: view.mainExact?.score, evidence: { exactScores: row.main.exactScores, modelVariant: view.mainVariant, stage: "playin" } })}>Я поставил по рекомендации</button> : null}</footer>
    <p>{row.match.winner ? `Факт: ${row.match.score_a}:${row.match.score_b} · ${team(row.match.winner).name}` : view.betLock ? "Решение заморожено; LATEST продолжит обновляться" : "Пара объявлена официально; MAIN обновляется до фиксации ставки"}</p>
  </article>;
}

function TournamentProjection({ state, actualPlayins, locking, onLock }: { state: CombinedState; actualPlayins: SeriesRow[]; locking: string | null; onLock: (request: LockRequest) => void }) {
  const simulation = state.simulation;
  if (!simulation) return <section className="fusion-panel fusion-simulation"><header><div><span>MONTE CARLO · ВЕСЬ ТУРНИР</span><h2>Готовим полный прогноз</h2></div></header></section>;
  const rounds = [...new Set(state.projections.swiss.map((match) => match.round))].sort((a, b) => a - b);
  return <section className="fusion-panel fusion-simulation">
    <header><div><span>MONTE CARLO · SWISS → СТЫКИ → PLAYOFF</span><h2>Как турнир развивается дальше</h2><p>Тот же полный прогон, что на главной. После каждого результата создаётся новая ревизия; зафиксированные ставки не переписываются.</p></div><div className="fusion-run-count"><b>{simulation.iterations.toLocaleString("ru-RU")}</b><span>полных турниров</span><small>snapshot #{state.mainSnapshot?.id ?? "—"} · после {state.mainSnapshot?.completedMatchCount ?? 0} результатов</small></div></header>
    <div className="fusion-simulation-stats"><span><b>{simulation.uniqueSwissOutcomes.toLocaleString("ru-RU")}</b><small>вариантов исхода Swiss</small></span><span><b>{simulation.uniqueTournamentPaths.toLocaleString("ru-RU")}</b><small>уникальных путей турнира</small></span><span><b>±{simulation.convergence?.maxSamplingMarginPp?.toFixed(2) ?? "—"} п.п.</b><small>максимальная ошибка выборки</small></span></div>
    <div className="fusion-scenario-grid">{simulation.scenarios.slice(0, 3).map((scenario, index) => <article key={`${scenario.rank}-${index}`}><header><span>СЦЕНАРИЙ {index + 1}</span><b>{scenario.probability < .1 ? scenario.probability.toFixed(3) : scenario.probability.toFixed(1)}%</b></header><small>{scenario.occurrences.toLocaleString("ru-RU")} из {simulation.iterations.toLocaleString("ru-RU")} прогонов</small><div><b>НАПРЯМУЮ</b><span>{[...scenario.direct40, ...scenario.direct41].map((id) => <Team key={id} id={id} />)}</span></div><div><b>ЧЕРЕЗ СТЫК</b><span>{scenario.via.map((id) => <Team key={id} id={id} />)}</span></div></article>)}</div>
    {!Array.isArray(simulation.swissMatchups) ? <div className="fusion-reforecast-status"><i /><span><b>Строится новая миллионная ревизия</b><small>Старый snapshot уже показывает исходы турнира, но распределение будущих пар появится после фонового перепрогона. Страница проверяет готовность каждые 10 секунд.</small></span></div> : rounds.length === 0 ? <div className="fusion-reforecast-status is-ready"><i /><span><b>Все ближайшие Swiss-пары уже объявлены</b><small>Новые варианты появятся после следующего результата и жеребьёвки.</small></span></div> : null}
    {rounds.map((round) => <div className="fusion-projection-stage" key={round}><header><div><span>БУДУЩИЕ ПАРЫ SWISS</span><h3>Раунд {round} · основные варианты</h3></div><small>частота пары рассчитана по всем {simulation.iterations.toLocaleString("ru-RU")} прогонам</small></header><div>{state.projections.swiss.filter((match) => match.round === round).map((match) => <ProjectionMatchCard key={match.id} match={match} />)}</div></div>)}
    <div className="fusion-projection-stage"><header><div><span>СТЫКОВЫЕ МАТЧИ</span><h3>{actualPlayins.length ? "Официальные пары и MAIN-прогноз" : "Вероятные пары и альтернативы"}</h3></div><small>победители заполняют оставшиеся пять мест playoff</small></header><div>{actualPlayins.map((row) => <OfficialStageCard key={row.match.id} row={row} locks={state.betLocks} isAdmin={state.isAdmin} locking={locking} onLock={onLock} />)}{state.projections.playins.map((match) => <ProjectionMatchCard key={match.id} match={match} />)}</div></div>
    <div className="fusion-simulation-table-wrap"><table><thead><tr><th>Команда</th><th>Напрямую</th><th>Попадёт в стык</th><th>Пройдёт стык</th><th>Плей-офф</th><th>Чемпион</th></tr></thead><tbody>{simulation.teams.map((item) => <tr key={item.id}><td><Team id={item.id} /></td><td>{item.direct.toFixed(1)}%</td><td>{item.playin.toFixed(1)}%</td><td>{item.viaPlayin.toFixed(1)}%</td><td><b>{item.qualify.toFixed(1)}%</b></td><td><strong>{item.champion.toFixed(1)}%</strong></td></tr>)}</tbody></table></div>
  </section>;
}

function BracketCard({ node, series, locks, isAdmin, locking, onLock }: { node: BracketNode; series: SeriesRow[]; locks: BetLock[]; isAdmin: boolean; locking: string | null; onLock: (request: LockRequest) => void }) {
  const actualSeries = node.matchId === null ? null : series.find((row) => row.match.id === node.matchId) ?? null;
  const betLock = node.matchId === null ? null : locks.find((lock) => lock.scope === "series" && String(lock.subjectId) === String(node.matchId)) ?? null;
  const actualView = actualSeries ? seriesPresentation(actualSeries, locks) : null;
  const actualProbabilityA = actualView ? (actualSeries!.match.team_a === node.a ? actualView.displayProbabilityA : 1 - actualView.displayProbabilityA) : null;
  const probabilityA = actualProbabilityA ?? (betLock?.teamA === node.a ? betLock.probabilityA : betLock?.teamB === node.a ? 1 - betLock.probabilityA : node.latestProbabilityA);
  const predictedWinner = actualView?.displayWinner ?? betLock?.recommendedWinner ?? (probabilityA >= .5 ? node.a : node.b);
  const exactScore = actualView?.displayExact ?? betLock?.exactScore ?? node.exactScore;
  return <article className={`fusion-bracket-card fusion-bracket-card--${node.status} ${betLock?.predictionCorrect === true ? "is-correct" : betLock?.predictionCorrect === false ? "is-wrong" : ""}`}>
    <header><span>{node.label}</span><b>BO{node.bestOf}</b></header>
    <div className={predictedWinner === node.a ? "is-winner" : ""}><Team id={node.a} /><em>{percent(probabilityA)}</em></div>
    <div className={predictedWinner === node.b ? "is-winner" : ""}><Team id={node.b} /><em>{percent(1 - probabilityA)}</em></div>
    <p><span>прогноз <b>{exactScore}</b></span>{node.actualScore ? <span>факт <b>{node.actualScore}</b></span> : <span>{betLock ? "ставка locked" : "main · обновляется"}</span>}</p>
    {node.actualWinner ? (betLock ? <Grade correct={betLock.predictionCorrect} /> : <span className="fusion-grade fusion-grade--late">СТАВКИ НЕ БЫЛО</span>) : betLock ? <small>ставка: {team(betLock.recommendedWinner).name}</small> : actualSeries && isAdmin ? <button className="fusion-bet-button" disabled={locking === `series:${actualSeries.match.id}`} onClick={() => onLock({ scope: "series", subjectId: String(actualSeries.match.id), probabilityA: actualSeries.main.probabilityA, recommendedWinner: actualSeries.main.probabilityA >= .5 ? actualSeries.match.team_a : actualSeries.match.team_b, exactScore: [...actualSeries.main.exactScores].sort((a, b) => b.probability - a.probability)[0]?.score, evidence: { bracketLabel: node.label, modelVariant: actualSeries.main.variant } })}>Я поставил по рекомендации</button> : <small>→ дальше: {team(node.winner).name}</small>}
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
  return <section className="fusion-panel fusion-bracket"><header><div><span>MAIN FORECAST · DOUBLE ELIMINATION</span><h2>Ровная сетка плей-офф</h2><p>Участники приходят из того же миллионного сценария Swiss и стыков. После каждого нового результата вся незамороженная ветка пересчитывается.</p></div><div className="fusion-bracket-champion"><span>MAIN-ЧЕМПИОН</span><b>{state.bracket.champion ? team(state.bracket.champion).name : "—"}</b></div></header>{state.bracket.nodes.length ? <div className="fusion-bracket-scroll">{track("upper")}{track("lower")}</div> : <p className="fusion-empty">Сетка появится после сохранения основного Monte Carlo snapshot с восьмёркой участников.</p>}</section>;
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
  const [expandedMatches, setExpandedMatches] = useState<Record<string, string>>({});
  useEffect(() => { const timer = window.setTimeout(() => { const params = new URLSearchParams(window.location.search); const run = Number(params.get("run")); const weight = Number(params.get("opinionWeight")); if (Number.isInteger(run) && run > 0) setSnapshotId(run); if ([0, 10, 20, 30].includes(weight)) setOpinionWeight(weight); setQueryReady(true); }, 0); return () => window.clearTimeout(timer); }, []);
  useEffect(() => { fetch("/draft-stats.json").then((response) => response.json()).then((data) => setHeroes(new Map((data.heroes as Hero[]).map((hero) => [hero.id, hero])))).catch(() => undefined); }, []);
  useEffect(() => { if (!queryReady) return; let cancelled = false; const load = async () => { try { const run = snapshotId ? `&run=${snapshotId}` : ""; const response = await fetch(`/api/combined?opinionWeight=${opinionWeight}${run}`, { cache: "no-store" }); if (!response.ok) throw new Error(`API ${response.status}`); const data = await response.json(); if (!cancelled) { setState(data); setError(null); } } catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); } }; void load(); const timer = window.setInterval(() => void load(), 10_000); return () => { cancelled = true; window.clearInterval(timer); }; }, [opinionWeight, queryReady, refreshKey, snapshotId]);
  const selectProfile = (weight: number) => { setOpinionWeight(weight); setSnapshotId(null); const url = new URL(window.location.href); url.searchParams.delete("run"); url.searchParams.set("opinionWeight", String(weight)); window.history.replaceState({}, "", url); };
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
  const comparison = state?.modelComparison ?? null;
  const toggleMatch = (matchId: number, teamId: string) => setExpandedMatches((current) => { const next = { ...current }; if (next[String(matchId)]) delete next[String(matchId)]; else next[String(matchId)] = teamId; return next; });
  return <main className="fusion-page"><header className="fusion-topbar"><a href="/" className="brand"><span className="brand-glyph">T</span><span>TI / PREDICTOR</span></a><nav><a href="/">Турнир</a><a href="/drafts">Пики</a><a href="/intel">Разведка</a><a className="active" href="/combined">Общий прогноз</a></nav><span className="live-pill"><i /> LIVE FUSION</span></header>
    <section className="fusion-hero fusion-hero--compact"><div><p>TABLE · BRACKET · MAP DRAFT · RESULT</p><h1>Прогноз,<br /><em>который помнит.</em></h1><span>Пока ставки нет, рекомендация свободно обновляется после новых матчей, пиков и live-данных. Нажатие «Я поставил» создаёт неизменяемый снимок именно того прогноза, по которому принято решение.</span></div><aside><label><span>ОСНОВНОЙ ПРОФИЛЬ</span><select value={opinionWeight} onChange={(event) => selectProfile(Number(event.target.value))}><option value={0}>0% · только статистика</option><option value={10}>10% · рекомендуемая смесь</option><option value={20}>20% · заметное влияние</option><option value={30}>30% · агрессивно</option></select></label><div><span><b>СТАВКИ НЕТ</b>можно обновлять</span><i>→</i><span><b>Я ПОСТАВИЛ</b>заморозить</span></div><small>{state?.mainSnapshot?.requested ? `Открыт исторический snapshot #${state.mainSnapshot.baselineId} · значения синхронизированы с главной` : state?.isAdmin ? "Админский режим активен · кнопки фиксации доступны" : "Войдите в админский режим на главной странице, чтобы фиксировать ставки"}</small></aside></section>
    {error ? <p className="fusion-error">Не удалось загрузить общий прогноз: {error}</p> : null}
    {lockMessage ? <p className="fusion-lock-message">{lockMessage}</p> : null}
    <section className="fusion-decision-rule"><article><b>1</b><h3>Рекомендация</h3><p>Без ставки MAIN/LATEST может перепрогнозироваться сколько угодно.</p></article><article><b>2</b><h3>Нажал «Я поставил»</h3><p>Сохраняются победитель, вероятность, точный счёт, профиль, модель, пики и время.</p></article><article><b>3</b><h3>Пришёл результат</h3><p>Ставка получает «угадан/не угадан»; новые расчёты рядом не меняют историю.</p></article></section>
    <section className="fusion-metrics"><article><span>СТАВКИ НА СЕРИИ</span><b>{gradedSeriesBets.length ? `${seriesCorrect}/${gradedSeriesBets.length}` : "—"}</b><small>угадано из завершённых ставок</small></article><article><span>СТАВКИ ПОСЛЕ ПИКОВ</span><b>{gradedMapBets.length ? `${draftCorrect}/${gradedMapBets.length}` : "—"}</b><small>угадано карт из завершённых ставок</small></article><article><span>ВСЕГО ЗАФИКСИРОВАНО</span><b>{state?.betLocks.length ?? "—"}</b><small>неизменяемых решений</small></article><article><span>ОБНОВЛЕНО</span><b>{state ? new Date(state.generatedAt).toLocaleTimeString("ru-RU") : "—"}</b><small>{state?.live.error ? "live-feed с ошибкой" : "опрос каждые 10 секунд"}</small></article></section>
    {comparison ? <section className={`fusion-model-gate fusion-model-gate--${comparison.selected}`}><div><span>PRODUCTION GATE · TEMPORAL</span><h2>MAIN = {comparison.selected.toUpperCase()}</h2><p>{comparison.selected === "static" ? "Adaptive не прошёл проверку качества и остаётся только в колонке LATEST. Ставка фиксирует STATIC." : "Adaptive улучшил accuracy, Brier и log loss и допущен в MAIN."}</p></div><dl><div><dt>STATIC</dt><dd>{comparison.static.correct}/{comparison.static.count}</dd><small>Brier {comparison.static.brier?.toFixed(3) ?? "—"} · LL {comparison.static.logLoss?.toFixed(3) ?? "—"}</small></div><div><dt>ADAPTIVE</dt><dd>{comparison.adaptive.correct}/{comparison.adaptive.count}</dd><small>Brier {comparison.adaptive.brier?.toFixed(3) ?? "—"} · LL {comparison.adaptive.logLoss?.toFixed(3) ?? "—"}</small></div></dl></section> : null}
    <SwissMatrix rows={swiss} maps={state?.maps ?? []} heroes={heroes} locks={state?.betLocks ?? []} isAdmin={Boolean(state?.isAdmin)} locking={locking} onLock={lockBet} expanded={expandedMatches} onToggle={toggleMatch} />
    {state ? <TournamentProjection state={state} actualPlayins={playins} locking={locking} onLock={lockBet} /> : null}
    {state ? <PlayoffBracket state={state} locking={locking} onLock={lockBet} /> : null}
    <footer><div className="brand"><span className="brand-glyph">T</span><span>TI / PREDICTOR</span></div><p>LOCKED оценивает решение · LATEST объясняет новую информацию</p><a href="/drafts">Открыть Draft Lab →</a></footer>
  </main>;
}
