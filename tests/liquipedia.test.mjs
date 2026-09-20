// Parser tests for the Liquipedia source. Fixtures are trimmed copies of real
// pages, so none of this touches the network.
import test from "node:test";
import assert from "node:assert/strict";

const {
  editionNumber, editionYear, parseMatchDate,
  parseFormat, parseBracket, parseScheduledMatches, parseParticipants,
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
