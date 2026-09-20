// Why the model said what it said.
//
// A probability on its own cannot be argued with. This module takes a forecast
// apart into the things that produced it, each one signed and measured in the
// unit the model actually works in, so the number can be read rather than
// trusted.
//
// One rule holds throughout: nothing is invented. Only what the model really
// used appears as an influence. Everything else worth knowing — the head to
// head, roster churn, recent form — is reported beside it and labelled as
// context, because presenting it as an input would misdescribe how the forecast
// was made.
import { loadRatings, ratingPairProbability } from "./ratings.mjs";
import { loadDraftModel } from "./predictions.mjs";
import { seriesOutcomeProbabilities } from "./series-outcomes.mjs";
import { counted } from "./russian.mjs";
import { rosterEras } from "./rosters.mjs";

const clampProbability = (value) => Math.min(0.99, Math.max(0.01, Number(value)));
const sigmoid = (value) => 1 / (1 + Math.exp(-Math.min(12, Math.max(-12, value))));
const round = (value, places = 4) => Math.round(Number(value) * 10 ** places) / 10 ** places;
const percent = (value) => (100 * Number(value)).toFixed(1);

/**
 * A running probability that records what moved it.
 *
 * Steps are applied in the order the model applies them, so each factor's
 * effect is measured against the state it actually saw and the deltas add up to
 * the final number exactly rather than approximately.
 */
function walk(start) {
  let current = clampProbability(start);
  const factors = [];
  return {
    add({ key, label, detail, to, logit = null, evidence = null }) {
      const next = clampProbability(to);
      factors.push({
        key, label, detail,
        logit: logit == null ? null : round(logit),
        from: round(current), to: round(next), delta: round(next - current),
        evidence,
      });
      current = next;
      return next;
    },
    get probability() { return current; },
    get factors() { return factors; },
  };
}

// --- context the model does not read directly -------------------------------

/**
 * The five a team is fielding now, and how far back that five goes.
 *
 * Both answers come from the roster history rather than from a raw frequency
 * count over the last N maps: counting most-frequent players and then walking
 * back from the newest map breaks on the first game with a stand-in, which made
 * an unchanged roster report as "together for 0 maps".
 */
export function teamLineup(db, teamId) {
  const eras = rosterEras(db, teamId);
  const current = eras.at(-1);
  if (!current) return null;
  const sampled = eras.reduce((total, era) => total + era.maps, 0);
  return {
    players: current.players.map((player) => ({ ...player, share: round(player.maps / current.maps, 3) })),
    sampledMaps: sampled,
    stableMaps: current.maps,
    stableSince: current.from,
    unchangedThroughout: eras.length === 1,
  };
}

/** Finished series between two teams, newest first, in the A/B frame. */
export function headToHead(db, teamAId, teamBId, { limit = 10 } = {}) {
  const rows = db.prepare(`SELECT series_key, league_id, start_time, best_of, score_a, score_b,
                                  team_a_id, team_b_id, winner_id, is_draw
                           FROM series
                           WHERE ((team_a_id = ? AND team_b_id = ?) OR (team_a_id = ? AND team_b_id = ?))
                             AND status = 'finished'
                           ORDER BY start_time DESC LIMIT ?`)
    .all(teamAId, teamBId, teamBId, teamAId, limit);

  let winsA = 0;
  let winsB = 0;
  let draws = 0;
  const matches = rows.map((row) => {
    const flipped = Number(row.team_a_id) !== Number(teamAId);
    if (row.is_draw) draws += 1;
    else if (Number(row.winner_id) === Number(teamAId)) winsA += 1;
    else if (Number(row.winner_id) === Number(teamBId)) winsB += 1;
    return {
      seriesKey: row.series_key,
      leagueId: row.league_id,
      startTime: row.start_time,
      bestOf: row.best_of,
      scoreA: flipped ? row.score_b : row.score_a,
      scoreB: flipped ? row.score_a : row.score_b,
      winner: row.is_draw ? null : (Number(row.winner_id) === Number(teamAId) ? "a" : "b"),
      isDraw: Boolean(row.is_draw),
    };
  });
  return { played: matches.length, winsA, winsB, draws, matches };
}

