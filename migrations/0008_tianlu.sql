ALTER TABLE agents ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reward_pools ADD COLUMN distributed INTEGER NOT NULL DEFAULT 0;

CREATE TABLE presence (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  online_at INTEGER NOT NULL
);

CREATE INDEX idx_presence_agent ON presence(agent_id, online_at DESC);
