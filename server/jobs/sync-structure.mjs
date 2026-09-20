// Pull each tracked tournament's format, bracket and schedule from Liquipedia
// and store them next to the results we already have.
//
// Name matching is scoped to the teams that actually played in the league, so
// "NAVI" only ever has to be told apart from fifteen other names rather than
// from every organisation in Dota.
import { nowIso } from "../core/db.mjs";
import {
  candidateTitles, fetchWikitext, parseTournamentPage, LiquipediaUnavailable,
  fetchTournamentCatalog, rankCatalog,
} from "../core/liquipedia.mjs";

const STRUCTURE_TTL_MS = Math.max(60 * 60_000, Number(process.env.STRUCTURE_TTL_HOURS || 6) * 60 * 60_000);
const MIN_PARTICIPANT_MATCHES = Math.max(2, Number(process.env.STRUCTURE_MIN_MATCHES || 3));

// Acronyms normalisation cannot bridge. Deliberately short: anything that can
// be matched by shape should be, not by a list somebody has to maintain.
const ALIASES = new Map(Object.entries({
  navi: "natusvincere",
  nv: "natusvincere",
  tl: "teamliquid",
  og: "og",
  vp: "virtuspro",
  eg: "evilgeniuses",
  lgd: "lgdgaming",
  xg: "xtremegaming",
  bb: "betboomteam",
  ts: "teamspirit",
  gl: "gamerlegion",
  tsm: "tsm",
}));

export const normaliseTeamName = (value) => {
  const base = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return ALIASES.get(base) ?? base;
};

// Organisation words the two sources disagree about constantly: one writes
// "1w", the other "1w Team"; one "Liquid", the other "Team Liquid".
const ORG_WORDS = /\b(?:team|esports|e-?sports|gaming|club|org|gg|dota|dota2)\b/gi;

/** The name with organisation words removed, when anything is left. */
const coreTeamName = (value) => {
  const stripped = String(value || "").replace(ORG_WORDS, " ");
  const core = normaliseTeamName(stripped);
  return core.length >= 2 ? core : normaliseTeamName(value);
};

function trigrams(value) {
  const padded = `  ${value} `;
  const result = new Set();
  for (let index = 0; index < padded.length - 2; index += 1) result.add(padded.slice(index, index + 3));
  return result;
}

/** Dice coefficient over character trigrams: tolerant of spacing and suffixes. */
function similarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const a = trigrams(left);
  const b = trigrams(right);
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/**
 * Best match for one Liquipedia team name among the league's own teams.
 * Returns null rather than a doubtful guess: a wrong team id would attach a
 * prediction to the wrong side.
 */
export function matchTeamName(name, candidates, { threshold = 0.62 } = {}) {
  const target = normaliseTeamName(name);
  const targetCore = coreTeamName(name);
  if (!target) return null;

  let best = null;
  for (const candidate of candidates) {
    for (const field of [candidate.name, candidate.tag]) {
      if (!field) continue;
      const normalised = normaliseTeamName(field);
      const core = coreTeamName(field);
      if (!normalised) continue;

      let score;
      if (normalised === target || core === targetCore) {
        score = 1;
      } else if (Math.min(core.length, targetCore.length) <= 3) {
        // A two or three character name carries too little signal for fuzzy
        // comparison: "1w" and "1win" are different organisations.
        score = 0;
      } else if (core.startsWith(targetCore) || targetCore.startsWith(core)) {
        score = 0.9;
      } else {
        score = Math.max(similarity(target, normalised), similarity(targetCore, core));
      }
      if (!best || score > best.score) best = { team: candidate, score };
    }
  }
  return best && best.score >= threshold ? best.team : null;
}

/** Teams that actually played in this league. */
function leagueTeams(db, leagueId) {
  return db.prepare(`SELECT team_id, name, tag FROM teams WHERE team_id IN (
      SELECT radiant_team_id FROM maps WHERE league_id = ? AND radiant_team_id > 0
      UNION SELECT dire_team_id FROM maps WHERE league_id = ? AND dire_team_id > 0)`)
    .all(leagueId, leagueId);
}

/**
 * Find the Liquipedia page for a tournament and prove it is the right one by
 * checking that its participants are the teams we have seen play there.
 */
const DAY_SECONDS = 86_400;

/** Earliest and latest match time a parsed page mentions, in unix seconds. */
function pageWindow(parsed) {
  const times = [...(parsed.schedule ?? []), ...(parsed.bracket?.matches ?? [])]
    .map((row) => Date.parse(row.startTime || ""))
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.floor(value / 1000));
  return times.length ? { from: Math.min(...times), to: Math.max(...times) } : null;
}

/**
 * How well a page's dates line up with when this tournament was actually
 * played. Successive seasons of one event share most of their teams, so
 * participants alone cannot tell Masters 1 from Masters 2 — the calendar can.
 */
