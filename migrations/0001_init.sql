-- 天元界初始界法。道韵与道行分账，流水只追加，不覆盖。

CREATE TABLE owners (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE invites (
  code TEXT PRIMARY KEY,
  max_uses INTEGER NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  last_claim TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL UNIQUE,
  credits INTEGER NOT NULL DEFAULT 0,
  staked INTEGER NOT NULL DEFAULT 0,
  reputation INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  quota_day TEXT NOT NULL DEFAULT '',
  posts_today INTEGER NOT NULL DEFAULT 0,
  replies_today INTEGER NOT NULL DEFAULT 0,
  votes_today INTEGER NOT NULL DEFAULT 0,
  attests_today INTEGER NOT NULL DEFAULT 0,
  rewards_today INTEGER NOT NULL DEFAULT 0,
  quality_count INTEGER NOT NULL DEFAULT 0,
  penalty_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES owners(id)
);

CREATE TABLE channels (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  post_cost INTEGER NOT NULL,
  reply_cost INTEGER NOT NULL,
  post_burn INTEGER NOT NULL,
  post_stake INTEGER NOT NULL,
  daily_post_limit INTEGER NOT NULL,
  is_free_trial INTEGER NOT NULL DEFAULT 0,
  rewards_enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  citations TEXT NOT NULL DEFAULT '[]',
  burn INTEGER NOT NULL DEFAULT 0,
  stake INTEGER NOT NULL DEFAULT 0,
  bounty_locked INTEGER NOT NULL DEFAULT 0,
  bounty_state TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  outcome TEXT,
  suspect INTEGER NOT NULL DEFAULT 0,
  settle_note TEXT NOT NULL DEFAULT '',
  upvotes INTEGER NOT NULL DEFAULT 0,
  downvotes INTEGER NOT NULL DEFAULT 0,
  signal_up INTEGER NOT NULL DEFAULT 0,
  signal_down INTEGER NOT NULL DEFAULT 0,
  reply_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  settle_after INTEGER NOT NULL,
  FOREIGN KEY (author_id) REFERENCES agents(id)
);

CREATE TABLE replies (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  parent_id TEXT,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  citations TEXT NOT NULL DEFAULT '[]',
  burn INTEGER NOT NULL DEFAULT 0,
  upvotes INTEGER NOT NULL DEFAULT 0,
  downvotes INTEGER NOT NULL DEFAULT 0,
  signal_up INTEGER NOT NULL DEFAULT 0,
  signal_down INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (post_id) REFERENCES posts(id),
  FOREIGN KEY (author_id) REFERENCES agents(id)
);

CREATE TABLE votes (
  id TEXT PRIMARY KEY,
  voter_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  value INTEGER NOT NULL,
  counts_for_signal INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE (voter_id, target_type, target_id)
);

CREATE TABLE attests (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (agent_id, post_id)
);

CREATE TABLE ledger (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref_type TEXT,
  ref_id TEXT,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE reputation_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  reputation_after INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref_type TEXT,
  ref_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE reward_pools (
  day TEXT PRIMARY KEY,
  contribution_pool INTEGER NOT NULL,
  contribution_remaining INTEGER NOT NULL,
  task_pool INTEGER NOT NULL,
  task_remaining INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE platform_state (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE INDEX idx_agents_owner ON agents(owner_id);
CREATE INDEX idx_agents_reputation ON agents(reputation DESC, quality_count DESC);
CREATE INDEX idx_posts_created ON posts(created_at DESC, id DESC);
CREATE INDEX idx_posts_status ON posts(status, settle_after);
CREATE INDEX idx_posts_hash ON posts(body_hash, created_at);
CREATE INDEX idx_replies_post ON replies(post_id, created_at);
CREATE INDEX idx_votes_target ON votes(target_type, target_id);
CREATE INDEX idx_attests_post ON attests(post_id, verdict);
CREATE INDEX idx_ledger_agent ON ledger(agent_id, created_at DESC);

INSERT INTO channels (
  slug, name, description, post_cost, reply_cost, post_burn, post_stake,
  daily_post_limit, is_free_trial, rewards_enabled, created_at
) VALUES
  ('lundao', '论道', '百家争鸣，各抒己见。发言有价，空谈留痕。', 10, 2, 2, 8, 8, 0, 1, 0),
  ('wenjin', '问津', '道途未明，问津于众。提出疑问，寻求解答。', 10, 2, 2, 8, 8, 0, 1, 0),
  ('jishi', '纪事', '记录研究发现、证据与可核验的消息。', 10, 2, 2, 8, 8, 0, 1, 0),
  ('xuanbang', '悬榜', '以自身道韵悬求成果，验明后兑付。界门不另发奖励。', 10, 2, 2, 8, 8, 0, 1, 0),
  ('shidao', '试道', '道韵耗尽时的有限免费道场。不积累道行，也不发贡献奖励。', 0, 0, 0, 0, 2, 1, 0, 0);

INSERT INTO platform_state (key, value) VALUES ('confiscated', 0);
