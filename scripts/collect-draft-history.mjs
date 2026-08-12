import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const API = process.env.OPENDOTA_API_URL || "https://api.opendota.com/api";
const API_KEY = process.env.OPENDOTA_API_KEY || "";
const MATCH_DIR = path.join(ROOT, "work", "opendota-cache", "matches");
const STATE_FILE = path.join(ROOT, "work", "draft-history-state.json");
const MANIFEST_FILE = path.join(ROOT, "work", "draft-dataset-manifest.json");
const MAX_NEW = Math.max(1, Number(process.env.DRAFT_HISTORY_MAX_NEW_MATCHES || 100));
const MAX_PAGES = Math.max(1, Number(process.env.DRAFT_HISTORY_MAX_PAGES || 60));
const STRATUM_SOFT_TARGET = Math.max(5, Number(process.env.DRAFT_HISTORY_STRATUM_TARGET || 25));
const MIN_START_TIME = Math.floor(Date.parse(process.env.DRAFT_HISTORY_START || "2022-01-01T00:00:00Z") / 1000);
const REQUEST_GAP_MS = Math.max(250, Number(process.env.OPENDOTA_REQUEST_GAP_MS || 1100));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let nextRequestAt = 0;

async function optionalJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

async function atomicJson(file, value) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

function endpointUrl(endpoint) {
  if (!API_KEY) return `${API}${endpoint}`;
  return `${API}${endpoint}${endpoint.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(API_KEY)}`;
}

async function apiJson(endpoint) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const delay = Math.max(0, nextRequestAt - Date.now());
    if (delay) await sleep(delay);
    nextRequestAt = Date.now() + REQUEST_GAP_MS;
    try {
      const response = await fetch(endpointUrl(endpoint), {
        headers: { "user-agent": "TI26Predictor/0.6 (resumable local model research)" },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return response.json();
      if (response.status !== 429 && response.status < 500) throw new Error(`OpenDota HTTP ${response.status}`);
    } catch (error) {
      if (attempt === 5) throw error;
    }
    await sleep(1000 * 2 ** attempt);
  }
  throw new Error(`OpenDota retry limit reached for ${endpoint}`);
}

function usableDetail(match) {
  const heroes = (match.players ?? []).map((player) => Number(player.hero_id)).filter(Boolean);
  return Number.isInteger(Number(match.match_id)) && Number.isInteger(Number(match.patch))
    && heroes.length === 10 && new Set(heroes).size === 10;
}

function patchForTimestamp(patches, timestamp) {
  let selected = null;
  for (const patch of patches) if (patch.timestamp <= timestamp && (!selected || patch.timestamp > selected.timestamp)) selected = patch;
  return selected?.id ?? null;
}

