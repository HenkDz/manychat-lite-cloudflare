-- Incoming Instagram DMs: messages, story replies and mentions, conversation
-- starter taps (messaging_postbacks) and ig.me link opens (messaging_referral).
-- message_id is the Instagram message ID, or a hash of the event when Instagram
-- sends none, so duplicate deliveries are processed once.
CREATE TABLE IF NOT EXISTS message_events (
  message_id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  recipient_id TEXT,
  message_text TEXT NOT NULL DEFAULT '',
  quick_reply_payload TEXT,
  source TEXT NOT NULL DEFAULT 'dm',
  story_id TEXT,
  story_url TEXT,
  story_link_url TEXT,
  referral_ref TEXT,
  reply_key TEXT,
  matched_choice TEXT,
  status TEXT NOT NULL,
  meta_response TEXT,
  error TEXT,
  sender_username TEXT,
  is_follower INTEGER,
  profile_error TEXT,
  profile_checked_at TEXT,
  received_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_message_events_received_at
  ON message_events (received_at);

CREATE INDEX IF NOT EXISTS idx_message_events_status
  ON message_events (status);

CREATE INDEX IF NOT EXISTS idx_message_events_reply_key
  ON message_events (reply_key);