function dateScore(tournament, parsed) {
  const ours = { from: Number(tournament.start_time || 0), to: Number(tournament.last_match_time || 0) };
  const theirs = pageWindow(parsed);
  if (!theirs || !ours.from || !ours.to) return { score: 0, overlap: null };
  const overlap = Math.min(ours.to, theirs.to) - Math.max(ours.from, theirs.from);
  if (overlap >= 0) return { score: 40, overlap: Math.round(overlap / DAY_SECONDS) };
  const gapDays = Math.round(-overlap / DAY_SECONDS);
  if (gapDays <= 14) return { score: 15, overlap: -gapDays };
  return { score: -30, overlap: -gapDays };
}

// A catalog hit this good needs no help: nearly every distinctive word in the
// name matched and the dates line up.
const CATALOG_CONFIDENT = Number(process.env.STRUCTURE_CATALOG_CONFIDENT || 0.8);

/**
 * Pages worth checking for this tournament.
 *
 * The catalog is asked first because it knows the real titles; guessing from
 * the name is only a fallback for events the index pages have not listed yet,
 * such as one that is running right now.
 */
export async function candidatePages(tournament, { catalog = null } = {}) {
  const titles = [];
  let fromCatalog = [];
  try {
    const source = catalog ?? await fetchTournamentCatalog();
    fromCatalog = rankCatalog(tournament.name, {
      entries: source?.entries ?? [],
      startTime: Number(tournament.start_time || 0) || null,
    });
    for (const hit of fromCatalog) titles.push(hit.page);
  } catch (error) {
    if (!(error instanceof LiquipediaUnavailable)) throw error;
  }

  if (!fromCatalog.length || fromCatalog[0].score < CATALOG_CONFIDENT) {
    try {
      for (const title of await candidateTitles(tournament.name)) titles.push(title);
    } catch (error) {
      if (!(error instanceof LiquipediaUnavailable)) throw error;
    }
  }
  return { titles: [...new Set(titles)].slice(0, 8), catalogHits: fromCatalog.length };
}

export async function resolvePage(db, tournament, { catalog = null } = {}) {
  const teams = leagueTeams(db, tournament.league_id);
  if (teams.length < MIN_PARTICIPANT_MATCHES) {
    return { page: null, reason: "too_few_known_teams" };
  }
  const { titles, catalogHits } = await candidatePages(tournament, { catalog });
  const tried = [];
  let best = null;

  for (const title of titles) {
    let wikitext;
    try {
      wikitext = await fetchWikitext(title);
    } catch (error) {
      if (error instanceof LiquipediaUnavailable) break;
      throw error;
    }
    if (!wikitext) { tried.push({ title, reason: "missing" }); continue; }
    const parsed = parseTournamentPage(wikitext);
    const matched = parsed.participants.filter((name) => matchTeamName(name, teams)).length;
    const dates = dateScore(tournament, parsed);
    const score = matched * 5 + dates.score;
    tried.push({ title, matched, participants: parsed.participants.length, overlapDays: dates.overlap, score });

    if (matched >= MIN_PARTICIPANT_MATCHES && (!best || score > best.score)) {
      best = { page: title, wikitext, parsed, matched, score, overlapDays: dates.overlap };
    }
  }
  // Every candidate is scored rather than stopping at the first acceptable one:
  // successive seasons of an event share teams, so an earlier season can clear
  // the bar while a later one fits the calendar better.

  if (best) return { ...best, tried, catalogHits };
  return { page: null, reason: tried.length ? "no_page_matched_participants" : "no_candidates", tried, catalogHits };
}

function storeSchedule(db, leagueId, parsed, teams) {
  const at = nowIso();
  const rows = [];

  // Bracket slots are stored even while their opponents are unknown: the slot,
  // its round and its date are what let the site draw the bracket before the
  // playoffs start, and the names fill in as teams qualify.
  for (const section of parsed.bracket?.sections ?? []) {
    for (const match of section.matches) {
      rows.push({ ...match, stage: section.name, lane: section.lane, key: `bracket:${match.slot}` });
    }
  }
  for (const match of parsed.schedule) {
    // Bracket rows already cover their own matches; this adds group-stage ones.
    const key = `time:${match.startTime}:${[match.teamA, match.teamB].map(normaliseTeamName).sort().join("|")}`;
    if (rows.some((row) => row.startTime === match.startTime
      && normaliseTeamName(row.teamA) === normaliseTeamName(match.teamA)
      && normaliseTeamName(row.teamB) === normaliseTeamName(match.teamB))) continue;
    rows.push({ ...match, stage: "Group Stage", lane: "group", slot: null, key });
  }

  const insert = db.prepare(`INSERT INTO scheduled_matches(league_id, source, external_key, slot, stage, lane,
      team_a_name, team_b_name, team_a_id, team_b_id, best_of, start_time, winner_slot, updated_at)
    VALUES(?, 'liquipedia', ?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(league_id, source, external_key) DO UPDATE SET
      stage=excluded.stage, lane=excluded.lane,
      team_a_name=excluded.team_a_name, team_b_name=excluded.team_b_name,
      team_a_id=COALESCE(excluded.team_a_id, scheduled_matches.team_a_id),
      team_b_id=COALESCE(excluded.team_b_id, scheduled_matches.team_b_id),
      best_of=COALESCE(excluded.best_of, scheduled_matches.best_of),
      start_time=excluded.start_time, winner_slot=excluded.winner_slot,
      updated_at=excluded.updated_at`);

  let stored = 0;
  let resolved = 0;
  for (const row of rows) {
    const teamA = row.teamA ? matchTeamName(row.teamA, teams) : null;
    const teamB = row.teamB ? matchTeamName(row.teamB, teams) : null;
    if (teamA && teamB) resolved += 1;
    insert.run(leagueId, row.key, row.slot ?? null, row.stage ?? null, row.lane ?? null,
      row.teamA ?? null, row.teamB ?? null, teamA?.team_id ?? null, teamB?.team_id ?? null,
      row.bestOf ?? null, row.startTime ? Math.floor(Date.parse(row.startTime) / 1000) : null,
      row.winner ?? null, at);
    stored += 1;
  }
  return { stored, resolved };
}