/** A team's last few finished series, read from that team's own side. */
export function recentForm(db, teamId, { limit = 6 } = {}) {
  const rows = db.prepare(`SELECT series_key, start_time, team_a_id, team_b_id, score_a, score_b,
                                  winner_id, is_draw, best_of
                           FROM series
                           WHERE (team_a_id = ? OR team_b_id = ?) AND status = 'finished'
                           ORDER BY start_time DESC LIMIT ?`).all(teamId, teamId, limit);
  return rows.map((row) => {
    const own = Number(row.team_a_id) === Number(teamId);
    return {
      seriesKey: row.series_key,
      startTime: row.start_time,
      opponentId: own ? row.team_b_id : row.team_a_id,
      score: own ? `${row.score_a}:${row.score_b}` : `${row.score_b}:${row.score_a}`,
      result: row.is_draw ? "draw" : (Number(row.winner_id) === Number(teamId) ? "win" : "loss"),
      bestOf: row.best_of,
    };
  });
}

// --- the series model -------------------------------------------------------

/** Where a team sits among every rated team. */
function ratingRank(artifact, teamId) {
  const ratings = artifact?.ratings || {};
  const own = ratings[String(teamId)];
  if (!own) return null;
  let above = 0;
  for (const entry of Object.values(ratings)) if (Number(entry.rating) > Number(own.rating)) above += 1;
  return { rank: above + 1, of: Object.keys(ratings).length, rating: round(own.rating, 3), series: Number(own.series || 0) };
}

function seriesNotes({ pair, roster, frozen = false }) {
  const notes = [];
  if (frozen) {
    notes.push({
      key: "frozen_basis",
      text: "Разбор построен на тех рейтингах, что были у модели в момент фиксации прогноза, а не на сегодняшних — "
        + "иначе он объяснял бы решение, которого модель не принимала.",
    });
  }
  notes.push({
    key: "h2h_not_an_input",
    text: "Личные встречи и форма показаны как контекст: модель серии читает только рейтинги, "
      + "а прошлые очные матчи уже вошли в них как обычные результаты.",
  });
  if (roster?.applied) {
    notes.push({
      key: "roster_weighting",
      text: "Смена состава влияет не на этот прогноз напрямую, а на обучение: результаты, сыгранные другой пятёркой, "
        + `получают меньший вес. На отложенной выборке это улучшило log loss с ${round(roster.withoutRosters?.logLoss ?? 0)} `
        + `до ${round(roster.withRosters?.logLoss ?? 0)} и точность с ${percent(roster.withoutRosters?.accuracy ?? 0)}% `
        + `до ${percent(roster.withRosters?.accuracy ?? 0)}%.`,
    });
  } else if (roster) {
    notes.push({
      key: "roster_weighting_rejected",
      text: "Взвешивание по составам проверялось, но на отложенной выборке прогноз не улучшило, поэтому не применяется.",
    });
  }
  if (pair.confidence !== "high") {
    notes.push({
      key: "thin_evidence",
      text: "Данных по этой паре немного, поэтому прогноз намеренно осторожен: разрыв притянут к равному.",
    });
  }
  return notes;
}

/**
 * Take a series prediction apart.
 *
 * The published series model reads exactly one thing: the gap between the two
 * teams' ratings, damped when either side is thinly observed, then stretched by
 * the length of the series. That is a short list, and saying so plainly beats
 * padding it with factors the model never consulted.
 */
