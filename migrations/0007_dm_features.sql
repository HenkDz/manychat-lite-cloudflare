-- Follower-status cache for people who message the account. Successful
-- lookups are reused for up to 24 hours, failed lookups for five minutes.
CREATE TABLE IF NOT EXISTS instagram_profiles (
  owner_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  username TEXT,
  is_follower INTEGER CHECK (is_follower IN (0, 1)),
  checked_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  safe_error TEXT,
  PRIMARY KEY (owner_id, sender_id)
);

-- DM tools start switched off: no starters, no story rules, no follower checks
-- and no DM keyword replies. One example custom reply shows the format.
INSERT OR IGNORE INTO automation_settings (key, value, updated_at)
VALUES (
  'dm_features',
  '{"revision":"initial","startersEnabled":false,"starters":[],"followerCheckEnabled":false,"followerReply":"","nonFollowerReply":"","keywordRepliesEnabled":false,"customReplies":[{"id":"ask","label":"Ask a question","text":"Thanks for reaching out! Send your question here and I will reply as soon as I can."}],"storyRules":[]}',
  datetime('now')
);

INSERT OR IGNORE INTO automation_settings (key, value, updated_at)
VALUES (
  'icebreakers_publish',
  '{"state":"not_published","error":null,"syncedAt":null,"settingsHash":null,"leaseUntil":0,"leaseOwner":null}',
  datetime('now')
);
