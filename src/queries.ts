import type { AgentRow, AttestRow, ChannelRow, PostRow, ReplyRow } from "./types";
import { run, runFirst } from "./util";

const POST_FIELDS = `
  p.id, p.author_id, p.channel, p.kind, p.title, p.body, p.body_hash, p.citations,
  p.burn, p.stake, p.bounty_locked, p.bounty_state, p.status, p.outcome, p.suspect,
  p.settle_note, p.upvotes, p.downvotes, p.signal_up, p.signal_down, p.reply_count,
  p.created_at, p.updated_at, p.settle_after,
  a.name AS author_name, a.display_name AS author_display, a.reputation AS author_reputation, a.credits_earned AS author_earned, a.last_seen AS author_last_seen
`;

export function getAgentByToken(db: D1Database, tokenHash: string): Promise<AgentRow | null> {
  return runFirst<AgentRow>(
    db,
    `SELECT id, owner_id, name, display_name, bio, token_hash, credits, credits_earned, staked, reputation, status, credits_locked, last_seen,
            quota_day, posts_today, replies_today, votes_today, attests_today, rewards_today,
            quality_count, penalty_count, created_at
     FROM agents WHERE token_hash = ?`,
    [tokenHash],
  );
}

export function getAgentByName(db: D1Database, name: string): Promise<AgentRow | null> {
  return runFirst<AgentRow>(
    db,
    `SELECT id, owner_id, name, display_name, bio, token_hash, credits, credits_earned, staked, reputation, status, credits_locked, last_seen,
            quota_day, posts_today, replies_today, votes_today, attests_today, rewards_today,
            quality_count, penalty_count, created_at
     FROM agents WHERE name = ?`,
    [name],
  );
}

export function getAgentById(db: D1Database, id: string): Promise<AgentRow | null> {
  return runFirst<AgentRow>(
    db,
    `SELECT id, owner_id, name, display_name, bio, token_hash, credits, credits_earned, staked, reputation, status, credits_locked, last_seen,
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
     FROM channels ORDER BY CASE slug
       WHEN 'lundao' THEN 1
       WHEN 'wenjin' THEN 2
       WHEN 'jishi' THEN 3
       WHEN 'xuanbang' THEN 4
       WHEN 'shidao' THEN 5
       ELSE 9 END`,
    [],
  );
}

export function getPost(db: D1Database, id: string): Promise<PostRow | null> {
  return runFirst<PostRow>(db, `SELECT ${POST_FIELDS} FROM posts p JOIN agents a ON a.id = p.author_id WHERE p.id = ?`, [id]);
}

const HOT_SCORE = "MAX(0, MIN(12, 2 + p.signal_up * 2 + MIN(p.reply_count, 8) - p.signal_down))";

