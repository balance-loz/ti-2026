const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const sigmoid = (value) => 1 / (1 + Math.exp(-clamp(value, -12, 12)));
const pairKey = (a, b) => [Number(a), Number(b)].sort((left, right) => left - right).join("|");

function safePicks(picks) {
  if (!Array.isArray(picks)) return [];
  const result = picks.map(Number);
  if (result.length > 5 || result.some((heroId) => !Number.isInteger(heroId) || heroId <= 0)) return null;
  return new Set(result).size === result.length ? result : null;
}

function heroComponent(model, heroes, roles = []) {
  return heroes.reduce((sum, heroId, index) => {
    const hero = model.heroes?.[String(heroId)];
    if (!hero) return sum;
    const role = Number(roles[index] || 0);
    return sum + Number(model.inference?.heroScale ?? .2) * Number(hero.coefficient || 0)
      + Number(model.inference?.roleScale ?? .08) * Number(hero.roles?.[String(role)]?.coefficient || 0);
  }, 0);
}

function synergyComponent(model, heroes) {
  let result = 0; let found = 0;
  for (let i = 0; i < heroes.length; i += 1) for (let j = i + 1; j < heroes.length; j += 1) {
    const row = model.synergy?.[pairKey(heroes[i], heroes[j])];
    if (!row) continue;
    result += Number(model.inference?.synergyScale ?? .04) * Number(row.coefficient || 0); found++;
  }
  return { value: result, found };
}

function counterComponent(model, radiantHeroes, direHeroes) {
  let result = 0; let found = 0;
  for (const radiant of radiantHeroes) for (const dire of direHeroes) {
    const forward = model.counters?.[`${radiant}>${dire}`];
    const reverse = model.counters?.[`${dire}>${radiant}`];
    if (!forward && !reverse) continue;
    result += Number(model.inference?.counterScale ?? .02) * (Number(forward?.coefficient || 0) - Number(reverse?.coefficient || 0)); found++;
  }
  return { value: result, found };
}

function factorizationComponent(model, radiantHeroes, direHeroes) {
  const dimensions = Number(model.inference?.dimensions || 0);
  if (!dimensions) return { value: 0, found: 0 };
  const signed = [...radiantHeroes.map((heroId) => ({ heroId, sign: 1 })), ...direHeroes.map((heroId) => ({ heroId, sign: -1 }))];
  let value = 0; let known = 0;
  for (const row of signed) if (Array.isArray(model.heroes?.[String(row.heroId)]?.embedding)) known++;
  for (let dimension = 0; dimension < dimensions; dimension += 1) {
    let radiantSum = 0; let radiantSquares = 0; let direSum = 0; let direSquares = 0;
    for (const row of signed) {
      const embedded = Number(model.heroes?.[String(row.heroId)]?.embedding?.[dimension] || 0);
      if (row.sign > 0) { radiantSum += embedded; radiantSquares += embedded * embedded; }
      else { direSum += embedded; direSquares += embedded * embedded; }
    }
    value += .5 * ((radiantSum * radiantSum - radiantSquares) - (direSum * direSum - direSquares));
  }
  return { value, found: known };
}

function memberComponents(model, a, b, rolesA, rolesB, radiantIsA, temperature = 1) {
  const radiantHeroes = radiantIsA ? a : b; const direHeroes = radiantIsA ? b : a;
  const radiantRoles = radiantIsA ? rolesA : rolesB; const direRoles = radiantIsA ? rolesB : rolesA;
  const hero = heroComponent(model, radiantHeroes, radiantRoles) - heroComponent(model, direHeroes, direRoles);
  const synergyRadiant = synergyComponent(model, radiantHeroes); const synergyDire = synergyComponent(model, direHeroes);
  const factorization = factorizationComponent(model, radiantHeroes, direHeroes);
  const synergy = synergyRadiant.value - synergyDire.value + factorization.value;
  const counter = counterComponent(model, radiantHeroes, direHeroes);
  const side = Number(model.inference?.radiantBias || 0);
  const safeTemperature = Math.max(.25, Number(temperature || model.inference?.temperature || 1));
  const direction = radiantIsA ? 1 : -1;
  return {
    components: {
      side: direction * side / safeTemperature,
      heroes: direction * hero / safeTemperature,
      synergy: direction * synergy / safeTemperature,
      counters: direction * counter.value / safeTemperature,
    },
    evidence: { synergies: synergyRadiant.found + synergyDire.found + factorization.found, counters: counter.found },
  };
}

export function predictTemporalDraft(model, { picksA, picksB, rolesA = [], rolesB = [], radiant = "a" } = {}) {
  if (!model || model.schemaVersion !== 1) throw new Error("temporal_model_unavailable");
  const a = safePicks(picksA); const b = safePicks(picksB);
  if (!a || !b || new Set([...a, ...b]).size !== a.length + b.length) throw new Error("invalid_picks");
  if (radiant !== "a" && radiant !== "b") throw new Error("invalid_side");
  const radiantIsA = radiant !== "b";
  let result;
  if (Array.isArray(model.ensemble?.members)) {
    const components = { side: 0, heroes: 0, synergy: 0, counters: 0 }; let synergies = 0; let counters = 0;
    for (const member of model.ensemble.members) {
      const memberResult = memberComponents(member.model, a, b, rolesA, rolesB, radiantIsA, member.temperature);
      const weight = Math.max(0, Number(member.weight || 0));
      for (const key of Object.keys(components)) components[key] += weight * memberResult.components[key];
      synergies = Math.max(synergies, memberResult.evidence.synergies); counters = Math.max(counters, memberResult.evidence.counters);
    }
    result = { components, evidence: { synergies, counters } };
  } else result = memberComponents(model, a, b, rolesA, rolesB, radiantIsA);
  const rawLogitA = Object.values(result.components).reduce((sum, value) => sum + value, 0);
  const completeness = Math.min(a.length, b.length) / 5;
  return {
    modelId: model.modelId, patchId: model.dataset?.currentPatchId ?? null,
    probabilityA: sigmoid(rawLogitA), rawLogitA, completeness,
    components: result.components,
    evidence: { heroes: a.length + b.length, synergies: result.evidence.synergies, counters: result.evidence.counters, trainingMatches: model.dataset?.matches ?? 0, patches: model.dataset?.patches ?? 0 },
  };
}
