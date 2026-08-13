"use client";

import { useEffect, useMemo, useState } from "react";
import { combineDraftSignals, combineLearnedDraftSignals } from "../../server/draft-combiner.mjs";
import { predictTemporalDraft } from "../../server/draft-inference.mjs";

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
type Sample = { games: number; wins?: number; winRate: number; lastPlayedAt?: number };
type HeroPriority = { maps: number; picks: number; bans: number; pickRate: number; banRate: number; contestedRate: number; firstPhaseRate: number; flex: number; score: number };
type PlayerHeroStats = { accountId: number; name: string; games: number; heroes: Record<string, Sample> };
type DraftStats = {
  generatedAt: string;
  provider: string;
  radiantWinRate: number;
  methodology: {
    latestOpenDotaPatchId: number;
    patchName?: string;
    patchStart?: string;
    eligiblePatchMaps?: number;
    cachedPatchMaps: number;
    missingPatchMaps?: number;
    proPriorGames: number;
    patchPriorGames: number;
    pairPriorGames: number;
    playerPriorGames?: number;
    caveat: string;
  };
  heroes: Hero[];
  heroPatch?: Record<string, Sample>;
  synergy: Record<string, Sample>;
  counters: Record<string, Sample>;
  lineups?: Record<string, Sample>;
  teams: Record<string, { maps: number; heroes: Record<string, Sample>; players?: PlayerHeroStats[] }>;
  activeSnapshot?: {
    generatedAt: string;
    featureContract: string[];
    radiantWinRate: number;
    teamPairwise: Record<string, { probabilityA: number }>;
    hero: Record<string, Sample>;
    heroPriority?: Record<string, HeroPriority>;
    synergy: Record<string, Sample>;
    counter: Record<string, Sample>;
    teamHero: Record<string, Sample>;
    playerHero: Record<string, Sample>;
    heroRole?: Record<string, Sample>;
    playerPositions?: Record<string, { role: number | null; games: number; distribution: Record<string, number> }>;
  };
  combiner?: { version: number; learnedFrom: string; weights: Record<string, number>; probabilityFloor?: number; probabilityCeiling?: number };
  validation?: { activeFormula?: { deployment?: { status?: string; validated?: boolean }; metrics?: { logLossDeltaVsNeutral?: number; logLossDeltaVsTeamSide?: number } } };
};
type TeamStats = { pairwise: Record<string, { mapProbabilityA: number }> };
type Side = "a" | "b";
type Pick = number | null;
type Feature = { key: string; label: string; contribution: number; rawLogit: number; detail: string; sample?: number };
type TemporalModelMetadata = {
  modelId?: string;
  trainedAt?: string;
  dataset?: { matches?: number; patches?: number; currentPatchId?: number; currentPatchMatches?: number; domains?: Record<string, number> };
  deployment?: { status?: "candidate" | "shadow" | "insufficient_data"; recommendedWeight?: number; incrementalToActiveValidated?: boolean; gate?: string };
  backtest?: { eligiblePatches?: number; aggregate?: { model?: { logLoss?: number }; neutral?: { logLoss?: number }; logLossDelta?: number | null; foldsWon?: number } };
  arena?: { leaderboard?: { name: string; logLoss: number; brier?: number; accuracy?: number }[] };
};
type TemporalModel = TemporalModelMetadata & { schemaVersion: number; inference?: object; heroes?: object; synergy?: object; counters?: object };
type TemporalPrediction = {
  modelId?: string;
  probabilityA: number;
  rawLogitA: number;
  completeness: number;
  components: { side: number; heroes: number; synergy: number; counters: number };
  evidence: { heroes: number; synergies: number; counters: number; trainingMatches: number; patches: number };
};
type LiveDraft = {
  matchId: string; seriesId: string; radiantTeam: string; direTeam: string; radiantPicks: number[]; direPicks: number[];
  radiantPlayers: LivePlayer[]; direPlayers: LivePlayer[];
  gameTime: number; delay: number; radiantScore: number; direScore: number; lastUpdateAt: string | null; phase: "draft" | "game";
  radiantLead: number | null; spectators: number | null; seriesScoreRadiant: number; seriesScoreDire: number; seriesBestOf: number | null;
};
type LivePlayer = { accountId: number; heroId: number; name: string | null };
type LiveDraftState = { games: LiveDraft[]; fetchedAt: string | null; error: string | null };

function liveMapAssessment(game: LiveDraft) {
  const goldLead = Number(game.radiantLead ?? 0);
  const killLead = Number(game.radiantScore) - Number(game.direScore);
  const aligned = !goldLead || !killLead || Math.sign(goldLead) === Math.sign(killLead);
  const settled = game.phase === "game" && game.gameTime >= 10 * 60 && (
    Math.abs(goldLead) >= 15_000
    || (game.gameTime >= 20 * 60 && Math.abs(goldLead) >= 9_000 && Math.abs(killLead) >= 8 && aligned)
    || (game.gameTime >= 35 * 60 && Math.abs(goldLead) >= 6_000 && aligned)
  );
  const leaderSide = Math.abs(goldLead) >= 1_000 ? (goldLead > 0 ? "radiant" : "dire") : Math.abs(killLead) >= 3 ? (killLead > 0 ? "radiant" : "dire") : null;
  const leader = leaderSide === "radiant" ? game.radiantTeam : leaderSide === "dire" ? game.direTeam : null;
  return {
    goldLead,
    killLead,
    leader,
    settled,
    status: game.phase === "draft" ? "draft" : settled ? "settled" : "in_progress",
  } as const;
}

function compactGold(value: number) {
  const absolute = Math.abs(value);
  return `${value >= 0 ? "+" : "−"}${absolute >= 1000 ? `${(absolute / 1000).toFixed(1)}k` : absolute.toFixed(0)}`;
}

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
const positionLabel = (position?: number) => position ? `позиция ${position}` : "позиция неизвестна";

function teamBaseProbability(model: TeamStats | null, a: string, b: string) {
  const key = teamPairKey(a, b);
  const stored = model?.pairwise[key]?.mapProbabilityA ?? 50;
  return key.startsWith(`${a}|`) ? stored / 100 : 1 - stored / 100;
}