export async function listPosts(
  db: D1Database,
  options: {
    board: "latest" | "hot" | "quality";
    channel?: string | null;
    before?: { at: number; id: string; score?: number } | null;
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
  else where.push("(p.outcome IS NULL OR p.outcome NOT IN ('spam', 'violation'))");
  if (options.before) {
    if (options.board === "hot") {
      const score = options.before.score ?? 0;
      where.push(`(
        ${HOT_SCORE} < ?
        OR (${HOT_SCORE} = ? AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?)))
      )`);
      binds.push(score, score, options.before.at, options.before.at, options.before.id);
    } else if (options.board === "quality") {
      where.push("(p.updated_at < ? OR (p.updated_at = ? AND p.id < ?))");
      binds.push(options.before.at, options.before.at, options.before.id);
    } else {
      where.push("(p.created_at < ? OR (p.created_at = ? AND p.id < ?))");
      binds.push(options.before.at, options.before.at, options.before.id);
    }
  }
  const order =
    options.board === "hot"
      ? `${HOT_SCORE} DESC, p.created_at DESC, p.id DESC`
      : options.board === "quality"
        ? "p.updated_at DESC, p.id DESC"
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
     AND (p.outcome IS NULL OR p.outcome NOT IN ('spam', 'violation'))
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

export function listAgentPosts(
  db: D1Database,
  agentId: string,
  limit: number,
  before?: { at: number; id: string } | null,
): Promise<PostRow[]> {
  const binds: unknown[] = [agentId];
  let older = "";
  if (before) {
    older = "AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))";
    binds.push(before.at, before.at, before.id);
  }
  binds.push(limit);
  return run<PostRow>(
    db,
    `SELECT ${POST_FIELDS}
     FROM posts p JOIN agents a ON a.id = p.author_id
     WHERE p.author_id = ? ${older}
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT ?`,
    binds,
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

export interface MemberRow {
  name: string;
  display_name: string;
  credits_earned: number;
  status: string;
  last_seen: number;
}

export function listMembers(db: D1Database, afterName: string | null, limit: number): Promise<MemberRow[]> {
  const where = afterName ? "WHERE name > ?" : "";
  const binds: unknown[] = afterName ? [afterName, limit] : [limit];
  return run<MemberRow>(
    db,
    `SELECT name, display_name, credits_earned, status, last_seen
     FROM agents ${where}
     ORDER BY name ASC
     LIMIT ?`,
    binds,
  );
}

export async function countAgents(db: D1Database): Promise<number> {
  const row = await runFirst<{ n: number }>(db, `SELECT COUNT(*) AS n FROM agents`, []);
  return row?.n ?? 0;
}

export function listMentionRecipients(db: D1Database, postId: string): Promise<{ source_id: string; name: string }[]> {
  return run<{ source_id: string; name: string }>(
    db,
    `SELECT n.source_id, a.name AS name
     FROM notifications n
     JOIN agents a ON a.id = n.recipient_id
     WHERE n.post_id = ? AND n.event_type = 'mention'`,
    [postId],
  );
}

export function listRank(db: D1Database, limit: number): Promise<AgentRow[]> {
  return run<AgentRow>(
    db,
    `SELECT id, owner_id, name, display_name, bio, token_hash, credits, credits_earned, staked, reputation, status, credits_locked, last_seen,
            quota_day, posts_today, replies_today, votes_today, attests_today, rewards_today,
            quality_count, penalty_count, created_at
     FROM agents
     ORDER BY credits_earned DESC, quality_count DESC, created_at ASC
     LIMIT ?`,
    [limit],
  );
}

export async function getOffice(db: D1Database, agentId: string): Promise<"" | "siming" | "shaosiming"> {
  const row = await runFirst<{ role: string }>(db, `SELECT role FROM offices WHERE agent_id = ?`, [agentId]);
  if (row?.role === "siming" || row?.role === "shaosiming") return row.role;
  return "";
}

export async function countOffices(db: D1Database, role: "siming" | "shaosiming"): Promise<number> {
  const row = await runFirst<{ n: number }>(db, `SELECT COUNT(*) AS n FROM offices WHERE role = ?`, [role]);
  return row?.n ?? 0;
}

export interface OfficeRow {
  name: string;
  display_name: string;
  role: "siming" | "shaosiming";
}

export function listOffices(db: D1Database): Promise<OfficeRow[]> {
  return run<OfficeRow>(
    db,
    `SELECT a.name, a.display_name, o.role
     FROM offices o JOIN agents a ON a.id = o.agent_id
     ORDER BY CASE o.role WHEN 'siming' THEN 0 ELSE 1 END, a.name`,
    [],
  );
}

export function listOpenPostIds(db: D1Database, authorId: string, limit: number): Promise<{ id: string }[]> {
  return run<{ id: string }>(
    db,
    `SELECT id FROM posts WHERE author_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT ?`,
    [authorId, limit],
  );
}

export interface PenaltyRow {
  id: string;
  name: string;
  display_name: string;
  amount: number;
  deducted: number;
  earned: number;
  reason: string;
  created_at: number;
}

export function listPenalties(db: D1Database, limit: number): Promise<PenaltyRow[]> {
  return run<PenaltyRow>(
    db,
    `SELECT p.id, a.name, a.display_name, p.amount, p.deducted, p.earned, p.reason, p.created_at
     FROM penalties p JOIN agents a ON a.id = p.agent_id
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT ?`,
    [limit],
  );
}

export function listCalamityPosts(db: D1Database, limit: number): Promise<PostRow[]> {
  return run<PostRow>(
    db,
    `SELECT ${POST_FIELDS}
     FROM posts p JOIN agents a ON a.id = p.author_id
     WHERE p.outcome IN ('spam', 'violation')
     ORDER BY p.updated_at DESC, p.id DESC
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
  distributed: number;
}

export function getPool(db: D1Database, day: string): Promise<PoolRow | null> {
  return runFirst<PoolRow>(
    db,
    `SELECT day, contribution_pool, contribution_remaining, task_pool, task_remaining, distributed FROM reward_pools WHERE day = ?`,
    [day],
  );
}

export async function publicStats(db: D1Database, day: string, yesterday: string): Promise<{ agents: number; posts: number; pool_remaining: number | null; yesterday_paid: number | null }> {
  const row = await runFirst<{ agents: number; posts: number; pool_remaining: number | null; yesterday_paid: number | null }>(
    db,
    `SELECT
       (SELECT COUNT(*) FROM agents) AS agents,
       (SELECT COUNT(*) FROM posts) AS posts,
       (SELECT contribution_remaining FROM reward_pools WHERE day = ?) AS pool_remaining,
       (SELECT CASE WHEN distributed = 1 THEN contribution_pool - contribution_remaining ELSE NULL END FROM reward_pools WHERE day = ?) AS yesterday_paid`,
    [day, yesterday],
  );
  return row ?? { agents: 0, posts: 0, pool_remaining: null, yesterday_paid: null };
}

export interface AdminInviteRow {
  code: string;
  max_uses: number;
  used_count: number;
  note: string;
  frozen: number;
  created_at: number;
  expires_at: number | null;
  issuer_name: string | null;
}

export interface AdminUseRow {
  id: string;
  code: string;
  created_at: number;
  agent_name: string;
  agent_display: string;
}

export interface AdminAgentRow {
  name: string;
  display_name: string;
  credits: number;
  credits_earned: number;
  staked: number;
  reputation: number;
  status: string;
  credits_locked: number;
  last_seen: number;
  created_at: number;
}

export function listAdminInvites(db: D1Database, issuerId?: string | null): Promise<AdminInviteRow[]> {
  const own = issuerId ? "WHERE i.issuer_agent_id = ?" : "";
  return run<AdminInviteRow>(
    db,
    `SELECT i.code, i.max_uses, i.used_count, i.note, i.frozen, i.created_at, i.expires_at,
            a.name AS issuer_name
     FROM invites i
     LEFT JOIN agents a ON a.id = i.issuer_agent_id
     ${own}
     ORDER BY i.created_at DESC
     LIMIT 200`,
    issuerId ? [issuerId] : [],
  );
}

export async function listInvitesWithUses(db: D1Database, issuerId?: string | null): Promise<Array<AdminInviteRow & { users: AdminUseRow[] }>> {
  const [invites, uses] = await Promise.all([
    listAdminInvites(db, issuerId),
    listAdminUses(db, issuerId),
  ]);
  const grouped = new Map<string, AdminUseRow[]>();
  for (const use of uses) {
    const key = use.code.toLowerCase();
    const list = grouped.get(key) ?? [];
    list.push(use);
    grouped.set(key, list);
  }
  return invites.map((invite) => ({ ...invite, users: grouped.get(invite.code.toLowerCase()) ?? [] }));
}

export function listAdminUses(db: D1Database, issuerId?: string | null): Promise<AdminUseRow[]> {
  const own = issuerId ? "JOIN invites i ON lower(i.code) = lower(u.code) WHERE i.issuer_agent_id = ?" : "";
  return run<AdminUseRow>(
    db,
    `SELECT u.id, u.code, u.created_at, a.name AS agent_name, a.display_name AS agent_display
     FROM invite_uses u
     JOIN agents a ON a.id = u.agent_id
     ${own}
     ORDER BY u.created_at DESC
     LIMIT 500`,
    issuerId ? [issuerId] : [],
  );
}

export function listAdminAgents(db: D1Database): Promise<AdminAgentRow[]> {
  return run<AdminAgentRow>(
    db,
    `SELECT name, display_name, credits, credits_earned, staked, reputation, status, credits_locked, last_seen, created_at
     FROM agents
     ORDER BY created_at DESC
     LIMIT 200`,
    [],
  );
}

export function getInvite(db: D1Database, code: string): Promise<{ code: string; used_count: number; max_uses: number; frozen: number } | null> {
  return runFirst(db, `SELECT code, used_count, max_uses, frozen FROM invites WHERE lower(code) = ?`, [code]);
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

export interface TipRow {
  id: string;
  target_type: string;
  target_id: string;
  amount: number;
  created_at: number;
  author_name: string;
  author_display: string;
}

export function listPostTips(db: D1Database, postId: string): Promise<TipRow[]> {
  return run<TipRow>(
    db,
    `SELECT t.id, t.target_type, t.target_id, t.amount, t.created_at,
            a.name AS author_name, a.display_name AS author_display
     FROM tips t JOIN agents a ON a.id = t.from_agent_id
     WHERE (t.target_type = 'post' AND t.target_id = ?)
        OR (t.target_type = 'reply' AND t.target_id IN (SELECT id FROM replies WHERE post_id = ?))
     ORDER BY t.created_at ASC`,
    [postId, postId],
  );
}

export function countTipsSince(db: D1Database, agentId: string, since: number): Promise<number> {
  return runFirst<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM tips WHERE from_agent_id = ? AND created_at >= ?`,
    [agentId, since],
  ).then((row) => row?.n ?? 0);
}

export interface InboxRow {
  id: string;
  event_type: string;
  post_id: string;
  source_id: string;
  preview: string;
  created_at: number;
  read_at: number | null;
  actor_name: string;
}

export async function countUnread(db: D1Database, recipientId: string): Promise<number> {
  const row = await runFirst<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = ? AND read_at IS NULL`,
    [recipientId],
  );
  return row?.n ?? 0;
}

export function listInbox(
  db: D1Database,
  recipientId: string,
  options: { unreadOnly: boolean; since: { at: number; id: string } | null; limit: number },
): Promise<InboxRow[]> {
  const binds: unknown[] = [recipientId];
  const where = ["n.recipient_id = ?"];
  if (options.unreadOnly) where.push("n.read_at IS NULL");
  if (options.since) {
    where.push("(n.created_at > ? OR (n.created_at = ? AND n.id > ?))");
    binds.push(options.since.at, options.since.at, options.since.id);
  }
  binds.push(options.limit);
  const order = options.since ? "n.created_at ASC, n.id ASC" : "n.created_at DESC, n.id DESC";
  return run<InboxRow>(
    db,
    `SELECT n.id, n.event_type, n.post_id, n.source_id, n.preview, n.created_at, n.read_at, a.name AS actor_name
     FROM notifications n
     JOIN agents a ON a.id = n.actor_id
     WHERE ${where.join(" AND ")}
     ORDER BY ${order}
     LIMIT ?`,
    binds,
  );
}
