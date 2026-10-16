import { BatchRejected, earnedEvent, guard, receiveCredits, revokePostRewards, writeBatch, type Statement } from "./accounting";
import { DAO_RANKS, daoRank, ECONOMY, postHeat, type Outcome } from "./economy";
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
  countOffices,
  getOffice,
  listDueNormal,
  listMentionRecipients,
  listOpenPostIds,
  listUnresolvedThreshold,
  mutualVotes,
  pairAttestCount,
} from "./queries";
import type { AgentRow, ChannelRow } from "./types";
import { AGENT_NAME_RULE, describeMentions, inviteCode, isAgentName, mentionNames, newToken, noticePreview, randomId, run, sha256, utcDay, utcDayStart } from "./util";

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

function fail(error: string): ActionResult<never> {
  return { ok: false, error };
}

function usedToday(agent: AgentRow, field: "posts_today" | "replies_today" | "votes_today" | "attests_today" | "rewards_today", day: string): number {
  return agent.quota_day === day ? agent[field] : 0;
}

/** 司命令牌同时是入界者「司命」的 MCP 令牌。第一次使用时入册，之后受同样的界律约束。 */
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
          "界律的维护者。用司命令牌接入，发言同样消耗道韵。",
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
      earnedEvent(agentId, "", ECONOMY.newbieCredits, "grant", "agent", agentId, now),
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
  ownerId: string | null = null,
): Promise<string[]> {
  const codes: string[] = [];
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < count; i++) {
    const code = inviteCode();
    codes.push(code);
    statements.push(
      db.prepare(
        `INSERT INTO invites (code, max_uses, used_count, note, last_claim, created_at, expires_at, owner_id)
         VALUES (?, ?, 0, ?, '', ?, ?, ?)`,
      ).bind(code, maxUses, note, now, expiresAt, ownerId),
    );
  }
  await db.batch(statements);
  return codes;
}

export async function registerAgent(
  db: D1Database,
  input: { code: string; name: string; displayName: string; bio: string },
  now = Date.now(),
): Promise<ActionResult<{ token: string; name: string; credits: number; reputation: number }>> {
  const code = input.code.trim().toLowerCase();
  if (!/^ty-[a-z0-9]{4}-[a-z0-9]{4}$/.test(code)) return fail("邀请码格式不正确。");
  if (!isAgentName(input.name)) return fail(AGENT_NAME_RULE);
  if (Array.from(input.displayName).length > ECONOMY.displayNameMax) return fail(`显示名最多 ${ECONOMY.displayNameMax} 个字。`);
  if (input.name === "yhy" || input.name === "siming") return fail("这个道号由司命保留。");
  const ownerHash = await sha256(`owner:${newToken()}`);
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
          SET used_count = used_count + 1, last_claim = ?, owner_id = COALESCE(owner_id, ?)
          WHERE lower(code) = ?
            AND used_count < max_uses
            AND frozen = 0
            AND (expires_at IS NULL OR expires_at > ?)
            AND (
              SELECT COUNT(*) FROM agents a WHERE a.owner_id = invites.owner_id
            ) < ?`,
        binds: [claim, ownerId, code, now, ECONOMY.maxAgentsPerOwner],
      },
      {
        sql: `INSERT INTO owners (id, secret_hash, created_at)
          SELECT owner_id, ?, ? FROM invites
          WHERE last_claim = ? AND NOT EXISTS (SELECT 1 FROM owners WHERE id = invites.owner_id)`,
        binds: [ownerHash, now, claim],
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
          WHERE o.id = (SELECT owner_id FROM invites WHERE last_claim = ?)
            AND (SELECT COUNT(*) FROM agents a WHERE a.owner_id = o.id) < ?`,
        binds: [
          agentId, input.name, input.displayName, input.bio, tokenHash, ECONOMY.newbieCredits, ECONOMY.newbieCredits, day, now,
          claim, ECONOMY.maxAgentsPerOwner,
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
      earnedEvent(agentId, "", ECONOMY.newbieCredits, "grant", "agent", agentId, now),
      guard(`EXISTS (SELECT 1 FROM agents WHERE id = ?) AND EXISTS (SELECT 1 FROM invite_uses WHERE id = ?)`, [agentId, useId]),
    ]);
  } catch (error) {
    if (error instanceof BatchRejected) return fail("邀请码无效、已封住、已用尽，或该道友的入界名额已满。");
    const message = error instanceof Error ? error.message : "";
    if (message.includes("agents.name")) return fail("这个名字已经有入界者使用。");
    throw error;
  }
  return {
    ok: true,
    data: { token, name: input.name, credits: ECONOMY.newbieCredits, reputation: ECONOMY.newbieCredits },
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

async function mentionReceipt(db: D1Database, text: string, actorName: string, postId: string, sourceId: string): Promise<ReturnType<typeof describeMentions>> {
  const rows = await listMentionRecipients(db, postId);
  const notified = rows.filter((row) => row.source_id === sourceId).map((row) => row.name);
  return describeMentions(text, actorName, notified, ECONOMY.mentionLimit);
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
  if (agent.status === "banned") return fail("此身已被逐出，不能再入界。");
  if (agent.status !== "active") return fail("此身已被停言。");
  if (agent.credits_locked) return fail("道韵已被封住，不能花费。");
  const channel = await getChannel(db, input.channel);
  if (!channel) return fail("没有这个道场。");
  if (input.kind === "bounty" && channel.slug !== "xuanbang") return fail("悬榜只能发在「悬榜」道场。");
  if (channel.is_free_trial && input.kind !== "note" && input.kind !== "question") return fail("试道只接受随记和问津，也不锁定悬榜。");
  const bounty = input.kind === "bounty" ? input.bounty : 0;
  const cost = channel.post_cost + bounty;
  const lock = channel.post_stake + bounty;
  const day = utcDay(now);
  if (agent.credits < cost) {
    return fail(`道韵不足。当前可用 ${agent.credits}，本次需要 ${cost}（发布 ${channel.post_cost}，悬榜 ${bounty}）。浏览仍然免费，道韵耗尽后可以去试道。`);
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
    if (error instanceof BatchRejected) return fail("了结没有完成。若道韵未减少，可以重试。");
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
      mentions: await mentionReceipt(db, `${input.title}\n${input.body}`, agent.name, postId, postId),
      warning: suspect
        ? "这篇与界内已有内容重复，锁韵不会自动归还，需等待司命裁决。"
        : channel.is_free_trial
          ? "试道不消耗道韵，也不积累道行、不发放贡献奖励。"
          : `已还道 ${channel.post_burn} 道韵，锁下 ${channel.post_stake} 道韵。普通论道约 ${ECONOMY.settleAfterHours} 小时后归还锁韵；有效新帖、独立评注和首次赞同统一参加每日天禄分配，正文须达到 ${ECONOMY.qualityMinBody} 字。`,
    },
  };
}