function average(values: number[], fallback = 0.5) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback;
}

type PlayerAssignmentRow = { player: string; hero: Hero; sample?: Sample; position?: number };
type PlayerAssignment = { rate: number; roleRate: number; games: number; found: number; rows: PlayerAssignmentRow[]; source: "observed" | "inferred" | "unavailable" };

function bestPlayerAssignment(team: DraftStats["teams"][string] | undefined, heroes: Hero[], activePlayerHero?: Record<string, Sample>, playerPositions?: DraftStats["activeSnapshot"]["playerPositions"], heroRole?: Record<string, Sample>, observedPlayers?: LivePlayer[]): PlayerAssignment {
  const players = team?.players ?? [];
  if (!heroes.length || players.length < heroes.length) return { rate: 0.5, roleRate: 0.5, games: 0, found: 0, rows: [], source: "unavailable" };
  const scoreRows = (assignments: { player: PlayerHeroStats; hero: Hero }[], source: "observed" | "inferred") => {
    let poolScore = 0; let roleScore = 0; let games = 0; let found = 0;
    const rows = assignments.map(({ player, hero }) => {
      const position = Number(playerPositions?.[String(player.accountId)]?.role || 0);
      const sample = activePlayerHero ? activePlayerHero[`${player.accountId}|${hero.id}`] : player.heroes[String(hero.id)];
      const roleSample = position ? heroRole?.[`${hero.id}|${position}`] : undefined;
      if (sample) { poolScore += logit(sample.winRate / 100) * (activePlayerHero ? 1 : Math.min(1, sample.games / 5)); games += sample.games; found += 1; }
      if (roleSample) roleScore += logit(roleSample.winRate / 100) * Math.min(1, roleSample.games / 8);
      return { player: player.name, hero, sample, position };
    });
    return { rate: sigmoid(poolScore / Math.max(1, assignments.length)), roleRate: sigmoid(roleScore / Math.max(1, assignments.length)), games, found, rows, source };
  };
  if (observedPlayers?.length) {
    const heroesById = new Map(heroes.map((hero) => [hero.id, hero]));
    const playersById = new Map(players.map((player) => [player.accountId, player]));
    const assignments = observedPlayers.flatMap((observed) => {
      const player = playersById.get(observed.accountId); const hero = heroesById.get(observed.heroId);
      return player && hero ? [{ player, hero }] : [];
    });
    if (assignments.length === heroes.length) return scoreRows(assignments, "observed");
    return { rate: 0.5, roleRate: 0.5, games: 0, found: 0, rows: [], source: "unavailable" };
  }
  let bestScore = -Infinity;
  let bestAssignments: { player: PlayerHeroStats; hero: Hero }[] = [];
  const used = new Set<number>();
  const rows: { player: PlayerHeroStats; hero: Hero }[] = [];
  const visit = (index: number, poolScore: number, roleScore: number) => {
    if (index === heroes.length) {
      if (poolScore + roleScore > bestScore) { bestScore = poolScore + roleScore; bestAssignments = [...rows]; }
      return;
    }
    for (let playerIndex = 0; playerIndex < players.length; playerIndex += 1) {
      if (used.has(playerIndex)) continue;
      const player = players[playerIndex];
      const position = Number(playerPositions?.[String(player.accountId)]?.role || 0);
      if (activePlayerHero && !position) continue;
      const sample = activePlayerHero ? activePlayerHero[`${player.accountId}|${heroes[index].id}`] : player.heroes[String(heroes[index].id)];
      const roleSample = position ? heroRole?.[`${heroes[index].id}|${position}`] : undefined;
      const roleGames = roleSample?.games ?? 0;
      if (activePlayerHero && roleGames < 2) continue;
      const poolEvidence = sample ? logit(sample.winRate / 100) * (activePlayerHero ? 1 : Math.min(1, sample.games / 5)) : 0;
      const roleEvidence = roleSample ? logit(roleSample.winRate / 100) * Math.min(1, roleGames / 8) : 0;
      used.add(playerIndex);
      rows.push({ player, hero: heroes[index] });
      visit(index + 1, poolScore + poolEvidence, roleScore + roleEvidence);
      rows.pop();
      used.delete(playerIndex);
    }
  };
  visit(0, 0, 0);
  if (!Number.isFinite(bestScore)) return { rate: 0.5, roleRate: 0.5, games: 0, found: 0, rows: [], source: "unavailable" };
  return scoreRows(bestAssignments, "inferred");
}

