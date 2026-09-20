// Hero reference data. Picks arrive as numeric ids, which are useless on a
// page, so names and portraits are resolved once and cached.
import { nowIso } from "./db.mjs";
import { opendota, BudgetExhausted, Throttled } from "./opendota.mjs";

// Valve's CDN derives the portrait path from the internal hero name.
const PORTRAIT_BASE = "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes";
export const heroImage = (name) => `${PORTRAIT_BASE}/${String(name || "").replace(/^npc_dota_hero_/, "")}.png`;

export async function syncHeroes(db) {
  let rows;
  try {
    rows = await opendota.heroes(db);
  } catch (error) {
    if (error instanceof BudgetExhausted || error instanceof Throttled) return { synced: 0, skipped: true };
    throw error;
  }
  if (!Array.isArray(rows)) return { synced: 0, skipped: true };
  const at = nowIso();
  const insert = db.prepare(`INSERT INTO heroes(hero_id, name, localized_name, primary_attr, attack_type, updated_at)
                             VALUES(?,?,?,?,?,?)
                             ON CONFLICT(hero_id) DO UPDATE SET name=excluded.name,
                               localized_name=excluded.localized_name, primary_attr=excluded.primary_attr,
                               attack_type=excluded.attack_type, updated_at=excluded.updated_at`);
  let synced = 0;
  for (const hero of rows) {
    if (!Number(hero.id)) continue;
    insert.run(Number(hero.id), String(hero.name || ""), String(hero.localized_name || hero.name || `Hero ${hero.id}`),
      hero.primary_attr ?? null, hero.attack_type ?? null, at);
    synced += 1;
  }
  return { synced };
}

let cache = null;
let cachedAt = 0;

/** { [heroId]: { id, name, image } }, refreshed at most once a minute. */
export function heroCatalog(db, { maxAgeMs = 60_000 } = {}) {
  if (cache && Date.now() - cachedAt < maxAgeMs) return cache;
  const rows = db.prepare("SELECT hero_id, name, localized_name FROM heroes").all();
  cache = Object.fromEntries(rows.map((row) => [
    String(row.hero_id),
    { id: Number(row.hero_id), name: row.localized_name, image: heroImage(row.name) },
  ]));
  cachedAt = Date.now();
  return cache;
}

export function invalidateHeroCache() {
  cache = null;
  cachedAt = 0;
}
