import { combineDraftSignals, combineLearnedDraftSignals } from "./draft-combiner.mjs";

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, Number(value)));
const sigmoid = (value) => 1 / (1 + Math.exp(-value));
const logit = (value) => Math.log(clamp(value, .01, .99) / (1 - clamp(value, .01, .99)));
const average = (values, fallback = .5) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback;
const heroPairKey = (a, b) => [Number(a), Number(b)].sort((left, right) => left - right).join("|");
const teamPairKey = (a, b) => [a, b].sort().join("|");

function teamMapProbability(teamStats, teamA, teamB) {
  const key = teamPairKey(teamA, teamB);
  const stored = Number(teamStats?.pairwise?.[key]?.mapProbabilityA);
  if (!Number.isFinite(stored)) return .5;
  return (key.startsWith(`${teamA}|`) ? stored : 100 - stored) / 100;
}

function safeHeroes(draftStats, picks) {
  if (!Array.isArray(picks) || picks.length > 5) return null;
  const ids = picks.map(Number);
  if (ids.some((id) => !Number.isInteger(id) || id <= 0) || new Set(ids).size !== ids.length) return null;
  const byId = new Map((draftStats?.heroes ?? []).map((hero) => [Number(hero.id), hero]));
  return ids.map((id) => byId.get(id) ?? { id, name: `Hero ${id}`, modelWinRate: 50, icon: null, image: null });
}

function liveRoleFrom(row) {
  const explicit = Number(row?.role);
  if (explicit >= 1 && explicit <= 5) return explicit;
  const slot = Number(row?.slot);
  if (slot >= 0 && slot <= 4) return slot + 1;
  if (slot >= 1 && slot <= 5) return slot;
  return 0;
}

function assignmentScore(team, heroes, active, observedPlayers) {
  const players = team?.players ?? [];
  if (!heroes.length) return { rate: .5, roleRate: .5, source: "unavailable", rows: [] };
  const score = (assignments, source) => {
    let pool = 0; let roles = 0;
    const rows = [];
    for (const { player, hero, liveRole } of assignments) {
      const rosterRole = Number(active?.playerPositions?.[String(player?.accountId)]?.role || 0);
      const position = Number(liveRole) >= 1 && Number(liveRole) <= 5 ? Number(liveRole) : rosterRole;
      const sample = active?.playerHero?.[`${player?.accountId}|${hero.id}`] ?? player?.heroes?.[String(hero.id)];
      const role = position ? active?.heroRole?.[`${hero.id}|${position}`] : null;
      if (sample) pool += logit(Number(sample.winRate) / 100) * (active?.playerHero ? 1 : Math.min(1, Number(sample.games) / 5));
      if (role) roles += logit(Number(role.winRate) / 100) * Math.min(1, Number(role.games) / 8);
      rows.push({
        accountId: Number(player?.accountId || 0),
        player: player?.name ?? String(player?.accountId || "unknown"),
        heroId: Number(hero.id),
        hero: hero.name,
        heroIcon: hero.icon ?? hero.image ?? null,
        position: position || null,
        games: Number(sample?.games || 0),
        winRate: Number(sample?.winRate ?? 50),
        roleGames: Number(role?.games || 0),
        roleWinRate: Number(role?.winRate ?? 50),
      });
    }
    return { rate: sigmoid(pool / assignments.length), roleRate: sigmoid(roles / assignments.length), source, rows };
  };
  if (observedPlayers?.length === heroes.length) {
    const byAccount = new Map(players.map((player) => [Number(player.accountId), player]));
    const byHero = new Map(heroes.map((hero) => [Number(hero.id), hero]));
    const exact = observedPlayers.map((row) => {
      const accountId = Number(row.accountId || 0);
      const liveRole = liveRoleFrom(row);
      return {
        player: byAccount.get(accountId) ?? { accountId, name: row.name || `slot ${liveRole || "?"}`, heroes: {} },
        hero: byHero.get(Number(row.heroId)),
        liveRole,
      };
    });
    if (exact.every((row) => row.hero)) {
      const observed = exact.every((row) => byAccount.has(Number(row.player.accountId)));
      return score(exact, observed ? "observed" : "inferred");
    }
  }
  if (players.length < heroes.length) return { rate: .5, roleRate: .5, source: "unavailable", rows: [] };
  let best = null;
  const visit = (index, used, rows, value) => {
    if (index === heroes.length) {
      if (!best || value > best.value) best = { value, rows: [...rows] };
      return;
    }
    players.forEach((player, playerIndex) => {
      if (used.has(playerIndex)) return;
      const position = Number(active?.playerPositions?.[String(player.accountId)]?.role || 0);
      if (active?.playerHero && !position) return;
      const sample = active?.playerHero?.[`${player.accountId}|${heroes[index].id}`] ?? player.heroes?.[String(heroes[index].id)];
      const role = position ? active?.heroRole?.[`${heroes[index].id}|${position}`] : null;
      if (active?.playerHero && Number(role?.games || 0) < 2) return;
      const evidence = (sample ? logit(Number(sample.winRate) / 100) : 0) + (role ? logit(Number(role.winRate) / 100) : 0);
      used.add(playerIndex); rows.push({ player, hero: heroes[index], liveRole: position });
      visit(index + 1, used, rows, value + evidence);
      rows.pop(); used.delete(playerIndex);
    });
  };
  visit(0, new Set(), [], 0);
  return best ? score(best.rows, "inferred") : { rate: .5, roleRate: .5, source: "unavailable", rows: [] };
}

