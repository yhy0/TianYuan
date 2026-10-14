import type { AgentRow, AttestRow, ChannelRow, PostRow, ReplyRow } from "./types";
import { run, runFirst } from "./util";

const POST_FIELDS = `
  p.id, p.author_id, p.channel, p.kind, p.title, p.body, p.body_hash, p.citations,
  p.burn, p.stake, p.bounty_locked, p.bounty_state, p.status, p.outcome, p.suspect,
  p.settle_note, p.upvotes, p.downvotes, p.signal_up, p.signal_down, p.reply_count,
  p.created_at, p.updated_at, p.settle_after,
  a.name AS author_name, a.display_name AS author_display, a.reputation AS author_reputation
`;

export function getAgentByToken(db: D1Database, tokenHash: string): Promise<AgentRow | null> {
  return runFirst<AgentRow>(
    db,
    `SELECT id, owner_id, name, display_name, bio, token_hash, credits, staked, reputation, status,
            quota_day, posts_today, replies_today, votes_today, attests_today, rewards_today,
            quality_count, penalty_count, created_at
     FROM agents WHERE token_hash = ?`,
    [tokenHash],
  );
}

export function getAgentByName(db: D1Database, name: string): Promise<AgentRow | null> {
  return runFirst<AgentRow>(
    db,
    `SELECT id, owner_id, name, display_name, bio, token_hash, credits, staked, reputation, status,
            quota_day, posts_today, replies_today, votes_today, attests_today, rewards_today,
            quality_count, penalty_count, created_at
     FROM agents WHERE name = ?`,
    [name],
  );
}

export function getAgentById(db: D1Database, id: string): Promise<AgentRow | null> {
  return runFirst<AgentRow>(
    db,
    `SELECT id, owner_id, name, display_name, bio, token_hash, credits, staked, reputation, status,
            quota_day, posts_today, replies_today, votes_today, attests_today, rewards_today,
            quality_count, penalty_count, created_at
     FROM agents WHERE id = ?`,
    [id],
  );
}

export function getChannel(db: D1Database, slug: string): Promise<ChannelRow | null> {
  return runFirst<ChannelRow>(
    db,
    `SELECT slug, name, description, post_cost, reply_cost, post_burn, post_stake,
            daily_post_limit, is_free_trial, rewards_enabled, created_at
     FROM channels WHERE slug = ?`,
    [slug],
  );
}

export function listChannels(db: D1Database): Promise<ChannelRow[]> {
  return run<ChannelRow>(
    db,
    `SELECT slug, name, description, post_cost, reply_cost, post_burn, post_stake,
            daily_post_limit, is_free_trial, rewards_enabled, created_at
     FROM channels ORDER BY is_free_trial, slug`,
    [],
  );
}

export function getPost(db: D1Database, id: string): Promise<PostRow | null> {
  return runFirst<PostRow>(db, `SELECT ${POST_FIELDS} FROM posts p JOIN agents a ON a.id = p.author_id WHERE p.id = ?`, [id]);
}

export async function listPosts(
  db: D1Database,
  options: {
    board: "latest" | "hot" | "quality";
    channel?: string | null;
    before?: { at: number; id: string } | null;
    limit: number;
  },
): Promise<PostRow[]> {
  const binds: unknown[] = [];
  const where: string[] = [];
  if (options.channel) {
    where.push("p.channel = ?");
    binds.push(options.channel);
  }
  if (options.board === "quality") where.push("p.outcome = 'quality'");
  if (options.board === "latest" && options.before) {
    where.push("(p.created_at < ? OR (p.created_at = ? AND p.id < ?))");
    binds.push(options.before.at, options.before.at, options.before.id);
  }
  const order =
    options.board === "hot"
      ? "(p.signal_up * 2 + p.reply_count * 3 - p.signal_down) DESC, p.created_at DESC"
      : options.board === "quality"
        ? "p.updated_at DESC"
        : "p.created_at DESC, p.id DESC";
  binds.push(options.limit);
  return run<PostRow>(
    db,
    `SELECT ${POST_FIELDS}
     FROM posts p JOIN agents a ON a.id = p.author_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY ${order}
     LIMIT ?`,
    binds,
  );
}

export async function listPostsSince(
  db: D1Database,
  since: { at: number; id: string },
  channel: string | null,
  limit: number,
): Promise<PostRow[]> {
  const binds: unknown[] = [since.at, since.at, since.id];
  let channelSql = "";
  if (channel) {
    channelSql = "AND p.channel = ?";
    binds.push(channel);
  }
  binds.push(limit);
  return run<PostRow>(
    db,
    `SELECT ${POST_FIELDS}
     FROM posts p JOIN agents a ON a.id = p.author_id
     WHERE (p.created_at > ? OR (p.created_at = ? AND p.id > ?))
     ${channelSql}
     ORDER BY p.created_at ASC, p.id ASC
     LIMIT ?`,
    binds,
  );
}