async function main() {
  await mkdir(MATCH_DIR, { recursive: true });
  const cachedFiles = (await readdir(MATCH_DIR)).filter((file) => /^\d+\.json$/.test(file));
  const cachedIds = new Set(cachedFiles.map((file) => Number(file.slice(0, -5))));
  const stratumCounts = new Map();
  const countStratum = (key) => stratumCounts.set(key, (stratumCounts.get(key) ?? 0) + 1);
  for (const file of cachedFiles) {
    try {
      const match = JSON.parse(await readFile(path.join(MATCH_DIR, file), "utf8"));
      const month = new Date(Number(match.start_time || 0) * 1000).toISOString().slice(0, 7);
      countStratum(`month:${match.patch}:${month}`); countStratum(`league:${match.patch}:${Number(match.leagueid || 0)}`);
      if (match.radiant_team_id) countStratum(`team:${match.patch}:${Number(match.radiant_team_id)}`);
      if (match.dire_team_id) countStratum(`team:${match.patch}:${Number(match.dire_team_id)}`);
    } catch { /* Dataset validation reports unreadable files. */ }
  }
  const oldestCachedId = cachedIds.size ? Math.min(...cachedIds) : null;
  const state = await optionalJson(STATE_FILE, {
    schemaVersion: 1, cursor: oldestCachedId, failedMatchIds: [], downloaded: 0, scanned: 0,
  });
  const previousDownloaded = Number(state.downloaded || 0);
  const previousScanned = Number(state.scanned || 0);
  if (!state.cursor && oldestCachedId) state.cursor = oldestCachedId;
  const [rawPatches, manifest] = await Promise.all([apiJson("/constants/patch"), optionalJson(MANIFEST_FILE, { patches: [] })]);
  const patches = (Array.isArray(rawPatches) ? rawPatches : []).map((patch) => ({ id: Number(patch.id), name: patch.name, timestamp: Math.floor(Date.parse(patch.date) / 1000) })).filter((patch) => patch.id && Number.isFinite(patch.timestamp));
  const patchCounts = new Map(Object.entries(state.patchCounts ?? {}).map(([patchId, matches]) => [Number(patchId), Number(matches)]));
  for (const patch of manifest.patches ?? []) patchCounts.set(Number(patch.patchId), Math.max(Number(patch.matches), patchCounts.get(Number(patch.patchId)) ?? 0));

  let downloaded = 0; let failed = 0; let scanned = 0; let pages = 0;
  const retryIds = [...new Set(state.failedMatchIds ?? [])];
  const pendingIds = [...new Set(state.pendingMatchIds ?? [])];
  state.failedMatchIds = [];
  state.pendingMatchIds = [];

  const downloadDetail = async (matchId) => {
    if (cachedIds.has(matchId)) return true;
    try {
      const detail = await apiJson(`/matches/${matchId}`);
      if (!usableDetail(detail)) throw new Error("match detail lacks patch or complete draft");
      detail.patch_name = patches.find((patch) => patch.id === Number(detail.patch))?.name ?? String(detail.patch);
      detail.data_source = detail.data_source || "opendota_pro_match_detail";
      await writeFile(path.join(MATCH_DIR, `${matchId}.json`), JSON.stringify(detail));
      cachedIds.add(matchId); downloaded += 1;
      return true;
    } catch (error) {
      failed += 1; state.failedMatchIds.push(matchId);
      process.stderr.write(`Historical match ${matchId} skipped: ${error.message}\n`);
      return false;
    }
  };

  const backlogIds = [...new Set([...pendingIds, ...retryIds])];
  for (let backlogIndex = 0; backlogIndex < backlogIds.length; backlogIndex += 1) {
    if (downloaded >= MAX_NEW) { state.pendingMatchIds.push(...backlogIds.slice(backlogIndex)); break; }
    await downloadDetail(Number(backlogIds[backlogIndex]));
  }

  while (downloaded < MAX_NEW && pages < MAX_PAGES) {
    const endpoint = state.cursor ? `/proMatches?less_than_match_id=${state.cursor}` : "/proMatches";
    const summaries = await apiJson(endpoint);
    if (!Array.isArray(summaries) || !summaries.length) break;
    pages += 1;
    const priority = (summary) => {
      const patchId = patchForTimestamp(patches, Number(summary.start_time || 0));
      const month = new Date(Number(summary.start_time || 0) * 1000).toISOString().slice(0, 7);
      const counts = [stratumCounts.get(`month:${patchId}:${month}`) ?? 0, stratumCounts.get(`league:${patchId}:${Number(summary.leagueid || 0)}`) ?? 0, stratumCounts.get(`team:${patchId}:${Number(summary.radiant_team_id || 0)}`) ?? 0, stratumCounts.get(`team:${patchId}:${Number(summary.dire_team_id || 0)}`) ?? 0];
      return counts.filter((count) => count < STRATUM_SOFT_TARGET).length * 1000 - Math.min(...counts);
    };
    const ordered = [...summaries].sort((a, b) => priority(b) - priority(a) || Number(b.match_id) - Number(a.match_id));
    for (let summaryIndex = 0; summaryIndex < ordered.length; summaryIndex += 1) {
      const summary = ordered[summaryIndex];
      const matchId = Number(summary.match_id); const startTime = Number(summary.start_time || 0);
      if (!matchId) continue;
      scanned += 1;
      state.cursor = Math.min(Number(state.cursor || matchId), matchId);
      state.cursorStartTime = startTime;
      if (startTime && startTime < MIN_START_TIME) { state.reachedStart = true; break; }
      const patchId = patchForTimestamp(patches, startTime);
      if (!cachedIds.has(matchId)) {
        const saved = await downloadDetail(matchId);
        if (saved && patchId) {
          patchCounts.set(patchId, (patchCounts.get(patchId) ?? 0) + 1);
          const month = new Date(startTime * 1000).toISOString().slice(0, 7);
          countStratum(`month:${patchId}:${month}`); countStratum(`league:${patchId}:${Number(summary.leagueid || 0)}`);
          if (summary.radiant_team_id) countStratum(`team:${patchId}:${Number(summary.radiant_team_id)}`);
          if (summary.dire_team_id) countStratum(`team:${patchId}:${Number(summary.dire_team_id)}`);
        }
      }
      if (downloaded >= MAX_NEW) {
        state.pendingMatchIds.push(...ordered.slice(summaryIndex + 1).map((item) => Number(item.match_id)).filter((id) => id && !cachedIds.has(id)));
        break;
      }
    }
    state.updatedAt = new Date().toISOString();
    state.patchCounts = Object.fromEntries([...patchCounts.entries()].sort((a, b) => a[0] - b[0]));
    state.downloaded = previousDownloaded + downloaded;
    state.scanned = previousScanned + scanned;
    state.pendingMatchIds = [...new Set(state.pendingMatchIds)];
    state.lastRun = { pages, downloaded, failed, scanned, exhaustive: true, stratifiedPriority: true, pending: state.pendingMatchIds.length, cursor: state.cursor, cursorStartTime: state.cursorStartTime };
    await atomicJson(STATE_FILE, state);
    if (state.reachedStart) break;
    process.stdout.write(`History: ${downloaded}/${MAX_NEW} downloaded from all pro matches, cursor ${state.cursor} (${state.cursorStartTime ? new Date(state.cursorStartTime * 1000).toISOString().slice(0, 10) : "unknown"})\n`);
  }

  state.updatedAt = new Date().toISOString();
  state.patchCounts = Object.fromEntries([...patchCounts.entries()].sort((a, b) => a[0] - b[0]));
  state.downloaded = previousDownloaded + downloaded;
  state.scanned = previousScanned + scanned;
  state.pendingMatchIds = [...new Set(state.pendingMatchIds)];
  state.lastRun = { pages, downloaded, failed, scanned, exhaustive: true, stratifiedPriority: true, pending: state.pendingMatchIds.length, cursor: state.cursor, cursorStartTime: state.cursorStartTime };
  await atomicJson(STATE_FILE, state);
  console.log(`Historical collection complete: ${downloaded} new from exhaustive pro history, ${failed} failed, ${pages} pages; ${MATCH_DIR}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
