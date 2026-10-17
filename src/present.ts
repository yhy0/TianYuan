import { daoRank, isOnline, KIND_LABEL, OUTCOME_LABEL } from "./economy";
import type { AttestRow, PostRow, ReplyRow } from "./types";

export function readJsonArray(raw: string): unknown[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function presentPost(post: PostRow, withBody: boolean): Record<string, unknown> {
  let outcomeLabel = "锁韵中。届时归还；单次驳道不招天罚。";
  if (post.outcome && OUTCOME_LABEL[post.outcome]) outcomeLabel = OUTCOME_LABEL[post.outcome];
  if (post.status === "open" && post.bounty_state === "locked") outcomeLabel = "悬榜锁定中。验明后兑付应征者。";
  if (post.status === "open" && post.suspect) outcomeLabel = "与已有内容重复，锁韵暂不自动归还。";
  const data: Record<string, unknown> = {
    id: post.id,
    title: post.title,
    channel: post.channel,
    kind: post.kind,
    kind_label: KIND_LABEL[post.kind] ?? post.kind,
    author: {
      name: post.author_name ?? "",
      display_name: post.author_display ?? "",
      reputation: post.author_reputation ?? 0,
      rank: daoRank(post.author_earned ?? 0).name,
      online: isOnline(post.author_last_seen ?? 0),
    },
    created_at: post.created_at,
    status: post.status,
    outcome: post.outcome,
    outcome_label: outcomeLabel,
    suspect: post.suspect === 1,
    burn: post.burn,
    stake: post.stake,
    bounty_locked: post.bounty_locked,
    bounty_state: post.bounty_state,
    reply_count: post.reply_count,
    signal_up: post.signal_up,
    signal_down: post.signal_down,
    upvotes: post.upvotes,
    downvotes: post.downvotes,
    settle_after: post.settle_after,
    settle_note: post.settle_note,
  };
  if (withBody) {
    data.body = post.body;
    data.citations = readJsonArray(post.citations);
  }
  return data;
}

export function presentReply(reply: ReplyRow): Record<string, unknown> {
  return {
    id: reply.id,
    post_id: reply.post_id,
    parent_id: reply.parent_id,
    kind: reply.kind,
    kind_label: KIND_LABEL[reply.kind] ?? reply.kind,
    body: reply.body,
    citations: readJsonArray(reply.citations),
    author: { name: reply.author_name ?? "", display_name: reply.author_display ?? "" },
    burn: reply.burn,
    signal_up: reply.signal_up,
    signal_down: reply.signal_down,
    upvotes: reply.upvotes,
    downvotes: reply.downvotes,
    created_at: reply.created_at,
  };
}

export function presentAttest(attest: AttestRow): Record<string, unknown> {
  return {
    id: attest.id,
    verdict: attest.verdict,
    verdict_label: attest.verdict === "useful" ? "验证为有用" : "施以天罚",
    reason: attest.reason,
    author: { name: attest.author_name ?? "", display_name: attest.author_display ?? "" },
    created_at: attest.created_at,
  };
}

export const LEDGER_LABEL: Record<string, string> = {
  grant: "入界初赐",
  post_open: "发表论道",
  reply_burn: "回复还道",
  stake_return: "锁韵归还",
  quality_settle: "有用了结",
  tianlu: "天禄",
  stake_confiscate: "天罚",
  bounty_receive: "悬榜所得",
  bounty_award: "悬榜拨付",
  bounty_cancel: "悬榜退回",
  tip_send: "赠出道韵",
  tip_receive: "受赠道韵",
  invite_mint: "生成邀请码",
  room_open: "开辟洞天",
  tianjie: "天劫",
  reward_revoke: "奖励追回",
};
