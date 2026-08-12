import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const API = process.env.OPENDOTA_API_URL || "https://api.opendota.com/api";
const OUTPUT_DIR = path.resolve(process.env.DRAFT_BULK_DIR || path.join(ROOT, "work", "opendota-bulk", "shards"));
const STATE_FILE = path.resolve(process.env.DRAFT_BULK_STATE || path.join(ROOT, "work", "opendota-bulk", "state.json"));
const WINDOW_YEARS = Math.max(.25, Number(process.env.DRAFT_RESEARCH_WINDOW_YEARS || 2));
const EXPLICIT_END_TIME = process.env.DRAFT_RESEARCH_END ? Math.floor(Date.parse(process.env.DRAFT_RESEARCH_END) / 1000) : null;
const EXPLICIT_START_TIME = process.env.DRAFT_RESEARCH_START ? Math.floor(Date.parse(process.env.DRAFT_RESEARCH_START) / 1000) : null;
let END_TIME;
let START_TIME;
const PAGE_MATCHES = Math.max(25, Math.min(1500, Number(process.env.DRAFT_BULK_PAGE_MATCHES || 500)));
const MAX_PAGES = Math.max(1, Number(process.env.DRAFT_BULK_MAX_PAGES || 20));
const REQUEST_GAP_MS = Math.max(1000, Number(process.env.OPENDOTA_REQUEST_GAP_MS || 1500));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function optionalJson(file, fallback) { try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; } }
async function atomicJson(file, value) { const temporary = `${file}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`); await rename(temporary, file); }

let nextRequestAt = 0;
async function apiJson(endpoint, timeout = 90_000) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const wait = Math.max(0, nextRequestAt - Date.now()); if (wait) await sleep(wait);
    nextRequestAt = Date.now() + REQUEST_GAP_MS;
    try {
      const response = await fetch(`${API}${endpoint}`, { headers: { "user-agent": "TI26Predictor/0.8 (two-year reproducible pro research)" }, signal: AbortSignal.timeout(timeout) });
      if (response.ok) return response.json();
      if (response.status < 500 && response.status !== 429) throw new Error(`OpenDota HTTP ${response.status}`);
    } catch (error) { if (attempt === 5) throw error; }
    await sleep(1500 * 2 ** attempt);
  }
  throw new Error("OpenDota retry limit reached");
}

function explorerSql(cursor) {
  const cursorFilter = cursor ? `AND m.match_id < ${Number(cursor)}` : "";
  return `SELECT page.match_id,page.start_time,page.leagueid,page.radiant_team_id,page.dire_team_id,page.radiant_win,page.duration,page.series_id,page.patch,pm.account_id,pm.hero_id,pm.player_slot,pm.lane_role
FROM (
  SELECT m.match_id,m.start_time,m.leagueid,m.radiant_team_id,m.dire_team_id,m.radiant_win,m.duration,m.series_id,mp.patch
  FROM matches m JOIN match_patch mp USING(match_id)
  WHERE m.start_time >= ${START_TIME} AND m.start_time < ${END_TIME} ${cursorFilter}
  ORDER BY m.match_id DESC LIMIT ${PAGE_MATCHES}
) page JOIN player_matches pm USING(match_id)
ORDER BY page.match_id DESC,pm.player_slot`;
}

function normalizeRows(rows, patchIds) {
  const matches = new Map();
  for (const row of rows ?? []) {
    const id = Number(row.match_id); const match = matches.get(id) ?? {
      match_id: id, start_time: Number(row.start_time), leagueid: Number(row.leagueid || 0),
      radiant_team_id: Number(row.radiant_team_id || 0), dire_team_id: Number(row.dire_team_id || 0),
      radiant_win: Boolean(row.radiant_win), duration: Number(row.duration || 0), series_id: Number(row.series_id || 0) || null,
      patch: patchIds.get(String(row.patch)) ?? null, patch_name: String(row.patch),
      data_source: "opendota_explorer_pro_bulk", players: [],
    };
    match.players.push({ account_id: Number(row.account_id || 0), hero_id: Number(row.hero_id || 0), player_slot: Number(row.player_slot), lane_role: Number(row.lane_role || 0) });
    matches.set(id, match);
  }
  return [...matches.values()].filter((match) => Number.isInteger(match.patch) && match.players.length === 10 && new Set(match.players.map((player) => player.hero_id)).size === 10);
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const savedState = await optionalJson(STATE_FILE, null);
  END_TIME = EXPLICIT_END_TIME ?? Number(savedState?.windowEnd || Math.floor(Date.now() / 1000));
  START_TIME = EXPLICIT_START_TIME ?? Number(savedState?.windowStart || Math.floor(END_TIME - WINDOW_YEARS * 365.2425 * 86400));
  const rawPatches = await apiJson("/constants/patch");
  const patchIds = new Map((Array.isArray(rawPatches) ? rawPatches : []).map((patch) => [String(patch.name), Number(patch.id)]));
  const state = savedState ?? { schemaVersion: 1, cursor: null, maps: 0, pages: 0, complete: false };
  if (state.windowStart !== START_TIME || state.windowEnd !== END_TIME) Object.assign(state, { schemaVersion: 1, cursor: null, maps: 0, pages: 0, complete: false, windowStart: START_TIME, windowEnd: END_TIME });
  let collected = 0; let pages = 0;
  while (!state.complete && pages < MAX_PAGES) {
    const sql = explorerSql(state.cursor); const response = await apiJson(`/explorer?sql=${encodeURIComponent(sql)}`);
    const matches = normalizeRows(response.rows, patchIds);
    if (!matches.length) { state.complete = true; break; }
    const newest = matches[0].match_id; const oldest = matches.at(-1).match_id;
    const shard = path.join(OUTPUT_DIR, `${newest}-${oldest}.jsonl`);
    await writeFile(shard, `${matches.map((match) => JSON.stringify(match)).join("\n")}\n`);
    state.cursor = oldest; state.maps += matches.length; state.pages += 1; state.updatedAt = new Date().toISOString();
    state.lastPage = { newest, oldest, maps: matches.length, rows: response.rowCount ?? response.rows?.length ?? 0 };
    collected += matches.length; pages += 1;
    if (matches.at(-1).start_time <= START_TIME || matches.length < PAGE_MATCHES) state.complete = true;
    await atomicJson(STATE_FILE, state);
    process.stdout.write(`Bulk pro history: +${collected} maps this run, cursor ${oldest}, ${new Date(matches.at(-1).start_time * 1000).toISOString().slice(0, 10)}\n`);
  }
  state.updatedAt = new Date().toISOString(); await atomicJson(STATE_FILE, state);
  console.log(`Bulk collection ${state.complete ? "complete" : "checkpointed"}: ${state.maps} maps in ${state.pages} shards for ${new Date(START_TIME * 1000).toISOString().slice(0, 10)}..${new Date(END_TIME * 1000).toISOString().slice(0, 10)}.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