function activeSignals(draftStats, teamA, teamB, radiant, heroesA, heroesB, liveGame) {
  const active = draftStats.activeSnapshot;
  const heroRate = (hero) => Number(active?.hero?.[String(hero.id)]?.winRate ?? hero.modelWinRate ?? 50) / 100;
  const priority = (heroes) => heroes.map((hero) => active?.heroPriority?.[String(hero.id)]).filter(Boolean);
  const synergyRows = (heroes) => {
    const rows = [];
    for (let i = 0; i < heroes.length; i += 1) for (let j = i + 1; j < heroes.length; j += 1) {
      const row = active?.synergy?.[heroPairKey(heroes[i].id, heroes[j].id)] ?? draftStats.synergy?.[heroPairKey(heroes[i].id, heroes[j].id)];
      if (row) rows.push({ heroA: heroes[i], heroB: heroes[j], sample: row });
    }
    return rows;
  };
  const familiarity = (team, heroes) => average(heroes.map((hero) => active?.teamHero?.[`${team}|${hero.id}`] ?? draftStats.teams?.[team]?.heroes?.[String(hero.id)]).filter(Boolean).map((row) => Number(row.winRate) / 100));
  const synergiesA = synergyRows(heroesA); const synergiesB = synergyRows(heroesB);
  const synergyScore = (rows) => average(rows.map((row) => Number(row.sample.coefficient ?? logit(Number(row.sample.winRate) / 100))), 0);
  const counters = heroesA.flatMap((heroA) => heroesB.flatMap((heroB) => {
    const sample = active?.counter?.[`${heroA.id}>${heroB.id}`] ?? draftStats.counters?.[`${heroA.id}|${heroB.id}`];
    return sample ? [{ heroA, heroB, sample }] : [];
  }));
  const observedA = teamA === liveGame?.radiantTeam ? liveGame.radiantPlayers : liveGame?.direPlayers;
  const observedB = teamB === liveGame?.radiantTeam ? liveGame.radiantPlayers : liveGame?.direPlayers;
  const assignmentA = assignmentScore(draftStats.teams?.[teamA], heroesA, active, observedA);
  const assignmentB = assignmentScore(draftStats.teams?.[teamB], heroesB, active, observedB);
  const signals = [
    { key: "side", label: "Сторона карты", value: logit(Number(active?.radiantWinRate ?? draftStats.radiantWinRate ?? 50) / 100) * (radiant === "a" ? 1 : -1), sample: Number(draftStats.methodology?.cachedPatchMaps || 0) },
    { key: "hero", label: "Мета героев", value: logit(average(heroesA.map(heroRate))) - logit(average(heroesB.map(heroRate))), sample: heroesA.length + heroesB.length },
    { key: "draftPriority", label: "Приоритет драфта", value: average(priority(heroesA).map((row) => Number(row.score)), 0) - average(priority(heroesB).map((row) => Number(row.score)), 0), sample: priority(heroesA).length + priority(heroesB).length },
    { key: "synergy", label: "Синергии", value: synergyScore(synergiesA) - synergyScore(synergiesB), sample: synergiesA.reduce((sum, row) => sum + Number(row.sample.games || 0), 0) + synergiesB.reduce((sum, row) => sum + Number(row.sample.games || 0), 0) },
    { key: "counter", label: "Контрпики", value: average(counters.map((row) => Number(row.sample.coefficient ?? logit(Number(row.sample.winRate) / 100))), 0), sample: counters.reduce((sum, row) => sum + Number(row.sample.games || 0), 0) },
    { key: "teamPool", label: "Пул команды", value: logit(familiarity(teamA, heroesA)) - logit(familiarity(teamB, heroesB)), sample: heroesA.length + heroesB.length },
    { key: "playerPool", label: "Игроки на героях", value: logit(assignmentA.rate) - logit(assignmentB.rate), sample: assignmentA.rows.reduce((sum, row) => sum + row.games, 0) + assignmentB.rows.reduce((sum, row) => sum + row.games, 0) },
    { key: "roles", label: "Герои на позициях", value: logit(assignmentA.roleRate) - logit(assignmentB.roleRate), sample: assignmentA.rows.reduce((sum, row) => sum + row.roleGames, 0) + assignmentB.rows.reduce((sum, row) => sum + row.roleGames, 0) },
  ];
  const compactPair = (row) => ({
    heroA: { id: Number(row.heroA.id), name: row.heroA.name, icon: row.heroA.icon ?? row.heroA.image ?? null },
    heroB: { id: Number(row.heroB.id), name: row.heroB.name, icon: row.heroB.icon ?? row.heroB.image ?? null },
    games: Number(row.sample.games || 0),
    winRate: Number(row.sample.winRate ?? 50),
  });
  return {
    signals,
    evidence: {
      assignments: { radiant: assignmentA, dire: assignmentB },
      synergies: { radiant: synergiesA.map(compactPair), dire: synergiesB.map(compactPair) },
      counters: counters.map(compactPair).sort((left, right) => Math.abs(right.winRate - 50) - Math.abs(left.winRate - 50)).slice(0, 10),
    },
  };
}

