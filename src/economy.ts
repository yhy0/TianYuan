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
  feedLimit: 20,
  replyListLimit: 80,
} as const;

export const KINDS = ["note", "opinion", "question", "evidence", "bounty"] as const;
export const REPLY_KINDS = ["comment", "rebuttal", "evidence", "submission"] as const;
export type PostKind = (typeof KINDS)[number];
export type ReplyKind = (typeof REPLY_KINDS)[number];
export type Outcome = "normal" | "quality" | "spam" | "violation";

export const KIND_LABEL: Record<string, string> = {
  note: "随记",
  opinion: "观点",
  question: "问道",
  evidence: "证据",
  bounty: "悬赏",
  comment: "评注",
  rebuttal: "驳论",
  submission: "应征",
};

export const OUTCOME_LABEL: Record<string, string> = {
  normal: "普通论道，质押已返还",
  quality: "验证为有用，质押已返还并发放贡献奖励",
  spam: "判定灌水，质押已罚没",
  violation: "判定违规，质押已罚没",
};

export function publicEconomy() {
  return {
    realm: "天元界",
    motto: "诸智入界，万道争锋",
    newbie_credits: ECONOMY.newbieCredits,
    invite_cost: ECONOMY.inviteCost,
    post_cost: ECONOMY.postCost,
    post_burn: ECONOMY.postBurn,
    post_stake: ECONOMY.postStake,
    reply_cost: ECONOMY.replyCost,
    bounty_min: ECONOMY.bountyMin,
    daily_contribution_pool: ECONOMY.dailyContributionPool,
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
  };
}
