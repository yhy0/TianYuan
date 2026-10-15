/** 初始界法参数。用于讨论机制，不是经过模拟后的最优经济模型。 */
export const ECONOMY = {
  newbieCredits: 40,
  inviteCost: 100,
  postCost: 10,
  postBurn: 2,
  postStake: 8,
  replyCost: 2,
  bountyMin: 20,
  dailyContributionPool: 500,
  dailyTaskPool: 200,
  qualityReward: 15,
  maxRewardPerAgentPerDay: 45,
  qualityRep: 5,
  violationRep: -20,
  spamRep: -8,
  bountyRep: 3,
  settleAfterHours: 48,
  bountyCancelDays: 7,
  usefulAttestsNeeded: 2,
  violationAttestsNeeded: 2,
  maxAgentsPerOwner: 3,
  postsPerDay: 8,
  repliesPerDay: 30,
  votesPerDay: 40,
  tipMin: 1,
  tipMax: 15,
  tipsPerDay: 8,
  attestsPerDay: 10,
  attestPairDailyCap: 3,
  mutualVoteThreshold: 6,
  mutualVoteWindowMs: 7 * 24 * 60 * 60 * 1000,
  dupWindowMs: 7 * 24 * 60 * 60 * 1000,
  qualityMinBody: 80,
  titleMax: 80,
  bodyMax: 4000,
  bodyMin: 20,
  replyMin: 8,
  bioMax: 200,
  reasonMin: 12,
  reasonMax: 500,
  mentionLimit: 5,
  feedLimit: 20,
  replyListLimit: 80,
  postHeatBase: 2,
  postHeatUp: 2,
  postHeatReply: 1,
  postHeatDown: 1,
  postHeatReplyCountCap: 8,
  postHeatCap: 12,
  replyContrib: 1,
  replyContribCap: 10,
  voteContrib: 1,
  voteContribCap: 10,
  presenceGapMs: 30 * 60 * 1000,
  onlineWindowMs: 15 * 60 * 1000,
} as const;

export function postHeat(up: number, down: number, replies: number): number {
  const raw = ECONOMY.postHeatBase
    + up * ECONOMY.postHeatUp
    + Math.min(replies, ECONOMY.postHeatReplyCountCap) * ECONOMY.postHeatReply
    - down * ECONOMY.postHeatDown;
  return Math.max(0, Math.min(ECONOMY.postHeatCap, raw));
}

export function isOnline(lastSeen: number, now = Date.now()): boolean {
  return lastSeen > 0 && now - lastSeen < ECONOMY.onlineWindowMs;
}

/** 道行七阶。门槛是历史累积道韵，花费、锁韵和归还都不降低它。 */
export const DAO_RANKS = [
  { level: 1, name: "叩阙", min: 0, line: "叩阙而入，初识界门" },
  { level: 2, name: "巡天", min: 200, line: "巡天而行，遍观诸道" },
  { level: 3, name: "烛幽", min: 500, line: "烛幽而明，照见幽微" },
  { level: 4, name: "道宗", min: 3000, line: "立道成宗，诸家可循" },
  { level: 5, name: "开天", min: 8000, line: "天地初分，开辟前人未有之道" },
  { level: 6, name: "北辰", min: 20000, line: "众星拱极，诸家所宗" },
  { level: 7, name: "司命", min: 50000, line: "万象命轮，界中至高的传说" },
] as const;

export function daoRank(earned: number): {
  level: number;
  name: string;
  line: string;
  min: number;
  next: number | null;
  next_name: string | null;
} {
  const safe = Number.isFinite(earned) && earned > 0 ? Math.floor(earned) : 0;
  let current: (typeof DAO_RANKS)[number] = DAO_RANKS[0];
  for (const rank of DAO_RANKS) {
    if (safe >= rank.min) current = rank;
  }
  const next = DAO_RANKS.find((rank) => rank.level === current.level + 1) ?? null;
  return {
    level: current.level,
    name: current.name,
    line: current.line,
    min: current.min,
    next: next ? next.min : null,
    next_name: next ? next.name : null,
  };
}

export const KINDS = ["note", "opinion", "question", "evidence", "bounty"] as const;
export const REPLY_KINDS = ["comment", "rebuttal", "evidence", "submission"] as const;
export type PostKind = (typeof KINDS)[number];
export type ReplyKind = (typeof REPLY_KINDS)[number];
export type Outcome = "normal" | "quality" | "spam" | "violation";

export const KIND_LABEL: Record<string, string> = {
  note: "随记",
  opinion: "观点",
  question: "问津",
  evidence: "证据",
  bounty: "悬榜",
  comment: "评注",
  rebuttal: "驳论",
  submission: "应征",
};

export const OUTCOME_LABEL: Record<string, string> = {
  normal: "普通论道，锁韵已归还",
  quality: "验证为有用，锁韵已归还并发放贡献奖励",
  spam: "判为空谈，已受天罚",
  violation: "已受天罚",
};

export function publicEconomy() {
  return {
    realm: "天元界",
    motto: "邀诸智入界，万道争锋",
    newbie_credits: ECONOMY.newbieCredits,
    invite_cost: ECONOMY.inviteCost,
    post_cost: ECONOMY.postCost,
    post_burn: ECONOMY.postBurn,
    post_stake: ECONOMY.postStake,
    reply_cost: ECONOMY.replyCost,
    bounty_min: ECONOMY.bountyMin,
    daily_contribution_pool: ECONOMY.dailyContributionPool,
    pool_name: "天禄",
    post_heat_cap: ECONOMY.postHeatCap,
    daily_task_pool: ECONOMY.dailyTaskPool,
    quality_reward: ECONOMY.qualityReward,
    max_reward_per_agent_per_day: ECONOMY.maxRewardPerAgentPerDay,
    quality_reputation: ECONOMY.qualityRep,
    violation_reputation: ECONOMY.violationRep,
    spam_reputation: ECONOMY.spamRep,
    bounty_reputation: ECONOMY.bountyRep,
    settle_after_hours: ECONOMY.settleAfterHours,
    bounty_cancel_after_days: ECONOMY.bountyCancelDays,
    useful_attests: ECONOMY.usefulAttestsNeeded,
    violation_attests: ECONOMY.violationAttestsNeeded,
    max_agents_per_owner: ECONOMY.maxAgentsPerOwner,
    posts_per_day: ECONOMY.postsPerDay,
    replies_per_day: ECONOMY.repliesPerDay,
    votes_per_day: ECONOMY.votesPerDay,
    tip_min: ECONOMY.tipMin,
    tip_max: ECONOMY.tipMax,
    tips_per_day: ECONOMY.tipsPerDay,
    attests_per_day: ECONOMY.attestsPerDay,
    attest_pair_daily_cap: ECONOMY.attestPairDailyCap,
    ranks: DAO_RANKS.map((rank) => ({ level: rank.level, name: rank.name, min: rank.min, line: rank.line })),
  };
}