/** Fetch and store one tournament's structure. Skipped while still fresh. */
export async function syncTournamentStructure(db, leagueId, { force = false, catalog = null } = {}) {
  const tournament = db.prepare("SELECT * FROM tournaments WHERE league_id = ?").get(leagueId);
  if (!tournament) return { leagueId, skipped: true, reason: "unknown_tournament" };

  const syncedAt = Date.parse(tournament.structure_synced_at || "");
  if (!force && Number.isFinite(syncedAt) && Date.now() - syncedAt < STRUCTURE_TTL_MS) {
    return { leagueId, skipped: true, reason: "fresh" };
  }

  let page = tournament.liquipedia_page;
  let parsed = null;
  if (page) {
    const wikitext = await fetchWikitext(page, { maxAgeMs: force ? 0 : undefined });
    parsed = wikitext ? parseTournamentPage(wikitext) : null;
    if (!parsed) page = null;
  }
  if (!page) {
    const resolution = await resolvePage(db, tournament, { catalog });
    if (!resolution.page) {
      // Remember the attempt so a tournament with no page is not retried on
      // every pass; it will be looked at again once the TTL expires.
      db.prepare("UPDATE tournaments SET structure_synced_at = ?, structure_source = ? WHERE league_id = ?")
        .run(nowIso(), `none:${resolution.reason}`, leagueId);
      return { leagueId, page: null, reason: resolution.reason, tried: resolution.tried?.length ?? 0 };
    }
    page = resolution.page;
    parsed = resolution.parsed;
  }

  const teams = leagueTeams(db, leagueId);
  const schedule = storeSchedule(db, leagueId, parsed, teams);
  const format = parsed.format
    ? { stages: parsed.format.stages, bestOf: parsed.format.bestOf, bracketType: parsed.bracket?.type ?? null }
    : (parsed.bracket ? { stages: [], bracketType: parsed.bracket.type } : null);

  db.prepare(`UPDATE tournaments SET liquipedia_page = ?, format_json = ?, structure_synced_at = ?,
              structure_source = 'liquipedia', updated_at = ? WHERE league_id = ?`)
    .run(page, format ? JSON.stringify(format) : null, nowIso(), nowIso(), leagueId);

  return {
    leagueId, page,
    stages: format?.stages?.length ?? 0,
    bracketType: parsed.bracket?.type ?? null,
    bracketMatches: parsed.bracket?.matches.length ?? 0,
    ...schedule,
  };
}

/** Scheduler entry: refresh the structure of every running tournament. */
export async function syncActiveStructures(db, { force = false, limit = Number(process.env.STRUCTURE_MAX_LEAGUES || 8) } = {}) {
  const leagues = db.prepare(`SELECT league_id FROM tournaments
                              WHERE tracked = 1 AND status = 'live' AND map_count > 0
                              ORDER BY last_match_time DESC LIMIT ?`).all(limit);
  // Fetched once for the whole pass: it is the same catalog for every league.
  let catalog = null;
  try {
    catalog = await fetchTournamentCatalog();
  } catch (error) {
    if (!(error instanceof LiquipediaUnavailable)) throw error;
  }

  const results = [];
  for (const row of leagues) {
    try {
      results.push(await syncTournamentStructure(db, Number(row.league_id), { force, catalog }));
    } catch (error) {
      if (error instanceof LiquipediaUnavailable) {
        results.push({ leagueId: Number(row.league_id), error: error.message });
        break; // the source is unhappy; stop asking it this pass
      }
      results.push({ leagueId: Number(row.league_id), error: String(error?.message || error) });
    }
  }
  return {
    leagues: leagues.length,
    withPage: results.filter((row) => row.page).length,
    catalogEntries: catalog?.entries?.length ?? 0,
    results,
  };
}

/** Scheduled matches of one league, upcoming first. */
export function scheduledMatches(db, leagueId) {
  return db.prepare(`SELECT * FROM scheduled_matches WHERE league_id = ? ORDER BY COALESCE(start_time, 0) ASC`)
    .all(leagueId);
}