function calculateDraft(
  draftStats: DraftStats | null,
  teamStats: TeamStats | null,
  temporalModel: TemporalModelMetadata | null,
  temporalPrediction: TemporalPrediction | null,
  teamA: string,
  teamB: string,
  radiant: Side,
  picksA: Pick[],
  picksB: Pick[],
  liveDraft?: LiveDraft | null,
) {
  const base = teamBaseProbability(teamStats, teamA, teamB);
  if (!draftStats) return { probability: base, base, teamPrior: base, draftOnly: 0.5, features: [] as Feature[], confidence: "данные загружаются" };
  const byId = new Map(draftStats.heroes.map((hero) => [hero.id, hero]));
  const heroesA = picksA.flatMap((id) => id ? [byId.get(id)].filter(Boolean) as Hero[] : []);
  const heroesB = picksB.flatMap((id) => id ? [byId.get(id)].filter(Boolean) as Hero[] : []);
  const completeness = Math.min(heroesA.length, heroesB.length) / 5;
  const features: Feature[] = [];

  const add = (key: string, label: string, rawLogit: number, detail: string, sample?: number) => {
    features.push({ key, label, rawLogit, contribution: 0, detail, sample });
  };

  const temporalWeight = temporalModel?.deployment?.status === "candidate" && temporalModel.deployment.incrementalToActiveValidated === true
    ? clamp(Number(temporalModel.deployment.recommendedWeight ?? 0), 0, 1)
    : 0;
  const activeRadiantWinRate = draftStats.activeSnapshot?.radiantWinRate ?? draftStats.radiantWinRate;
  const radiantEffect = logit(activeRadiantWinRate / 100) * (radiant === "a" ? 1 : -1);
  add("side", "Сторона карты", radiantEffect, `${radiant === "a" ? teamById(teamA).name : teamById(teamB).name} играет за Radiant · ${activeRadiantWinRate.toFixed(1)}% побед в walk-forward состоянии`, draftStats.methodology.cachedPatchMaps);

  if (temporalPrediction) {
    const temporalDraftLogit = temporalPrediction.components.heroes + temporalPrediction.components.synergy + temporalPrediction.components.counters;
    const status = temporalWeight > 0
      ? `вес ${(temporalWeight * 100).toFixed(0)}% после проверки поверх активной формулы`
      : "SHADOW · не влияет на итог: не доказано улучшение поверх активной формулы";
    add("temporal", "Межпатчевая модель", temporalDraftLogit * temporalWeight, `${status} · ${temporalPrediction.evidence.trainingMatches} карт / ${temporalPrediction.evidence.patches} патча · модель ${temporalPrediction.modelId ?? "—"}`, temporalPrediction.evidence.trainingMatches);
  }

  const activeHeroRate = (hero: Hero) => (draftStats.activeSnapshot ? (draftStats.activeSnapshot.hero[String(hero.id)]?.winRate ?? 50) : hero.modelWinRate) / 100;
  const metaA = average(heroesA.map(activeHeroRate));
  const metaB = average(heroesB.map(activeHeroRate));
  add("hero", "Мета героев", logit(metaA) - logit(metaB), `усреднённый walk-forward рейтинг пика ${teamById(teamA).short} ${(metaA * 100).toFixed(1)}% против ${(metaB * 100).toFixed(1)}%`);

  const priorityFor = (heroes: Hero[]) => heroes.flatMap((hero) => {
    const row = draftStats.activeSnapshot?.heroPriority?.[String(hero.id)];
    return row ? [row] : [];
  });
  const priorityA = priorityFor(heroesA); const priorityB = priorityFor(heroesB);
  const priorityScoreA = average(priorityA.map((row) => row.score), 0); const priorityScoreB = average(priorityB.map((row) => row.score), 0);
  const prioritySummary = (rows: HeroPriority[]) => ({ contested: average(rows.map((row) => row.contestedRate), 0), bans: average(rows.map((row) => row.banRate), 0), early: average(rows.map((row) => row.firstPhaseRate), 0), flex: average(rows.map((row) => row.flex * 100), 0) });
  const priorityMetaA = prioritySummary(priorityA); const priorityMetaB = prioritySummary(priorityB);
  add("draftPriority", "Приоритет драфта", priorityScoreA - priorityScoreB, `prequential без утечки: contested ${priorityMetaA.contested.toFixed(1)}% / ${priorityMetaB.contested.toFixed(1)}%, bans ${priorityMetaA.bans.toFixed(1)}% / ${priorityMetaB.bans.toFixed(1)}%, early ${priorityMetaA.early.toFixed(1)}% / ${priorityMetaB.early.toFixed(1)}%, flex ${priorityMetaA.flex.toFixed(0)}% / ${priorityMetaB.flex.toFixed(0)}%`, priorityA.reduce((sum, row) => sum + row.picks + row.bans, 0) + priorityB.reduce((sum, row) => sum + row.picks + row.bans, 0));

  const synergyFor = (heroes: Hero[]) => {
    const rows: { a: Hero; b: Hero; sample: Sample }[] = [];
    for (let i = 0; i < heroes.length; i += 1) for (let j = i + 1; j < heroes.length; j += 1) {
      const row = draftStats.activeSnapshot
        ? (draftStats.activeSnapshot.synergy[pairKey(heroes[i].id, heroes[j].id)] ?? { games: 0, wins: 0, winRate: 50 })
        : draftStats.synergy[pairKey(heroes[i].id, heroes[j].id)];
      if (row) rows.push({ a: heroes[i], b: heroes[j], sample: row });
    }
    return rows;
  };
  const synergyA = synergyFor(heroesA);
  const synergyB = synergyFor(heroesB);
  const synergyEffectA = average(synergyA.map((row) => Number((row.sample as Sample & { coefficient?: number }).coefficient ?? logit(row.sample.winRate / 100))), 0);
  const synergyEffectB = average(synergyB.map((row) => Number((row.sample as Sample & { coefficient?: number }).coefficient ?? logit(row.sample.winRate / 100))), 0);
  add("synergy", "Синергии", synergyEffectA - synergyEffectB, `остаточные эффекты после силы отдельных героев: ${synergyA.length} сочетаний у ${teamById(teamA).short}, ${synergyB.length} у ${teamById(teamB).short}`, synergyA.reduce((sum, row) => sum + row.sample.games, 0) + synergyB.reduce((sum, row) => sum + row.sample.games, 0));

  const counterRows = heroesA.flatMap((heroA) => heroesB.flatMap((heroB) => {
    const row = draftStats.activeSnapshot
      ? (draftStats.activeSnapshot.counter[`${heroA.id}>${heroB.id}`] ?? { games: 0, wins: 0, winRate: 50 })
      : draftStats.counters[`${heroA.id}|${heroB.id}`];
    return row ? [{ a: heroA, b: heroB, sample: row }] : [];
  }));
  const counterEffect = average(counterRows.map((row) => Number((row.sample as Sample & { coefficient?: number }).coefficient ?? logit(row.sample.winRate / 100))), 0);
  add("counter", "Контрпики", counterEffect, `остаточный matchup-эффект после hero main effects · найдено ${counterRows.length}/25`, counterRows.reduce((sum, row) => sum + row.sample.games, 0));

  const familiarity = (teamId: string, heroes: Hero[]) => heroes.flatMap((hero) => {
    const row = draftStats.activeSnapshot
      ? (draftStats.activeSnapshot.teamHero[`${teamId}|${hero.id}`] ?? { games: 0, wins: 0, winRate: 50 })
      : draftStats.teams[teamId]?.heroes[String(hero.id)];
    return row ? [row] : [];
  });
  const familiarityA = familiarity(teamA, heroesA);
  const familiarityB = familiarity(teamB, heroesB);
  const familiarityRateA = average(familiarityA.map((row) => row.winRate / 100));
  const familiarityRateB = average(familiarityB.map((row) => row.winRate / 100));
  add("teamPool", "Пул команды", logit(familiarityRateA) - logit(familiarityRateB), `подтверждённые пики: ${familiarityA.length} у ${teamById(teamA).short}, ${familiarityB.length} у ${teamById(teamB).short}`, familiarityA.reduce((sum, row) => sum + row.games, 0) + familiarityB.reduce((sum, row) => sum + row.games, 0));

  const observedA = !liveDraft ? undefined : teamA === liveDraft.radiantTeam ? liveDraft.radiantPlayers : teamA === liveDraft.direTeam ? liveDraft.direPlayers : undefined;
  const observedB = !liveDraft ? undefined : teamB === liveDraft.direTeam ? liveDraft.direPlayers : teamB === liveDraft.radiantTeam ? liveDraft.radiantPlayers : undefined;
  const assignmentA = bestPlayerAssignment(draftStats.teams[teamA], heroesA, draftStats.activeSnapshot?.playerHero, draftStats.activeSnapshot?.playerPositions, draftStats.activeSnapshot?.heroRole, observedA);
  const assignmentB = bestPlayerAssignment(draftStats.teams[teamB], heroesB, draftStats.activeSnapshot?.playerHero, draftStats.activeSnapshot?.playerPositions, draftStats.activeSnapshot?.heroRole, observedB);
  const assignmentSource = assignmentA.source === "observed" && assignmentB.source === "observed" ? "точные live-привязки OpenDota" : "гипотеза по позициям игроков";
  add("playerPool", "Игроки на героях", logit(assignmentA.rate) - logit(assignmentB.rate), `${assignmentSource} · история найдена для ${assignmentA.found + assignmentB.found}/${heroesA.length + heroesB.length}`, assignmentA.games + assignmentB.games);
  add("roles", "Герои на позициях", logit(assignmentA.roleRate) - logit(assignmentB.roleRate), "обученная совместимость hero×position; старая эвристика Carry/Support/контроль полностью удалена");

  const totalPairSamples = features.reduce((sum, feature) => sum + (feature.sample ?? 0), 0);
  const confidence = completeness < 1 ? `черновик · выбрано ${heroesA.length + heroesB.length}/10` : totalPairSamples >= 160 ? "средняя" : "низкая";
  const activeFeatures = features.filter((feature) => feature.key !== "temporal");
  const combined = draftStats.combiner
    ? combineLearnedDraftSignals(base, activeFeatures.map((feature) => ({ key: feature.key, value: feature.rawLogit })), draftStats.combiner, completeness)
    : combineDraftSignals(base, activeFeatures.map((feature) => feature.rawLogit), completeness);
  let activeIndex = 0;
  const explainedFeatures = features.map((feature) => ({ ...feature, contribution: feature.key === "temporal" ? 0 : combined.contributions[activeIndex++] }));
  return { probability: combined.probability, base, teamPrior: combined.teamPriorProbability, draftOnly: combined.draftOnlyProbability, features: explainedFeatures, confidence, assignmentA, assignmentB, synergyA, synergyB, counterRows };
}

