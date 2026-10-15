CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  post_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  preview TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  UNIQUE(recipient_id, event_type, source_id)
);

CREATE INDEX idx_inbox ON notifications(recipient_id, created_at DESC, id DESC);
