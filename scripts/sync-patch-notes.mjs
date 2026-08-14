import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const STATE_PATH = path.join(ROOT, "work", "opendota-bulk", "state.json");
const TIMELINE_PATH = path.resolve(process.env.DRAFT_PATCH_TIMELINE || path.join(ROOT, "work", "patch-timeline.json"));
const NOTES_DIR = path.resolve(process.env.DRAFT_PATCH_NOTES_DIR || path.join(ROOT, "work", "patch-notes"));
const LIST_URL = "https://www.dota2.com/datafeed/patchnoteslist?language=english";

const state = JSON.parse(await readFile(STATE_PATH, "utf8"));
const windowStart = Number(state.windowStart);
// The bulk census has a frozen historical cutoff, but the resumable live cache
// can contain newer tournament maps.  Keep the lower bound reproducible while
// extending the active patch through the instant at which this timeline is
// regenerated; otherwise valid live maps are incorrectly labelled as being
// outside the last subpatch.
const windowEnd = Math.max(Number(state.windowEnd), Math.floor(Date.now() / 1000) + 1);
if (!windowStart || !windowEnd) throw new Error("Bulk collection state has no fixed research window.");

async function json(url) {
  const response = await fetch(url, { headers: { "user-agent": "TI2026-patch-research/1.0" } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

await mkdir(NOTES_DIR, { recursive: true });
const listing = await json(LIST_URL);
const all = (listing.patches ?? []).map((patch) => ({
  version: String(patch.patch_number),
  name: String(patch.patch_name || patch.patch_number),
  timestamp: Number(patch.patch_timestamp),
  website: patch.patch_website || null,
})).filter((patch) => patch.timestamp > 0).sort((a, b) => a.timestamp - b.timestamp);
const firstInside = all.findIndex((patch) => patch.timestamp >= windowStart);
const startIndex = Math.max(0, firstInside - 1);
const selected = all.slice(startIndex).filter((patch) => patch.timestamp < windowEnd);

for (const [index, patch] of selected.entries()) {
  const detailsUrl = `https://www.dota2.com/datafeed/patchnotes?version=${encodeURIComponent(patch.version)}&language=english`;
  const details = await json(detailsUrl);
  const raw = `${JSON.stringify(details, null, 2)}\n`;
  const file = path.join(NOTES_DIR, `${patch.version}.json`);
  await writeFile(file, raw);
  patch.detailsFile = path.relative(ROOT, file).replaceAll("\\", "/");
  patch.detailsChecksum = createHash("sha256").update(raw).digest("hex");
  patch.heroChanges = Array.isArray(details.heroes) ? details.heroes.length : 0;
  patch.generalChanges = Array.isArray(details.general_notes) ? details.general_notes.length : 0;
  process.stdout.write(`Patch notes ${index + 1}/${selected.length}: ${patch.version}\n`);
}

const timeline = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: LIST_URL,
  window: { start: windowStart, end: windowEnd },
  versions: selected.map((patch, index) => ({
    ...patch,
    effectiveEnd: selected[index + 1]?.timestamp ?? windowEnd,
    overlapsWindow: patch.timestamp < windowEnd && (selected[index + 1]?.timestamp ?? windowEnd) > windowStart,
  })),
};
timeline.checksum = createHash("sha256").update(JSON.stringify(timeline.versions)).digest("hex");
await writeFile(TIMELINE_PATH, `${JSON.stringify(timeline, null, 2)}\n`);
console.log(`Official patch timeline ready: ${timeline.versions.filter((patch) => patch.overlapsWindow).length} versions; ${TIMELINE_PATH}`);
