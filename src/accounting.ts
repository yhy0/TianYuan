import { assertBinds } from "./util";

export type Statement = { sql: string; binds: unknown[] };
export class BatchRejected extends Error {}

export async function writeBatch(db: D1Database, parts: Statement[]): Promise<void> {
  try {
    await db.batch(parts.map(({ sql, binds }) => {
      assertBinds(sql, binds);
      return db.prepare(sql).bind(...binds);
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("division by zero") || message.includes("platform_state.value")) throw new BatchRejected();
    throw error;
  }
}

export function guard(condition: string, binds: unknown[]): Statement {
  return { sql: `UPDATE platform_state SET value = value / 0 WHERE key = 'confiscated' AND NOT (${condition})`, binds };
}

/** 所有入账先偿还奖励追回欠额；流水分别记录可用余额与欠额的变化。 */
export function receiveCredits(amount: number): string {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("入账金额无效");
  return `credits = credits + MAX(0, ${amount} - reward_debt),
    hold_delta = MAX(0, ${amount} - reward_debt),
    hold_debt_delta = -MIN(reward_debt, ${amount}),
    reward_debt = MAX(0, reward_debt - ${amount})`;
}

export function earnedEvent(agentId: string, claim: string, delta: number, reason: string, refType: string, refId: string, now: number): Statement {
  return {
    sql: `INSERT INTO earned_events (id, agent_id, delta, earned_after, reason, ref_type, ref_id, created_at)
      SELECT 'ern_' || lower(hex(randomblob(12))), id, ?, credits_earned, ?, ?, ?, ?
      FROM agents WHERE id = ? AND hold_ref = ? AND ? != 0`,
    binds: [delta, reason, refType, refId, now, agentId, claim, delta],
  };
}

/** 与帖子裁决同一事务中撤销所有可追溯奖励；花掉的部分由未来入账抵扣。 */
export function revokePostRewards(postId: string, claim: string, now: number): Statement[] {
  const amount = `(SELECT SUM(amount) FROM contribution_rewards r WHERE r.agent_id = agents.id AND r.revoked_by = ?)`;
  return [
    { sql: `UPDATE contribution_rewards SET revoked_by = ? WHERE post_id = ? AND revoked_by = ''`, binds: [claim, postId] },
    {
      sql: `UPDATE agents SET
        hold_delta = -MIN(credits, ${amount}),
        hold_debt_delta = MAX(0, ${amount} - credits),
        credits = MAX(0, credits - ${amount}),
        reward_debt = reward_debt + MAX(0, ${amount} - credits),
        hold_earned_delta = -MIN(credits_earned, ${amount}),
        credits_earned = MAX(0, credits_earned - ${amount}),
        hold_ref = ?
        WHERE id IN (SELECT agent_id FROM contribution_rewards WHERE revoked_by = ?)`,
      binds: [claim, claim, claim, claim, claim, claim, claim, claim],
    },
    {
      sql: `INSERT INTO ledger (id, agent_id, delta, balance_after, debt_delta, reason, ref_type, ref_id, detail, created_at)
        SELECT 'ldg_' || lower(hex(randomblob(12))), id, hold_delta, credits, hold_debt_delta,
          'reward_revoke', 'post', ?, '违规贡献奖励追回；欠额由后续入账抵扣', ? FROM agents WHERE hold_ref = ?`,
      binds: [postId, now, claim],
    },
    {
      sql: `INSERT INTO earned_events (id, agent_id, delta, earned_after, reason, ref_type, ref_id, created_at)
        SELECT 'ern_' || lower(hex(randomblob(12))), id, hold_earned_delta,
          credits_earned, 'reward_revoke', 'post', ?, ?
        FROM agents WHERE hold_ref = ? AND hold_earned_delta != 0`,
      binds: [postId, now, claim],
    },
    {
      sql: `UPDATE platform_state SET value = value - COALESCE((SELECT SUM(hold_delta) FROM agents WHERE hold_ref = ?), 0)
        WHERE key = 'confiscated'`, binds: [claim],
    },
  ];
}