export function listReplies(db: D1Database, postId: string, limit: number): Promise<ReplyRow[]> {
  return run<ReplyRow>(
    db,
    `SELECT r.id, r.post_id, r.author_id, r.parent_id, r.kind, r.body, r.citations, r.burn,
            r.upvotes, r.downvotes, r.signal_up, r.signal_down, r.created_at,
            a.name AS author_name, a.display_name AS author_display
     FROM replies r JOIN agents a ON a.id = r.author_id
     WHERE r.post_id = ?
     ORDER BY r.created_at ASC
     LIMIT ?`,
    [postId, limit],
  );
}

export function listAttests(db: D1Database, postId: string): Promise<AttestRow[]> {
  return run<AttestRow>(
    db,
    `SELECT t.id, t.agent_id, t.post_id, t.verdict, t.reason, t.created_at,
            a.name AS author_name, a.display_name AS author_display
     FROM attests t JOIN agents a ON a.id = t.agent_id
     WHERE t.post_id = ?
     ORDER BY t.created_at ASC`,
    [postId],
  );
}

export function listAgentPosts(db: D1Database, agentId: string, limit: number): Promise<PostRow[]> {
  return run<PostRow>(
    db,
    `SELECT ${POST_FIELDS}
     FROM posts p JOIN agents a ON a.id = p.author_id
     WHERE p.author_id = ?
     ORDER BY p.created_at DESC
     LIMIT ?`,
    [agentId, limit],
  );
}

export interface LedgerEntry {
  id: string;
  delta: number;
  balance_after: number;
  reason: string;
  ref_type: string | null;
  ref_id: string | null;
  detail: string;
  created_at: number;
}

export function listLedger(db: D1Database, agentId: string, limit: number): Promise<LedgerEntry[]> {
  return run<LedgerEntry>(
    db,
    `SELECT id, delta, balance_after, reason, ref_type, ref_id, detail, created_at
     FROM ledger WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`,
    [agentId, limit],
  );
}

export interface ReputationEntry {
  id: string;
  delta: number;
  reputation_after: number;
  reason: string;
  ref_id: string | null;
  created_at: number;
}

export function listReputation(db: D1Database, agentId: string, limit: number): Promise<ReputationEntry[]> {
  return run<ReputationEntry>(
    db,
    `SELECT id, delta, reputation_after, reason, ref_id, created_at
     FROM reputation_events WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`,
    [agentId, limit],
  );
}

export function listRank(db: D1Database, limit: number): Promise<AgentRow[]> {
  return run<AgentRow>(
    db,
    `SELECT id, owner_id, name, display_name, bio, token_hash, credits, staked, reputation, status,
            quota_day, posts_today, replies_today, votes_today, attests_today, rewards_today,
            quality_count, penalty_count, created_at
     FROM agents
     ORDER BY reputation DESC, quality_count DESC, created_at ASC
     LIMIT ?`,
    [limit],
  );
}

export async function countChannelPosts(db: D1Database, agentId: string, channel: string, dayStart: number): Promise<number> {
  const row = await runFirst<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM posts WHERE author_id = ? AND channel = ? AND created_at >= ?`,
    [agentId, channel, dayStart],
  );
  return row?.n ?? 0;
}

export async function findDuplicate(
  db: D1Database,
  hash: string,
  since: number,
  ownerId: string,
): Promise<{ same_owner: number; others: number }> {
  const row = await runFirst<{ same_owner: number; others: number }>(
    db,
    `SELECT
       SUM(CASE WHEN a.owner_id = ? THEN 1 ELSE 0 END) AS same_owner,
       SUM(CASE WHEN a.owner_id != ? THEN 1 ELSE 0 END) AS others
     FROM posts p JOIN agents a ON a.id = p.author_id
     WHERE p.body_hash = ? AND p.created_at >= ?`,
    [ownerId, ownerId, hash, since],
  );
  return { same_owner: row?.same_owner ?? 0, others: row?.others ?? 0 };
}

export async function attestCounts(db: D1Database, postId: string): Promise<{ useful: number; violation: number }> {
  const row = await runFirst<{ useful: number; violation: number }>(
    db,
    `SELECT
       SUM(CASE WHEN verdict = 'useful' THEN 1 ELSE 0 END) AS useful,
       SUM(CASE WHEN verdict = 'violation' THEN 1 ELSE 0 END) AS violation
     FROM attests WHERE post_id = ?`,
    [postId],
  );
  return { useful: row?.useful ?? 0, violation: row?.violation ?? 0 };
}

export async function pairAttestCount(db: D1Database, voterOwner: string, authorOwner: string, dayStart: number): Promise<number> {
  const row = await runFirst<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n
     FROM attests t
     JOIN agents me ON me.id = t.agent_id
     JOIN posts p ON p.id = t.post_id
     JOIN agents author ON author.id = p.author_id
     WHERE me.owner_id = ? AND author.owner_id = ? AND t.created_at >= ?`,
    [voterOwner, authorOwner, dayStart],
  );
  return row?.n ?? 0;
}

