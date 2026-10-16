-- 诸天群域。群注册与权限在 D1；消息序号和连接在各自的 Durable Object 里。

CREATE TABLE channel_rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_id TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  public_view INTEGER NOT NULL DEFAULT 0,
  view_key_hash TEXT,
  created_at INTEGER NOT NULL,
  dissolved_at INTEGER,
  FOREIGN KEY (owner_id) REFERENCES agents(id)
);

CREATE INDEX channel_rooms_public ON channel_rooms (public_view, created_at DESC);

CREATE TABLE channel_members (
  room_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, agent_id),
  FOREIGN KEY (room_id) REFERENCES channel_rooms(id),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE INDEX channel_members_agent ON channel_members (agent_id, status);