export function calculateActiveDraftPrediction({ draftStats, teamStats, game } = {}) {
  if (!draftStats || !teamStats || !game) throw new Error("active_draft_inputs_unavailable");
  const heroesA = safeHeroes(draftStats, game.radiantPicks);
  const heroesB = safeHeroes(draftStats, game.direPicks);
  if (!heroesA || !heroesB || new Set([...heroesA, ...heroesB].map((hero) => hero.id)).size !== heroesA.length + heroesB.length) throw new Error("invalid_picks");
  const completeness = Math.min(heroesA.length, heroesB.length) / 5;
  const base = teamMapProbability(teamStats, game.radiantTeam, game.direTeam);
  const { signals, evidence } = activeSignals(draftStats, game.radiantTeam, game.direTeam, "a", heroesA, heroesB, game);
  const combined = draftStats.combiner
    ? combineLearnedDraftSignals(base, signals, draftStats.combiner, completeness)
    : combineDraftSignals(base, signals.map((signal) => signal.value), completeness);
  return {
    probabilityRadiant: combined.probability,
    modelId: `active-draft-combiner-v${Number(draftStats.combiner?.version || 1)}`,
    completeness,
    sourceTeamProbability: combined.sourceTeamProbability,
    temporalWeight: 0,
    nextgenWeight: 0,
    signals: signals.map((signal, index) => ({ ...signal, contribution: combined.contributions[index] })),
    evidence,
  };
}
