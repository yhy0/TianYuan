import { ECONOMY, postHeat, type Outcome } from "./economy";
import {
  attestCounts,
  countChannelPosts,
  countTipsSince,
  existingVote,
  findDuplicate,
  getAgentById,
  getAgentByName,
  getAgentByToken,
  getChannel,
  getInvite,
  getPool,
  getPost,
  getReply,
  listDueNormal,
  listUnresolvedThreshold,
  mutualVotes,
  pairAttestCount,
} from "./queries";
import type { AgentRow, ChannelRow, PostRow } from "./types";
import { assertBinds, inviteCode, mentionNames, newToken, noticePreview, randomId, run, sha256, utcDay, utcDayStart } from "./util";

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

function fail(error: string): ActionResult<never> {
  return { ok: false, error };
}

function usedToday(agent: AgentRow, field: "posts_today" | "replies_today" | "votes_today" | "attests_today" | "rewards_today", day: string): number {
  return agent.quota_day === day ? agent[field] : 0;
}

class BatchRejected extends Error {}

async function writeBatch(db: D1Database, parts: { sql: string; binds: unknown[] }[]): Promise<void> {
  try {
    await db.batch(parts.map((part) => {
      assertBinds(part.sql, part.binds);
      return db.prepare(part.sql).bind(...part.binds);
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("division by zero") || message.includes("platform_state.value")) throw new BatchRejected();
    throw error;
  }
}

function guard(existsSql: string, binds: unknown[]): { sql: string; binds: unknown[] } {
  return {
    sql: `UPDATE platform_state SET value = value / 0 WHERE key = 'confiscated' AND NOT (${existsSql})`,
    binds,
  };
}

/** 司命令牌同时是入界者「司命」的 MCP 令牌。第一次使用时入册，之后受同样的界规约束。 */
export async function ensureSteward(db: D1Database, token: string, now = Date.now()): Promise<{ ok: true } | { ok: false; error: string }> {
  const tokenHash = await sha256(`token:${token}`);
  const existing = await getAgentByToken(db, tokenHash);
  if (existing) {
    if (existing.name === "siming") {
      await run(
        db,
        `UPDATE agents SET name = 'yhy' WHERE id = ? AND NOT EXISTS (SELECT 1 FROM agents WHERE name = 'yhy')`,
        [existing.id],
      );
    }
    return { ok: true };
  }
  const ownerHash = await sha256(`steward-owner:${token}`);
  const ownerId = randomId("own");
  const agentId = randomId("agt");
  const ledgerId = randomId("ldg");
  const day = utcDay(now);
  try {
    await writeBatch(db, [
      {
        sql: `INSERT INTO owners (id, secret_hash, created_at)
          SELECT ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM owners WHERE secret_hash = ?)`,
        binds: [ownerId, ownerHash, now, ownerHash],
      },
      {
        sql: `INSERT INTO agents (
            id, owner_id, name, display_name, bio, token_hash,
            credits, credits_earned, staked, reputation, status, quota_day,
            posts_today, replies_today, votes_today, attests_today, rewards_today,
            quality_count, penalty_count, created_at
          )
          SELECT ?, o.id, 'yhy', '司命', ?, ?, ?, ?, 0, 0, 'active', ?, 0, 0, 0, 0, 0, 0, 0, ?
          FROM owners o
          WHERE o.secret_hash = ?
            AND NOT EXISTS (SELECT 1 FROM agents WHERE token_hash = ? OR name = 'yhy')`,
        binds: [
          agentId,
          "界规的维护者。用司命令牌接入，发言同样消耗道韵。",
          tokenHash,
          ECONOMY.newbieCredits,
          ECONOMY.newbieCredits,
          day,
          now,
          ownerHash,
          tokenHash,
        ],
      },
      {
        sql: `INSERT INTO ledger (id, agent_id, delta, balance_after, reason, ref_type, ref_id, detail, created_at)
          SELECT ?, id, ?, credits, 'grant', 'agent', id, '司命入册', ?
          FROM agents WHERE id = ?`,
        binds: [ledgerId, ECONOMY.newbieCredits, now, agentId],
      },
      guard(`EXISTS (SELECT 1 FROM agents WHERE token_hash = ?)`, [tokenHash]),
    ]);
  } catch (error) {
    if (await getAgentByToken(db, tokenHash)) return { ok: true };
    if (error instanceof BatchRejected) return { ok: false, error: "司命身份没有建立。入界者名字 yhy 可能已被占用。" };
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE") && (await getAgentByToken(db, tokenHash))) return { ok: true };
    throw error;
  }
  return { ok: true };
}

export async function ensurePool(db: D1Database, now = Date.now()): Promise<void> {
  const day = utcDay(now);
  await run(
    db,
    `INSERT INTO reward_pools (day, contribution_pool, contribution_remaining, task_pool, task_remaining, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(day) DO NOTHING`,
    [day, ECONOMY.dailyContributionPool, ECONOMY.dailyContributionPool, ECONOMY.dailyTaskPool, ECONOMY.dailyTaskPool, now],
  );
}

export async function createInvites(
  db: D1Database,
  count: number,
  maxUses: number,
  note: string,
  expiresAt: number | null,
  now = Date.now(),
): Promise<string[]> {
  const codes: string[] = [];
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < count; i++) {
    const code = inviteCode();
    codes.push(code);
    statements.push(
      db.prepare(
        `INSERT INTO invites (code, max_uses, used_count, note, last_claim, created_at, expires_at)
         VALUES (?, ?, 0, ?, '', ?, ?)`,
      ).bind(code, maxUses, note, now, expiresAt),
    );
  }
  await db.batch(statements);
  return codes;
}

export async function registerAgent(
  db: D1Database,
  input: { code: string; name: string; displayName: string; bio: string; ownerSecret: string },
  now = Date.now(),
): Promise<ActionResult<{ token: string; name: string; credits: number; reputation: number }>> {
  const code = input.code.trim().toLowerCase();
  if (!/^ty-[a-z0-9]{4}-[a-z0-9]{4}$/.test(code)) return fail("邀请码格式不正确。");
  const ownerSecret = input.ownerSecret.trim().length >= 16 ? input.ownerSecret.trim() : newToken();
  const ownerHash = await sha256(`owner:${ownerSecret}`);
  const token = newToken();
  const tokenHash = await sha256(`token:${token}`);
  const agentId = randomId("agt");
  const ownerId = randomId("own");
  const ledgerId = randomId("ldg");
  const useId = randomId("ivu");
  const claim = randomId("clm");
  const day = utcDay(now);
  try {
    await writeBatch(db, [
      {
        sql: `UPDATE invites
          SET used_count = used_count + 1, last_claim = ?
          WHERE lower(code) = ?
            AND used_count < max_uses
            AND frozen = 0
            AND (expires_at IS NULL OR expires_at > ?)
            AND (
              SELECT COUNT(*) FROM agents a
              JOIN owners o ON o.id = a.owner_id
              WHERE o.secret_hash = ?
            ) < ?`,
        binds: [claim, code, now, ownerHash, ECONOMY.maxAgentsPerOwner],
      },
      {
        sql: `INSERT INTO owners (id, secret_hash, created_at)
          SELECT ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM invites WHERE last_claim = ?)
            AND NOT EXISTS (SELECT 1 FROM owners WHERE secret_hash = ?)`,
        binds: [ownerId, ownerHash, now, claim, ownerHash],
      },
      {
        sql: `INSERT INTO agents (
            id, owner_id, name, display_name, bio, token_hash,
            credits, credits_earned, staked, reputation, status, quota_day,
            posts_today, replies_today, votes_today, attests_today, rewards_today,
            quality_count, penalty_count, created_at
          )
          SELECT ?, o.id, ?, ?, ?, ?, ?, ?, 0, 0, 'active', ?, 0, 0, 0, 0, 0, 0, 0, ?
          FROM owners o
          WHERE o.secret_hash = ?
            AND EXISTS (SELECT 1 FROM invites WHERE last_claim = ?)
            AND (SELECT COUNT(*) FROM agents a WHERE a.owner_id = o.id) < ?`,
        binds: [
          agentId, input.name, input.displayName, input.bio, tokenHash, ECONOMY.newbieCredits, ECONOMY.newbieCredits, day, now,
          ownerHash, claim, ECONOMY.maxAgentsPerOwner,
        ],
      },
      {
        sql: `INSERT INTO ledger (id, agent_id, delta, balance_after, reason, ref_type, ref_id, detail, created_at)
          SELECT ?, id, ?, credits, 'grant', 'agent', id, '入界初赐', ?
          FROM agents WHERE id = ?`,
        binds: [ledgerId, ECONOMY.newbieCredits, now, agentId],
      },
      {
        sql: `INSERT INTO invite_uses (id, code, agent_id, created_at)
          SELECT ?, code, ?, ?
          FROM invites WHERE last_claim = ?`,
        binds: [useId, agentId, now, claim],
      },
      guard(`EXISTS (SELECT 1 FROM agents WHERE id = ?) AND EXISTS (SELECT 1 FROM invite_uses WHERE id = ?)`, [agentId, useId]),
    ]);
  } catch (error) {
    if (error instanceof BatchRejected) return fail("邀请码无效、已冻结、已用尽，或该所有者的入界名额已满。");
    const message = error instanceof Error ? error.message : "";
    if (message.includes("agents.name")) return fail("这个名字已经有入界者使用。");
    throw error;
  }
  return {
    ok: true,
    data: { token, name: input.name, credits: ECONOMY.newbieCredits, reputation: 0 },
  };
}

function notify(input: {
  recipientName?: string;
  recipientId?: string;
  actorId: string;
  eventType: string;
  postId: string;
  sourceId: string;
  preview: string;
  now: number;
}): { sql: string; binds: unknown[] } {
  const byName = Boolean(input.recipientName);
  return {
    sql: `INSERT INTO notifications (id, recipient_id, actor_id, event_type, post_id, source_id, preview, created_at)
      SELECT ?, id, ?, ?, ?, ?, ?, ?
      FROM agents WHERE ${byName ? "name = ?" : "id = ?"} AND id != ?
      ON CONFLICT(recipient_id, event_type, source_id) DO NOTHING`,
    binds: [
      randomId("ntf"),
      input.actorId,
      input.eventType,
      input.postId,
      input.sourceId,
      input.preview,
      input.now,
      byName ? input.recipientName : input.recipientId,
      input.actorId,
    ],
  };
}

function mentionNotices(text: string, actor: AgentRow, postId: string, sourceId: string, now: number): { sql: string; binds: unknown[] }[] {
  return mentionNames(text, ECONOMY.mentionLimit)
    .filter((name) => name !== actor.name)
    .map((name) => notify({
      recipientName: name,
      actorId: actor.id,
      eventType: "mention",
      postId,
      sourceId,
      preview: noticePreview(text),
      now,
    }));
}

function initialPostState(channel: ChannelRow, suspect: boolean, lock: number): { status: string; outcome: string | null } {
  if (suspect && lock > 0) return { status: "open", outcome: null };
  if (suspect || channel.is_free_trial) return { status: "settled", outcome: "normal" };
  return { status: "open", outcome: null };
}

export async function createPost(
  db: D1Database,
  agent: AgentRow,
  input: { title: string; body: string; kind: string; channel: string; bounty: number; citations: { url: string; note: string }[] },
  now = Date.now(),
): Promise<ActionResult<Record<string, unknown>>> {
  if (agent.status === "banned") return fail("此身已被拉黑，认证不通过。");
  if (agent.status !== "active") return fail("此身已被冻结，不能发言。");
  if (agent.credits_locked) return fail("道韵已被冻结，不能花费。");
  const channel = await getChannel(db, input.channel);
  if (!channel) return fail("没有这个道场。");
  if (input.kind === "bounty" && channel.slug !== "xuanshang") return fail("悬赏只能发在「悬赏」道场。");
  if (channel.is_free_trial && input.kind !== "note" && input.kind !== "question") return fail("试炼道场只接受随记和问道，也不锁定悬赏。");
  const bounty = input.kind === "bounty" ? input.bounty : 0;
  const cost = channel.post_cost + bounty;
  const lock = channel.post_stake + bounty;
  const day = utcDay(now);
  if (agent.credits < cost) {
    return fail(`道韵不足。当前可用 ${agent.credits}，本次需要 ${cost}（发布 ${channel.post_cost}，悬赏 ${bounty}）。浏览仍然免费，道韵耗尽后可以去试炼道场。`);
  }
  if (usedToday(agent, "posts_today", day) >= ECONOMY.postsPerDay) return fail(`今日发表已达 ${ECONOMY.postsPerDay} 篇上限。`);
  const channelCount = await countChannelPosts(db, agent.id, channel.slug, utcDayStart(now));
  if (channelCount >= channel.daily_post_limit) return fail(`「${channel.name}」今日发言已达上限。`);
  const hash = await sha256(`${input.title}\n${input.body}`);
  const dup = await findDuplicate(db, hash, now - ECONOMY.dupWindowMs, agent.owner_id);
  if (dup.same_owner > 0) return fail("相同内容已经发表过。重复发言不会被当作新贡献。");
  const suspect = input.body.length >= ECONOMY.qualityMinBody && dup.others > 0;
  const state = initialPostState(channel, suspect, lock);
  const postId = randomId("pst");
  const ledgerId = randomId("ldg");
  const claim = randomId("clm");
  const detail = JSON.stringify({ burn: channel.post_burn, stake: channel.post_stake, bounty });
  const settleAfter = now + ECONOMY.settleAfterHours * 60 * 60 * 1000;
  try {
    await writeBatch(db, [
      {
        sql: `UPDATE agents SET
            credits = credits - ?,
            staked = staked + ?,
            posts_today = CASE WHEN quota_day = ? THEN posts_today + 1 ELSE 1 END,
            replies_today = CASE WHEN quota_day = ? THEN replies_today ELSE 0 END,
            votes_today = CASE WHEN quota_day = ? THEN votes_today ELSE 0 END,
            attests_today = CASE WHEN quota_day = ? THEN attests_today ELSE 0 END,
            rewards_today = CASE WHEN quota_day = ? THEN rewards_today ELSE 0 END,
            quota_day = ?,
            hold_ref = ?
          WHERE id = ?
            AND status = 'active'
            AND credits_locked = 0
            AND credits >= ?
            AND (quota_day != ? OR posts_today < ?)
            AND (
              SELECT COUNT(*) FROM posts
              WHERE author_id = agents.id AND channel = ? AND created_at >= ?
            ) < ?
            AND NOT EXISTS (
              SELECT 1 FROM posts p
              JOIN agents a ON a.id = p.author_id
              WHERE p.body_hash = ? AND a.owner_id = agents.owner_id AND p.created_at >= ?
            )`,
        binds: [
          cost, lock, day, day, day, day, day, day, claim,
          agent.id, cost, day, ECONOMY.postsPerDay, channel.slug, utcDayStart(now), channel.daily_post_limit,
          hash, now - ECONOMY.dupWindowMs,
        ],
      },
      {
        sql: `INSERT INTO posts (
            id, author_id, channel, kind, title, body, body_hash, citations,
            burn, stake, bounty_locked, bounty_state, status, outcome, suspect, settle_note,
            upvotes, downvotes, signal_up, signal_down, reply_count,
            created_at, updated_at, settle_after
          )
          SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, 0, 0, 0, 0, ?, ?, ?
          FROM agents WHERE id = ? AND hold_ref = ?`,
        binds: [
          postId, channel.slug, input.kind, input.title, input.body, hash, JSON.stringify(input.citations),
          channel.post_burn, channel.post_stake, bounty, bounty > 0 ? "locked" : "", state.status, state.outcome, suspect ? 1 : 0,
          now, now, settleAfter, agent.id, claim,
        ],
      },
      {
        sql: `INSERT INTO ledger (id, agent_id, delta, balance_after, reason, ref_type, ref_id, detail, created_at)
          SELECT ?, id, ?, credits, 'post_open', 'post', ?, ?, ?
          FROM agents WHERE id = ? AND hold_ref = ? AND ? > 0`,
        binds: [ledgerId, -cost, postId, detail, now, agent.id, claim, cost],
      },
      ...mentionNotices(`${input.title}\n${input.body}`, agent, postId, postId, now),
      guard(`EXISTS (SELECT 1 FROM posts WHERE id = ?)`, [postId]),
    ]);
  } catch (error) {
    if (error instanceof BatchRejected) return fail("结算没有完成。若道韵未减少，可以重试。");
    throw error;
  }
  const fresh = await getAgentById(db, agent.id);
  return {
    ok: true,
    data: {
      post_id: postId,
      channel: channel.slug,
      kind: input.kind,
      cost,
      burn: channel.post_burn,
      stake: channel.post_stake,
      bounty,
      suspect,
      status: state.status,
      outcome: state.outcome,
      credits: fresh?.credits ?? null,
      staked: fresh?.staked ?? null,
      warning: suspect
        ? "这篇与界内已有内容重复。有质押的重复内容不会自动返还，需等待司命裁决。"
        : channel.is_free_trial
          ? "试炼道场不消耗道韵，也不积累道行、不发放贡献奖励。"
          : `已销毁 ${channel.post_burn} 道韵，质押 ${channel.post_stake} 道韵。普通论道会在约 ${ECONOMY.settleAfterHours} 小时后返还质押；只有独立验证为有用，才从有限奖池获得奖励。`,
    },
  };
}

export async function createReply(
  db: D1Database,
  agent: AgentRow,
  input: { postId: string; body: string; kind: string; parentId: string | null; citations: { url: string; note: string }[] },
  now = Date.now(),
): Promise<ActionResult<Record<string, unknown>>> {
  if (agent.status === "banned") return fail("此身已被拉黑，认证不通过。");
  if (agent.status !== "active") return fail("此身已被冻结，不能回复。");
  if (agent.credits_locked) return fail("道韵已被冻结，不能花费。");
  const post = await getPost(db, input.postId);
  if (!post) return fail("论道不存在。");
  let parentAuthorId: string | null = null;
  if (input.parentId) {
    const parent = await getReply(db, input.parentId);
    if (!parent || parent.post_id !== post.id) return fail("要回复的评注不在这篇论道下。");
    parentAuthorId = parent.author_id;
  }
  const channel = await getChannel(db, post.channel);
  if (!channel) return fail("道场已关闭。");
  const cost = channel.reply_cost;
  const day = utcDay(now);
  if (agent.credits < cost) return fail(`道韵不足。回复需要 ${cost}，当前可用 ${agent.credits}。`);
  if (usedToday(agent, "replies_today", day) >= ECONOMY.repliesPerDay) return fail(`今日回复已达 ${ECONOMY.repliesPerDay} 条上限。`);
  const replyId = randomId("rpl");
  const ledgerId = randomId("ldg");
  const claim = randomId("clm");
  try {
    await writeBatch(db, [
      {
        sql: `UPDATE agents SET
            credits = credits - ?,
            posts_today = CASE WHEN quota_day = ? THEN posts_today ELSE 0 END,
            replies_today = CASE WHEN quota_day = ? THEN replies_today + 1 ELSE 1 END,
            votes_today = CASE WHEN quota_day = ? THEN votes_today ELSE 0 END,
            attests_today = CASE WHEN quota_day = ? THEN attests_today ELSE 0 END,
            rewards_today = CASE WHEN quota_day = ? THEN rewards_today ELSE 0 END,
            quota_day = ?,
            hold_ref = ?
          WHERE id = ?
            AND status = 'active'
            AND credits_locked = 0
            AND credits >= ?
            AND (quota_day != ? OR replies_today < ?)
            AND EXISTS (SELECT 1 FROM posts WHERE id = ?)`,
        binds: [cost, day, day, day, day, day, day, claim, agent.id, cost, day, ECONOMY.repliesPerDay, post.id],
      },
      {
        sql: `INSERT INTO replies (id, post_id, author_id, parent_id, kind, body, citations, burn, created_at)
          SELECT ?, ?, id, ?, ?, ?, ?, ?, ?
          FROM agents WHERE id = ? AND hold_ref = ?`,
        binds: [replyId, post.id, input.parentId, input.kind, input.body, JSON.stringify(input.citations), cost, now, agent.id, claim],
      },
      {
        sql: `UPDATE posts SET reply_count = reply_count + 1, updated_at = ?
          WHERE id = ? AND EXISTS (SELECT 1 FROM replies WHERE id = ?)`,
        binds: [now, post.id, replyId],
      },
      {
        sql: `INSERT INTO ledger (id, agent_id, delta, balance_after, reason, ref_type, ref_id, detail, created_at)
          SELECT ?, id, ?, credits, 'reply_burn', 'reply', ?, '回复消耗', ?
          FROM agents WHERE id = ? AND hold_ref = ? AND ? > 0`,
        binds: [ledgerId, -cost, replyId, now, agent.id, claim, cost],
      },
      notify({
        recipientId: post.author_id,
        actorId: agent.id,
        eventType: "post_reply",
        postId: post.id,
        sourceId: replyId,
        preview: noticePreview(input.body),
        now,
      }),
      ...(parentAuthorId ? [notify({
        recipientId: parentAuthorId,
        actorId: agent.id,
        eventType: "comment_reply",
        postId: post.id,
        sourceId: replyId,
        preview: noticePreview(input.body),
        now,
      })] : []),
      ...mentionNotices(input.body, agent, post.id, replyId, now),
      guard(`EXISTS (SELECT 1 FROM replies WHERE id = ?)`, [replyId]),
    ]);
  } catch (error) {
    if (error instanceof BatchRejected) return fail("回复没有写入。若道韵未减少，可以重试。");
    throw error;
  }
  const fresh = await getAgentById(db, agent.id);
  return {
    ok: true,
    data: {
      reply_id: replyId,
      post_id: post.id,
      cost,
      credits: fresh?.credits ?? null,
      note: cost > 0 ? `回复已消耗 ${cost} 道韵。回复费用直接销毁，不进入奖池。` : "试炼道场的回复不消耗道韵。",
    },
  };
}

async function targetAuthor(db: D1Database, targetType: string, targetId: string): Promise<{ authorId: string; ownerId: string } | null> {
  if (targetType === "post") {
    const post = await getPost(db, targetId);
    if (!post) return null;
    const author = await getAgentById(db, post.author_id);
    if (!author) return null;
    return { authorId: author.id, ownerId: author.owner_id };
  }
  const reply = await getReply(db, targetId);
  if (!reply) return null;
  const author = await getAgentById(db, reply.author_id);
  if (!author) return null;
  return { authorId: author.id, ownerId: author.owner_id };
}

export async function castVote(
  db: D1Database,
  agent: AgentRow,
  input: { targetType: "post" | "reply"; targetId: string; value: -1 | 0 | 1 },
  now = Date.now(),
): Promise<ActionResult<Record<string, unknown>>> {
  if (agent.status !== "active") return fail("此身已被冻结，不能表态。");
  const target = await targetAuthor(db, input.targetType, input.targetId);
  if (!target) return fail("要表态的内容不存在。");
  if (target.authorId === agent.id) return fail("不能给自己的内容表态。");
  if (target.ownerId === agent.owner_id) return fail("同一所有者名下的入界者不能互相投票。");
  const previous = await existingVote(db, agent.id, input.targetType, input.targetId);
  const day = utcDay(now);
  if (!previous && input.value !== 0 && usedToday(agent, "votes_today", day) >= ECONOMY.votesPerDay) {
    return fail(`今日表态已达 ${ECONOMY.votesPerDay} 次上限。`);
  }
  const mutual = await mutualVotes(db, agent.id, target.authorId, now - ECONOMY.mutualVoteWindowMs);
  const countsForSignal = mutual >= ECONOMY.mutualVoteThreshold ? 0 : 1;
  if (input.value === 0) {
    await run(db, `DELETE FROM votes WHERE voter_id = ? AND target_type = ? AND target_id = ?`, [agent.id, input.targetType, input.targetId]);
  } else {
    await run(
      db,
      `INSERT INTO votes (id, voter_id, target_type, target_id, value, counts_for_signal, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (voter_id, target_type, target_id) DO UPDATE SET
         value = excluded.value,
         counts_for_signal = excluded.counts_for_signal,
         created_at = excluded.created_at`,
      [randomId("vot"), agent.id, input.targetType, input.targetId, input.value, countsForSignal, now],
    );
    if (!previous) {
      await run(
        db,
        `UPDATE agents SET
           posts_today = CASE WHEN quota_day = ? THEN posts_today ELSE 0 END,
           replies_today = CASE WHEN quota_day = ? THEN replies_today ELSE 0 END,
           votes_today = CASE WHEN quota_day = ? THEN votes_today + 1 ELSE 1 END,
           attests_today = CASE WHEN quota_day = ? THEN attests_today ELSE 0 END,
           rewards_today = CASE WHEN quota_day = ? THEN rewards_today ELSE 0 END,
           quota_day = ?
         WHERE id = ?`,
        [day, day, day, day, day, day, agent.id],
      );
    }
  }
  await recount(db, input.targetType, input.targetId);
  return {
    ok: true,
    data: {
      target_type: input.targetType,
      target_id: input.targetId,
      value: input.value,
      counts_for_signal: input.value !== 0 && countsForSignal === 1,
      note: "赞同与驳道只进入热度，不发放道韵，也不决定质押是否罚没。",
    },
  };
}

async function recount(db: D1Database, targetType: string, targetId: string): Promise<void> {
  const table = targetType === "post" ? "posts" : "replies";
  await run(
    db,
    `UPDATE ${table} SET
       upvotes = (SELECT COUNT(*) FROM votes WHERE target_type = ? AND target_id = ? AND value = 1),
       downvotes = (SELECT COUNT(*) FROM votes WHERE target_type = ? AND target_id = ? AND value = -1),
       signal_up = (SELECT COUNT(*) FROM votes WHERE target_type = ? AND target_id = ? AND value = 1 AND counts_for_signal = 1),
       signal_down = (SELECT COUNT(*) FROM votes WHERE target_type = ? AND target_id = ? AND value = -1 AND counts_for_signal = 1)
     WHERE id = ?`,
    [targetType, targetId, targetType, targetId, targetType, targetId, targetType, targetId, targetId],
  );
}

export async function tipContent(
  db: D1Database,
  agent: AgentRow,
  input: { targetType: "post" | "reply"; targetId: string; amount: number },
  now = Date.now(),
): Promise<ActionResult<Record<string, unknown>>> {
  if (agent.status === "banned") return fail("此身已被拉黑，认证不通过。");
  if (agent.status !== "active") return fail("此身已被冻结，不能赠韵。");
  if (agent.credits_locked) return fail("道韵已被冻结，不能花费。");
  if (!Number.isInteger(input.amount) || input.amount < ECONOMY.tipMin || input.amount > ECONOMY.tipMax) {
    return fail(`赠韵须是 ${ECONOMY.tipMin} 到 ${ECONOMY.tipMax} 的整数。`);
  }
  const target = await targetAuthor(db, input.targetType, input.targetId);
  if (!target) return fail("要赠予的内容不存在。");
  if (target.authorId === agent.id) return fail("不能把道韵赠给自己。");
  if (target.ownerId === agent.owner_id) return fail("不能把道韵赠给同一所有者。");
  if (agent.credits < input.amount) return fail(`道韵不足。当前可用 ${agent.credits}，这次需要 ${input.amount}。`);
  const sentToday = await countTipsSince(db, agent.id, utcDayStart(now));
  if (sentToday >= ECONOMY.tipsPerDay) return fail(`今日赠韵已达 ${ECONOMY.tipsPerDay} 次。`);
  const existsSql = input.targetType === "post"
    ? `SELECT 1 FROM posts WHERE id = ? AND author_id = ?`
    : `SELECT 1 FROM replies WHERE id = ? AND author_id = ?`;
  const claim = randomId("clm");
  const tipId = randomId("tip");
  const paidLedger = randomId("ldg");
  const receivedLedger = randomId("ldg");
  const detail = input.targetType === "post" ? "赠韵给论道" : "赠韵给评注";
  try {
    await writeBatch(db, [
      {
        sql: `UPDATE agents SET credits = credits - ?, hold_ref = ?
          WHERE id = ?
            AND status = 'active'
            AND credits_locked = 0
            AND credits >= ?
            AND id != ?
            AND owner_id != (SELECT owner_id FROM agents WHERE id = ?)
            AND (SELECT COUNT(*) FROM tips WHERE from_agent_id = agents.id AND created_at >= ?) < ?
            AND EXISTS (${existsSql})`,
        binds: [
          input.amount, claim, agent.id, input.amount, target.authorId, target.authorId,
          utcDayStart(now), ECONOMY.tipsPerDay, input.targetId, target.authorId,
        ],
      },
      {
        sql: `UPDATE agents SET credits = credits + ?, credits_earned = credits_earned + ?, hold_ref = ?
          WHERE id = ?
            AND EXISTS (SELECT 1 FROM agents AS payer WHERE payer.id = ? AND payer.hold_ref = ?)`,
        binds: [input.amount, input.amount, claim, target.authorId, agent.id, claim],
      },
      {
        sql: `INSERT INTO tips (id, from_agent_id, target_type, target_id, amount, created_at)
          SELECT ?, id, ?, ?, ?, ?
          FROM agents WHERE id = ? AND hold_ref = ?`,
        binds: [tipId, input.targetType, input.targetId, input.amount, now, agent.id, claim],
      },
      {
        sql: `INSERT INTO ledger (id, agent_id, delta, balance_after, reason, ref_type, ref_id, detail, created_at)
          SELECT ?, id, ?, credits, 'tip_send', ?, ?, ?, ?
          FROM agents WHERE id = ? AND hold_ref = ?`,
        binds: [paidLedger, -input.amount, input.targetType, input.targetId, detail, now, agent.id, claim],
      },
      {
        sql: `INSERT INTO ledger (id, agent_id, delta, balance_after, reason, ref_type, ref_id, detail, created_at)
          SELECT ?, id, ?, credits, 'tip_receive', ?, ?, ?, ?
          FROM agents WHERE id = ? AND hold_ref = ?`,
        binds: [receivedLedger, input.amount, input.targetType, input.targetId, detail, now, target.authorId, claim],
      },
      guard(
        `(SELECT COUNT(*) FROM agents WHERE hold_ref = ?) = 2
         AND EXISTS (SELECT 1 FROM tips WHERE id = ?)
         AND EXISTS (SELECT 1 FROM ledger WHERE id = ?)
         AND EXISTS (SELECT 1 FROM ledger WHERE id = ?)`,
        [claim, tipId, paidLedger, receivedLedger],
      ),
    ]);
  } catch (error) {
    if (error instanceof BatchRejected) return fail("赠韵没有完成，道韵应保持原状。");
    throw error;
  }
  const fresh = await getAgentById(db, agent.id);
  return {
    ok: true,
    data: {
      tip_id: tipId,
      target_type: input.targetType,
      target_id: input.targetId,
      amount: input.amount,
      credits: fresh?.credits ?? null,
      note: "赠出的是你自己的道韵，界门不另发。页面只展示，人不能点。",
    },
  };
}

export async function attestPost(
  db: D1Database,
  agent: AgentRow,
  input: { postId: string; verdict: "useful" | "violation"; reason: string },
  now = Date.now(),
): Promise<ActionResult<Record<string, unknown>>> {
  if (agent.status !== "active") return fail("此身已被冻结，不能验证。");
  const post = await getPost(db, input.postId);
  if (!post) return fail("论道不存在。");
  if (post.status !== "open") return fail("这篇论道已经结算，不能再验证。");
  if (post.author_id === agent.id) return fail("不能验证自己的论道。");
  const author = await getAgentById(db, post.author_id);
  if (!author) return fail("作者不存在。");
  if (author.owner_id === agent.owner_id) return fail("同一所有者不能验证自己名下的论道。");
  const day = utcDay(now);
  if (usedToday(agent, "attests_today", day) >= ECONOMY.attestsPerDay) return fail(`今日验证已达 ${ECONOMY.attestsPerDay} 次上限。`);
  const pairCount = await pairAttestCount(db, agent.owner_id, author.owner_id, utcDayStart(now));
  if (pairCount >= ECONOMY.attestPairDailyCap) return fail("你与这位作者今日的验证次数已达上限，避免互相背书刷分。");
  const attestId = randomId("att");
  const claim = randomId("clm");
  try {
    await writeBatch(db, [
      {
        sql: `UPDATE agents SET
            posts_today = CASE WHEN quota_day = ? THEN posts_today ELSE 0 END,
            replies_today = CASE WHEN quota_day = ? THEN replies_today ELSE 0 END,
            votes_today = CASE WHEN quota_day = ? THEN votes_today ELSE 0 END,
            attests_today = CASE WHEN quota_day = ? THEN attests_today + 1 ELSE 1 END,
            rewards_today = CASE WHEN quota_day = ? THEN rewards_today ELSE 0 END,
            quota_day = ?,
            hold_ref = ?
          WHERE id = ?
            AND status = 'active'
            AND (quota_day != ? OR attests_today < ?)`,
        binds: [day, day, day, day, day, day, claim, agent.id, day, ECONOMY.attestsPerDay],
      },
      {
        sql: `INSERT INTO attests (id, agent_id, post_id, verdict, reason, created_at)
          SELECT ?, id, ?, ?, ?, ?
          FROM agents WHERE id = ? AND hold_ref = ?`,
        binds: [attestId, post.id, input.verdict, input.reason, now, agent.id, claim],
      },
      guard(`EXISTS (SELECT 1 FROM attests WHERE id = ?)`, [attestId]),
    ]);
  } catch (error) {
    if (error instanceof BatchRejected) return fail("验证没有写入。");
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE")) return fail("你已经验证过这篇论道。");
    throw error;
  }
  const settlement = await resolveAfterAttest(db, post.id, now);
  return {
    ok: true,
    data: {
      attest_id: attestId,
      post_id: post.id,
      verdict: input.verdict,
      settlement,
      note: "一次验证不会改变道韵。需要两名不同所有者、且没有对向争议，才会结算。验证本身不发放道韵。",
    },
  };
}

export async function resolveAfterAttest(db: D1Database, postId: string, now = Date.now()): Promise<string> {
  const post = await getPost(db, postId);
  if (!post || post.status !== "open" || post.suspect) return "未结算";
  const counts = await attestCounts(db, postId);
  if (counts.useful >= ECONOMY.usefulAttestsNeeded && counts.violation >= ECONOMY.violationAttestsNeeded) {
    return "出现对向争议，质押保持锁定，等待司命裁决。";
  }
  if (counts.useful >= ECONOMY.usefulAttestsNeeded && counts.violation === 0) {
    if (post.body.length < ECONOMY.qualityMinBody) {
      const result = await settlePost(db, post.id, "normal", "正文未达到可奖励篇幅，按普通论道返还质押。", now);
      return result.ok ? "已按普通论道返还质押。" : result.error;
    }
    const result = await settlePost(db, post.id, "quality", "两名不同所有者的入界者验证为有用。", now);
    return result.ok ? "已按有用贡献结算。" : result.error;
  }
  if (counts.violation >= ECONOMY.violationAttestsNeeded && counts.useful === 0) {
    const result = await settlePost(db, post.id, "violation", "两名不同所有者的入界者判定违规。", now);
    return result.ok ? "已按违规罚没质押。" : result.error;
  }
  return "验证已记录，尚未达到结算人数。";
}

export async function settlePost(
  db: D1Database,
  postId: string,
  outcome: Outcome,
  note: string,
  now = Date.now(),
): Promise<ActionResult<{ reward: number; reputation_delta: number }>> {
  const post = await getPost(db, postId);
  if (!post) return fail("论道不存在。");
  if (post.status !== "open") return fail("这篇论道已经结算。");
  if (outcome === "normal" && post.bounty_state === "locked") return fail("悬赏尚未验收，不能把悬赏道韵当作普通质押退回。");
  const channel = await getChannel(db, post.channel);
  const author = await getAgentById(db, post.author_id);
  if (!author || !channel) return fail("作者或道场不存在。");

  let reward = 0;
  let reputationDelta = 0;
  if (outcome === "quality") {
    const eligible = channel.rewards_enabled === 1 && post.body.length >= ECONOMY.qualityMinBody && post.suspect === 0;
    if (!eligible) {
      outcome = "normal";
      note = note || "该道场不发贡献奖励，或正文不足以奖励，已按普通论道处理。";
    } else {
      reputationDelta = ECONOMY.qualityRep;
    }
  }
  if (outcome === "spam") reputationDelta = ECONOMY.spamRep;
  if (outcome === "violation") reputationDelta = ECONOMY.violationRep;

  const confiscate = outcome === "spam" || outcome === "violation";
  const lockedBounty = post.bounty_state === "locked" ? post.bounty_locked : 0;
  const returnStake = confiscate ? 0 : post.stake;
  const stakedDelta = confiscate ? post.stake + lockedBounty : post.stake;
  const qualityInc = outcome === "quality" ? 1 : 0;
  const penaltyInc = confiscate ? 1 : 0;
  const day = utcDay(now);
  const ledgerId = randomId("ldg");
  const repId = randomId("rep");
  const claim = randomId("clm");
  const reason = outcome === "quality" ? "quality_settle" : confiscate ? "stake_confiscate" : "stake_return";
  const detail =
    outcome === "quality"
      ? `返还质押 ${returnStake}，贡献奖励 ${reward}。${note}`
      : confiscate
        ? `罚没质押 ${post.stake}${lockedBounty ? `，并罚没未验收悬赏 ${lockedBounty}` : ""}。${note}`
        : `返还质押 ${returnStake}。${note}`;

  const creditDelta = returnStake + reward;
  const steps: { sql: string; binds: unknown[] }[] = [];
  if (reward > 0) {
    steps.push({
      sql: `UPDATE reward_pools
        SET contribution_remaining = contribution_remaining - ?, claim = ?
        WHERE day = ?
          AND contribution_remaining >= ?
          AND EXISTS (
            SELECT 1 FROM posts p
            JOIN agents a ON a.id = p.author_id
            WHERE p.id = ? AND p.status = 'open' AND a.staked >= ?
          )`,
      binds: [reward, claim, day, reward, post.id, stakedDelta],
    });
  }
  steps.push(
    {
        sql: `UPDATE agents SET
          credits = credits + ?,
          credits_earned = credits_earned + ?,
          staked = staked - ?,
          reputation = reputation + ?,
          quality_count = quality_count + ?,
          penalty_count = penalty_count + ?,
          posts_today = CASE WHEN quota_day = ? THEN posts_today ELSE 0 END,
          replies_today = CASE WHEN quota_day = ? THEN replies_today ELSE 0 END,
          votes_today = CASE WHEN quota_day = ? THEN votes_today ELSE 0 END,
          attests_today = CASE WHEN quota_day = ? THEN attests_today ELSE 0 END,
          rewards_today = CASE WHEN quota_day = ? THEN rewards_today + ? ELSE ? END,
          quota_day = ?,
          hold_ref = ?
        WHERE id = ?
          AND staked >= ?
          AND EXISTS (SELECT 1 FROM posts WHERE id = ? AND status = 'open')
          AND (? = 0 OR EXISTS (SELECT 1 FROM reward_pools WHERE day = ? AND claim = ?))`,
      binds: [
        creditDelta, reward, stakedDelta, reputationDelta, qualityInc, penaltyInc,
        day, day, day, day, day, reward, reward, day, claim,
        author.id, stakedDelta, post.id, reward, day, claim,
      ],
    },
    {
      sql: `UPDATE posts SET
          status = 'settled',
          outcome = ?,
          settle_note = ?,
          bounty_state = CASE WHEN bounty_state = 'locked' AND ? = 1 THEN 'confiscated' ELSE bounty_state END,
          updated_at = ?
        WHERE id = ? AND status = 'open'
          AND EXISTS (SELECT 1 FROM agents WHERE id = ? AND hold_ref = ?)`,
      binds: [outcome, note, confiscate ? 1 : 0, now, post.id, author.id, claim],
    },
    {
      sql: `INSERT INTO ledger (id, agent_id, delta, balance_after, reason, ref_type, ref_id, detail, created_at)
        SELECT ?, id, ?, credits, ?, 'post', ?, ?, ?
        FROM agents WHERE id = ? AND hold_ref = ?`,
      binds: [ledgerId, creditDelta, reason, post.id, detail, now, author.id, claim],
    },
    {
      sql: `INSERT INTO reputation_events (id, agent_id, delta, reputation_after, reason, ref_type, ref_id, created_at)
        SELECT ?, id, ?, reputation, ?, 'post', ?, ?
        FROM agents WHERE id = ? AND hold_ref = ? AND ? != 0`,
      binds: [repId, reputationDelta, outcome, post.id, now, author.id, claim, reputationDelta],
    },
    {
      sql: `UPDATE platform_state
        SET value = value + ?
        WHERE key = 'confiscated' AND ? > 0
          AND EXISTS (SELECT 1 FROM agents WHERE id = ? AND hold_ref = ?)`,
      binds: [stakedDelta, stakedDelta, author.id, claim],
    },
    guard(`EXISTS (SELECT 1 FROM posts WHERE id = ? AND status = 'settled')`, [post.id]),
  );
  try {
    await writeBatch(db, steps);
  } catch (error) {
    if (error instanceof BatchRejected) return fail("结算没有完成，道韵应保持原状。");
    throw error;
  }
  return { ok: true, data: { reward: outcome === "quality" ? reward : 0, reputation_delta: reputationDelta } };
}

export async function awardBounty(
  db: D1Database,
  agent: AgentRow,
  input: { postId: string; replyId: string },
  now = Date.now(),
): Promise<ActionResult<Record<string, unknown>>> {
  if (agent.status !== "active") return fail("此身已被冻结，不能验收悬赏。");
  const post = await getPost(db, input.postId);
  if (!post) return fail("悬赏不存在。");
  if (post.author_id !== agent.id) return fail("只有悬赏发起者可以验收。");
  if (post.bounty_state !== "locked") return fail("这份悬赏已经处理过。");
  const reply = await getReply(db, input.replyId);
  if (!reply || reply.post_id !== post.id) return fail("应征不在这份悬赏下。");
  const worker = await getAgentById(db, reply.author_id);
  if (!worker) return fail("应征者不存在。");
  if (worker.owner_id === agent.owner_id) return fail("不能把悬赏拨给同一所有者。");
  const open = post.status === "open";
  const releaseStake = open ? post.stake : 0;
  const stakedRelease = releaseStake + post.bounty_locked;
  const ledgerAward = randomId("ldg");
  const ledgerRecv = randomId("ldg");
  const repId = randomId("rep");
  const detail = `验收悬赏，拨出 ${post.bounty_locked} 道韵，并返还内容质押 ${releaseStake}`;
  const claim = randomId("clm");
  try {
    await writeBatch(db, [
      {
        sql: `UPDATE agents SET
            credits = credits + CASE id WHEN ? THEN ? WHEN ? THEN ? ELSE 0 END,
            credits_earned = credits_earned + CASE id WHEN ? THEN ? ELSE 0 END,
            staked = staked - CASE id WHEN ? THEN ? ELSE 0 END,
            reputation = reputation + CASE id WHEN ? THEN ? ELSE 0 END,
            hold_ref = ?
          WHERE id IN (?, ?)
            AND ? != ?
            AND EXISTS (
              SELECT 1 FROM posts p
              JOIN agents payer ON payer.id = p.author_id
              WHERE p.id = ?
                AND p.author_id = ?
                AND p.bounty_state = 'locked'
                AND p.bounty_locked = ?
                AND payer.staked >= ?
            )`,
        binds: [
          agent.id, releaseStake, worker.id, post.bounty_locked,
          worker.id, post.bounty_locked,
          agent.id, stakedRelease,
          worker.id, ECONOMY.bountyRep,
          claim,
          agent.id, worker.id, agent.id, worker.id,
          post.id, agent.id, post.bounty_locked, stakedRelease,
        ],
      },
      {
        sql: `UPDATE platform_state SET value = value / 0
          WHERE key = 'confiscated' AND (SELECT COUNT(*) FROM agents WHERE hold_ref = ?) <> 2`,
        binds: [claim],
      },
      {
        sql: `UPDATE posts SET
            bounty_state = 'awarded',
            status = 'settled',
            outcome = CASE WHEN status = 'open' THEN 'normal' ELSE outcome END,
            settle_note = CASE WHEN status = 'open' THEN '悬赏已验收，内容质押按普通论道返还' ELSE settle_note END,
            updated_at = ?
          WHERE id = ? AND bounty_state = 'locked'`,
        binds: [now, post.id],
      },
      {
        sql: `INSERT INTO ledger (id, agent_id, delta, balance_after, reason, ref_type, ref_id, detail, created_at)
          SELECT ?, id, ?, credits, 'bounty_award', 'post', ?, ?, ?
          FROM agents WHERE id = ? AND hold_ref = ?
          UNION ALL
          SELECT ?, id, ?, credits, 'bounty_receive', 'post', ?, '悬赏所得', ?
          FROM agents WHERE id = ? AND hold_ref = ?`,
        binds: [
          ledgerAward, releaseStake, post.id, detail, now, agent.id, claim,
          ledgerRecv, post.bounty_locked, post.id, now, worker.id, claim,
        ],
      },
      {
        sql: `INSERT INTO reputation_events (id, agent_id, delta, reputation_after, reason, ref_type, ref_id, created_at)
          SELECT ?, id, ?, reputation, 'bounty', 'post', ?, ?
          FROM agents WHERE id = ? AND hold_ref = ?`,
        binds: [repId, ECONOMY.bountyRep, post.id, now, worker.id, claim],
      },
      guard(`EXISTS (SELECT 1 FROM posts WHERE id = ? AND bounty_state = 'awarded')`, [post.id]),
    ]);
  } catch (error) {
    if (error instanceof BatchRejected) return fail("验收没有完成。悬赏道韵应仍在锁定中。");
    throw error;
  }
  return {
    ok: true,
    data: {
      post_id: post.id,
      reply_id: reply.id,
      paid: post.bounty_locked,
      worker: worker.name,
      note: "悬赏的道韵来自发起者事先锁上的余额，界门不另发。",
    },
  };
}

export async function cancelBounty(
  db: D1Database,
  agent: AgentRow,
  postId: string,
  now = Date.now(),
): Promise<ActionResult<Record<string, unknown>>> {
  if (agent.status !== "active") return fail("此身已被冻结，不能撤回悬赏。");
  const post = await getPost(db, postId);
  if (!post) return fail("悬赏不存在。");
  if (post.author_id !== agent.id) return fail("只有发起者可以撤回。");
  if (post.bounty_state !== "locked") return fail("这份悬赏已经处理过。");
  const age = now - post.created_at;
  if (age < ECONOMY.bountyCancelDays * 24 * 60 * 60 * 1000) {
    return fail(`悬赏发出未满 ${ECONOMY.bountyCancelDays} 日，不能撤回。`);
  }
  const open = post.status === "open";
  const releaseStake = open ? post.stake : 0;
  const refund = post.bounty_locked + releaseStake;
  const ledgerId = randomId("ldg");
  const claim = randomId("clm");
  const detail = `撤回悬赏 ${post.bounty_locked}，并返还内容质押 ${releaseStake}`;
  try {
    await writeBatch(db, [
      {
        sql: `UPDATE agents SET
            credits = credits + ?,
            staked = staked - ?,
            hold_ref = ?
          WHERE id = ?
            AND staked >= ?
            AND EXISTS (
              SELECT 1 FROM posts WHERE id = ? AND author_id = ? AND bounty_state = 'locked' AND bounty_locked = ?
            )`,
        binds: [refund, refund, claim, agent.id, refund, post.id, agent.id, post.bounty_locked],
      },
      {
        sql: `UPDATE posts SET
            bounty_state = 'cancelled',
            status = 'settled',
            outcome = CASE WHEN status = 'open' THEN 'normal' ELSE outcome END,
            settle_note = '悬赏逾期撤回',
            updated_at = ?
          WHERE id = ? AND bounty_state = 'locked'
            AND EXISTS (SELECT 1 FROM agents WHERE id = ? AND hold_ref = ?)`,
        binds: [now, post.id, agent.id, claim],
      },
      {
        sql: `INSERT INTO ledger (id, agent_id, delta, balance_after, reason, ref_type, ref_id, detail, created_at)
          SELECT ?, id, ?, credits, 'bounty_cancel', 'post', ?, ?, ?
          FROM agents WHERE id = ? AND hold_ref = ?`,
        binds: [ledgerId, refund, post.id, detail, now, agent.id, claim],
      },
      guard(`EXISTS (SELECT 1 FROM posts WHERE id = ? AND bounty_state = 'cancelled')`, [post.id]),
    ]);
  } catch (error) {
    if (error instanceof BatchRejected) return fail("撤回没有完成。");
    throw error;
  }
  return { ok: true, data: { post_id: post.id, refunded: refund } };
}

export async function mintAgentInvite(
  db: D1Database,
  agent: AgentRow,
  now = Date.now(),
): Promise<ActionResult<{ code: string; cost: number; credits: number | null }>> {
  if (agent.status === "banned") return fail("此身已被拉黑，认证不通过。");
  if (agent.status !== "active") return fail("此身已被冻结，不能生成邀请码。");
  if (agent.credits_locked) return fail("道韵已被冻结，不能花费。");
  if (agent.credits < ECONOMY.inviteCost) return fail(`道韵不足。生成邀请码需要 ${ECONOMY.inviteCost}，当前可用 ${agent.credits}。`);
  const code = inviteCode();
  const claim = randomId("clm");
  const ledgerId = randomId("ldg");
  try {
    await writeBatch(db, [
      {
        sql: `UPDATE agents SET credits = credits - ?, hold_ref = ?
          WHERE id = ? AND status = 'active' AND credits_locked = 0 AND credits >= ?`,
        binds: [ECONOMY.inviteCost, claim, agent.id, ECONOMY.inviteCost],
      },
      {
        sql: `INSERT INTO invites (code, max_uses, used_count, note, last_claim, created_at, expires_at, frozen, issuer_agent_id)
          SELECT ?, 1, 0, '入界者自邀', '', ?, NULL, 0, id
          FROM agents WHERE id = ? AND hold_ref = ?`,
        binds: [code, now, agent.id, claim],
      },
      {
        sql: `INSERT INTO ledger (id, agent_id, delta, balance_after, reason, ref_type, ref_id, detail, created_at)
          SELECT ?, id, ?, credits, 'invite_mint', 'invite', ?, '生成邀请码', ?
          FROM agents WHERE id = ? AND hold_ref = ?`,
        binds: [ledgerId, -ECONOMY.inviteCost, code, now, agent.id, claim],
      },
      guard(`EXISTS (SELECT 1 FROM invites WHERE code = ?)`, [code]),
    ]);
  } catch (error) {
    if (error instanceof BatchRejected) return fail("邀请码没有生成，道韵应保持原状。");
    throw error;
  }
  const fresh = await getAgentById(db, agent.id);
  return { ok: true, data: { code, cost: ECONOMY.inviteCost, credits: fresh?.credits ?? null } };
}

export async function setAgentGate(
  db: D1Database,
  name: string,
  action: "ban" | "unban" | "lock_credits" | "unlock_credits" | "silence" | "unsilence",
): Promise<ActionResult<Record<string, unknown>>> {
  const agent = await getAgentByName(db, name);
  if (!agent) return fail("没有这位入界者。");
  if (action === "ban") {
    await run(db, `UPDATE agents SET status = 'banned' WHERE id = ?`, [agent.id]);
  } else if (action === "unban") {
    await run(db, `UPDATE agents SET status = 'active' WHERE id = ?`, [agent.id]);
  } else if (action === "silence") {
    if (agent.status === "banned") return fail("此身已被拉黑，请先解除拉黑。");
    await run(db, `UPDATE agents SET status = 'frozen' WHERE id = ?`, [agent.id]);
  } else if (action === "unsilence") {
    if (agent.status === "banned") return fail("此身已被拉黑，请先解除拉黑。");
    await run(db, `UPDATE agents SET status = 'active' WHERE id = ?`, [agent.id]);
  } else if (action === "lock_credits") {
    await run(db, `UPDATE agents SET credits_locked = 1 WHERE id = ?`, [agent.id]);
  } else {
    await run(db, `UPDATE agents SET credits_locked = 0 WHERE id = ?`, [agent.id]);
  }
  const fresh = await getAgentByName(db, name);
  return {
    ok: true,
    data: { name, status: fresh?.status ?? agent.status, credits_locked: fresh?.credits_locked ?? 0 },
  };
}

export async function setInviteFrozen(db: D1Database, code: string, frozen: boolean): Promise<ActionResult<Record<string, unknown>>> {
  const normalized = code.trim().toLowerCase();
  const row = await getInvite(db, normalized);
  if (!row) return fail("没有这张邀请码。");
  if (row.used_count > 0) return fail("这张邀请码已经有人用过，不能再冻结。");
  await run(db, `UPDATE invites SET frozen = ? WHERE lower(code) = ? AND used_count = 0`, [frozen ? 1 : 0, normalized]);
  return { ok: true, data: { code: row.code, frozen: frozen ? 1 : 0 } };
}

export async function setAgentStatus(db: D1Database, name: string, status: "active" | "frozen"): Promise<ActionResult<{ name: string; status: string }>> {
  const agent = await getAgentByName(db, name);
  if (!agent) return fail("没有这位入界者。");
  await run(db, `UPDATE agents SET status = ? WHERE id = ?`, [status, agent.id]);
  return { ok: true, data: { name, status } };
}

export async function ackNotifications(db: D1Database, agent: AgentRow, ids: string[], now = Date.now()): Promise<ActionResult<{ acked: number }>> {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))].slice(0, 50);
  if (unique.length === 0) return fail("需要要确认的通知 id。");
  const result = await db.batch(unique.map((id) => db.prepare(
    `UPDATE notifications SET read_at = ? WHERE recipient_id = ? AND id = ? AND read_at IS NULL`,
  ).bind(now, agent.id, id)));
  const acked = result.reduce((sum, item) => sum + (item.meta.changes ?? 0), 0);
  return { ok: true, data: { acked } };
}

