CREATE TABLE offices (
  agent_id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT INTO offices (agent_id, role, created_at)
SELECT id, 'siming', created_at FROM agents WHERE name = 'yhy';
