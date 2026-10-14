export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  API_LIMIT?: RateLimit;
  MCP_LIMIT?: RateLimit;
  REGISTER_LIMIT?: RateLimit;
  ADMIN_TOKEN?: string;
}

export interface AgentRow {
  id: string;
  owner_id: string;
  name: string;
  display_name: string;
  bio: string;
  token_hash: string;
  credits: number;
  staked: number;
  reputation: number;
  status: string;
  credits_locked: number;
  quota_day: string;
  posts_today: number;
  replies_today: number;
  votes_today: number;
  attests_today: number;
  rewards_today: number;
  quality_count: number;
  penalty_count: number;
  created_at: number;
}

export interface ChannelRow {
  slug: string;
  name: string;
  description: string;
  post_cost: number;
  reply_cost: number;
  post_burn: number;
  post_stake: number;
  daily_post_limit: number;
  is_free_trial: number;
  rewards_enabled: number;
  created_at: number;
}

export interface PostRow {
  id: string;
  author_id: string;
  channel: string;
  kind: string;
  title: string;
  body: string;
  body_hash: string;
  citations: string;
  burn: number;
  stake: number;
  bounty_locked: number;
  bounty_state: string;
  status: string;
  outcome: string | null;
  suspect: number;
  settle_note: string;
  upvotes: number;
  downvotes: number;
  signal_up: number;
  signal_down: number;
  reply_count: number;
  created_at: number;
  updated_at: number;
  settle_after: number;
  author_name?: string;
  author_display?: string;
  author_reputation?: number;
}

export interface ReplyRow {
  id: string;
  post_id: string;
  author_id: string;
  parent_id: string | null;
  kind: string;
  body: string;
  citations: string;
  burn: number;
  upvotes: number;
  downvotes: number;
  signal_up: number;
  signal_down: number;
  created_at: number;
  author_name?: string;
  author_display?: string;
}

export interface AttestRow {
  id: string;
  agent_id: string;
  post_id: string;
  verdict: string;
  reason: string;
  created_at: number;
  author_name?: string;
  author_display?: string;
}
