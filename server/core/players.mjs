// Player names.
//
// Every map records who played it as account ids, but almost none record their
// names: the archived history was imported without them, and the writers use
// COALESCE, so a later fetch can never fill them in. Without a second source a
// roster reads as five numbers.
//
// The pro-player list is that source — one request returns the whole scene, so
// it costs a single call a day out of a budget measured in thousands.
import { nowIso } from "./db.mjs";
import { opendota, BudgetExhausted, Throttled } from "./opendota.mjs";

export async function syncPlayers(db) {
  let rows;
  try {
    rows = await opendota.proPlayers(db);
  } catch (error) {
    if (error instanceof BudgetExhausted || error instanceof Throttled) return { synced: 0, skipped: true };
    throw error;
  }
  if (!Array.isArray(rows)) return { synced: 0, skipped: true };

  const at = nowIso();
  const insert = db.prepare(`INSERT INTO players(account_id, name, team_id, team_name, country_code, updated_at)
                             VALUES(?,?,?,?,?,?)
                             ON CONFLICT(account_id) DO UPDATE SET name=excluded.name,
                               team_id=excluded.team_id, team_name=excluded.team_name,
                               country_code=excluded.country_code, updated_at=excluded.updated_at`);
  let synced = 0;
  for (const player of rows) {
    const accountId = Number(player.account_id || 0);
    // A handle is the point; an account with neither name nor persona is noise.
    const name = String(player.name || player.personaname || "").trim();
    if (!accountId || !name) continue;
    insert.run(accountId, name, Number(player.team_id) || null,
      player.team_name ? String(player.team_name) : null,
      player.country_code ? String(player.country_code) : null, at);
    synced += 1;
  }
  return { synced };
}

/** How many names we hold, for the activity feed. */
export const playerNameCount = (db) => db.prepare("SELECT COUNT(*) AS n FROM players").get().n;