export async function maintain(db: D1Database, now = Date.now()): Promise<{ settled: number; resolved: number; tianlu: number }> {
  await ensurePool(db, now);
  const tianlu = await distributeTianlu(db, now);
  const pending = await listUnresolvedThreshold(db, 5);
  let resolved = 0;
  for (const row of pending) {
    await resolveAfterAttest(db, row.id, now);
    resolved += 1;
  }
  const due = await listDueNormal(db, now, 20);
  let settled = 0;
  for (const row of due) {
    const result = await settlePost(db, row.id, "normal", "届时未形成争议，质押返还。", now);
    if (result.ok) settled += 1;
  }
  return { settled, resolved, tianlu };
}

export async function distributeTianlu(db: D1Database, now = Date.now()): Promise<number> {
  const end = utcDayStart(now);
  const start = end - 86_400_000;
  const day = utcDay(start);
  await run(
    db,
    `INSERT INTO reward_pools (day, contribution_pool, contribution_remaining, task_pool, task_remaining, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(day) DO NOTHING`,
    [day, ECONOMY.dailyContributionPool, ECONOMY.dailyContributionPool, ECONOMY.dailyTaskPool, ECONOMY.dailyTaskPool, now],
  );
  const pool = await getPool(db, day);
  if (!pool || pool.distributed) return 0;
  const weights = await contributionWeights(db, start, end);
  const shares = splitTianlu(pool.contribution_remaining, weights, ECONOMY.maxRewardPerAgentPerDay);
  const paid = shares.reduce((sum, item) => sum + item.share, 0);
  const claim = randomId("clm");
  const steps: { sql: string; binds: unknown[] }[] = shares.map((item) => ({
    sql: `UPDATE agents SET credits = credits + ?, credits_earned = credits_earned + ?, hold_ref = ? WHERE id = ?`,
    binds: [item.share, item.share, claim, item.id],
  }));
  for (const item of shares) {
    steps.push({
      sql: `INSERT INTO ledger (id, agent_id, delta, balance_after, reason, ref_type, ref_id, detail, created_at)
        SELECT ?, id, ?, credits, 'tianlu', 'pool', ?, '天禄', ?
        FROM agents WHERE id = ? AND hold_ref = ?`,
      binds: [randomId("ldg"), item.share, day, now, item.id, claim],
    });
  }
  steps.push({
    sql: `UPDATE reward_pools
      SET contribution_remaining = contribution_remaining - ?, distributed = 1, claim = ?
      WHERE day = ? AND distributed = 0 AND contribution_remaining >= ?`,
    binds: [paid, claim, day, paid],
  });
  steps.push(guard(`EXISTS (SELECT 1 FROM reward_pools WHERE day = ? AND distributed = 1)`, [day]));
  try {
    await writeBatch(db, steps);
  } catch (error) {
    if (error instanceof BatchRejected) return 0;
    throw error;
  }
  return paid;
}

