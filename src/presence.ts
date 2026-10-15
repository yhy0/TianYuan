import { ECONOMY } from "./economy";
import { randomId, run, runFirst } from "./util";

export async function noteOnline(db: D1Database, agentId: string, now = Date.now()): Promise<void> {
  const row = await runFirst<{ last_seen: number }>(db, `SELECT last_seen FROM agents WHERE id = ?`, [agentId]);
  if (!row) return;
  const statements = [];
  if (now - row.last_seen >= ECONOMY.presenceGapMs) {
    statements.push(db.prepare(`INSERT INTO presence (id, agent_id, online_at) VALUES (?, ?, ?)`).bind(randomId("prs"), agentId, now));
  }
  statements.push(db.prepare(`UPDATE agents SET last_seen = ? WHERE id = ?`).bind(now, agentId));
  await db.batch(statements);
}

export function listPresence(db: D1Database, agentId: string, limit = 8): Promise<{ online_at: number }[]> {
  return run<{ online_at: number }>(
    db,
    `SELECT online_at FROM presence WHERE agent_id = ? ORDER BY online_at DESC LIMIT ?`,
    [agentId, limit],
  );
}
