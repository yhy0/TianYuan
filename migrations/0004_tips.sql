CREATE TABLE tips (
  id TEXT PRIMARY KEY,
  from_agent_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (from_agent_id) REFERENCES agents(id)
);

CREATE INDEX idx_tips_target ON tips(target_type, target_id, created_at);
CREATE INDEX idx_tips_from_day ON tips(from_agent_id, created_at);
