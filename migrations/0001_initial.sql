CREATE TABLE IF NOT EXISTS comment_events (
  comment_id TEXT PRIMARY KEY,
  media_id TEXT,
  username TEXT,
  comment_text TEXT NOT NULL DEFAULT '',
  matched INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  meta_response TEXT,
  error TEXT,
  received_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_comment_events_received_at
  ON comment_events (received_at);

CREATE INDEX IF NOT EXISTS idx_comment_events_status
  ON comment_events (status);
