"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

type Team = { id: string; name: string; short: string; color: string; logo: string };
type Hero = {
  id: number;
  name: string;
  slug: string;
  image: string;
  icon: string;
  primaryAttribute: "str" | "agi" | "int" | "all";
  attackType: "Melee" | "Ranged";
  roles: string[];
  proPicks: number;
  proBans: number;
  proWinRate: number;
  rankedPicks: number;
  rankedWinRate: number;
  patchSample: number;
  modelWinRate: number;
};
type Sample = { games: number; winRate: number };
type DraftStats = {
  generatedAt: string;
  provider: string;
  radiantWinRate: number;
  methodology: {
    latestOpenDotaPatchId: number;
    cachedPatchMaps: number;
    proPriorGames: number;
    patchPriorGames: number;
    pairPriorGames: number;
    caveat: string;
  };
  heroes: Hero[];
  synergy: Record<string, Sample>;
  counters: Record<string, Sample>;
  teams: Record<string, { maps: number; heroes: Record<string, Sample> }>;
};
type TeamStats = { pairwise: Record<string, { mapProbabilityA: number }> };
type Side = "a" | "b";
type Pick = number | null;
type Feature = { label: string; contribution: number; detail: string; sample?: number };

const TEAMS: Team[] = [
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
  { id: "parivision", name: "PARIVISION", short: "PV", color: "#2ddccf", logo: "/team-logos/parivision.webp" },
  { id: "resilience", name: "Resilience", short: "RS", color: "#e65d61", logo: "/team-logos/resilience.webp" },
  { id: "spirit", name: "Spirit", short: "TS", color: "#c7d0d9", logo: "/team-logos/spirit.webp" },
  { id: "vg", name: "VG", short: "VG", color: "#c4c0b7", logo: "/team-logos/vg.webp" },
  { id: "xtreme", name: "Xtreme", short: "XG", color: "#d5dae2", logo: "/team-logos/xtreme.webp" },
  { id: "yandex", name: "Yandex", short: "YX", color: "#ff4c58", logo: "/team-logos/yandex.webp" },
];

