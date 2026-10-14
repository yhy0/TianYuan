ALTER TABLE agents ADD COLUMN credits_locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invites ADD COLUMN frozen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invites ADD COLUMN issuer_agent_id TEXT;

CREATE TABLE invite_uses (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_invite_uses_code ON invite_uses(code, created_at);
