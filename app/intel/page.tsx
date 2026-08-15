"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- Vinext navigation uses native links. */

import { useEffect, useMemo, useState } from "react";

type TeamMeta = { id: string; name: string; short: string; color: string; logo: string };
type ContextRecord = { id: string; label: string; maps: number; wins: number; losses: number; winRate: number | null; from: string | null; to: string | null };
type StyleMetric = { id: string; label: string; value: number | null; unit: string; higherIs: string; detail: string; percentile: number };
type Storyline = { kind: string; title: string; detail: string; metricId: string; direction: "up" | "down"; impactPp: number | null; score: number; confidence: "low" | "medium" | "high"; causal: boolean };
type Player = { accountId: number; name: string; role: number; roleName: string; games: number; winRate: number | null; kda: number | null; gpm: number | null; xpm: number | null; heroPool: number; topHeroes: { heroId: number; games: number }[] };
type IntelTeam = { id: string; name: string; contexts: ContextRecord[]; latestPatch: number; style: { sampleMaps: number; metrics: StyleMetric[] }; players: Player[]; storylines: Storyline[]; identity: { openDotaIds: number[]; aliases: string[]; rosterAccounts: number[] }; dataQuality: { score: number; grade: string; maps: number; parsedMaps: number; exactRosterShare: number; parsedShare: number; projection: boolean } };
type TournamentOdds = { qualify: number; top3: number; final: number; champion: number };
type IntelData = { generatedAt: string; modelGeneratedAt: string; methodology: { acceptedMaps: number; parsedReplayFiles: number; contexts: string[]; storylineFormula: string; caveat: string }; sources: { id: string; label: string; url: string | null; role: string; retrievedAt: string }[]; matchPatches: Record<string, number>; tournament: { iterations: number; seed: number; teams: Record<string, TournamentOdds> }; teams: Record<string, IntelTeam> };
type Pair = { probabilityA: number; mapProbabilityA: number; directEffectiveGames: number; modelEffectiveGames: number; source: string; confidence: string; uncertainty: number; featureContributions?: { commonOpponentsPp: number; headToHeadPp: number; rosterPp: number } };
type Series = { opponentTiId: string | null; startTime: number; wins: number; losses: number; maps: { matchId: number; startTime: number; won: boolean }[] };
type StatsTeam = { tournaments: { rosterStatus: string; series: Series[] }[] };
type TeamStats = { generatedAt: string; methodology: { recencyHalfLifeDays: number; directMatchPriorSeries: number }; pairwise: Record<string, Pair>; teams: Record<string, StatsTeam> };
type Snapshot = { probabilities: Record<string, number>; result: { teams?: Array<{ id: string; qualify: number; top3?: number; final?: number; champion?: number }> }; created_at: string };

const TEAMS: TeamMeta[] = [
  { id: "1w", name: "1w", short: "1W", color: "#f1f4f7", logo: "/team-logos/1w.webp" },
  { id: "aurora", name: "Aurora", short: "AU", color: "#19d3cb", logo: "/team-logos/aurora.webp" },
  { id: "betboom", name: "BETBOOM", short: "BB", color: "#ff384f", logo: "/team-logos/betboom.webp" },
  { id: "falcons", name: "Falcons", short: "FL", color: "#6bd263", logo: "/team-logos/falcons.jpg" },
  { id: "gamerlegion", name: "GamerLegion", short: "GL", color: "#94b9c7", logo: "/team-logos/gamerlegion.webp" },
  { id: "l1ga", name: "L1ga", short: "L1", color: "#4bfa6d", logo: "/team-logos/l1ga.webp" },
  { id: "lgd", name: "LGD", short: "LG", color: "#e32a4d", logo: "/team-logos/lgd.webp" },
  { id: "liquid", name: "Liquid", short: "TL", color: "#5f83d8", logo: "/team-logos/liquid.webp" },
  { id: "nigma", name: "Nigma", short: "NG", color: "#939aa7", logo: "/team-logos/nigma.webp" },
  { id: "og", name: "OG", short: "OG", color: "#a2c974", logo: "/team-logos/og.webp" },
  { id: "parivision", name: "PARIVISION", short: "PV", color: "#20d8c3", logo: "/team-logos/parivision.webp" },
  { id: "resilience", name: "Resilience", short: "RS", color: "#ec4a52", logo: "/team-logos/resilience.webp" },
  { id: "spirit", name: "Spirit", short: "SP", color: "#d8dee7", logo: "/team-logos/spirit.webp" },
  { id: "vg", name: "VG", short: "VG", color: "#c9b78d", logo: "/team-logos/vg.webp" },
  { id: "xtreme", name: "Xtreme", short: "XT", color: "#dce3ea", logo: "/team-logos/xtreme.webp" },
  { id: "yandex", name: "Yandex", short: "YX", color: "#ff514f", logo: "/team-logos/yandex.webp" },
];