const ATTRIBUTES = [
  { id: "all", label: "Все" },
  { id: "str", label: "Сила" },
  { id: "agi", label: "Ловкость" },
  { id: "int", label: "Интеллект" },
  { id: "universal", label: "Универсальные" },
] as const;
const emptyDraft = (): Pick[] => Array(5).fill(null);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));
const logit = (value: number) => Math.log(clamp(value, 0.01, 0.99) / (1 - clamp(value, 0.01, 0.99)));
const pairKey = (a: string | number, b: string | number) => [a, b].sort((left, right) => Number(left) - Number(right)).join("|");
const teamPairKey = (a: string, b: string) => [a, b].sort().join("|");
const teamById = (id: string) => TEAMS.find((team) => team.id === id) ?? TEAMS[0];
const signed = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(1)} п.п.`;

function teamBaseProbability(model: TeamStats | null, a: string, b: string) {
  const key = teamPairKey(a, b);
  const stored = model?.pairwise[key]?.mapProbabilityA ?? 50;
  return key.startsWith(`${a}|`) ? stored / 100 : 1 - stored / 100;
}

function average(values: number[], fallback = 0.5) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback;
}

function roleScore(heroes: Hero[]) {
  if (!heroes.length) return 0.5;
  const has = (role: string) => heroes.some((hero) => hero.roles.includes(role));
  const supports = heroes.filter((hero) => hero.roles.includes("Support")).length;
  const score = Number(has("Carry")) + Math.min(1, supports / 2) + Number(has("Initiator") || has("Disabler"))
    + Number(has("Durable")) + Number(heroes.some((hero) => hero.attackType === "Ranged"));
  return score / 5;
}

function calculateDraft(
  draftStats: DraftStats | null,
  teamStats: TeamStats | null,
  teamA: string,
  teamB: string,
  radiant: Side,
  picksA: Pick[],
  picksB: Pick[],
) {
  const base = teamBaseProbability(teamStats, teamA, teamB);
  if (!draftStats) return { probability: base, base, features: [] as Feature[], confidence: "данные загружаются" };
  const byId = new Map(draftStats.heroes.map((hero) => [hero.id, hero]));
  const heroesA = picksA.flatMap((id) => id ? [byId.get(id)].filter(Boolean) as Hero[] : []);
  const heroesB = picksB.flatMap((id) => id ? [byId.get(id)].filter(Boolean) as Hero[] : []);
  const completeness = Math.min(heroesA.length, heroesB.length) / 5;
  let currentLogit = logit(base);
  const features: Feature[] = [];

  const add = (label: string, rawLogit: number, detail: string, sample?: number) => {
    const before = sigmoid(currentLogit);
    currentLogit += rawLogit * completeness;
    const after = sigmoid(currentLogit);
    features.push({ label, contribution: (after - before) * 100, detail, sample });
  };

  const radiantEffect = logit(draftStats.radiantWinRate / 100) * 0.45 * (radiant === "a" ? 1 : -1);
  add("Сторона карты", radiantEffect, `${radiant === "a" ? teamById(teamA).name : teamById(teamB).name} играет за Radiant · ${draftStats.radiantWinRate.toFixed(1)}% побед в локальной выборке`, draftStats.methodology.cachedPatchMaps);

  const metaA = average(heroesA.map((hero) => hero.modelWinRate / 100));
  const metaB = average(heroesB.map((hero) => hero.modelWinRate / 100));
  add("Мета героев", (logit(metaA) - logit(metaB)) * 0.42, `усреднённый рейтинг пика ${teamById(teamA).short} ${(metaA * 100).toFixed(1)}% против ${(metaB * 100).toFixed(1)}%`);

  const synergyFor = (heroes: Hero[]) => {
    const rows: Sample[] = [];
    for (let i = 0; i < heroes.length; i += 1) for (let j = i + 1; j < heroes.length; j += 1) {
      const row = draftStats.synergy[pairKey(heroes[i].id, heroes[j].id)];
      if (row) rows.push(row);
    }
    return rows;
  };
  const synergyA = synergyFor(heroesA);
  const synergyB = synergyFor(heroesB);
  const synergyRateA = average(synergyA.map((row) => row.winRate / 100));
  const synergyRateB = average(synergyB.map((row) => row.winRate / 100));
  add("Синергии", (logit(synergyRateA) - logit(synergyRateB)) * 0.28, `найдено сочетаний: ${synergyA.length} у ${teamById(teamA).short}, ${synergyB.length} у ${teamById(teamB).short}`, synergyA.reduce((sum, row) => sum + row.games, 0) + synergyB.reduce((sum, row) => sum + row.games, 0));

  const counterRows = heroesA.flatMap((heroA) => heroesB.flatMap((heroB) => {
    const row = draftStats.counters[`${heroA.id}|${heroB.id}`];
    return row ? [row] : [];
  }));
  const counterRate = average(counterRows.map((row) => row.winRate / 100));
  add("Контрпики", logit(counterRate) * 0.32, `из 25 возможных дуэлей героев есть данные по ${counterRows.length}`, counterRows.reduce((sum, row) => sum + row.games, 0));

  const familiarity = (teamId: string, heroes: Hero[]) => heroes.flatMap((hero) => {
    const row = draftStats.teams[teamId]?.heroes[String(hero.id)];
    return row ? [row] : [];
  });
  const familiarityA = familiarity(teamA, heroesA);
  const familiarityB = familiarity(teamB, heroesB);
  const familiarityRateA = average(familiarityA.map((row) => row.winRate / 100));
  const familiarityRateB = average(familiarityB.map((row) => row.winRate / 100));
  add("Опыт команды на героях", (logit(familiarityRateA) - logit(familiarityRateB)) * 0.24, `подтверждённые пики: ${familiarityA.length} у ${teamById(teamA).short}, ${familiarityB.length} у ${teamById(teamB).short}`, familiarityA.reduce((sum, row) => sum + row.games, 0) + familiarityB.reduce((sum, row) => sum + row.games, 0));

  const rolesA = roleScore(heroesA);
  const rolesB = roleScore(heroesB);
  add("Баланс ролей", (rolesA - rolesB) * 0.22, `эвристика Carry / Support / контроль / фронтлейн / дальняя атака: ${(rolesA * 5).toFixed(1)} против ${(rolesB * 5).toFixed(1)}`);

  const totalPairSamples = features.reduce((sum, feature) => sum + (feature.sample ?? 0), 0);
  const confidence = completeness < 1 ? `черновик · выбрано ${heroesA.length + heroesB.length}/10` : totalPairSamples >= 160 ? "средняя" : "низкая";
  return { probability: clamp(sigmoid(currentLogit), 0.08, 0.92), base, features, confidence };
}

function TeamLogo({ team }: { team: Team }) {
  return <span className="draft-team-logo" style={{ "--draft-team-color": team.color } as React.CSSProperties}><img src={team.logo} alt="" /></span>;
}

function HeroSlot({ hero, index, active, onClick }: { hero?: Hero; index: number; active: boolean; onClick: () => void }) {
  return <button type="button" className={`draft-slot ${active ? "is-active" : ""} ${hero ? "is-filled" : ""}`} onClick={onClick} aria-label={hero ? `Убрать ${hero.name}` : `Выбрать героя в слот ${index + 1}`}>
    {hero ? <><img src={hero.image} alt="" /><span><b>{hero.name}</b><small>{hero.roles.slice(0, 2).join(" · ")}</small></span><i>×</i></> : <><em>0{index + 1}</em><span><b>Выбрать героя</b><small>нажмите на карточку ниже</small></span></>}
  </button>;
}

export default function DraftsPage() {
  const [draftStats, setDraftStats] = useState<DraftStats | null>(null);
  const [teamStats, setTeamStats] = useState<TeamStats | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [teamA, setTeamA] = useState("falcons");
  const [teamB, setTeamB] = useState("parivision");
  const [radiant, setRadiant] = useState<Side>("a");
  const [picksA, setPicksA] = useState<Pick[]>(emptyDraft);
  const [picksB, setPicksB] = useState<Pick[]>(emptyDraft);
  const [active, setActive] = useState<{ side: Side; index: number }>({ side: "a", index: 0 });
  const [search, setSearch] = useState("");
  const [attribute, setAttribute] = useState<(typeof ATTRIBUTES)[number]["id"]>("all");

  useEffect(() => {
    Promise.all([
      fetch("/draft-stats.json").then((response) => response.ok ? response.json() : Promise.reject()),
      fetch("/team-stats.json").then((response) => response.ok ? response.json() : Promise.reject()),
    ]).then(([draft, teams]) => { setDraftStats(draft); setTeamStats(teams); }).catch(() => setLoadError(true));
  }, []);

  const heroesById = useMemo(() => new Map((draftStats?.heroes ?? []).map((hero) => [hero.id, hero])), [draftStats]);
  const selected = useMemo(() => new Set([...picksA, ...picksB].filter((id): id is number => id !== null)), [picksA, picksB]);
  const visibleHeroes = useMemo(() => (draftStats?.heroes ?? []).filter((hero) => {
    const matchesSearch = hero.name.toLowerCase().includes(search.trim().toLowerCase());
    const normalizedAttribute = attribute === "universal" ? "all" : attribute;
    return matchesSearch && (attribute === "all" || hero.primaryAttribute === normalizedAttribute);
  }).sort((a, b) => b.proPicks + b.proBans - a.proPicks - a.proBans || a.name.localeCompare(b.name)), [draftStats, search, attribute]);
  const result = useMemo(() => calculateDraft(draftStats, teamStats, teamA, teamB, radiant, picksA, picksB), [draftStats, teamStats, teamA, teamB, radiant, picksA, picksB]);

  const chooseHero = (heroId: number) => {
    if (selected.has(heroId)) return;
    const picks = active.side === "a" ? [...picksA] : [...picksB];
    picks[active.index] = heroId;
    if (active.side === "a") setPicksA(picks); else setPicksB(picks);
    const nextEmpty = picks.findIndex((pick, index) => pick === null && index > active.index);
    if (nextEmpty !== -1) setActive({ side: active.side, index: nextEmpty });
    else if (active.side === "a" && picksB.some((pick) => pick === null)) setActive({ side: "b", index: picksB.findIndex((pick) => pick === null) });
  };
  const selectSlot = (side: Side, index: number) => {
    const picks = side === "a" ? [...picksA] : [...picksB];
    if (picks[index] !== null) {
      picks[index] = null;
      if (side === "a") setPicksA(picks); else setPicksB(picks);
    }
    setActive({ side, index });
  };
  const swapTeams = () => {
    setTeamA(teamB); setTeamB(teamA); setPicksA(picksB); setPicksB(picksA); setRadiant(radiant === "a" ? "b" : "a");
  };
  const reset = () => { setPicksA(emptyDraft()); setPicksB(emptyDraft()); setActive({ side: "a", index: 0 }); };
  const firstTeam = teamById(teamA);
  const secondTeam = teamById(teamB);

  return <main className="draft-page">
    <header className="topbar">
      <Link className="brand" href="/" aria-label="Вернуться к прогнозу турнира"><span className="brand-glyph">T</span><span>TI / PREDICTOR</span></Link>
      <nav aria-label="Разделы"><Link href="/">Турнир</Link><Link className="is-current" href="/drafts">Пики</Link><a href="#model">Модель</a></nav>
      <div className="live-pill"><span /> DRAFT LAB</div>
    </header>

    <section className="draft-hero">
      <div><p className="eyebrow">ЭКСПЕРИМЕНТАЛЬНАЯ МОДЕЛЬ КАРТЫ · OPENDOTA PATCH ID {draftStats?.methodology.latestOpenDotaPatchId ?? "—"}</p><h1>Кто выиграл<br /><em>драфт?</em></h1></div>
      <p>Выбери команды и десять героев. Модель соединит прогноз силы составов со свежей метой, опытом команд на героях, синергиями и контрпиками.</p>
      <div className="draft-data-stamp"><b>{draftStats?.methodology.cachedPatchMaps ?? "—"}</b><span>профессиональная карта<br />актуального патча в выборке</span></div>
    </section>

    {loadError ? <section className="draft-error">Не удалось загрузить статистику пиков. Обнови страницу или запусти обновление статистики из панели администратора.</section> : null}

    <section className="draft-builder">
      <div className="draft-matchbar">
        <label><span>КОМАНДА A</span><div><TeamLogo team={firstTeam} /><select value={teamA} onChange={(event) => { if (event.target.value !== teamB) setTeamA(event.target.value); }}>{TEAMS.map((team) => <option key={team.id} value={team.id} disabled={team.id === teamB}>{team.name}</option>)}</select></div></label>
        <button type="button" className="draft-swap" onClick={swapTeams} aria-label="Поменять команды местами">⇄</button>
        <label><span>КОМАНДА B</span><div><TeamLogo team={secondTeam} /><select value={teamB} onChange={(event) => { if (event.target.value !== teamA) setTeamB(event.target.value); }}>{TEAMS.map((team) => <option key={team.id} value={team.id} disabled={team.id === teamA}>{team.name}</option>)}</select></div></label>
        <div className="side-picker"><span>СТОРОНА</span><button type="button" className={radiant === "a" ? "active" : ""} onClick={() => setRadiant("a")}>{firstTeam.short} · Radiant</button><button type="button" className={radiant === "b" ? "active" : ""} onClick={() => setRadiant("b")}>{secondTeam.short} · Radiant</button></div>
      </div>

      <div className="draft-columns">
        <article className={`draft-lineup ${active.side === "a" ? "is-active" : ""}`}>
          <header><TeamLogo team={firstTeam} /><div><span>ПИК A</span><h2>{firstTeam.name}</h2></div><b>{picksA.filter(Boolean).length}/5</b></header>
          <div>{picksA.map((heroId, index) => <HeroSlot key={index} index={index} hero={heroId ? heroesById.get(heroId) : undefined} active={active.side === "a" && active.index === index} onClick={() => selectSlot("a", index)} />)}</div>
        </article>
        <article className="draft-result-card">
          <p>ПРОГНОЗ НА КАРТУ</p><div className="draft-probability"><b style={{ color: firstTeam.color }}>{(result.probability * 100).toFixed(1)}%</b><span>—</span><b style={{ color: secondTeam.color }}>{((1 - result.probability) * 100).toFixed(1)}%</b></div>
          <div className="draft-probability-bar"><i style={{ width: `${result.probability * 100}%`, background: firstTeam.color }} /><i style={{ background: secondTeam.color }} /></div>
          <strong>{result.probability >= 0.5 ? firstTeam.name : secondTeam.name} — фаворит карты</strong>
          <small>Уверенность: {result.confidence}. Базовый прогноз без пиков — {(result.base * 100).toFixed(1)}% на {firstTeam.short}.</small>
          <button type="button" onClick={reset}>Сбросить пики</button>
        </article>
        <article className={`draft-lineup draft-lineup--dire ${active.side === "b" ? "is-active" : ""}`}>
          <header><TeamLogo team={secondTeam} /><div><span>ПИК B</span><h2>{secondTeam.name}</h2></div><b>{picksB.filter(Boolean).length}/5</b></header>
          <div>{picksB.map((heroId, index) => <HeroSlot key={index} index={index} hero={heroId ? heroesById.get(heroId) : undefined} active={active.side === "b" && active.index === index} onClick={() => selectSlot("b", index)} />)}</div>
        </article>
      </div>

      <section className="hero-pool">
        <header><div><p className="eyebrow">ПУЛ ГЕРОЕВ</p><h2>Выбери героя для {active.side === "a" ? firstTeam.name : secondTeam.name}</h2></div><label><span>Поиск</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Например, Puck" /></label></header>
        <div className="hero-filters">{ATTRIBUTES.map((item) => <button type="button" key={item.id} className={attribute === item.id ? "active" : ""} onClick={() => setAttribute(item.id)}>{item.label}</button>)}</div>
        <div className="hero-grid">{visibleHeroes.map((hero) => <button type="button" key={hero.id} disabled={selected.has(hero.id)} onClick={() => chooseHero(hero.id)} title={`${hero.roles.join(", ")} · модель ${hero.modelWinRate.toFixed(1)}%`}><img src={hero.image} alt="" /><span><b>{hero.name}</b><small>{hero.modelWinRate.toFixed(1)}% · {hero.proPicks + hero.proBans} pro P/B</small></span>{selected.has(hero.id) ? <i>В ПИКЕ</i> : null}</button>)}</div>
      </section>
    </section>

    <section className="draft-model" id="model">
      <div className="section-heading section-heading--light"><span className="step-number">02</span><div><p>ПРОЗРАЧНОСТЬ МОДЕЛИ</p><h2>Почему получилась эта вероятность</h2></div><span className="section-note">Каждая поправка ограничена и сжата к нулю,<br />если данных по сочетанию мало.</span></div>
      <div className="draft-model-grid">
        <article className="draft-breakdown"><header><span>СТАРТ</span><b>{(result.base * 100).toFixed(1)}%</b><p>Сила команд на карте до учёта драфта</p></header>{result.features.map((feature) => <div key={feature.label}><span><b>{feature.label}</b><small>{feature.detail}</small></span><strong className={feature.contribution > 0.04 ? "positive" : feature.contribution < -0.04 ? "negative" : "neutral"}>{signed(feature.contribution)}</strong></div>)}<footer><span>ИТОГ ДЛЯ {firstTeam.short}</span><b>{(result.probability * 100).toFixed(1)}%</b></footer></article>
        <aside className="draft-method-card"><p className="eyebrow">ЧТО УЖЕ УЧИТЫВАЕМ</p><h3>Не чёрный ящик</h3><ul><li><b>Команды</b><span>Bradley–Terry по сериям и актуальным составам.</span></li><li><b>Герои</b><span>Pro и high-rank winrate с байесовским сглаживанием.</span></li><li><b>Пары</b><span>Синергии союзников и результаты герой против героя.</span></li><li><b>Практика</b><span>Каких героев эта конкретная пятёрка уже брала.</span></li></ul><p>Сейчас локальная выборка пиков содержит <b>{draftStats?.methodology.cachedPatchMaps ?? "—"} карт</b>. Поэтому модель не изображает ложную точность: редкие сочетания почти не двигают прогноз. Следующий слой — догрузить все карты актуального патча и учитывать распределение героев по игрокам и позициям.</p><small>Обновлено {draftStats ? new Date(draftStats.generatedAt).toLocaleString("ru-RU") : "—"} · OpenDota patch ID {draftStats?.methodology.latestOpenDotaPatchId ?? "—"}</small></aside>
      </div>
    </section>

    <footer><div className="brand"><span className="brand-glyph">T</span><span>TI / PREDICTOR</span></div><p>Экспериментальный прогноз драфта · коэффициенты будут проверяться на сыгранных картах TI</p><Link href="/">К турниру →</Link></footer>
  </main>;
}
