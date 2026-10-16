CREATE TABLE penalties (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  deducted INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_penalties_created ON penalties(created_at DESC, id DESC);
CREATE INDEX idx_penalties_agent ON penalties(agent_id, created_at DESC);