function TeamLogo({ team }: { team: Team }) {
  return <span className="draft-team-logo" style={{ "--draft-team-color": team.color } as React.CSSProperties}><img src={team.logo} alt="" /></span>;
}

function HeroSlot({ hero, index, active, locked, onClick }: { hero?: Hero; index: number; active: boolean; locked?: boolean; onClick: () => void }) {
  return <button type="button" className={`draft-slot ${active ? "is-active" : ""} ${hero ? "is-filled" : ""}`} disabled={locked} onClick={onClick} aria-label={hero ? `Убрать ${hero.name}` : `Выбрать героя в слот ${index + 1}`}>
    {hero ? <><img src={hero.image} alt="" /><span><b>{hero.name}</b><small>{hero.roles.slice(0, 2).join(" · ")}</small></span><i>×</i></> : <><em>0{index + 1}</em><span><b>Выбрать героя</b><small>нажмите на карточку ниже</small></span></>}
  </button>;
}

export default function DraftsPage() {
  const [draftStats, setDraftStats] = useState<DraftStats | null>(null);
  const [teamStats, setTeamStats] = useState<TeamStats | null>(null);
  const [temporalModel, setTemporalModel] = useState<TemporalModelMetadata | null>(null);
  const [temporalFallback, setTemporalFallback] = useState<TemporalModel | null>(null);
  const [temporalPrediction, setTemporalPrediction] = useState<TemporalPrediction | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [teamA, setTeamA] = useState("falcons");
  const [teamB, setTeamB] = useState("parivision");
  const [radiant, setRadiant] = useState<Side>("a");
  const [picksA, setPicksA] = useState<Pick[]>(emptyDraft);
  const [picksB, setPicksB] = useState<Pick[]>(emptyDraft);
  const [active, setActive] = useState<{ side: Side; index: number }>({ side: "a", index: 0 });
  const [search, setSearch] = useState("");
  const [attribute, setAttribute] = useState<(typeof ATTRIBUTES)[number]["id"]>("all");
  const [liveDrafts, setLiveDrafts] = useState<LiveDraftState>({ games: [], fetchedAt: null, error: null });
  const [liveDraftId, setLiveDraftId] = useState<string | null>(null);
  const [lastSelectedLiveDraft, setLastSelectedLiveDraft] = useState<LiveDraft | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/draft-stats.json").then((response) => response.ok ? response.json() : Promise.reject()),
      fetch("/team-stats.json").then((response) => response.ok ? response.json() : Promise.reject()),
    ]).then(([draft, teams]) => { setDraftStats(draft); setTeamStats(teams); }).catch(() => setLoadError(true));
  }, []);

  useEffect(() => {
    let activeRequest = true;
    const load = () => fetch("/api/draft/live", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((state: LiveDraftState) => { if (activeRequest) setLiveDrafts(state); })
      .catch(() => { if (activeRequest) setLiveDrafts((state) => ({ ...state, error: "live_feed_unavailable" })); });
    void load();
    const timer = window.setInterval(load, 5_000);
    return () => { activeRequest = false; window.clearInterval(timer); };
  }, []);

  const selectedLiveDraft = liveDrafts.games.find((game) => game.matchId === liveDraftId) ?? null;
  const boundLiveDraft = selectedLiveDraft ?? (lastSelectedLiveDraft?.matchId === liveDraftId ? lastSelectedLiveDraft : null);
  const selectedLiveAssessment = selectedLiveDraft ? liveMapAssessment(selectedLiveDraft) : null;
  useEffect(() => {
    if (!selectedLiveDraft) return;
    setLastSelectedLiveDraft(selectedLiveDraft);
    const slots = (heroes: number[]): Pick[] => [...heroes.slice(0, 5), ...Array(Math.max(0, 5 - heroes.length)).fill(null)];
    setTeamA(selectedLiveDraft.radiantTeam); setTeamB(selectedLiveDraft.direTeam); setRadiant("a");
    setPicksA(slots(selectedLiveDraft.radiantPicks)); setPicksB(slots(selectedLiveDraft.direPicks));
  }, [selectedLiveDraft?.matchId, selectedLiveDraft?.lastUpdateAt, selectedLiveDraft?.radiantPicks.join("|"), selectedLiveDraft?.direPicks.join("|")]);

  useEffect(() => {
    let activeRequest = true;
    fetch("/api/draft/model")
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((model) => { if (activeRequest) setTemporalModel(model); })
      .catch(() => fetch("/draft-temporal-model.json")
        .then((response) => response.ok ? response.json() : Promise.reject())
        .then((model: TemporalModel) => { if (activeRequest) { setTemporalModel(model); setTemporalFallback(model); } })
        .catch(() => undefined));
    return () => { activeRequest = false; };
  }, []);

  useEffect(() => {
    if (!temporalModel) return;
    const controller = new AbortController();
    const payload = { picksA: picksA.filter((pick): pick is number => pick !== null), picksB: picksB.filter((pick): pick is number => pick !== null), radiant };
    fetch("/api/draft/predict", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((prediction: TemporalPrediction) => setTemporalPrediction(prediction))
      .catch(() => {
        if (controller.signal.aborted) return;
        if (temporalFallback) {
          try { setTemporalPrediction(predictTemporalDraft(temporalFallback, payload)); } catch { setTemporalPrediction(null); }
        } else setTemporalPrediction(null);
      });
    return () => controller.abort();
  }, [temporalModel, temporalFallback, picksA, picksB, radiant]);

  const heroesById = useMemo(() => new Map((draftStats?.heroes ?? []).map((hero) => [hero.id, hero])), [draftStats]);
  const selected = useMemo(() => new Set([...picksA, ...picksB].filter((id): id is number => id !== null)), [picksA, picksB]);
  const visibleHeroes = useMemo(() => (draftStats?.heroes ?? []).filter((hero) => {
    const matchesSearch = hero.name.toLowerCase().includes(search.trim().toLowerCase());
    const normalizedAttribute = attribute === "universal" ? "all" : attribute;
    return matchesSearch && (attribute === "all" || hero.primaryAttribute === normalizedAttribute);
  }).sort((a, b) => b.proPicks + b.proBans - a.proPicks - a.proBans || a.name.localeCompare(b.name)), [draftStats, search, attribute]);
  const result = useMemo(() => calculateDraft(draftStats, teamStats, temporalModel, temporalPrediction, teamA, teamB, radiant, picksA, picksB, boundLiveDraft), [draftStats, teamStats, temporalModel, temporalPrediction, teamA, teamB, radiant, picksA, picksB, boundLiveDraft]);

  const chooseHero = (heroId: number) => {
    if (selectedLiveDraft) return;
    if (selected.has(heroId)) return;
    const picks = active.side === "a" ? [...picksA] : [...picksB];
    picks[active.index] = heroId;
    if (active.side === "a") setPicksA(picks); else setPicksB(picks);
    const nextEmpty = picks.findIndex((pick, index) => pick === null && index > active.index);
    if (nextEmpty !== -1) setActive({ side: active.side, index: nextEmpty });
    else if (active.side === "a" && picksB.some((pick) => pick === null)) setActive({ side: "b", index: picksB.findIndex((pick) => pick === null) });
  };
  const selectSlot = (side: Side, index: number) => {
    if (selectedLiveDraft) return;
    const picks = side === "a" ? [...picksA] : [...picksB];
    if (picks[index] !== null) {
      picks[index] = null;
      if (side === "a") setPicksA(picks); else setPicksB(picks);
    }
    setActive({ side, index });
  };
  const swapTeams = () => {
    if (selectedLiveDraft) return;
    setTeamA(teamB); setTeamB(teamA); setPicksA(picksB); setPicksB(picksA); setRadiant(radiant === "a" ? "b" : "a");
  };
  const reset = () => { setPicksA(emptyDraft()); setPicksB(emptyDraft()); setActive({ side: "a", index: 0 }); };
  const firstTeam = teamById(teamA);
  const secondTeam = teamById(teamB);
  const selectedLeaderTeam = selectedLiveAssessment?.leader ? teamById(selectedLiveAssessment.leader) : null;
  const selectedGameClock = selectedLiveDraft ? `${Math.max(0, Math.floor(selectedLiveDraft.gameTime / 60))}:${String(Math.max(0, selectedLiveDraft.gameTime % 60)).padStart(2, "0")}` : null;

  return <main className="draft-page">
    <header className="topbar">
      <a className="brand" href="/" aria-label="Вернуться к прогнозу турнира"><span className="brand-glyph">T</span><span>TI / PREDICTOR</span></a>
      <nav aria-label="Разделы"><a href="/">Турнир</a><a className="is-current" href="/drafts">Пики</a><a href="/intel">Разведка</a><a href="#model">Модель</a></nav>
      <div className="live-pill"><span /> DRAFT LAB</div>
    </header>

    <section className="draft-hero">
      <div><p className="eyebrow">ЭКСПЕРИМЕНТАЛЬНАЯ МОДЕЛЬ · НЕ БУКМЕКЕРСКИЙ КОЭФФИЦИЕНТ · PATCH {draftStats?.methodology.patchName ?? draftStats?.methodology.latestOpenDotaPatchId ?? "—"}</p><h1>Кто выиграл<br /><em>драфт?</em></h1></div>
      <p>Выбери команды и десять героев. Модель соединит прогноз силы составов со свежей метой, опытом команд на героях, синергиями и контрпиками.</p>
      <div className="draft-data-stamp"><b>{draftStats?.methodology.cachedPatchMaps ?? "—"}/{draftStats?.methodology.eligiblePatchMaps ?? "—"}</b><span>профессиональных карт<br />патча загружено в базу</span></div>
    </section>

    {loadError ? <section className="draft-error">Не удалось загрузить статистику пиков. Обнови страницу или запусти обновление статистики из панели администратора.</section> : null}

    <section className="live-draft-panel">
      <header><div><p className="eyebrow"><i /> LIVE · THE INTERNATIONAL</p><h2>Драфты прямо сейчас</h2></div><span>{liveDrafts.error ? "Источник временно недоступен" : liveDrafts.games.length ? `Обновление каждые 5 сек · задержка источника ${Math.max(...liveDrafts.games.map((game) => game.delay), 0)} сек` : "Активных карт с известными командами пока нет"}</span></header>
      {liveDrafts.games.length ? <div>{liveDrafts.games.map((game) => {
        const radiantTeam = teamById(game.radiantTeam); const direTeam = teamById(game.direTeam); const selected = game.matchId === liveDraftId;
        const minutes = Math.max(0, Math.floor(game.gameTime / 60)); const seconds = Math.max(0, game.gameTime % 60); const assessment = liveMapAssessment(game);
        const leader = assessment.leader ? teamById(assessment.leader) : null;
        const goldLeader = assessment.goldLead >= 0 ? radiantTeam : direTeam;
        return <button type="button" className={`${selected ? "is-selected" : ""} live-game--${assessment.status}`} key={game.matchId} onClick={() => setLiveDraftId(selected ? null : game.matchId)}>
          <span><TeamLogo team={radiantTeam} /><b>{radiantTeam.name}</b></span>
          <strong>{game.phase === "draft" ? "ДРАФТ" : `${minutes}:${String(seconds).padStart(2, "0")}`}<small>{game.radiantPicks.length + game.direPicks.length}/10 пиков</small></strong>
          <span><b>{direTeam.name}</b><TeamLogo team={direTeam} /></span>
          <div className="live-game-stats"><b>СЕРИЯ {game.seriesScoreRadiant}:{game.seriesScoreDire}{game.seriesBestOf ? ` · BO${game.seriesBestOf}` : ""}</b>{game.phase === "game" ? <><span>УБИЙСТВА {game.radiantScore}:{game.direScore}</span><span>ЗОЛОТО {goldLeader.short} {compactGold(Math.abs(assessment.goldLead))}</span><strong>{leader ? `${leader.name} ведёт сейчас` : "карта пока равная"}</strong></> : <span>ожидаем начало карты</span>}</div>
          <em>{selected ? "ПОДКЛЮЧЕНО" : assessment.settled ? "ИСХОД СЛОЖИЛСЯ" : game.phase === "game" ? "LIVE · NO BET" : "СМОТРЕТЬ"}</em>
        </button>;
      })}</div> : null}
      {liveDraftId && !selectedLiveDraft ? <small>Карта завершилась или пропала из live-feed. Последние пики оставлены на экране; выбери другую live-карту или продолжи вручную.</small> : null}
    </section>

    <section className="draft-builder">
      <div className="draft-matchbar">
        <label><span>КОМАНДА A</span><div><TeamLogo team={firstTeam} /><select disabled={Boolean(selectedLiveDraft)} value={teamA} onChange={(event) => { if (event.target.value !== teamB) setTeamA(event.target.value); }}>{TEAMS.map((team) => <option key={team.id} value={team.id} disabled={team.id === teamB}>{team.name}</option>)}</select></div></label>
        <button type="button" className="draft-swap" disabled={Boolean(selectedLiveDraft)} onClick={swapTeams} aria-label="Поменять команды местами">⇄</button>
        <label><span>КОМАНДА B</span><div><TeamLogo team={secondTeam} /><select disabled={Boolean(selectedLiveDraft)} value={teamB} onChange={(event) => { if (event.target.value !== teamA) setTeamB(event.target.value); }}>{TEAMS.map((team) => <option key={team.id} value={team.id} disabled={team.id === teamA}>{team.name}</option>)}</select></div></label>
        <div className="side-picker"><span>СТОРОНА</span><button type="button" disabled={Boolean(selectedLiveDraft)} className={radiant === "a" ? "active" : ""} onClick={() => setRadiant("a")}>{firstTeam.short} · Radiant</button><button type="button" disabled={Boolean(selectedLiveDraft)} className={radiant === "b" ? "active" : ""} onClick={() => setRadiant("b")}>{secondTeam.short} · Radiant</button></div>
      </div>

      <div className="draft-columns">
        <article className={`draft-lineup ${active.side === "a" ? "is-active" : ""}`}>
          <header><TeamLogo team={firstTeam} /><div><span>ПИК A</span><h2>{firstTeam.name}</h2></div><b>{picksA.filter(Boolean).length}/5</b></header>
          <div>{picksA.map((heroId, index) => <HeroSlot key={index} index={index} hero={heroId ? heroesById.get(heroId) : undefined} active={active.side === "a" && active.index === index} locked={Boolean(selectedLiveDraft)} onClick={() => selectSlot("a", index)} />)}</div>
        </article>
        <article className={`draft-result-card ${selectedLiveAssessment ? `draft-result-card--${selectedLiveAssessment.status}` : ""}`}>
          <p>{selectedLiveDraft ? selectedLiveDraft.phase === "draft" ? "LIVE · ПРОГНОЗ ПО ДРАФТУ" : "ЗАМОРОЖЕННЫЙ ПРОГНОЗ ПО ДРАФТУ" : "ПРОГНОЗ НА КАРТУ"}</p>
          {selectedLiveDraft && selectedLiveAssessment ? <div className="live-state-summary"><header><b>СОСТОЯНИЕ КАРТЫ</b><em className={`live-state-summary--${selectedLiveAssessment.status}`}>{selectedLiveDraft.phase === "draft" ? "ДРАФТ" : selectedLiveAssessment.settled ? "NO BET · ИСХОД СЛОЖИЛСЯ" : "LIVE · NO BET"}</em></header><strong>{selectedLiveDraft.phase === "draft" ? "Карта ещё не началась" : selectedLeaderTeam ? `${selectedLeaderTeam.name} ведёт сейчас` : "Карта пока близкая"}</strong><div><span><b>{selectedLiveDraft.phase === "draft" ? "—" : selectedGameClock}</b>время</span><span><b>{selectedLiveDraft.radiantScore}:{selectedLiveDraft.direScore}</b>убийства R:D</span><span><b>{selectedLiveDraft.radiantLead === null ? "—" : compactGold(selectedLiveDraft.radiantLead)}</b>золото Radiant</span><span><b>{selectedLiveDraft.seriesScoreRadiant}:{selectedLiveDraft.seriesScoreDire}</b>счёт серии R:D</span></div>{selectedLiveDraft.spectators !== null ? <small>{selectedLiveDraft.spectators.toLocaleString("ru-RU")} зрителей в OpenDota live · задержка {selectedLiveDraft.delay} сек.</small> : <small>Задержка источника {selectedLiveDraft.delay} сек.</small>}</div> : null}
          <div className="draft-probability"><b style={{ color: firstTeam.color }}>{(result.probability * 100).toFixed(1)}%</b><span>—</span><b style={{ color: secondTeam.color }}>{((1 - result.probability) * 100).toFixed(1)}%</b></div>
          <div className="draft-probability-bar"><i style={{ width: `${result.probability * 100}%`, background: firstTeam.color }} /><i style={{ background: secondTeam.color }} /></div>
          <strong>{selectedLiveDraft?.phase === "game" ? `До старта модель выбирала ${result.probability >= 0.5 ? firstTeam.name : secondTeam.name}` : `${result.probability >= 0.5 ? firstTeam.name : secondTeam.name} — фаворит карты`}</strong>
          <small>{selectedLiveDraft?.phase === "game" ? "После начала карты это не сигнал для ставки: live-состояние показано отдельно и не подмешано в драфтовую модель. " : ""}Уверенность: {result.confidence}. Базовый прогноз без пиков — {(result.base * 100).toFixed(1)}% на {firstTeam.short}.</small>
          <button type="button" onClick={() => selectedLiveDraft ? setLiveDraftId(null) : reset()}>{selectedLiveDraft ? "Отключить LIVE" : "Сбросить пики"}</button>
        </article>
        <article className={`draft-lineup draft-lineup--dire ${active.side === "b" ? "is-active" : ""}`}>
          <header><TeamLogo team={secondTeam} /><div><span>ПИК B</span><h2>{secondTeam.name}</h2></div><b>{picksB.filter(Boolean).length}/5</b></header>
          <div>{picksB.map((heroId, index) => <HeroSlot key={index} index={index} hero={heroId ? heroesById.get(heroId) : undefined} active={active.side === "b" && active.index === index} locked={Boolean(selectedLiveDraft)} onClick={() => selectSlot("b", index)} />)}</div>
        </article>
      </div>

      <section className="hero-pool">
        <header><div><p className="eyebrow">ПУЛ ГЕРОЕВ</p><h2>Выбери героя для {active.side === "a" ? firstTeam.name : secondTeam.name}</h2></div><label><span>Поиск</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Например, Puck" /></label></header>
        <div className="hero-filters">{ATTRIBUTES.map((item) => <button type="button" key={item.id} className={attribute === item.id ? "active" : ""} onClick={() => setAttribute(item.id)}>{item.label}</button>)}</div>
        <div className="hero-grid">{visibleHeroes.map((hero) => { const priority = draftStats?.activeSnapshot?.heroPriority?.[String(hero.id)]; return <button type="button" key={hero.id} disabled={selected.has(hero.id) || Boolean(selectedLiveDraft)} onClick={() => chooseHero(hero.id)} title={`${hero.roles.join(", ")} · модель ${hero.modelWinRate.toFixed(1)}%${priority ? ` · pick ${priority.pickRate.toFixed(1)}% · ban ${priority.banRate.toFixed(1)}% · contested ${priority.contestedRate.toFixed(1)}%` : ""}`}><img src={hero.image} alt="" /><span><b>{hero.name}</b><small>{hero.modelWinRate.toFixed(1)}% · {priority ? `P ${priority.pickRate.toFixed(1)}% · B ${priority.banRate.toFixed(1)}%` : `${hero.proPicks + hero.proBans} pro P/B`}</small></span>{selected.has(hero.id) ? <i>В ПИКЕ</i> : null}</button>; })}</div>
      </section>
    </section>

    <section className="draft-model" id="model">
      <div className="section-heading section-heading--light"><span className="step-number">02</span><div><p>ПРОЗРАЧНОСТЬ МОДЕЛИ</p><h2>Почему получилась эта вероятность</h2></div><span className="section-note">Каждая поправка ограничена и сжата к нулю,<br />если данных по сочетанию мало.</span></div>
      <div className="draft-model-grid">
        <article className="draft-breakdown"><header><span>СТАРТ</span><b>{(result.base * 100).toFixed(1)}%</b><p>Сила команд на карте до учёта драфта</p></header>{result.features.map((feature) => <div key={feature.label}><span><b>{feature.label}</b><small>{feature.detail}</small></span><strong className={feature.contribution > 0.04 ? "positive" : feature.contribution < -0.04 ? "negative" : "neutral"}>{signed(feature.contribution)}</strong></div>)}<footer><span>ИТОГ ДЛЯ {firstTeam.short}</span><b>{(result.probability * 100).toFixed(1)}%</b></footer></article>
        <aside className="draft-method-card"><p className="eyebrow">ЧТО УЖЕ УЧИТЫВАЕМ</p><h3>Не чёрный ящик</h3><ul><li><b>Команды</b><span>Walk-forward map prior: для каждой карты используются только более ранние результаты.</span></li><li><b>Герой в патче</b><span>Базовая сила героя на всех загруженных pro-картах 7.41, а не только у участников TI.</span></li><li><b>Приоритет драфта</b><span>Pick, ban, contested, ранняя фаза и flex считаются только по предыдущим картам; вес обучен на OOF и может быть нулевым.</span></li><li><b>Переход между патчами</b><span>{temporalModel ? `${temporalModel.dataset?.matches ?? 0} карт, ${temporalModel.dataset?.patches ?? 0} патча · ${temporalModel.deployment?.status === "candidate" ? "включена" : "SHADOW без влияния на прогноз"}` : "модель загружается"}.</span></li><li><b>Игрок × герой</b><span>Личная практика каждого из пяти игроков с байесовским сглаживанием.</span></li><li><b>Связки и контрпики</b><span>Все 10 пар союзников и 25 направленных матчапов против пика соперника.</span></li></ul><p>Отдельная SQLite-база содержит <b>{draftStats?.methodology.cachedPatchMaps ?? "—"} pro-карт</b> актуального патча. Коллектор постепенно проходит всю историю, стратифицируя очередь по времени, лигам и командам. Редкие сочетания почти не двигают прогноз.</p><small>Обновлено {draftStats ? new Date(draftStats.generatedAt).toLocaleString("ru-RU") : "—"} · патч {draftStats?.methodology.patchName ?? draftStats?.methodology.latestOpenDotaPatchId ?? "—"} · начало {draftStats?.methodology.patchStart ? new Date(draftStats.methodology.patchStart).toLocaleDateString("ru-RU") : "—"}</small></aside>
      </div>
      {temporalModel?.arena?.leaderboard?.length ? <article className="draft-arena-card">
        <header><div><p className="eyebrow">MODEL ARENA · PATCH WALK-FORWARD</p><h3>Какая модель действительно лучше</h3></div><span className={temporalModel.deployment?.status === "candidate" ? "is-candidate" : "is-shadow"}>{temporalModel.deployment?.status === "candidate" ? "CANDIDATE" : temporalModel.deployment?.status === "insufficient_data" ? "МАЛО ДАННЫХ" : "SHADOW"}</span></header>
        <div className="draft-arena-table"><div className="draft-arena-head"><span>#</span><span>Модель</span><span>Log loss</span><span>Accuracy</span></div>{temporalModel.arena.leaderboard.slice(0, 6).map((model, index) => <div key={model.name}><span>{String(index + 1).padStart(2, "0")}</span><b>{model.name.replaceAll("_", " ")}</b><strong>{model.logLoss.toFixed(6)}</strong><em>{model.accuracy === undefined ? "—" : `${(model.accuracy * 100).toFixed(1)}%`}</em></div>)}</div>
        <footer><span>Ансамбль <b>{temporalModel.backtest?.aggregate?.model?.logLoss?.toFixed(6) ?? "—"}</b></span><span>Team-only baseline <b>{temporalModel.backtest?.aggregate?.neutral?.logLoss?.toFixed(6) ?? "—"}</b></span><span>Δ log loss <b>{temporalModel.backtest?.aggregate?.logLossDelta?.toFixed(6) ?? "—"}</b></span><span>Выиграно fold <b>{temporalModel.backtest?.aggregate?.foldsWon ?? 0}/{temporalModel.backtest?.eligiblePatches ?? 0}</b></span></footer>
      </article> : null}
      {result.assignmentA?.rows.length && result.assignmentB?.rows.length ? <div className="draft-evidence-grid">
        <article className={`draft-player-evidence draft-player-evidence--${result.assignmentA.source}`}><header><span>ИГРОК × ГЕРОЙ</span><b>{result.assignmentA.source === "observed" && result.assignmentB.source === "observed" ? "точное распределение из live-feed" : "гипотеза модели · не подтверждено"}</b></header><div className="draft-assignment-columns"><section><h3>{firstTeam.name}</h3>{result.assignmentA.rows.map((row) => <div key={`${row.player}-${row.hero.id}`}><span><img src={row.hero.icon} alt="" /><b>{row.player}</b><i>→</i><strong>{row.hero.name}</strong></span><small>{positionLabel(row.position)} · {row.sample ? `${row.sample.games} карт · ${row.sample.winRate.toFixed(1)}% сглаженный кэф` : "нет карт · нейтральный кэф"}</small></div>)}</section><section><h3>{secondTeam.name}</h3>{result.assignmentB.rows.map((row) => <div key={`${row.player}-${row.hero.id}`}><span><img src={row.hero.icon} alt="" /><b>{row.player}</b><i>→</i><strong>{row.hero.name}</strong></span><small>{positionLabel(row.position)} · {row.sample ? `${row.sample.games} карт · ${row.sample.winRate.toFixed(1)}% сглаженный кэф` : "нет карт · нейтральный кэф"}</small></div>)}</section></div>{result.assignmentA.source !== "observed" || result.assignmentB.source !== "observed" ? <footer>Без live account_id модель не знает фактическую рассадку. Этот блок — наиболее совместимая гипотеза по позициям, а не утверждение.</footer> : null}</article>
        <article className="draft-counter-evidence"><header><span>ГЕРОЙ ПРОТИВ ГЕРОЯ</span><b>{result.counterRows.length}/25 матчапов найдено</b></header><div>{[...result.counterRows].sort((left, right) => Math.abs(right.sample.winRate - 50) - Math.abs(left.sample.winRate - 50)).slice(0, 10).map((row) => <div key={`${row.a.id}-${row.b.id}`}><span><img src={row.a.icon} alt="" /><b>{row.a.name}</b><i>vs</i><img src={row.b.icon} alt="" /><strong>{row.b.name}</strong></span><small>{row.sample.winRate.toFixed(1)}% · {row.sample.games} карт</small></div>)}</div></article>
      </div> : null}
    </section>

    <footer><div className="brand"><span className="brand-glyph">T</span><span>TI / PREDICTOR</span></div><p>Экспериментальный прогноз драфта · коэффициенты будут проверяться на сыгранных картах TI</p><a href="/">К турниру →</a></footer>
  </main>;
}
