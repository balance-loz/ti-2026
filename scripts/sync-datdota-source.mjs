import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
const OUT_DIR = path.resolve(process.env.DATDOTA_CACHE_DIR || path.join(ROOT, "work", "datdota-cache"));
const DEFAULT_URL = "https://datdota.com/api/drafts/positions?tier=1%2C2&threshold=1&after=2010-01-01&before=2026-08-12&patch=7.41";
const SOURCE_URL = process.env.DATDOTA_POSITIONS_URL || DEFAULT_URL;
const SOURCE_FILE = process.env.DATDOTA_POSITIONS_FILE ? path.resolve(process.env.DATDOTA_POSITIONS_FILE) : null;
const AS_OF = process.env.DATDOTA_AS_OF || null;

function payloadRows(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["data", "rows", "results", "positions", "heroes"]) if (Array.isArray(value[key])) return value[key];
  return [];
}

function blockedHtml(raw) { return /^\s*</.test(raw) && /access denied|cfwafblock|cloudflare/i.test(raw); }

export function normalizeDatdotaPayload(raw, { transport = "test", locator = "memory", asOf = null, observedAt = new Date().toISOString() } = {}) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("DatDota payload is not JSON; save the API response, not the rendered HTML table."); }
  const rows = payloadRows(parsed);
  if (!rows.length) throw new Error("DatDota JSON schema was received but no position rows were found; keep the raw export and update the adapter before model use.");
  const checksum = createHash("sha256").update(raw).digest("hex");
  return {
    checksum, rows, artifact: {
      schemaVersion: 1, provider: "datdota", dataset: "draft_positions", observedAt, asOf,
      source: { transport, locator, checksum: `sha256:${checksum}` },
      query: { tier: [1, 2], threshold: 1, patch: "7.41", before: "2026-08-12" }, rows,
      modelPolicy: {
        status: "shadow", aggregateRowsAreNotTrainingMatches: true,
        allowedUses: ["role-distribution prior for currently missing roles", "provider disagreement audit", "challenger feature with chronological snapshots"],
        forbiddenUses: ["adding aggregate games or wins to OpenDota totals", "historical walk-forward without an as-of snapshot", "production activation without incremental OOF gate"],
      },
    },
  };
}

async function sourcePayload() {
  if (SOURCE_FILE) return { raw: await readFile(SOURCE_FILE, "utf8"), transport: "manual_export", locator: SOURCE_FILE };
  const response = await fetch(SOURCE_URL, { headers: { accept: "application/json", "user-agent": "TI2026 research collector" } });
  const raw = await response.text();
  if (!response.ok || blockedHtml(raw)) throw new Error(`DatDota refused the public API request (${response.status}). Use DATDOTA_POSITIONS_FILE with an authorized JSON export; protection is not bypassed.`);
  return { raw, transport: "public_api", locator: SOURCE_URL };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await mkdir(OUT_DIR, { recursive: true });
  const source = await sourcePayload();
  const { artifact, checksum, rows } = normalizeDatdotaPayload(source.raw, { transport: source.transport, locator: source.locator, asOf: AS_OF });
  const output = path.join(OUT_DIR, `draft-positions-${checksum.slice(0, 12)}.json`);
  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`);
  await writeFile(path.join(OUT_DIR, "latest.json"), `${JSON.stringify({ output, checksum: artifact.source.checksum, observedAt: artifact.observedAt, asOf: AS_OF, rows: rows.length, status: "shadow" }, null, 2)}\n`);
  console.log(`DatDota draft positions: ${rows.length} rows cached as SHADOW (${output})`);
}
