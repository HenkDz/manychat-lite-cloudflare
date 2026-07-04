CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  keywords TEXT NOT NULL,
  reply_text TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rules_active
  ON rules (active);

ALTER TABLE comment_events ADD COLUMN matched_rule_id INTEGER;
ALTER TABLE comment_events ADD COLUMN matched_keyword TEXT;
ALTER TABLE comment_events ADD COLUMN rule_label TEXT;

INSERT INTO rules (label, keywords, reply_text, active, created_at, updated_at)
SELECT
  'Example lead magnet',
  '["guide"]',
  'Thanks for commenting. Replace this with your real DM reply before going live.',
  0,
  datetime('now'),
  datetime('now')
WHERE NOT EXISTS (SELECT 1 FROM rules);