export function explainSeries(db, { teamAId, teamBId, bestOf = 3, ratings = null, snapshot = null }) {
  const live = ratings ?? loadRatings();
  // A frozen prediction recorded the ratings it was made with. Explaining it
  // from today's ratings would describe a call nobody made, so when that record
  // exists the explanation is rebuilt from it — same arithmetic, stored inputs.
  const frozen = snapshot && Number.isFinite(Number(snapshot.ratingA)) && Number.isFinite(Number(snapshot.ratingB))
    ? {
      modelId: snapshot.modelId ?? null,
      ratings: {
        [String(teamAId)]: { rating: Number(snapshot.ratingA), series: Number(snapshot.seriesA || 0) },
        [String(teamBId)]: { rating: Number(snapshot.ratingB), series: Number(snapshot.seriesB || 0) },
      },
    }
    : null;
  const artifact = frozen ?? live;
  const pair = ratingPairProbability(artifact, teamAId, teamBId);
  const chain = walk(0.5);

  if (pair.confidence === "none") {
    chain.add({
      key: "unrated",
      label: "Нет оценки ни для одной команды",
      detail: "Модель не видела достаточно матчей ни одной из команд, поэтому исход считается равновероятным.",
      to: 0.5,
    });
  } else {
    // A team with no history sits at the default rating of zero. Printing that
    // as a number invites it to be read as a measurement, which it is not.
    const unrated = [
      pair.seriesA ? null : "первая команда",
      pair.seriesB ? null : "вторая команда",
    ].filter(Boolean);
    const byPlayers = pair.playerPartA != null && pair.playerPartB != null;
    chain.add({
      key: "rating",
      label: "Разница в силе составов",
      detail: `Сила ${round(pair.ratingA ?? 0, 2)} против ${round(pair.ratingB ?? 0, 2)}. `
        + (byPlayers
          ? `Она складывается из пятёрки игроков (${round(pair.playerPartA, 2)} против ${round(pair.playerPartB, 2)}) `
            + `и того, что добавляет сама организация поверх своих игроков `
            + `(${round(pair.teamPartA, 2)} против ${round(pair.teamPartB, 2)}). `
            + "Разделение между ними подобрано на данных, а не назначено; благодаря игрокам команда с новым "
            + "названием, но знакомым составом не считается неизвестной."
          : "Это единственная величина, из которой модель считает вероятность одной карты.")
        + (unrated.length
          ? ` При этом ${unrated.join(" и ")} в обучении не встречалась — у неё не рейтинг, а значение по умолчанию.`
          : ""),
      to: pair.rawMapProbabilityA ?? pair.mapProbabilityA,
      logit: Number(pair.ratingA ?? 0) - Number(pair.ratingB ?? 0),
      evidence: { rankA: ratingRank(artifact, teamAId), rankB: ratingRank(artifact, teamBId) },
    });

    if (Math.abs((pair.rawMapProbabilityA ?? pair.mapProbabilityA) - pair.mapProbabilityA) > 0.002) {
      chain.add({
        key: "reliability",
        label: "Поправка на объём данных",
        detail: pair.shrinkMethod === "moderated"
          ? `За первой командой стоит вес ${round(pair.evidenceA, 1)}, за второй ${round(pair.evidenceB, 1)} — `
            + "это сумма сыгранного её составом с поправкой на давность. Чем меньше вес, тем сильнее разрыв "
            + "считается шумом и притягивается к равному."
          : `В обучении у первой команды ${counted(pair.seriesA, "серия", "серии", "серий")}, `
            + `у второй ${counted(pair.seriesB, "серия", "серии", "серий")}. `
            + "Пока меньшая из величин ниже восьми, разрыв считается частично шумом и оценка притягивается к равной.",
        to: pair.mapProbabilityA,
        evidence: { seriesA: pair.seriesA, seriesB: pair.seriesB },
      });
    }
  }

  const maps = Number(bestOf) || 3;
  const outcome = seriesOutcomeProbabilities(chain.probability, maps);
  if (maps > 1) {
    chain.add({
      key: "format",
      label: `Формат Bo${maps}`,
      detail: maps % 2 === 0
        ? `В серии из чётного числа карт возможна ничья (${percent(outcome.draw)}%), поэтому шансы сторон не дополняют друг друга до ста процентов.`
        : `Длинная серия усиливает фаворита: случайность отдельной карты усредняется по ${maps}.`,
      to: outcome.winA,
      evidence: { drawProbability: round(outcome.draw) },
    });
  }

  // Quality always describes the model that is published now; it is a property
  // of the model, not of this one call.
  const validation = live?.validation ?? null;
  return {
    scope: "series",
    modelKind: "team_ratings",
    modelId: artifact?.modelId ?? null,
    basis: frozen ? "frozen" : "current",
    bestOf: maps,
    probabilityA: round(outcome.winA),
    probabilityB: round(outcome.winB),
    drawProbability: round(outcome.draw),
    confidence: pair.confidence,
    factors: chain.factors,
    context: {
      headToHead: headToHead(db, teamAId, teamBId),
      lineupA: teamLineup(db, teamAId),
      lineupB: teamLineup(db, teamBId),
      formA: recentForm(db, teamAId),
      formB: recentForm(db, teamBId),
    },
    quality: validation ? {
      family: validation.champion?.family ?? null,
      logLoss: round(validation.champion?.logLoss ?? 0),
      accuracy: round(validation.champion?.accuracy ?? 0, 3),
      coinflipLogLoss: round(validation.coinflipLogLoss ?? 0),
      samples: validation.champion?.samples ?? 0,
      holdoutDays: validation.holdoutDays ?? null,
    } : null,
    notes: seriesNotes({ pair, roster: validation?.rosterWeighting ?? null, frozen: Boolean(frozen) }),
  };
}