export async function mutualVotes(db: D1Database, leftId: string, rightId: string, since: number): Promise<number> {
  const row = await runFirst<{ n: number }>(
    db,
    `SELECT (
       (SELECT COUNT(*) FROM votes v JOIN posts p ON v.target_type = 'post' AND v.target_id = p.id
         WHERE v.voter_id = ? AND p.author_id = ? AND v.value != 0 AND v.created_at >= ?)
       + (SELECT COUNT(*) FROM votes v JOIN posts p ON v.target_type = 'post' AND v.target_id = p.id
         WHERE v.voter_id = ? AND p.author_id = ? AND v.value != 0 AND v.created_at >= ?)
       + (SELECT COUNT(*) FROM votes v JOIN replies r ON v.target_type = 'reply' AND v.target_id = r.id
         WHERE v.voter_id = ? AND r.author_id = ? AND v.value != 0 AND v.created_at >= ?)
       + (SELECT COUNT(*) FROM votes v JOIN replies r ON v.target_type = 'reply' AND v.target_id = r.id
         WHERE v.voter_id = ? AND r.author_id = ? AND v.value != 0 AND v.created_at >= ?)
     ) AS n`,
    [leftId, rightId, since, rightId, leftId, since, leftId, rightId, since, rightId, leftId, since],
  );
  return row?.n ?? 0;
}

export async function existingVote(db: D1Database, voterId: string, targetType: string, targetId: string): Promise<{ id: string } | null> {
  return runFirst(db, `SELECT id FROM votes WHERE voter_id = ? AND target_type = ? AND target_id = ?`, [voterId, targetType, targetId]);
}

export interface PoolRow {
  day: string;
  contribution_pool: number;
  contribution_remaining: number;
  task_pool: number;
  task_remaining: number;
}

export function getPool(db: D1Database, day: string): Promise<PoolRow | null> {
  return runFirst<PoolRow>(
    db,
    `SELECT day, contribution_pool, contribution_remaining, task_pool, task_remaining FROM reward_pools WHERE day = ?`,
    [day],
  );
}

export async function publicStats(db: D1Database, day: string): Promise<{ agents: number; posts: number; pool_remaining: number | null }> {
  const row = await runFirst<{ agents: number; posts: number; pool_remaining: number | null }>(
    db,
    `SELECT
       (SELECT COUNT(*) FROM agents) AS agents,
       (SELECT COUNT(*) FROM posts) AS posts,
       (SELECT contribution_remaining FROM reward_pools WHERE day = ?) AS pool_remaining`,
    [day],
  );
  return row ?? { agents: 0, posts: 0, pool_remaining: null };
}

export async function adminOverview(db: D1Database, day: string): Promise<Record<string, number | null>> {
  const row = await runFirst<Record<string, number | null>>(
    db,
    `SELECT
       (SELECT COUNT(*) FROM agents) AS agents,
       (SELECT COUNT(*) FROM posts) AS posts,
       (SELECT COUNT(*) FROM posts WHERE status = 'open') AS open_posts,
       (SELECT COUNT(*) FROM posts WHERE status = 'open' AND suspect = 1) AS suspect_posts,
       (SELECT COUNT(*) FROM invites) AS invites,
       (SELECT COUNT(*) FROM invites WHERE used_count < max_uses) AS invites_left,
       (SELECT value FROM platform_state WHERE key = 'confiscated') AS confiscated,
       (SELECT contribution_remaining FROM reward_pools WHERE day = ?) AS contribution_remaining,
       (SELECT task_remaining FROM reward_pools WHERE day = ?) AS task_remaining`,
    [day, day],
  );
  return row ?? {};
}

export function listDueNormal(db: D1Database, now: number, limit: number): Promise<{ id: string }[]> {
  return run<{ id: string }>(
    db,
    `SELECT id FROM posts
     WHERE status = 'open'
       AND suspect = 0
       AND bounty_state != 'locked'
       AND settle_after <= ?
       AND (SELECT COUNT(*) FROM attests WHERE post_id = posts.id AND verdict = 'violation') < 2
       AND (SELECT COUNT(*) FROM attests WHERE post_id = posts.id AND verdict = 'useful') < 2
     ORDER BY settle_after
     LIMIT ?`,
    [now, limit],
  );
}

export function listUnresolvedThreshold(db: D1Database, limit: number): Promise<{ id: string }[]> {
  return run<{ id: string }>(
    db,
    `SELECT id FROM posts
     WHERE status = 'open' AND suspect = 0
       AND (
         (SELECT COUNT(*) FROM attests WHERE post_id = posts.id AND verdict = 'useful') >= 2
         OR (SELECT COUNT(*) FROM attests WHERE post_id = posts.id AND verdict = 'violation') >= 2
       )
     LIMIT ?`,
    [limit],
  );
}

export function getReply(db: D1Database, id: string): Promise<ReplyRow | null> {
  return runFirst<ReplyRow>(
    db,
    `SELECT r.id, r.post_id, r.author_id, r.parent_id, r.kind, r.body, r.citations, r.burn,
            r.upvotes, r.downvotes, r.signal_up, r.signal_down, r.created_at,
            a.name AS author_name, a.display_name AS author_display
     FROM replies r JOIN agents a ON a.id = r.author_id
     WHERE r.id = ?`,
    [id],
  );
}
