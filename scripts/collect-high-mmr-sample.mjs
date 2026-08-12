import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const API = process.env.OPENDOTA_API_URL || "https://api.opendota.com/api";
const API_KEY = process.env.OPENDOTA_API_KEY || "";
const OUTPUT_DIR = path.join(ROOT, "work", "high-mmr-cache", "matches");
const STATE_FILE = path.join(ROOT, "work", "high-mmr-cache", "state.json");
const MAX_PAGES = Math.max(1, Number(process.env.DRAFT_HIGH_MMR_PAGES || 20));
const MIN_AVG_MMR = Math.max(0, Number(process.env.DRAFT_HIGH_MMR_MIN_AVG_MMR || 6500));
const MIN_AVG_RANK_TIER = Math.max(0, Number(process.env.DRAFT_HIGH_MMR_MIN_RANK_TIER || 80));
const REQUEST_GAP_MS = Math.max(250, Number(process.env.OPENDOTA_REQUEST_GAP_MS || 1100));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let nextRequestAt = 0;

async function optionalJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

async function atomicJson(file, value) {
  const temporary = `${file}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`); await rename(temporary, file);
}

function endpointUrl(endpoint) {
  if (!API_KEY) return `${API}${endpoint}`;
  return `${API}${endpoint}${endpoint.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(API_KEY)}`;
}

async function apiJson(endpoint) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const delay = Math.max(0, nextRequestAt - Date.now()); if (delay) await sleep(delay); nextRequestAt = Date.now() + REQUEST_GAP_MS;
    try {
      const response = await fetch(endpointUrl(endpoint), { headers: { "user-agent": "TI26Predictor/0.6 (high-mmr research sample)" }, signal: AbortSignal.timeout(30_000) });
      if (response.ok) return response.json();
      if (response.status !== 429 && response.status < 500) throw new Error(`OpenDota HTTP ${response.status}`);
    } catch (error) { if (attempt === 5) throw error; }
    await sleep(1000 * 2 ** attempt);
  }
  throw new Error(`OpenDota retry limit reached for ${endpoint}`);
}

function patchForTimestamp(patches, timestamp) {
  let selected = null;
  for (const patch of patches) if (patch.timestamp <= timestamp && (!selected || patch.timestamp > selected.timestamp)) selected = patch;
  return selected?.id ?? null;
}

function normalizedMatch(row, patchId) {
  const radiant = (row.radiant_team ?? []).map(Number).filter(Boolean); const dire = (row.dire_team ?? []).map(Number).filter(Boolean);
  if (radiant.length !== 5 || dire.length !== 5 || new Set([...radiant, ...dire]).size !== 10) return null;
  return {
    match_id: Number(row.match_id), patch: patchId, start_time: Number(row.start_time), duration: Number(row.duration || 0), radiant_win: Boolean(row.radiant_win),
    leagueid: 0, radiant_team_id: 0, dire_team_id: 0, game_mode: Number(row.game_mode || 0), lobby_type: Number(row.lobby_type || 0), avg_mmr: Number(row.avg_mmr || 0), avg_rank_tier: Number(row.avg_rank_tier || 0), num_mmr: Number(row.num_mmr || 0),
    data_source: "opendota_public_matches_high_mmr", picks_bans: [],
    players: [...radiant.map((heroId, slot) => ({ player_slot: slot, hero_id: heroId, account_id: 0, position_est: 0 })), ...dire.map((heroId, slot) => ({ player_slot: 128 + slot, hero_id: heroId, account_id: 0, position_est: 0 }))],
  };
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const state = await optionalJson(STATE_FILE, { schemaVersion: 1, cursor: null, downloaded: 0, rejected: 0 });
  const previousDownloaded = Number(state.downloaded || 0); const previousRejected = Number(state.rejected || 0);
  const rawPatches = await apiJson("/constants/patch");
  const patches = (Array.isArray(rawPatches) ? rawPatches : []).map((patch) => ({ id: Number(patch.id), timestamp: Math.floor(Date.parse(patch.date) / 1000) })).filter((patch) => patch.id && Number.isFinite(patch.timestamp));
  let downloaded = 0; let rejected = 0; let lowSkillEvidence = 0; let invalidDraft = 0; let pages = 0;
  while (pages < MAX_PAGES) {
    const endpoint = state.cursor ? `/publicMatches?less_than_match_id=${state.cursor}` : "/publicMatches";
    const rows = await apiJson(endpoint); if (!Array.isArray(rows) || !rows.length) break; pages += 1;
    for (const row of rows) {
      const matchId = Number(row.match_id); if (!matchId) continue;
      state.cursor = Math.min(Number(state.cursor || matchId), matchId);
      const skillQualified = Number(row.avg_mmr || 0) >= MIN_AVG_MMR || Number(row.avg_rank_tier || 0) >= MIN_AVG_RANK_TIER;
      if (!skillQualified) { rejected += 1; lowSkillEvidence += 1; continue; }
      const patchId = patchForTimestamp(patches, Number(row.start_time || 0)); const match = patchId ? normalizedMatch(row, patchId) : null;
      if (!match) { rejected += 1; invalidDraft += 1; continue; }
      await writeFile(path.join(OUTPUT_DIR, `${matchId}.json`), JSON.stringify(match)); downloaded += 1;
    }
    state.updatedAt = new Date().toISOString(); state.downloaded = previousDownloaded + downloaded; state.rejected = previousRejected + rejected;
    state.lastRun = { pages, downloaded, rejected, lowSkillEvidence, invalidDraft, cursor: state.cursor }; await atomicJson(STATE_FILE, state);
    process.stdout.write(`High MMR: ${pages}/${MAX_PAGES} pages, ${downloaded} accepted, ${lowSkillEvidence} without rank evidence, ${invalidDraft} invalid drafts\n`);
  }
  state.updatedAt = new Date().toISOString(); state.downloaded = previousDownloaded + downloaded; state.rejected = previousRejected + rejected; state.lastRun = { pages, downloaded, rejected, lowSkillEvidence, invalidDraft, cursor: state.cursor }; await atomicJson(STATE_FILE, state);
  console.log(`High-MMR collection complete: ${downloaded} accepted from ${pages} pages; ${OUTPUT_DIR}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
