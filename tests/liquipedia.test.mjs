// Parser tests for the Liquipedia source. Fixtures are trimmed copies of real
// pages, and the one test that does make a request makes it to a local stand-in,
// so none of this touches Liquipedia.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Liquipedia answers a blocked client with an HTML interstitial carrying a 200,
// not with JSON and not with a 429. Standing in for that is the only way to
// test that the client recognises it.
let upstreamRequests = 0;
const upstream = createServer((req, res) => {
  upstreamRequests += 1;
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<!DOCTYPE HTML><title>Rate Limited - Liquipedia</title><h1>Rate Limited</h1>"
    + "<p>Your IP address has been temporarily blocked from accessing Liquipedia.");
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
// A listening socket would hold the process open long after the tests finish.
upstream.unref();

process.env.LIQUIPEDIA_API_URL = `http://127.0.0.1:${upstream.address().port}/api.php`;
process.env.LIQUIPEDIA_CACHE_DIR = mkdtempSync(path.join(tmpdir(), "liquipedia-test-"));

process.on("exit", () => {
  upstream.close();
  try { rmSync(process.env.LIQUIPEDIA_CACHE_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

const {
  editionNumber, editionYear, parseMatchDate,
  parseFormat, parseBracket, parseScheduledMatches, parseParticipants,
  parseTournamentIndex, parseIndexDates, rankCatalog,
  fetchWikitext, cooldownRemainingMs, LiquipediaUnavailable,
} = await import("../server/core/liquipedia.mjs");

const BRACKET_FIXTURE = `
==Playoffs==
{{Bracket|Bracket/8U4L2DSL1D|id=xHpm1txH7L|matchsection=Playoffs

<!-- Upper Bracket Quarterfinals -->
|R1M1={{Match
|opponent1={{TeamOpponent|NAVI}}
|opponent2={{TeamOpponent|Power Rangers}}
|date=September 7, 2026 - 12:00 {{Abbr/EEST}}
|winner=1
|map1={{Map|team1side=|winner=1}}
|map2={{Map|team1side=|winner=1}}
|map3={{Map|team1side=|winner=}}
}}
|R1M2={{Match
|opponent1={{TeamOpponent|MOUZ}}
|opponent2={{TeamOpponent|Team Synapse}}
|date=September 7, 2026 - 15:00 {{Abbr/EEST}}
|winner=2
|map1={{Map|winner=2}}
|map2={{Map|winner=2}}
|map3={{Map|winner=}}
}}
<!-- Lower Bracket Round 1 -->
|R1M5={{Match
|opponent1={{TeamOpponent|HULIGANI}}
|opponent2={{TeamOpponent|Klim Sani4}}
|date=September 8, 2026 - 09:00 {{Abbr/EEST}}
|map1={{Map|winner=}}
|map2={{Map|winner=}}
|map3={{Map|winner=}}
}}
<!-- Grand Final -->
|R5M1={{Match
|opponent1={{TeamOpponent|NAVI}}
|opponent2={{TeamOpponent|Klim Sani4}}
|date=September 10, 2026 - 16:00 {{Abbr/EEST}}
|map1={{Map|winner=}}
|map2={{Map|winner=}}
|map3={{Map|winner=}}
|map4={{Map|winner=}}
|map5={{Map|winner=}}
}}
}}
`;

const FORMAT_FIXTURE = `
==Format==
*'''Group Stage'''
**One modified Swiss-system of sixteen teams
**All matches are {{Abbr/Bo3}}
**{{Bgcolortext|up|Top eight teams}} advance to playoffs
*'''Playoffs'''
**Double-elimination bracket
**Grand Final is {{Abbr/Bo5}}, all other matches are {{Abbr/Bo3}}

==Prize Pool==
`;

test("an edition number is read from however the organiser wrote it", () => {
  assert.equal(editionNumber("PGL Wallachia 2026 Season 9"), 9);
  assert.equal(editionNumber("BLAST Slam VII China Qualifier"), 7, "roman numerals are common in event names");
  assert.equal(editionNumber("1win Essence II"), 2);
  assert.equal(editionYear("PGL Wallachia 2026 Season 9"), 2026);
  assert.equal(editionYear("1win Essence II"), null);
  // A bare year must not be mistaken for an edition number.
  assert.equal(editionNumber("The International 2026"), null);
});

test("a match time is converted from its stated zone, or refused", () => {
  assert.equal(parseMatchDate("September 24, 2026 - 10:00 {{Abbr/EEST}}"), "2026-09-24T07:00:00.000Z");
  assert.equal(parseMatchDate("October 1, 2026 - 18:30 {{Abbr/CEST}}"), "2026-10-01T16:30:00.000Z");
  assert.equal(parseMatchDate("March 3, 2026 - 09:00 {{Abbr/SGT}}"), "2026-03-03T01:00:00.000Z");
  // A time we cannot place is worse than no time: it would freeze a prediction
  // at the wrong moment, so an unknown zone is refused outright.
  assert.equal(parseMatchDate("March 3, 2026 - 09:00 {{Abbr/ZZZ}}"), null);
  assert.equal(parseMatchDate("sometime next week"), null);
  assert.equal(parseMatchDate(null), null);
});

test("the format section becomes stages with their best-of", () => {
  const format = parseFormat(FORMAT_FIXTURE);
  assert.equal(format.stages.length, 2);
  assert.equal(format.stages[0].name, "Group Stage");
  assert.equal(format.stages[0].bestOf, 3);
  assert.match(format.stages[0].rules[0], /Swiss/);
  assert.match(format.stages[0].rules.join(" "), /Top eight teams advance/, "coloured markup must not eat the text");
  assert.equal(format.stages[1].name, "Playoffs");
  assert.equal(format.stages[1].bestOf, 5);
});

test("the bracket keeps its lanes, opponents and real best-of", () => {
  const bracket = parseBracket(BRACKET_FIXTURE);
  assert.equal(bracket.type, "8U4L2DSL1D");

  const byName = Object.fromEntries(bracket.sections.map((section) => [section.name, section]));
  assert.equal(byName["Upper Bracket Quarterfinals"].lane, "upper");
  assert.equal(byName["Lower Bracket Round 1"].lane, "lower");
  assert.equal(byName["Grand Final"].lane, "final");

  const first = byName["Upper Bracket Quarterfinals"].matches[0];
  assert.equal(first.teamA, "NAVI", "the opponent template must be unwrapped, not printed raw");
  assert.equal(first.teamB, "Power Rangers");
  assert.equal(first.winner, 1);
  // Nested Map templates belong to their own match; counting across neighbours
  // used to produce nonsense like Bo14.
  assert.equal(first.bestOf, 3);
  assert.equal(byName["Grand Final"].matches[0].bestOf, 5);
  assert.equal(byName["Grand Final"].matches[0].winner, null, "an unplayed match has no winner");
});

test("scheduled matches are deduplicated and carry a usable time", () => {
  const schedule = parseScheduledMatches(BRACKET_FIXTURE);
  assert.equal(schedule.length, 4);
  for (const row of schedule) {
    assert.ok(row.startTime, "a row without a time is not a schedule entry");
    assert.ok(row.teamA && row.teamB);
    assert.doesNotMatch(row.teamA, /\{\{/, "markup must never reach the caller");
  }
  assert.equal(schedule[0].startTime, "2026-09-07T09:00:00.000Z");

  // The same match appears in both a match list and the bracket on real pages.
  const doubled = parseScheduledMatches(BRACKET_FIXTURE + BRACKET_FIXTURE);
  assert.equal(doubled.length, 4);
});

test("participants are collected from opponents and cards alike", () => {
  const names = parseParticipants(BRACKET_FIXTURE);
  for (const expected of ["NAVI", "Power Rangers", "MOUZ", "Klim Sani4"]) {
    assert.ok(names.includes(expected), `${expected} must be listed`);
  }
});

test("a page without a bracket or format is reported as absent, not guessed", () => {
  assert.equal(parseBracket("==Overview==\nnothing here"), null);
  assert.equal(parseFormat("==Overview==\nnothing here"), null);
  assert.deepEqual(parseScheduledMatches(""), []);
});

// --- name matching and page selection ---------------------------------------

const { matchTeamName, normaliseTeamName } = await import("../server/jobs/sync-structure.mjs");

const LEAGUE_TEAMS = [
  { team_id: 36, name: "Natus Vincere", tag: null },
  { team_id: 10150633, name: "Pipsqueak + 4", tag: null },
  { team_id: 9338413, name: "MOUZ", tag: null },
  { team_id: 10182357, name: "1w", tag: null },
  { team_id: 9964962, name: "GamerLegion", tag: null },
  { team_id: 10261180, name: "Conventus Stellarum", tag: null },
];

test("a Liquipedia team name is matched against the league's own teams", () => {
  // Punctuation and spacing differ constantly between the two sources.
  assert.equal(matchTeamName("Pipsqueak+4", LEAGUE_TEAMS)?.team_id, 10150633);
  assert.equal(matchTeamName("MOUZ", LEAGUE_TEAMS)?.team_id, 9338413);
  assert.equal(matchTeamName("1w Team", LEAGUE_TEAMS)?.team_id, 10182357);
  assert.equal(matchTeamName("Conventus Stellarum", LEAGUE_TEAMS)?.team_id, 10261180);
  // An acronym normalisation cannot bridge is handled by the alias list.
  assert.equal(matchTeamName("NAVI", LEAGUE_TEAMS)?.team_id, 36);
  assert.equal(normaliseTeamName("NAVI"), normaliseTeamName("Natus Vincere"));
});

test("an unknown team is refused rather than matched to the nearest name", () => {
  // A wrong team id would attach a prediction to the wrong side, which is worse
  // than having no id at all.
  assert.equal(matchTeamName("Team Spirit", LEAGUE_TEAMS), null);
  assert.equal(matchTeamName("", LEAGUE_TEAMS), null);
  assert.equal(matchTeamName("zzzz", LEAGUE_TEAMS), null);
});

// --- the tournament catalog -------------------------------------------------

// One row of a rendered tier index page, with Liquipedia's own entity encoding
// of the class names left intact — that encoding is why a naive parser reads
// nothing at all.
const INDEX_FIXTURE = `<div class="table2 table2--generic tournaments-listing"><div class="table2&#95;&#95;container"><table class="table2&#95;&#95;table"><tbody>
<tr class="table2&#95;&#95;row--head"><th colspan="2">Tournament</th><th>Date</th><th>Prize&#160;Pool</th></tr>
<tr class="table2&#95;&#95;row--body"><td data-sort-value="PGL Wallachia Season 8"><span class="league-icon-small-image"><a href="/dota2/PGL/Wallachia/8"><img alt="x" /></a></span></td><td class="column&#95;&#95;tournament" data-sort-value="PGL Wallachia Season 8"><a href="/dota2/PGL/Wallachia/8" title="PGL/Wallachia/8">PGL Wallachia Season 8</a></td><td data-nowrap="">Apr 18&#8211;26, 2026</td><td>$1,000,000</td></tr>
<tr class="table2&#95;&#95;row--body"><td data-sort-value="RES"><span><a href="/dota2/BLAST/SLAM/9/Europe"><img alt="x" /></a></span></td><td class="column&#95;&#95;tournament" data-nowrap="" data-sort-value="RES"><a href="/dota2/BLAST/SLAM/9/Europe" title="BLAST/SLAM/9/Europe">RES Unchained 6: BLAST SLAM IX Europe Closed Qualifier</a></td><td data-nowrap="">Sep 12&#8211;13, 2026</td><td>-</td></tr>
<tr class="table2&#95;&#95;row--body"><td data-sort-value="BLAST SLAM IX"><span><a href="/dota2/BLAST/SLAM/9"><img alt="x" /></a></span></td><td class="column&#95;&#95;tournament" data-sort-value="BLAST SLAM IX"><a href="/dota2/BLAST/SLAM/9" title="BLAST/SLAM/9">BLAST SLAM IX</a></td><td data-nowrap="">Nov 20&#8211;29, 2026</td><td>$1,000,000</td></tr>
</tbody></table></div></div>`;

const day = (year, month, date) => Math.floor(Date.UTC(year, month - 1, date) / 1000);

test("index dates cover every shape the tier tables use", () => {
  assert.deepEqual(parseIndexDates("Sep 10, 2026"), { startTime: day(2026, 9, 10), endTime: day(2026, 9, 10) });
  // A range that states its month once: the far side borrows it.
  assert.deepEqual(parseIndexDates("Oct 19–31, 2027"), { startTime: day(2027, 10, 19), endTime: day(2027, 10, 31) });
  // Two months, one year.
  assert.deepEqual(parseIndexDates("Apr 26 – May 09, 2027"), { startTime: day(2027, 4, 26), endTime: day(2027, 5, 9) });
  // Two months and two years, across new year.
  assert.deepEqual(parseIndexDates("Dec 30, 2025 – Jan 05, 2026"), { startTime: day(2025, 12, 30), endTime: day(2026, 1, 5) });
  // Nothing usable rather than a guess.
  assert.deepEqual(parseIndexDates("TBD"), { startTime: null, endTime: null });
  assert.deepEqual(parseIndexDates("Oct 2026"), { startTime: null, endTime: null });
});

test("a rendered index page yields page titles, names and dates", () => {
  const entries = parseTournamentIndex(INDEX_FIXTURE);
  assert.equal(entries.length, 3);

  const wallachia = entries.find((entry) => entry.page === "PGL/Wallachia/8");
  assert.equal(wallachia.name, "PGL Wallachia Season 8");
  assert.equal(wallachia.startTime, day(2026, 4, 18));
  assert.equal(wallachia.endTime, day(2026, 4, 26));

  // The header row is not a tournament, and the icon cell's link must not be
  // mistaken for the name cell's.
  assert.ok(!entries.some((entry) => entry.name === "Tournament"));
  assert.equal(entries.filter((entry) => entry.page === "BLAST/SLAM/9/Europe").length, 1);
});

test("catalog lookup finds pages whose titles the name never suggests", () => {
  const entries = parseTournamentIndex(INDEX_FIXTURE);

  // OpenDota truncates this name, and nothing in it hints at `BLAST/SLAM/9/...`.
  const quali = rankCatalog("RES Unchained - A Blast Dota Slam IX Quali",
    { entries, startTime: day(2026, 9, 12) });
  assert.equal(quali[0].page, "BLAST/SLAM/9/Europe");

  // The main event shares three words with its qualifier; the rare ones decide.
  const main = rankCatalog("BLAST Slam IX", { entries, startTime: day(2026, 11, 21) });
  assert.equal(main[0].page, "BLAST/SLAM/9");

  // The calendar is part of the score: the same page rates lower when the
  // tournament we are placing was played nowhere near it.
  const offDate = rankCatalog("BLAST Slam IX", { entries, startTime: day(2026, 9, 12) });
  const scoreOf = (hits) => hits.find((hit) => hit.page === "BLAST/SLAM/9")?.score ?? 0;
  assert.ok(scoreOf(offDate) < scoreOf(main));
  // And on that date the qualifier, not the main event, is the better guess.
  assert.equal(offDate[0].page, "BLAST/SLAM/9/Europe");

  // A tournament Liquipedia does not list gets no candidates, not a wrong one.
  assert.deepEqual(rankCatalog("肛宝联赛-老婆杯", { entries, startTime: day(2026, 9, 15) }), []);
});

test("roman numerals and arabic seasons are the same edition", () => {
  const entries = parseTournamentIndex(INDEX_FIXTURE);
  // "Season 9" must reach a page Liquipedia titled "IX".
  const hits = rankCatalog("BLAST Slam Season 9", { entries, startTime: day(2026, 11, 21) });
  assert.equal(hits[0].page, "BLAST/SLAM/9");
});

// --- behaving when the source says stop -------------------------------------

test("a block is recognised as one and stops the client asking again", async () => {
  assert.equal(cooldownRemainingMs(), 0, "nothing should be cooling down yet");

  // The block arrives as HTML with a 200. Parsing it as JSON throws a
  // SyntaxError that no caller expects, so the client has to spot it first.
  await assert.rejects(
    () => fetchWikitext("Any Page"),
    (error) => error instanceof LiquipediaUnavailable && /rate_limited/.test(error.message),
  );
  assert.equal(upstreamRequests, 1);
  assert.ok(cooldownRemainingMs() > 0, "being blocked has to be remembered");

  // Liquipedia warns that repeatedly tripping their limiter makes the block
  // permanent, so while cooling down nothing is asked of them at all.
  await assert.rejects(
    () => fetchWikitext("Another Page"),
    (error) => error instanceof LiquipediaUnavailable && /cooling_down/.test(error.message),
  );
  assert.equal(upstreamRequests, 1, "a cooling-down client must send no requests");
});

// --- group rounds -----------------------------------------------------------

const ROUNDS_FIXTURE = `
==Group Stage==
===Round 1===
{{Match
|opponent1={{TeamOpponent|NAVI}}
|opponent2={{TeamOpponent|MOUZ}}
|date=September 18, 2026 - 12:00 {{Abbr/EEST}}
|winner=1
|map1={{Map|winner=1}}
|map2={{Map|winner=1}}
}}
===Round 2===
{{Matchlist|id=xY|title=Round 2
|M1={{Match
|opponent1={{TeamOpponent|Aurora}}
|opponent2={{TeamOpponent|LGD}}
|date=September 19, 2026 - 12:00 {{Abbr/EEST}}
|map1={{Map|winner=2}}
}}
|M2={{Match
|opponent1={{TeamOpponent|Xtreme}}
|opponent2={{TeamOpponent|Hokori}}
|date=September 19, 2026 - 15:00 {{Abbr/EEST}}
|map1={{Map|winner=1}}
}}
}}
==Playoffs==
{{Match
|opponent1={{TeamOpponent|NAVI}}
|opponent2={{TeamOpponent|Aurora}}
|date=September 24, 2026 - 10:00 {{Abbr/EEST}}
|map1={{Map|winner=}}
}}
`;

test("a group match carries the round it was published under", () => {
  const schedule = parseScheduledMatches(ROUNDS_FIXTURE);
  const byTeams = new Map(schedule.map((row) => [`${row.teamA}|${row.teamB}`, row]));

  // Straight from the section heading.
  assert.equal(byTeams.get("NAVI|MOUZ").round, 1);
  // And from a match list's own title, for the matches inside it.
  assert.equal(byTeams.get("Aurora|LGD").round, 2);
  assert.equal(byTeams.get("Xtreme|Hokori").round, 2);
  // A section that names no round must not inherit the previous one: these
  // fixtures are playoff matches and belong to no group round at all.
  assert.equal(byTeams.get("NAVI|Aurora").round, null);
});

test("the bracket keeps carrying slots rather than rounds", () => {
  // Round tracking must not disturb what the bracket parser already reads.
  for (const row of parseScheduledMatches(BRACKET_FIXTURE)) {
    assert.equal(row.round, null, "a bracket match is identified by its slot");
  }
  assert.equal(parseBracket(BRACKET_FIXTURE).type, "8U4L2DSL1D");
});