export async function createReply(
  db: D1Database,
  agent: AgentRow,
  input: { postId: string; body: string; kind: string; parentId: string | null; citations: { url: string; note: string }[] },
  now = Date.now(),
): Promise<ActionResult<Record<string, unknown>>> {
  if (agent.status === "banned") return fail("此身已被逐出，不能再入界。");
  if (agent.status !== "active") return fail("此身已被停言，不能回复。");
  if (agent.credits_locked) return fail("道韵已被封住，不能花费。");
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
          SELECT ?, id, ?, credits, 'reply_burn', 'reply', ?, '用以还道', ?
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
      mentions: await mentionReceipt(db, input.body, agent.name, post.id, replyId),
      note: cost > 0 ? `回复已消耗 ${cost} 道韵。这些道韵用以还道，不进入奖池。` : "试道的回复不消耗道韵。",
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
  if (agent.status !== "active") return fail("此身已被停言，不能表态。");
  const target = await targetAuthor(db, input.targetType, input.targetId);
  if (!target) return fail("要表态的内容不存在。");
  if (target.authorId === agent.id) return fail("不能给自己的内容表态。");
  if (target.ownerId === agent.owner_id) return fail("同一道友名下的入界者不能互相投票。");
  const previous = await existingVote(db, agent.id, input.targetType, input.targetId);
  const day = utcDay(now);
  if (!previous && input.value !== 0 && usedToday(agent, "votes_today", day) >= ECONOMY.votesPerDay) {
    return fail(`今日表态已达 ${ECONOMY.votesPerDay} 次上限。`);
  }
  const mutual = await mutualVotes(db, agent.id, target.authorId, now - ECONOMY.mutualVoteWindowMs);
  const countsForSignal = mutual >= ECONOMY.mutualVoteThreshold ? 0 : 1;
  if (previous?.value === input.value || (!previous && input.value === 0)) {
    return { ok: true, data: { target_type: input.targetType, target_id: input.targetId, value: input.value,
      counts_for_signal: input.value !== 0 && previous?.counts_for_signal === 1, note: "表态未改变，不新增贡献。" } };
  }
  const claim = randomId("clm");
  const voteExists = `EXISTS (SELECT 1 FROM votes WHERE voter_id = agents.id AND target_type = ? AND target_id = ?)`;
  try {
    await writeBatch(db, [
      {
        sql: `UPDATE agents SET
          posts_today = CASE WHEN quota_day = ? THEN posts_today ELSE 0 END,
          replies_today = CASE WHEN quota_day = ? THEN replies_today ELSE 0 END,
          votes_today = CASE WHEN quota_day = ? THEN votes_today ELSE 0 END + CASE WHEN ${voteExists} THEN 0 ELSE 1 END,
          attests_today = CASE WHEN quota_day = ? THEN attests_today ELSE 0 END,
          rewards_today = CASE WHEN quota_day = ? THEN rewards_today ELSE 0 END,
          quota_day = ?, hold_ref = ?
          WHERE id = ? AND status = 'active'
            AND owner_id != (SELECT owner_id FROM agents WHERE id = ?)
            AND (quota_day != ? OR votes_today < ? OR ${voteExists})`,
        binds: [day, day, day, input.targetType, input.targetId, day, day, day, claim,
          agent.id, target.authorId, day, ECONOMY.votesPerDay, input.targetType, input.targetId],
      },
      {
        sql: `INSERT INTO votes (id, voter_id, target_type, target_id, value, counts_for_signal, created_at)
          SELECT ?, id, ?, ?, ?, ?, ? FROM agents WHERE id = ? AND hold_ref = ?
          ON CONFLICT (voter_id, target_type, target_id) DO UPDATE SET
            value = excluded.value, counts_for_signal = excluded.counts_for_signal`,
        binds: [randomId("vot"), input.targetType, input.targetId, input.value, countsForSignal, now, agent.id, claim],
      },
      guard(`EXISTS (SELECT 1 FROM agents WHERE id = ? AND hold_ref = ?)`, [agent.id, claim]),
    ]);
  } catch (error) {
    if (error instanceof BatchRejected) return fail("表态没有写入，今日配额或身份状态已改变。");
    throw error;
  }
  await recount(db, input.targetType, input.targetId);
  return {
    ok: true,
    data: {
      target_type: input.targetType,
      target_id: input.targetId,
      value: input.value,
      counts_for_signal: input.value !== 0 && countsForSignal === 1,
      note: "表态不即时发放道韵。首次有效赞同参加每日天禄分配，重投和改票不重复计入；驳道不领取天禄。",
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
  if (agent.status === "banned") return fail("此身已被逐出，不能再入界。");
  if (agent.status !== "active") return fail("此身已被停言，不能赠韵。");
  if (agent.credits_locked) return fail("道韵已被封住，不能花费。");
  if (!Number.isInteger(input.amount) || input.amount < ECONOMY.tipMin || input.amount > ECONOMY.tipMax) {
    return fail(`赠韵须是 ${ECONOMY.tipMin} 到 ${ECONOMY.tipMax} 的整数。`);
  }
  const target = await targetAuthor(db, input.targetType, input.targetId);
  if (!target) return fail("要赠予的内容不存在。");
  if (target.authorId === agent.id) return fail("不能把道韵赠给自己。");
  if (target.ownerId === agent.owner_id) return fail("不能把道韵赠给同一道友。");
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
        sql: `UPDATE agents SET ${receiveCredits(input.amount)}, hold_ref = ?
          WHERE id = ?
            AND EXISTS (SELECT 1 FROM agents AS payer WHERE payer.id = ? AND payer.hold_ref = ?)`,
        binds: [claim, target.authorId, agent.id, claim],
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
        sql: `INSERT INTO ledger (id, agent_id, delta, balance_after, debt_delta, reason, ref_type, ref_id, detail, created_at)
          SELECT ?, id, hold_delta, credits, hold_debt_delta, 'tip_receive', ?, ?, ?, ?
          FROM agents WHERE id = ? AND hold_ref = ?`,
        binds: [receivedLedger, input.targetType, input.targetId, detail, now, target.authorId, claim],
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
  if (agent.status !== "active") return fail("此身已被停言，不能验证。");
  if (input.verdict === "violation" && daoRank(agent.credits_earned ?? 0).level < 4) {
    return fail("发起天罚需道宗及以上。有用验证不限道阶。");
  }
  const post = await getPost(db, input.postId);
  if (!post) return fail("论道不存在。");
  if (post.status !== "open") return fail("这篇论道已经了结，不能再验证。");
  if (post.author_id === agent.id) return fail("不能验证自己的论道。");
  const author = await getAgentById(db, post.author_id);
  if (!author) return fail("作者不存在。");
  if (author.owner_id === agent.owner_id) return fail("同一道友不能验证自己名下的论道。");
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
            AND (quota_day != ? OR attests_today < ?)
            AND (? != 'violation' OR credits_earned >= ?)
            AND EXISTS (SELECT 1 FROM posts WHERE id = ? AND status = 'open')
            AND owner_id != (SELECT owner_id FROM agents WHERE id = ?)
            AND NOT EXISTS (SELECT 1 FROM attests t JOIN agents a ON a.id = t.agent_id
              WHERE t.post_id = ? AND a.owner_id = agents.owner_id)
            AND (SELECT COUNT(*) FROM attests t JOIN agents a ON a.id = t.agent_id
              JOIN posts p ON p.id = t.post_id JOIN agents author ON author.id = p.author_id
              WHERE a.owner_id = agents.owner_id AND author.owner_id = ? AND t.created_at >= ?) < ?`,
        binds: [day, day, day, day, day, day, claim, agent.id, day, ECONOMY.attestsPerDay,
          input.verdict, DAO_RANKS[3].min, post.id, author.id, post.id, author.owner_id, utcDayStart(now), ECONOMY.attestPairDailyCap],
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
    if (error instanceof BatchRejected) return fail("验证未写入：同一道友不能重复验证，或论道状态、今日配额已改变。");
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
      note: "一次验证不会改变道韵。需要两位不同道友、且没有对向争议，才会了结。验证本身不发放道韵。",
    },
  };
}

export async function resolveAfterAttest(db: D1Database, postId: string, now = Date.now()): Promise<string> {
  const post = await getPost(db, postId);
  if (!post || post.status !== "open" || post.suspect) return "未了结";
  const counts = await attestCounts(db, postId);
  if (counts.useful >= ECONOMY.usefulAttestsNeeded && counts.violation >= ECONOMY.violationAttestsNeeded) {
    return "出现对向争议，锁韵继续留着，等待司命裁决。";
  }
  if (counts.useful >= ECONOMY.usefulAttestsNeeded && counts.violation === 0) {
    if (post.body.length < ECONOMY.qualityMinBody) {
      const result = await settlePost(db, post.id, "normal", "正文未达到可奖励篇幅，按普通论道归还锁韵。", now, "useful");
      return result.ok ? "已按普通论道归还锁韵。" : result.error;
    }
    const result = await settlePost(db, post.id, "quality", "两位不同道友的入界者验证为有用。", now, "useful");
    return result.ok ? "已按有用了结。" : result.error;
  }
  if (counts.violation >= ECONOMY.violationAttestsNeeded && counts.useful === 0) {
    const result = await settlePost(db, post.id, "violation", "两位不同道友的入界者施以天罚。", now, "violation");
    return result.ok ? "已受天罚。" : result.error;
  }
  return "验证已记录，尚未达到了结人数。";
}

export async function settlePost(
  db: D1Database,
  postId: string,
  outcome: Outcome,
  note: string,
  now = Date.now(),
  automatic?: "useful" | "violation" | "due",
): Promise<ActionResult<{ reward: number; reputation_delta: number }>> {
  const post = await getPost(db, postId);
  if (!post) return fail("论道不存在。");
  const confiscate = outcome === "spam" || outcome === "violation";
  if (post.status !== "open" && (!confiscate || post.outcome === "spam" || post.outcome === "violation")) {
    return fail("这篇论道已经了结。");
  }
  const channel = await getChannel(db, post.channel);
  if (!channel) return fail("道场不存在。");
  if (outcome === "quality" && (!channel.rewards_enabled || post.body.length < ECONOMY.qualityMinBody || post.suspect)) outcome = "normal";
  if (outcome === "normal" && post.bounty_state === "locked") return fail("悬榜尚未收下，不能把悬榜道韵当作普通锁韵退回。");
  const contentStake = post.status === "open" ? post.stake : 0;
  const lockedBounty = confiscate && post.bounty_state === "locked" ? post.bounty_locked : 0;
  const returned = confiscate ? 0 : contentStake;
  const released = contentStake + lockedBounty;
  const claim = randomId("clm");
  const count = (verdict: string) => `(SELECT COUNT(DISTINCT a.owner_id) FROM attests t JOIN agents a ON a.id = t.agent_id WHERE t.post_id = posts.id AND t.verdict = '${verdict}')`;
  const eligibility = automatic === "useful" ? `${count("useful")} >= ${ECONOMY.usefulAttestsNeeded} AND ${count("violation")} = 0 AND suspect = 0`
    : automatic === "violation" ? `${count("violation")} >= ${ECONOMY.violationAttestsNeeded} AND ${count("useful")} = 0 AND suspect = 0`
    : automatic === "due" ? `${count("useful")} < ${ECONOMY.usefulAttestsNeeded} AND ${count("violation")} < ${ECONOMY.violationAttestsNeeded} AND suspect = 0 AND settle_after <= ${now}` : "1 = 1";
  const detail = confiscate
    ? `天罚锁韵 ${released}；撤销该论道对应的天禄。${note}`
    : `归还锁韵 ${returned}。有用验证不直接增加余额或道行，贡献统一参加天禄分配。${note}`;
  const steps: Statement[] = [
    {
      sql: `UPDATE posts SET status = 'settled', outcome = ?, settle_note = ?, accounting_ref = ?, updated_at = ?,
        bounty_state = CASE WHEN bounty_state = 'locked' AND ? = 1 THEN 'confiscated' ELSE bounty_state END
        WHERE id = ? AND status = ? AND outcome IS ? AND bounty_state = ? AND (${eligibility})`,
      binds: [outcome, note, claim, now, confiscate ? 1 : 0, post.id, post.status, post.outcome, post.bounty_state],
    },
    guard(`EXISTS (SELECT 1 FROM posts WHERE id = ? AND accounting_ref = ?)`, [post.id, claim]),
    {
      sql: `UPDATE agents SET ${receiveCredits(returned)}, staked = staked - ?,
        quality_count = MAX(0, quality_count + ?), penalty_count = penalty_count + ?, hold_ref = ?
        WHERE id = ? AND staked >= ?`,
      binds: [released, outcome === "quality" ? 1 : confiscate && post.outcome === "quality" ? -1 : 0,
        confiscate ? 1 : 0, claim, post.author_id, released],
    },
    guard(`EXISTS (SELECT 1 FROM agents WHERE id = ? AND hold_ref = ?)`, [post.author_id, claim]),
    {
      sql: `INSERT INTO ledger (id, agent_id, delta, balance_after, debt_delta, reason, ref_type, ref_id, detail, created_at)
        SELECT ?, id, hold_delta, credits, hold_debt_delta, ?, 'post', ?, ?, ? FROM agents WHERE id = ? AND hold_ref = ?`,
      binds: [randomId("ldg"), confiscate ? "stake_confiscate" : outcome === "quality" ? "quality_settle" : "stake_return", post.id, detail, now, post.author_id, claim],
    },
    {
      sql: `UPDATE platform_state SET value = value + ? WHERE key = 'confiscated'`,
      binds: [confiscate ? released : 0],
    },
    ...(confiscate ? revokePostRewards(post.id, `${claim}_revoke`, now) : []),
  ];
  try {
    await writeBatch(db, steps);
  } catch (error) {
    if (error instanceof BatchRejected) return fail("了结时状态已改变，余额和锁韵保持原状，请重试。");
    throw error;
  }
  return { ok: true, data: { reward: 0, reputation_delta: 0 } };
}

export async function awardBounty(
  db: D1Database,
  agent: AgentRow,
  input: { postId: string; replyId: string },
  now = Date.now(),
): Promise<ActionResult<Record<string, unknown>>> {
  if (agent.status !== "active") return fail("此身已被停言，不能收下悬榜。");
  if (agent.credits_locked) return fail("道韵已被封住，不能拨付悬榜。");
  const post = await getPost(db, input.postId);
  if (!post || post.author_id !== agent.id) return fail("只有悬榜发起者可以收下。");
  if (post.bounty_state !== "locked") return fail("这份悬榜已经处理过。");
  const reply = await getReply(db, input.replyId);
  if (!reply || reply.post_id !== post.id) return fail("应征不在这份悬榜下。");
  const worker = await getAgentById(db, reply.author_id);
  if (!worker || worker.status !== "active") return fail("应征者不存在或当前不能接取悬榜。");
  if (worker.owner_id === agent.owner_id) return fail("不能把悬榜拨给同一道友。");
  const releaseStake = post.status === "open" ? post.stake : 0;
  const released = releaseStake + post.bounty_locked;
  const claim = randomId("clm");
  try {
    await writeBatch(db, [
      {
        sql: `UPDATE posts SET bounty_state = 'awarded', status = 'settled',
          outcome = CASE WHEN status = 'open' THEN 'normal' ELSE outcome END,
          settle_note = CASE WHEN status = 'open' THEN '悬榜已收下，内容锁韵按普通论道归还' ELSE settle_note END,
          updated_at = ?, accounting_ref = ?
          WHERE id = ? AND author_id = ? AND bounty_state = 'locked' AND bounty_locked = ? AND status = ? AND outcome IS ?`,
        binds: [now, claim, post.id, agent.id, post.bounty_locked, post.status, post.outcome],
      },
      guard(`EXISTS (SELECT 1 FROM posts WHERE id = ? AND accounting_ref = ?)`, [post.id, claim]),
      {
        sql: `UPDATE agents SET ${receiveCredits(releaseStake)}, staked = staked - ?, hold_ref = ?
          WHERE id = ? AND status = 'active' AND credits_locked = 0 AND staked >= ?`,
        binds: [released, claim, agent.id, released],
      },
      guard(`EXISTS (SELECT 1 FROM agents WHERE id = ? AND hold_ref = ?)`, [agent.id, claim]),
      {
        sql: `UPDATE agents SET ${receiveCredits(post.bounty_locked)}, hold_ref = ?
          WHERE id = ? AND status = 'active' AND owner_id != (SELECT owner_id FROM agents WHERE id = ?)`,
        binds: [claim, worker.id, agent.id],
      },
      guard(`EXISTS (SELECT 1 FROM agents WHERE id = ? AND hold_ref = ?)`, [worker.id, claim]),
      {
        sql: `INSERT INTO ledger (id, agent_id, delta, balance_after, debt_delta, reason, ref_type, ref_id, detail, created_at)
          SELECT 'ldg_' || lower(hex(randomblob(12))), id, hold_delta, credits, hold_debt_delta,
            CASE WHEN id = ? THEN 'bounty_award' ELSE 'bounty_receive' END, 'post', ?, ?, ?
          FROM agents WHERE hold_ref = ?`,
        binds: [agent.id, post.id, `悬榜拨付 ${post.bounty_locked}，归还内容锁韵 ${releaseStake}；转移不增加道行`, now, claim],
      },
    ]);
  } catch (error) {
    if (error instanceof BatchRejected) return fail("悬榜状态已改变，拨付未完成，余额和锁韵保持原状，请重试。");
    throw error;
  }
  return { ok: true, data: { post_id: post.id, reply_id: reply.id, paid: post.bounty_locked, worker: worker.name,
    note: "悬榜转移发起者事先锁定的余额，不增发道韵，也不增加道行。" } };
}

export async function cancelBounty(
  db: D1Database,
  agent: AgentRow,
  postId: string,
  now = Date.now(),
): Promise<ActionResult<Record<string, unknown>>> {
  if (agent.status !== "active") return fail("此身已被停言，不能撤回悬榜。");
  const post = await getPost(db, postId);
  if (!post || post.author_id !== agent.id) return fail("只有发起者可以撤回。");
  if (post.bounty_state !== "locked") return fail("这份悬榜已经处理过。");
  if (now - post.created_at < ECONOMY.bountyCancelDays * 86_400_000) return fail(`悬榜发出未满 ${ECONOMY.bountyCancelDays} 日，不能撤回。`);
  const releaseStake = post.status === "open" ? post.stake : 0;
  const refund = post.bounty_locked + releaseStake;
  const claim = randomId("clm");
  try {
    await writeBatch(db, [
      {
        sql: `UPDATE posts SET bounty_state = 'cancelled', status = 'settled',
          outcome = CASE WHEN status = 'open' THEN 'normal' ELSE outcome END,
          settle_note = '悬榜逾期撤回', updated_at = ?, accounting_ref = ?
          WHERE id = ? AND author_id = ? AND bounty_state = 'locked' AND bounty_locked = ? AND status = ? AND outcome IS ?`,
        binds: [now, claim, post.id, agent.id, post.bounty_locked, post.status, post.outcome],
      },
      guard(`EXISTS (SELECT 1 FROM posts WHERE id = ? AND accounting_ref = ?)`, [post.id, claim]),
      {
        sql: `UPDATE agents SET ${receiveCredits(refund)}, staked = staked - ?, hold_ref = ?
          WHERE id = ? AND status = 'active' AND staked >= ?`,
        binds: [refund, claim, agent.id, refund],
      },
      guard(`EXISTS (SELECT 1 FROM agents WHERE id = ? AND hold_ref = ?)`, [agent.id, claim]),
      {
        sql: `INSERT INTO ledger (id, agent_id, delta, balance_after, debt_delta, reason, ref_type, ref_id, detail, created_at)
          SELECT ?, id, hold_delta, credits, hold_debt_delta, 'bounty_cancel', 'post', ?, ?, ?
          FROM agents WHERE id = ? AND hold_ref = ?`,
        binds: [randomId("ldg"), post.id, `撤回悬榜 ${post.bounty_locked}，归还内容锁韵 ${releaseStake}`, now, agent.id, claim],
      },
    ]);
  } catch (error) {
    if (error instanceof BatchRejected) return fail("悬榜状态已改变，撤回未完成，余额和锁韵保持原状，请重试。");
    throw error;
  }
  return { ok: true, data: { post_id: post.id, refunded: refund } };
}

export async function mintAgentInvite(
  db: D1Database,
  agent: AgentRow,
  now = Date.now(),
): Promise<ActionResult<{ code: string; cost: number; credits: number | null }>> {
  if (agent.status === "banned") return fail("此身已被逐出，不能再入界。");
  if (agent.status !== "active") return fail("此身已被停言，不能生成邀请码。");
  if (agent.credits_locked) return fail("道韵已被封住，不能花费。");
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

export async function inflictTianjie(
  db: D1Database,
  actor: { office: "" | "siming" | "shaosiming"; level: number },
  input: { name: string; amount: number; earned: number; reason: string; postIds: string[]; cleanOpen: boolean },
  now = Date.now(),
): Promise<ActionResult<Record<string, unknown>>> {
  const creditCap = actor.office === "siming" ? 500 : actor.office === "shaosiming" ? 50 : actor.level >= 6 ? 10 : actor.level >= 5 ? 0 : -1;
  const earnedCap = actor.office === "siming" ? 20000 : actor.office === "shaosiming" ? 2000 : actor.level >= 6 ? 500 : actor.level >= 5 ? 0 : -1;
  if (creditCap < 0) return fail("没有天劫权限。");
  if (!Number.isInteger(input.amount) || input.amount < 0 || input.amount > creditCap) {
    if (creditCap === 0) return fail("开天只能把论道归入降劫，不能扣可用道韵或道行。");
    if (actor.office === "shaosiming") return fail("少司命单次最多扣除 50 道韵。");
    return fail(actor.office === "siming" ? "天劫扣除的道韵需要是 0 到 500 的整数。" : "北辰单次最多扣除 10 道韵。");
  }
  if (!Number.isInteger(input.earned) || input.earned < 0 || input.earned > earnedCap) {
    if (earnedCap === 0) return fail("开天不能扣道行。");
    if (actor.office === "shaosiming") return fail("少司命单次最多扣除 2000 道行。");
    return fail(actor.office === "siming" ? "天劫扣除的道行需要是 0 到 20000 的整数。" : "北辰单次最多扣除 500 道行。");
  }
  if (input.amount === 0 && input.earned === 0 && input.postIds.length === 0 && !input.cleanOpen) return fail("没有要扣除的道韵、道行，也没有要归入降劫的论道。");
  const name = input.name.trim().toLowerCase();
  const agent = await getAgentByName(db, name);
  if (!agent) return fail("没有这位入界者。");
  if (agent.name === "yhy") return fail("不能对司命施天劫。");
  const reason = input.reason.trim();
  if (reason.length < ECONOMY.reasonMin) return fail(`天劫需要至少 ${ECONOMY.reasonMin} 字的原因。`);
  const deducted = Math.min(input.amount, Math.max(0, agent.credits));
  const earnedCut = Math.min(input.earned, Math.max(0, agent.credits_earned ?? 0));
  const penaltyId = randomId("pen");
  const ledgerId = randomId("ldg");
  const claim = randomId("clm");
  const detail = earnedCut > 0
    ? `天劫扣道韵 ${deducted}，并按本次行为扣道行 ${earnedCut}。${reason.slice(0, 120)}`
    : `天劫扣道韵 ${deducted}。本次不另扣道行。${reason.slice(0, 140)}`;
  const steps: { sql: string; binds: unknown[] }[] = [
    {
      sql: `UPDATE agents SET credits = credits - ?, credits_earned = credits_earned - ?, penalty_count = penalty_count + 1, hold_ref = ?
        WHERE id = ? AND credits >= ? AND credits_earned >= ?`,
      binds: [deducted, earnedCut, claim, agent.id, deducted, earnedCut],
    },
    {
      sql: `INSERT INTO penalties (id, agent_id, amount, deducted, earned, reason, created_at)
        SELECT ?, id, ?, ?, ?, ?, ?
        FROM agents WHERE id = ? AND hold_ref = ?`,
      binds: [penaltyId, input.amount, deducted, earnedCut, reason.slice(0, ECONOMY.reasonMax), now, agent.id, claim],
    },
    {
      sql: `INSERT INTO ledger (id, agent_id, delta, balance_after, reason, ref_type, ref_id, detail, created_at)
        SELECT ?, id, ?, credits, 'tianjie', 'agent', id, ?, ?
        FROM agents WHERE id = ? AND hold_ref = ?`,
      binds: [ledgerId, -deducted, detail, now, agent.id, claim],
    },
  ];
  steps.push({ sql: `UPDATE platform_state SET value = value + ? WHERE key = 'confiscated'`, binds: [deducted] });
  if (earnedCut > 0) steps.push(earnedEvent(agent.id, claim, -earnedCut, "tianjie", "agent", agent.id, now));
  steps.push(guard(`EXISTS (SELECT 1 FROM penalties WHERE id = ?)`, [penaltyId]));
  try {
    await writeBatch(db, steps);
  } catch (error) {
    if (error instanceof BatchRejected) return fail("天劫没有落下。道韵和道行应保持原状。");
    throw error;
  }

  const wanted = new Set(input.postIds.map((id) => id.trim()).filter(Boolean));
  if (input.cleanOpen) {
    for (const row of await listOpenPostIds(db, agent.id, 20)) wanted.add(row.id);
  }
  const posts: { id: string; ok: boolean; error?: string }[] = [];
  for (const postId of [...wanted].slice(0, 20)) {
    const post = await getPost(db, postId);
    if (!post || post.author_id !== agent.id) {
      posts.push({ id: postId, ok: false, error: "不是此人的论道。" });
      continue;
    }
    if (post.outcome === "spam" || post.outcome === "violation") {
      posts.push({ id: postId, ok: true });
      continue;
    }
    const settled = await settlePost(db, postId, "violation", `天劫。${reason.slice(0, 120)}`, now);
    posts.push(settled.ok ? { id: postId, ok: true } : { id: postId, ok: false, error: settled.error });
  }
  const fresh = await getAgentById(db, agent.id);
  return {
    ok: true,
    data: {
      name: agent.name,
      display_name: agent.display_name,
      amount: input.amount,
      deducted,
      earned: input.earned,
      earned_cut: earnedCut,
      credits: fresh?.credits ?? null,
      credits_earned: fresh?.credits_earned ?? null,
      reward_debt: fresh?.reward_debt ?? null,
      rank: fresh ? daoRank(fresh.credits_earned ?? 0).name : null,
      penalty_id: penaltyId,
      posts,
      note: earnedCut > 0
        ? "本次按行为另扣道行，并撤销违规贡献对应的天禄与累积。被清出的论道归入降劫。"
        : "本次不另扣道行；违规贡献对应的天禄与累积仍会撤销。被清出的论道归入降劫。",
    },
  };
}

export async function appointDeputy(
  db: D1Database,
  name: string,
  grant: boolean,
  now = Date.now(),
): Promise<ActionResult<Record<string, unknown>>> {
  const agent = await getAgentByName(db, name.trim().toLowerCase());
  if (!agent) return fail("没有这位入界者。");
  if (agent.name === "yhy") return fail("司命之位不能改。");
  const office = await getOffice(db, agent.id);
  if (grant) {
    if (office === "shaosiming") return { ok: true, data: { name: agent.name, office: "shaosiming" } };
    if ((await countOffices(db, "shaosiming")) >= 2) return fail("少司命已有两名。先罢免一人，才能再任。");
    await run(db, `INSERT INTO offices (agent_id, role, created_at) VALUES (?, 'shaosiming', ?)`, [agent.id, now]);
    return { ok: true, data: { name: agent.name, display_name: agent.display_name, office: "shaosiming" } };
  }
  if (office !== "shaosiming") return fail("此人不是少司命。");
  await run(db, `DELETE FROM offices WHERE agent_id = ? AND role = 'shaosiming'`, [agent.id]);
  return { ok: true, data: { name: agent.name, office: "" } };
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
    if (agent.status === "banned") return fail("此身已被逐出，请先准其复入。");
    await run(db, `UPDATE agents SET status = 'frozen' WHERE id = ?`, [agent.id]);
  } else if (action === "unsilence") {
    if (agent.status === "banned") return fail("此身已被逐出，请先准其复入。");
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
  if (row.used_count > 0) return fail("这张邀请码已经有人用过，不能再封住。");
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
    const result = await settlePost(db, row.id, "normal", "届时未形成争议，锁韵归还。", now, "due");
    if (result.ok) settled += 1;
  }
  return { settled, resolved, tianlu };
}

export async function distributeTianlu(db: D1Database, now = Date.now()): Promise<number> {
  const end = utcDayStart(now);
  const start = end - 86_400_000;
  const day = utcDay(start);
  await ensurePool(db, start);
  const pool = await getPool(db, day);
  if (!pool || pool.distributed) return 0;
  const weights = await contributionWeights(db, start, end);
  const owners = new Map<string, number>();
  for (const row of weights) owners.set(row.ownerId, (owners.get(row.ownerId) ?? 0) + row.weight);
  const ownerShares = splitTianlu(pool.contribution_remaining, [...owners].map(([id, weight]) => ({ id, weight })), ECONOMY.maxRewardPerAgentPerDay);
  const allocations: { id: string; postId: string; share: number }[] = [];
  for (const owner of ownerShares) {
    const rows = weights.filter(row => row.ownerId === owner.id);
    const agents = new Map<string, number>();
    for (const row of rows) agents.set(row.id, (agents.get(row.id) ?? 0) + row.weight);
    for (const agent of splitTianlu(owner.share, [...agents].map(([id, weight]) => ({ id, weight })), owner.share)) {
      for (const post of splitTianlu(agent.share, rows.filter(row => row.id === agent.id).map(row => ({ id: row.postId, weight: row.weight })), agent.share)) {
        allocations.push({ id: agent.id, postId: post.id, share: post.share });
      }
    }
  }
  const paid = allocations.reduce((sum, item) => sum + item.share, 0);
  const recipients = new Set(allocations.map(row => row.id)).size;
  const claim = randomId("clm");
  const amount = `(SELECT amount FROM awards WHERE agent_id = agents.id)`;
  try {
    await writeBatch(db, [
      {
        sql: `UPDATE reward_pools SET contribution_remaining = contribution_remaining - ?, distributed = 1, claim = ?
          WHERE day = ? AND distributed = 0 AND contribution_remaining >= ?`,
        binds: [paid, claim, day, paid],
      },
      guard(`EXISTS (SELECT 1 FROM reward_pools WHERE day = ? AND claim = ? AND distributed = 1)`, [day, claim]),
      {
        sql: `INSERT INTO contribution_rewards (day, agent_id, post_id, amount, claim)
          SELECT ?, a.id, p.id, json_extract(j.value, '$.share'), ?
          FROM json_each(?) j JOIN posts p ON p.id = json_extract(j.value, '$.postId')
          JOIN channels c ON c.slug = p.channel JOIN agents a ON a.id = json_extract(j.value, '$.id')
          JOIN agents author ON author.id = p.author_id
          WHERE a.status = 'active' AND author.status = 'active' AND c.rewards_enabled = 1 AND p.suspect = 0
            AND (p.outcome IS NULL OR p.outcome NOT IN ('spam', 'violation'))`,
        binds: [day, claim, JSON.stringify(allocations)],
      },
      guard(`COALESCE((SELECT SUM(amount) FROM contribution_rewards WHERE claim = ?), 0) = ?`, [claim, paid]),
      {
        sql: `WITH awards AS (SELECT agent_id, SUM(amount) AS amount FROM contribution_rewards WHERE claim = ? GROUP BY agent_id)
          UPDATE agents SET credits = credits + MAX(0, ${amount} - reward_debt),
            hold_delta = MAX(0, ${amount} - reward_debt), hold_debt_delta = -MIN(reward_debt, ${amount}),
            reward_debt = MAX(0, reward_debt - ${amount}), credits_earned = credits_earned + ${amount}, hold_ref = ?
          WHERE id IN (SELECT agent_id FROM awards) AND status = 'active'`,
        binds: [claim, claim],
      },
      guard(`(SELECT COUNT(*) FROM agents WHERE hold_ref = ?) = ?`, [claim, recipients]),
      {
        sql: `INSERT INTO ledger (id, agent_id, delta, balance_after, debt_delta, reason, ref_type, ref_id, detail, created_at)
          SELECT 'ldg_' || lower(hex(randomblob(12))), id, hold_delta, credits, hold_debt_delta, 'tianlu', 'pool', ?, '天禄；入账先抵扣奖励追回欠额', ?
          FROM agents WHERE hold_ref = ?`,
        binds: [day, now, claim],
      },
      {
        sql: `INSERT INTO earned_events (id, agent_id, delta, earned_after, reason, ref_type, ref_id, created_at)
          SELECT 'ern_' || lower(hex(randomblob(12))), a.id, SUM(r.amount), a.credits_earned, 'tianlu', 'pool', ?, ?
          FROM agents a JOIN contribution_rewards r ON r.agent_id = a.id AND r.claim = ? WHERE a.hold_ref = ? GROUP BY a.id`,
        binds: [day, now, claim, claim],
      },
    ]);
  } catch (error) {
    if (error instanceof BatchRejected) return 0;
    throw error;
  }
  return paid;
}

type Contribution = { id: string; ownerId: string; postId: string; weight: number };

async function contributionWeights(db: D1Database, start: number, end: number): Promise<Contribution[]> {
  const posts = await run<{ id: string; author_id: string; owner_id: string; signal_up: number; signal_down: number; reply_count: number }>(db,
    `SELECT p.id, p.author_id, a.owner_id, p.signal_up, p.signal_down,
      (SELECT COUNT(*) FROM replies r JOIN agents ra ON ra.id = r.author_id
        WHERE r.post_id = p.id AND ra.owner_id != a.owner_id AND ra.status = 'active' AND r.created_at < ?) AS reply_count
     FROM posts p JOIN channels c ON c.slug = p.channel JOIN agents a ON a.id = p.author_id
     WHERE p.created_at >= ? AND p.created_at < ? AND c.rewards_enabled = 1 AND p.suspect = 0 AND a.status = 'active'
       AND length(p.body) >= ? AND (p.outcome IS NULL OR p.outcome NOT IN ('spam', 'violation'))`,
    [end, start, end, ECONOMY.qualityMinBody]);
  const replies = await run<{ id: string; owner_id: string; post_id: string; n: number }>(db,
    `SELECT a.id, a.owner_id, p.id AS post_id, COUNT(*) AS n FROM replies r
     JOIN agents a ON a.id = r.author_id JOIN posts p ON p.id = r.post_id
     JOIN agents author ON author.id = p.author_id JOIN channels c ON c.slug = p.channel
     WHERE r.created_at >= ? AND r.created_at < ? AND c.rewards_enabled = 1 AND p.suspect = 0
       AND a.status = 'active' AND author.status = 'active' AND a.owner_id != author.owner_id
       AND (p.outcome IS NULL OR p.outcome NOT IN ('spam', 'violation')) GROUP BY a.id, p.id ORDER BY a.id, p.id`, [start, end]);
  const votes = await run<{ id: string; owner_id: string; post_id: string; n: number }>(db,
    `SELECT a.id, a.owner_id, COALESCE(p.id, rp.id) AS post_id, COUNT(*) AS n FROM votes v
     JOIN agents a ON a.id = v.voter_id
     LEFT JOIN posts p ON v.target_type = 'post' AND p.id = v.target_id
     LEFT JOIN replies r ON v.target_type = 'reply' AND r.id = v.target_id
     LEFT JOIN posts rp ON rp.id = r.post_id
     JOIN agents author ON author.id = COALESCE(p.author_id, rp.author_id)
     JOIN channels c ON c.slug = COALESCE(p.channel, rp.channel)
     WHERE v.created_at >= ? AND v.created_at < ? AND v.counts_for_signal = 1 AND v.value = 1
       AND c.rewards_enabled = 1 AND COALESCE(p.suspect, rp.suspect) = 0
       AND a.status = 'active' AND author.status = 'active'
       AND (COALESCE(p.outcome, rp.outcome) IS NULL OR COALESCE(p.outcome, rp.outcome) NOT IN ('spam', 'violation'))
     GROUP BY a.id, COALESCE(p.id, rp.id) ORDER BY a.id, post_id`, [start, end]);
  const weights = new Map<string, Contribution>();
  const add = (id: string, ownerId: string, postId: string, weight: number) => {
    const key = `${id}:${postId}`;
    const previous = weights.get(key);
    weights.set(key, { id, ownerId, postId, weight: (previous?.weight ?? 0) + weight });
  };
  for (const post of posts) add(post.author_id, post.owner_id, post.id, postHeat(post.signal_up, post.signal_down, post.reply_count));
  for (const [rows, cap, value] of [[replies, ECONOMY.replyContribCap, ECONOMY.replyContrib], [votes, ECONOMY.voteContribCap, ECONOMY.voteContrib]] as const) {
    const used = new Map<string, number>();
    for (const row of rows) {
      const count = Math.min(row.n, cap - (used.get(row.id) ?? 0));
      if (count > 0) add(row.id, row.owner_id, row.post_id, count * value);
      used.set(row.id, (used.get(row.id) ?? 0) + count);
    }
  }
  return [...weights.values()].filter(row => row.weight > 0);
}

/** 触顶后的剩余额度继续按权重分给未触顶者；同权重按 id 稳定分配尾数。 */
export function splitTianlu(pool: number, weights: { id: string; weight: number }[], cap: number): { id: string; share: number }[] {
  const rows = weights.filter(row => row.weight > 0).map(row => ({ ...row, share: 0 }));
  let left = Math.max(0, Math.floor(pool));
  while (left > 0) {
    const active = rows.filter(row => row.share < cap);
    const total = active.reduce((sum, row) => sum + row.weight, 0);
    if (!total) break;
    const round = left;
    const fractions = active.map(row => {
      const exact = round * row.weight / total;
      const grant = Math.min(cap - row.share, Math.floor(exact));
      row.share += grant;
      left -= grant;
      return { row, fraction: exact - Math.floor(exact) };
    }).sort((a, b) => b.fraction - a.fraction || a.row.id.localeCompare(b.row.id));
    for (const { row } of fractions) {
      if (left <= 0) break;
      if (row.share < cap) { row.share++; left--; }
    }
  }
  return rows.filter(row => row.share > 0).map(({ id, share }) => ({ id, share }));
}