const CONTEXTS = [
  { id: "days90", label: "90 дней" }, { id: "patch", label: "Патч" }, { id: "current", label: "Текущая пятёрка" },
  { id: "ti-field", label: "Против поля TI" }, { id: "year", label: "12 месяцев" },
];
const pairKey = (a: string, b: string) => [a, b].sort().join("|");
const getTeam = (id: string) => TEAMS.find((team) => team.id === id) ?? TEAMS[0];
const probabilityFor = (a: string, b: string, values: Record<string, number>) => {
  const key = pairKey(a, b); const stored = values[key];
  if (!Number.isFinite(stored)) return 50;
  return key.startsWith(`${a}|`) ? stored : 100 - stored;
};
const confidenceRu = (value: string) => value === "high" ? "высокая" : value === "medium" ? "средняя" : "низкая";
const sourceRu = (value: string) => value === "head_to_head_and_indirect" ? "H2H + общие соперники" : value === "roster_proxy" ? "проекция состава" : "общие соперники";
const date = (value: string) => new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value));
const signed = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(1)} п.п.`;

function TeamLogo({ team, small = false }: { team: TeamMeta; small?: boolean }) {
  return <span className={`intel-team-logo ${small ? "is-small" : ""}`} style={{ "--intel-team": team.color } as React.CSSProperties}>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={team.logo} alt="" />
  </span>;
}

function contextCutoff(context: string) {
  if (context === "days90") return Date.now() / 1000 - 90 * 86400;
  return 0;
}

function headToHead(stats: TeamStats, intel: IntelData, a: string, b: string, context: string) {
  let wins = 0; let losses = 0;
  const cutoff = contextCutoff(context);
  for (const tournament of stats.teams[a]?.tournaments ?? []) {
    if (context === "current" && tournament.rosterStatus !== "current") continue;
    if (tournament.rosterStatus !== "current" && tournament.rosterStatus !== "proxy") continue;
    for (const series of tournament.series ?? []) {
      if (series.opponentTiId !== b) continue;
      for (const map of series.maps ?? []) {
        if (map.startTime < cutoff) continue;
        if (context === "patch" && intel.matchPatches[String(map.matchId)] !== intel.teams[a].latestPatch) continue;
        wins += map.won ? 1 : 0; losses += map.won ? 0 : 1;
      }
    }
  }
  return { wins, losses, maps: wins + losses, rate: wins + losses ? 100 * wins / (wins + losses) : null };
}

function percent(value: number | null | undefined) { return Number.isFinite(value) ? `${Number(value).toFixed(1)}%` : "—"; }

export default function IntelPage() {
  const [intel, setIntel] = useState<IntelData | null>(null);
  const [stats, setStats] = useState<TeamStats | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [context, setContext] = useState("days90");
  const [matrixMode, setMatrixMode] = useState<"model" | "h2h">("model");
  const [selectedPair, setSelectedPair] = useState<[string, string]>(["liquid", "spirit"]);
  const [selectedTeam, setSelectedTeam] = useState("liquid");
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      fetch("/intel-stats.json").then((response) => { if (!response.ok) throw new Error("intel-stats"); return response.json(); }),
      fetch("/team-stats.json").then((response) => { if (!response.ok) throw new Error("team-stats"); return response.json(); }),
      fetch("/api/state").then((response) => response.ok ? response.json() : null).catch(() => null),
    ]).then(([intelData, teamData, state]) => {
      setIntel(intelData); setStats(teamData); setSnapshot(state?.snapshots?.[0] ?? null);
    }).catch(() => setError("Не удалось загрузить разведданные. Запусти npm run intel:update."));
  }, []);

  const modelProbabilities = useMemo(() => {
    if (snapshot?.probabilities) return snapshot.probabilities;
    return Object.fromEntries(Object.entries(stats?.pairwise ?? {}).map(([key, pair]) => [key, pair.probabilityA]));
  }, [snapshot, stats]);

  const odds = useMemo(() => {
    const current = { ...(intel?.tournament.teams ?? {}) };
    for (const team of snapshot?.result?.teams ?? []) if (Number.isFinite(team.champion)) current[team.id] = {
      qualify: team.qualify, top3: team.top3 ?? 0, final: team.final ?? 0, champion: team.champion ?? 0,
    };
    return current;
  }, [intel, snapshot]);

  const ranking = useMemo(() => TEAMS.map((team) => ({ team, ...(odds[team.id] ?? { qualify: 0, top3: 0, final: 0, champion: 0 }) })).sort((a, b) => b.champion - a.champion), [odds]);
  const pair = stats?.pairwise[pairKey(...selectedPair)];
  const pairOrientation = pairKey(...selectedPair).startsWith(`${selectedPair[0]}|`) ? 1 : -1;
  const selectedH2h = stats && intel ? headToHead(stats, intel, selectedPair[0], selectedPair[1], context) : null;
  const selected = intel?.teams[selectedTeam];

  if (error) return <main className="intel-loading"><b>INTEL ERROR</b><p>{error}</p><a href="/">← К прогнозу</a></main>;
  if (!intel || !stats) return <main className="intel-loading"><b>TI / INTEL</b><p>Собираю карту поля…</p></main>;

  return <main className="intel-page" id="top">
    <header className="topbar intel-topbar">
      <a className="brand" href="/" aria-label="Вернуться к прогнозу турнира"><span className="brand-glyph">T</span><span>TI / PREDICTOR</span></a>
      <nav aria-label="Разделы"><a href="/">Прогноз</a><a href="/#live">Live-карты</a><a className="is-current" href="/intel">Разведка</a><a href="#sources">Данные</a></nav>
    </header>

    <section className="intel-hero">
      <div><p className="eyebrow">TI 2026 · COMPETITIVE INTELLIGENCE</p><h1>Карта<br/><em>поля</em></h1></div>
      <div className="intel-hero-copy"><p>Не просто «кто чаще побеждал», а <b>каким составом, на какой дистанции, в каком стиле и что это меняет в прогнозе.</b></p><dl><div><dt>{intel.methodology.acceptedMaps}</dt><dd>карт в модели</dd></div><div><dt>{intel.methodology.parsedReplayFiles}</dt><dd>реплеев разобрано</dd></div><div><dt>{intel.tournament.iterations.toLocaleString("ru-RU")}</dt><dd>симуляций TI</dd></div></dl></div>
      <span className="intel-freshness">DATA CUT · {date(intel.generatedAt)}{snapshot ? ` · LIVE ${date(snapshot.created_at)}` : ""}</span>
    </section>

    <section className="intel-section intel-odds" id="odds">
      <header className="intel-section-head"><div><p className="eyebrow">ЭКСПЕРИМЕНТАЛЬНЫЕ ВЕРОЯТНОСТИ · НЕ БУКМЕКЕРСКИЕ КОЭФФИЦИЕНТЫ</p><h2>От швейцарки до Aegis</h2></div><p>Исследовательская модель: проценты показывают текущую симуляцию и не являются готовыми коэффициентами. Live-снимок автоматически заменяет базовый расчёт.</p></header>
      <div className="intel-odds-grid">
        {ranking.map((row, index) => <button key={row.team.id} onClick={() => { setSelectedTeam(row.team.id); document.getElementById("teams")?.scrollIntoView({ behavior: "smooth" }); }}>
          <span className="intel-rank">{String(index + 1).padStart(2, "0")}</span><TeamLogo team={row.team} /><span className="intel-odds-name"><b>{row.team.name}</b><small>Плей-офф {percent(row.qualify)}</small></span>
          <span><small>TOP 3</small><b>{percent(row.top3)}</b></span><span><small>ФИНАЛ</small><b>{percent(row.final)}</b></span><span className="is-champion"><small>ЧЕМПИОН</small><b>{percent(row.champion)}</b></span>
        </button>)}
      </div>
    </section>

    <section className="intel-section intel-matrix-section" id="matrix">
      <header className="intel-section-head"><div><p className="eyebrow">МАТРИЦА ПОЛЯ · 16 × 16</p><h2>История и прогноз рядом</h2></div><p>Клик по ячейке раскрывает выборку и вклад факторов. H2H — фактические карты выбранного периода; модель — вероятность серии BO3.</p></header>
      <div className="intel-toolbar"><div>{CONTEXTS.map((item) => <button className={context === item.id ? "active" : ""} key={item.id} onClick={() => setContext(item.id)}>{item.label}</button>)}</div><div><button className={matrixMode === "model" ? "active" : ""} onClick={() => setMatrixMode("model")}>Модель BO3</button><button className={matrixMode === "h2h" ? "active" : ""} onClick={() => setMatrixMode("h2h")}>Факт H2H</button></div></div>
      <div className="intel-matrix-wrap"><table className="intel-matrix"><thead><tr><th>TEAM</th>{TEAMS.map((team) => <th key={team.id} title={team.name}>{team.short}</th>)}</tr></thead><tbody>{TEAMS.map((teamA) => <tr key={teamA.id}><th><TeamLogo team={teamA} small/><span>{teamA.short}</span></th>{TEAMS.map((teamB) => {
        if (teamA.id === teamB.id) return <td className="is-self" key={teamB.id}>—</td>;
        const h2h = headToHead(stats, intel, teamA.id, teamB.id, context);
        const value = matrixMode === "model" ? probabilityFor(teamA.id, teamB.id, modelProbabilities) : h2h.rate;
        const strength = value === null ? 0 : Math.abs(value - 50) / 50;
        return <td key={teamB.id}><button title={`${teamA.name} — ${teamB.name}`} onClick={() => setSelectedPair([teamA.id, teamB.id])} className={selectedPair[0] === teamA.id && selectedPair[1] === teamB.id ? "selected" : ""} style={{ "--cell-strength": strength, "--cell-color": value !== null && value < 50 ? "#ff6573" : "#d8ff48" } as React.CSSProperties}>{value === null ? "·" : Math.round(value)}</button></td>;
      })}</tr>)}</tbody></table></div>
      <article className="intel-pair-inspector">
        <div className="intel-pair-title"><TeamLogo team={getTeam(selectedPair[0])}/><span><small>ЭКСПЕРИМЕНТАЛЬНАЯ ВЕРОЯТНОСТЬ BO3</small><b>{getTeam(selectedPair[0]).name}</b></span><strong>{probabilityFor(selectedPair[0], selectedPair[1], modelProbabilities).toFixed(1)}<i>%</i></strong><em>VS</em><strong>{(100 - probabilityFor(selectedPair[0], selectedPair[1], modelProbabilities)).toFixed(1)}<i>%</i></strong><span><small>{CONTEXTS.find((item) => item.id === context)?.label}</small><b>{getTeam(selectedPair[1]).name}</b></span><TeamLogo team={getTeam(selectedPair[1])}/></div>
        <div className="intel-pair-facts"><div><small>ЛИЧНЫЕ КАРТЫ</small><b>{selectedH2h?.maps ? `${selectedH2h.wins}–${selectedH2h.losses}` : "нет выборки"}</b><span>{selectedH2h?.maps ?? 0} карт в контексте</span></div><div><small>НАДЁЖНОСТЬ</small><b>{confidenceRu(pair?.confidence ?? "low")}</b><span>{pair ? `${pair.modelEffectiveGames.toFixed(1)} эффективных серий` : "—"}</span></div><div><small>ИСТОЧНИК СИГНАЛА</small><b>{sourceRu(pair?.source ?? "indirect")}</b><span>uncertainty ±{Math.round(100 * (pair?.uncertainty ?? .07))}%</span></div></div>
        {pair?.featureContributions && <div className="intel-contributions"><span><b>Общие соперники</b><em>{signed(pairOrientation * pair.featureContributions.commonOpponentsPp)}</em></span><span><b>Личные встречи</b><em>{signed(pairOrientation * pair.featureContributions.headToHeadPp)}</em></span><span><b>Состав / проекция</b><em>{signed(pairOrientation * pair.featureContributions.rosterPp)}</em></span></div>}
      </article>
    </section>

    <section className="intel-section intel-teams" id="teams">
      <header className="intel-section-head"><div><p className="eyebrow">ДОСЬЕ КОМАНД</p><h2>Контекст вместо голой цифры</h2></div><p>Пять срезов результатов, три автоматически выбранных сюжета и честная оценка качества данных для каждой команды.</p></header>
      <div className="intel-team-grid">{TEAMS.map((meta) => {
        const team = intel.teams[meta.id]; const teamContext = team.contexts.find((item) => item.id === context) ?? team.contexts[0]; const teamOdds = odds[meta.id];
        return <button className={selectedTeam === meta.id ? "active" : ""} key={meta.id} onClick={() => setSelectedTeam(meta.id)}><header><TeamLogo team={meta}/><span><small>QUALITY {team.dataQuality.grade} · {team.dataQuality.score}/100</small><b>{meta.name}</b></span><em>{percent(teamOdds?.champion)}</em></header><div className="intel-team-record"><strong>{teamContext.wins}–{teamContext.losses}</strong><span><b>{percent(teamContext.winRate)}</b><small>{teamContext.label} · {teamContext.maps} карт</small></span></div><ul>{team.storylines.map((story) => <li key={story.metricId}><i className={story.direction}/><span><b>{story.title}</b><small>{story.causal && story.impactPp !== null ? `${signed(story.impactPp)} к среднему матчапу` : story.detail}</small></span></li>)}</ul><footer><span>Плей-офф <b>{percent(teamOdds?.qualify)}</b></span><span>TOP 3 <b>{percent(teamOdds?.top3)}</b></span><span>Подробнее →</span></footer></button>;
      })}</div>

      {selected && <article className="intel-team-detail">
        <header><div><TeamLogo team={getTeam(selectedTeam)}/><span><p className="eyebrow">DEEP DIVE · {selected.dataQuality.parsedMaps} PARSED MAPS</p><h3>{getTeam(selectedTeam).name}</h3></span></div><p>Точный состав: {selected.dataQuality.exactRosterShare}% выборки · телеметрия: {selected.dataQuality.parsedShare}% карт · OpenDota ID: {selected.identity.openDotaIds.join(", ")} · {selected.identity.aliases.length} алиасов.</p></header>
        <div className="intel-context-strip">{selected.contexts.map((item) => <button className={context === item.id ? "active" : ""} onClick={() => setContext(item.id)} key={item.id}><small>{item.label}</small><b>{item.wins}–{item.losses}</b><span>{percent(item.winRate)} · {item.maps} карт</span></button>)}</div>
        <div className="intel-detail-columns"><section><div className="intel-subhead"><span><p className="eyebrow">TEAM IDENTITY</p><h4>Почерк по реплеям</h4></span><small>перцентиль среди 16 команд</small></div><div className="intel-style-list">{selected.style.metrics.map((item) => <div key={item.id}><span><b>{item.label}</b><small>{item.detail}</small></span><strong>{item.value ?? "—"}<i>{item.unit === "%" ? "%" : ` ${item.unit}`}</i></strong><em><i style={{ width: `${item.percentile}%` }}/></em><small>P{item.percentile}</small></div>)}</div></section>
        <section><div className="intel-subhead"><span><p className="eyebrow">CURRENT FIVE</p><h4>Профили игроков</h4></span><small>роли определены по parsed matches</small></div><div className="intel-player-list">{selected.players.map((player) => <div key={player.accountId}><span className="intel-position">{player.role || "?"}</span><span><b>{player.name}</b><small>{player.roleName} · пул {player.heroPool} героев</small></span><span><small>КАРТЫ</small><b>{player.games}</b></span><span><small>WR</small><b>{percent(player.winRate)}</b></span><span><small>KDA</small><b>{player.kda ?? "—"}</b></span><span><small>GPM</small><b>{player.gpm ?? "—"}</b></span></div>)}</div></section></div>
        <div className="intel-story-detail">{selected.storylines.map((story) => <article key={story.metricId}><header><span>{story.score}</span><small>INTERESTINGNESS</small><em>{story.causal ? "В МОДЕЛИ" : "ОПИСАТЕЛЬНО"}</em></header><h4>{story.title}</h4><p>{story.detail}</p><footer>Надёжность: {confidenceRu(story.confidence)}{story.impactPp !== null ? ` · влияние ${signed(story.impactPp)}` : " · причинное влияние не заявляется"}</footer></article>)}</div>
      </article>}
    </section>

    <section className="intel-section intel-sources" id="sources">
      <header className="intel-section-head"><div><p className="eyebrow">DATA PROVENANCE</p><h2>Каждая цифра оставляет след</h2></div><p>Источник, дата среза, размер выборки и эпоха состава видны в продукте. Это защищает от тихих ошибок с переименованиями и сменами пятёрок.</p></header>
      <div className="intel-source-grid">{intel.sources.map((source, index) => <article key={source.id}><span>{String(index + 1).padStart(2, "0")}</span><div><h3>{source.label}</h3><p>{source.role}</p><small>Срез: {date(source.retrievedAt)}</small>{source.url && <a href={source.url} target="_blank" rel="noreferrer">Открыть первоисточник ↗</a>}</div></article>)}</div>
      <div className="intel-method"><p><b>Автовыбор сюжетов:</b> {intel.methodology.storylineFormula}.</p><p><b>Ограничение:</b> стилевые метрики описывают поведение и не выдаются за причинные факторы прогноза. Влияние в п.п. показывается только для сигналов, которые действительно входят в модель.</p><p><b>Следующий уровень данных:</b> собственное хранение `.dem` и повторный парсинг нужны для независимости от покрытия OpenDota; текущий pipeline уже рассчитан на эти же поля.</p></div>
    </section>

    <footer className="intel-footer"><div className="brand"><span className="brand-glyph">T</span><span>TI / PREDICTOR</span></div><p>Прогноз говорит, что будет. Разведка объясняет, на каких данных он стоит.</p><a href="#top">Наверх ↑</a></footer>
  </main>;
}