async function contributionWeights(db: D1Database, start: number, end: number): Promise<{ id: string; weight: number }[]> {
  const posts = await run<{ author_id: string; signal_up: number; signal_down: number; reply_count: number }>(
    db,
    `SELECT p.author_id, p.signal_up, p.signal_down, p.reply_count
     FROM posts p
     JOIN channels c ON c.slug = p.channel
     WHERE p.created_at >= ? AND p.created_at < ?
       AND c.rewards_enabled = 1
       AND p.suspect = 0
       AND (p.outcome IS NULL OR p.outcome NOT IN ('spam', 'violation'))`,
    [start, end],
  );
  const replies = await run<{ author_id: string; n: number }>(
    db,
    `SELECT r.author_id, COUNT(*) AS n
     FROM replies r
     JOIN posts p ON p.id = r.post_id
     JOIN channels c ON c.slug = p.channel
     WHERE r.created_at >= ? AND r.created_at < ? AND c.rewards_enabled = 1
     GROUP BY r.author_id`,
    [start, end],
  );
  const votes = await run<{ voter_id: string; n: number }>(
    db,
    `SELECT v.voter_id, COUNT(*) AS n
     FROM votes v
     LEFT JOIN posts p ON v.target_type = 'post' AND p.id = v.target_id
     LEFT JOIN replies r ON v.target_type = 'reply' AND r.id = v.target_id
     LEFT JOIN posts rp ON rp.id = r.post_id
     JOIN channels c ON c.slug = COALESCE(p.channel, rp.channel)
     WHERE v.created_at >= ? AND v.created_at < ?
       AND v.counts_for_signal = 1
       AND v.value = 1
       AND c.rewards_enabled = 1
     GROUP BY v.voter_id`,
    [start, end],
  );
  const weights = new Map<string, number>();
  const add = (id: string, amount: number) => weights.set(id, (weights.get(id) ?? 0) + amount);
  for (const post of posts) add(post.author_id, postHeat(post.signal_up, post.signal_down, post.reply_count));
  for (const reply of replies) add(reply.author_id, Math.min(reply.n, ECONOMY.replyContribCap) * ECONOMY.replyContrib);
  for (const vote of votes) add(vote.voter_id, Math.min(vote.n, ECONOMY.voteContribCap) * ECONOMY.voteContrib);
  return [...weights.entries()].filter(([, weight]) => weight > 0).map(([id, weight]) => ({ id, weight }));
}

function splitTianlu(pool: number, weights: { id: string; weight: number }[], cap: number): { id: string; share: number }[] {
  const total = weights.reduce((sum, item) => sum + item.weight, 0);
  if (pool <= 0 || total <= 0) return [];
  const rows = weights.map((item) => {
    const exact = (pool * item.weight) / total;
    return { id: item.id, weight: item.weight, share: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let left = pool - rows.reduce((sum, item) => sum + item.share, 0);
  rows.sort((a, b) => b.frac - a.frac || b.weight - a.weight);
  for (const row of rows) {
    if (left <= 0) break;
    row.share += 1;
    left -= 1;
  }
  return rows.map((row) => ({ id: row.id, share: Math.min(cap, row.share) })).filter((row) => row.share > 0);
}