// --- the draft model --------------------------------------------------------

/**
 * Each picked hero's own contribution to the map logit, in the Radiant frame.
 *
 * The inference path sums these into a single number; here the sum is kept open
 * so a draft can be read pick by pick.
 */
export function heroContributions(model, radiantPicks = [], direPicks = []) {
  if (!model) return [];
  const members = Array.isArray(model.ensemble?.members) && model.ensemble.members.length
    ? model.ensemble.members.map((member) => ({
      model: member.model,
      weight: Math.max(0, Number(member.weight || 0)),
      temperature: member.temperature,
    }))
    : [{ model, weight: 1, temperature: model.inference?.temperature }];

  const contribution = (heroId, sign) => {
    let logit = 0;
    let games = 0;
    let known = false;
    for (const member of members) {
      const inner = member.model;
      const hero = inner?.heroes?.[String(heroId)];
      if (!hero) continue;
      known = true;
      const temperature = Math.max(0.25, Number(member.temperature || inner.inference?.temperature || 1));
      logit += sign * member.weight * Number(inner.inference?.heroScale ?? 0.2) * Number(hero.coefficient || 0) / temperature;
      games = Math.max(games, Number(hero.games || 0));
    }
    return { logit, games, known };
  };

  const rows = [];
  for (const [picks, side, sign] of [[radiantPicks, "radiant", 1], [direPicks, "dire", -1]]) {
    for (const heroId of picks || []) {
      const { logit, games, known } = contribution(heroId, sign);
      rows.push({ heroId: Number(heroId), side, logit: round(logit, 5), games, known });
    }
  }
  return rows;
}

/** Hero id to display name, read once per call. */
function heroNames(db) {
  return new Map(db.prepare("SELECT hero_id, localized_name FROM heroes").all()
    .map((row) => [Number(row.hero_id), row.localized_name]));
}

function draftNotes(model, heroes) {
  const notes = [];
  const search = Array.isArray(model.validation?.search) ? model.validation.search : [];
  const withPairs = search.find((row) => (row.features?.synergies || 0) > 0);
  const best = search[0];

  if (!Object.keys(model.synergy || {}).length && !Object.keys(model.counters || {}).length) {
    notes.push({
      key: "pairs_rejected",
      text: withPairs && best
        ? "Связки и контрпики в модель не вошли. Их обучали отдельно "
          + `(${counted(withPairs.features.synergies, "связка", "связки", "связок")}, `
          + `${counted(withPairs.features.counters, "контрпик", "контрпика", "контрпиков")}) `
          + "и проверяли на данных, которых модель не видела: "
          + `log loss ${round(withPairs.validation.logLoss)} против ${round(best.validation.logLoss)} у версии без них. `
          + "Хуже — значит это была подгонка под прошлое, а не знание о будущем."
        : "Связок и контрпиков в этой версии модели нет: на проверке они ухудшали прогноз.",
    });
  }
  const unknown = heroes.filter((row) => !row.known);
  if (unknown.length) {
    notes.push({
      key: "unknown_heroes",
      text: `Коэффициент не обучен для: ${unknown.map((row) => row.name).join(", ")} — эти пики прогноз не двигают.`,
    });
  }
  return notes;
}

/**
 * Take a map prediction apart: the rating prior, the side, then the draft.
 *
 * The draft model published here carries hero coefficients and a Radiant bias
 * and nothing else. Synergies and counter-picks were fitted and measured, and
 * they made the forecast worse on data the model had not seen, so they are not
 * in it. That is reported rather than quietly omitted: their absence is a
 * finding, not a gap.
 */
export function explainDraft(db, {
  radiantTeamId, direTeamId, radiantPicks = [], direPicks = [], ratings = null, draftModel = null,
}) {
  const artifact = ratings ?? loadRatings();
  const model = draftModel ?? loadDraftModel();
  const pair = ratingPairProbability(artifact, radiantTeamId, direTeamId);
  const prior = clampProbability(pair.mapProbabilityA);

  const base = {
    scope: "map",
    modelKind: "draft",
    modelId: model?.modelId ?? null,
    priorProbabilityRadiant: round(prior),
    prior: {
      label: "Прогноз по рейтингу до драфта",
      ratingRadiant: round(pair.ratingA ?? 0, 3),
      ratingDire: round(pair.ratingB ?? 0, 3),
      confidence: pair.confidence,
    },
  };

  const complete = radiantPicks.length === 5 && direPicks.length === 5;
  if (!model || !complete) {
    return {
      ...base,
      available: false,
      reason: !model ? "draft_model_unavailable" : "incomplete_picks",
      probabilityRadiant: round(prior),
      draftDelta: 0,
      factors: [],
      heroes: [],
      quality: null,
      notes: [{
        key: "no_draft",
        text: !model
          ? "Модель драфта ещё не обучена, поэтому показан только прогноз по рейтингу."
          : "Драфт не завершён: вклад пиков считается только по полным составам из пяти героев.",
      }],
    };
  }

  const priorLogit = Math.log(prior / (1 - prior));
  const side = Number(model.inference?.radiantBias || 0) / Math.max(0.25, Number(model.inference?.temperature || 1));
  const namesById = heroNames(db);
  const heroes = heroContributions(model, radiantPicks, direPicks);
  const heroLogit = heroes.reduce((sum, row) => sum + row.logit, 0);
  const total = priorLogit + side + heroLogit;

  const detailed = heroes.map((row) => ({
    ...row,
    name: namesById.get(row.heroId) ?? `Герой ${row.heroId}`,
    favours: row.logit > 0 ? "radiant" : row.logit < 0 ? "dire" : "none",
    // Leave-one-out: where the probability would sit without this pick, with
    // the rest of the draft unchanged.
    impact: round(sigmoid(total) - sigmoid(total - row.logit)),
  })).sort((a, b) => Math.abs(b.logit) - Math.abs(a.logit));

  const chain = walk(prior);
  if (Math.abs(side) > 1e-6) {
    chain.add({
      key: "side",
      label: "Сторона карты",
      detail: `Свет выигрывает чуть чаще Тьмы — на обучающих данных ${percent(model.validation?.radiantBaseRate ?? 0.5)}% побед. `
        + `Модель оценила этот перевес в ${round(side, 4)} логита.`,
      to: sigmoid(priorLogit + side),
      logit: side,
    });
  }
  chain.add({
    key: "heroes",
    label: "Герои в драфте",
    detail: `Сумма вкладов десяти пиков — ${round(heroLogit, 4)} логита. `
      + `Каждый герой входит своим коэффициентом, обученным на ${counted(model.dataset?.matches ?? 0, "карте", "картах", "картах")}.`,
    to: sigmoid(total),
    logit: heroLogit,
    evidence: {
      strongestRadiant: detailed.find((row) => row.side === "radiant" && row.logit > 0)?.name ?? null,
      strongestDire: detailed.find((row) => row.side === "dire" && row.logit < 0)?.name ?? null,
      unknownHeroes: detailed.filter((row) => !row.known).length,
    },
  });

  const validation = model.validation ?? null;
  return {
    ...base,
    available: true,
    probabilityRadiant: round(chain.probability),
    draftDelta: round(chain.probability - prior),
    factors: chain.factors,
    heroes: detailed,
    quality: validation ? {
      logLoss: round(validation.holdout?.logLoss ?? 0),
      accuracy: round(validation.holdout?.accuracy ?? 0, 3),
      samples: validation.holdout?.samples ?? 0,
      baselineLogLoss: round(validation.baselineLogLoss ?? 0),
      baselineDescription: validation.baselineDescription ?? null,
      improvementNats: round(validation.improvementNats ?? 0, 5),
    } : null,
    notes: draftNotes(model, detailed),
  };
}
