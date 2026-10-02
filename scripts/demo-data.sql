-- Demo data for a fictional creator, used for screenshots and local UI work.
--
-- LOCAL DEVELOPMENT DATABASE ONLY. Apply it after the local migrations:
--   npx wrangler d1 migrations apply manychat-lite-cloudflare --local
--   npx wrangler d1 execute manychat-lite-cloudflare --local --file scripts/demo-data.sql
--
-- Never run this file with --remote. It replaces the DM tools settings and adds
-- fake comments and DMs. Every username, link and ID below is made up.
-- Running it again replaces the previous demo rows.

DELETE FROM comment_events WHERE comment_id LIKE 'demo-%';
DELETE FROM message_events WHERE message_id LIKE 'demo-%';
DELETE FROM rules WHERE id IN (101, 102, 103, 104);

INSERT INTO rules (id, label, keywords, reply_text, public_reply_text, link_url, link_button_label, active, created_at, updated_at)
VALUES
  (101, 'Free photo guide', '["GUIDE","guidebook"]',
   'Thanks for commenting! Here is the free beginner photo guide.',
   'Sent it to your DMs!' || char(10) || 'Check your DMs.' || char(10) || 'Just sent it over!',
   'https://example.com/guide', 'Get the guide', 1,
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')),
  (102, 'Lightroom presets', '["PRESET","presets"]',
   'Here are the free Lightroom presets from today''s post. Enjoy!',
   'Presets are in your DMs!' || char(10) || 'Sent!',
   'https://example.com/presets', 'Get presets', 1,
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-21 days'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-21 days')),
  (103, 'Workshop waitlist', '["WORKSHOP"]',
   'The next workshop opens soon. Join the waitlist to hear about it first.',
   'Check your DMs for the waitlist link.',
   'https://example.com/workshop', 'Join waitlist', 1,
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-14 days'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-14 days')),
  (104, 'Podcast episode', '["PODCAST"]',
   'Here is the full episode: https://example.com/podcast',
   NULL, NULL, NULL, 0,
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days'));

INSERT INTO comment_events
  (comment_id, media_id, username, comment_text, matched, status, error, matched_rule_id, matched_keyword, rule_label, received_at, sent_at)
VALUES
  ('demo-c1', 'demo-media-1', 'demo_reader_1', 'GUIDE please!', 1, 'sent', NULL, 101, 'GUIDE', 'Free photo guide',
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-12 minutes'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-12 minutes')),
  ('demo-c2', 'demo-media-2', 'demo_reader_2', 'Would love the presets', 1, 'sent', NULL, 102, 'presets', 'Lightroom presets',
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-35 minutes'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-35 minutes')),
  ('demo-c3', 'demo-media-3', 'demo_reader_3', 'WORKSHOP', 1, 'sent', NULL, 103, 'WORKSHOP', 'Workshop waitlist',
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours')),
  ('demo-c4', 'demo-media-1', 'demo_reader_4', 'guide', 1, 'sent_public_reply_error', 'Meta API 500: temporary public reply error (demo)', 101, 'GUIDE', 'Free photo guide',
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours')),
  ('demo-c5', 'demo-media-2', 'demo_reader_5', 'Beautiful light in this one', 0, 'ignored_no_keyword', NULL, NULL, NULL, NULL,
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 hours'), NULL),
  ('demo-c6', 'demo-media-2', 'demo_reader_6', 'PRESET', 1, 'sent', NULL, 102, 'PRESET', 'Lightroom presets',
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 hours'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 hours')),
  ('demo-c7', 'demo-media-1', 'demo_reader_7', 'guide pls', 1, 'send_error', 'Meta API 400: the comment is too old for a private reply (demo)', 101, 'GUIDE', 'Free photo guide',
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 days'), NULL),
  ('demo-c8', 'demo-media-3', 'demo_reader_8', 'Signing up for the WORKSHOP', 1, 'dry_run_matched', NULL, 103, 'WORKSHOP', 'Workshop waitlist',
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 days'), NULL);

INSERT INTO message_events
  (message_id, sender_id, recipient_id, message_text, quick_reply_payload, source, story_id, story_url, story_link_url, referral_ref,
   reply_key, matched_choice, status, sender_username, is_follower, profile_checked_at, received_at, sent_at)
VALUES
  ('demo-m1', 'demo-000001', 'demo-account', 'Get the free guide', 'DM_REPLY__rule-101', 'starter', NULL, NULL, NULL, NULL,
   'rule-101', 'Free photo guide', 'sent', 'demo_reader_9', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-20 minutes'),
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-20 minutes'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-20 minutes')),
  ('demo-m2', 'demo-000002', 'demo-account', 'When is the next one?', NULL, 'story_reply', '1234567890', NULL, NULL, NULL,
   'rule-103', 'Workshop waitlist', 'sent', 'demo_reader_10', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-50 minutes'),
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-50 minutes'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-50 minutes')),
  ('demo-m3', 'demo-000003', 'demo-account', '', NULL, 'referral', NULL, NULL, NULL, 'rule-102__newsletter',
   'rule-102', 'Lightroom presets', 'sent', NULL, NULL, NULL,
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours')),
  ('demo-m4', 'demo-000004', 'demo-account', 'Do you teach in-person classes?', NULL, 'dm', NULL, NULL, NULL, NULL,
   NULL, NULL, 'ignored_no_match', 'demo_reader_11', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-4 hours'),
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-4 hours'), NULL),
  ('demo-m5', 'demo-000005', 'demo-account', 'Ask a question', 'DM_REPLY__text-ask', 'starter', NULL, NULL, NULL, NULL,
   'text-ask', 'Ask a question', 'sent', 'demo_reader_12', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-6 hours'),
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-6 hours'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-6 hours')),
  ('demo-m6', 'demo-000006', 'demo-account', 'presets please', NULL, 'dm', NULL, NULL, NULL, NULL,
   'rule-102', 'Lightroom presets', 'sent', 'demo_reader_13', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-9 hours'),
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-9 hours'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-9 hours'));

-- Starters, custom replies and story rules that point at the demo rules.
INSERT INTO automation_settings (key, value, updated_at)
VALUES (
  'dm_features',
  '{"revision":"demo","startersEnabled":true,"starters":[{"title":"Get the free guide","reply":"rule-101"},{"title":"Download the presets","reply":"rule-102"},{"title":"Join the workshop waitlist","reply":"rule-103"},{"title":"Ask a question","reply":"text-ask"}],"followerCheckEnabled":true,"followerReply":"Thanks for following!","nonFollowerReply":"Thanks for stopping by!","keywordRepliesEnabled":true,"customReplies":[{"id":"ask","label":"Ask a question","text":"Thanks for reaching out! Send your question here and I will reply as soon as I can."},{"id":"collab","label":"Collaborations","text":"For collaborations, email hello@example.com with a short note about your project."}],"storyRules":[{"id":"demo-story-workshop","label":"Workshop announcement","storyId":"1234567890","storyUrl":"","keyword":"","reply":"rule-103","enabled":true},{"id":"demo-story-guide","label":"Any story reply with GUIDE","storyId":"","storyUrl":"","keyword":"GUIDE","reply":"rule-101","enabled":true},{"id":"demo-story-presets","label":"Presets link sticker","storyId":"","storyUrl":"https://example.com/presets","keyword":"","reply":"rule-102","enabled":false}]}',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

-- A healthy connection for the Connection panel. The fingerprint matches the
-- placeholder IG_USER_ID and INSTAGRAM_ACCESS_TOKEN in .dev.vars.example (see
-- fingerprint() in src/instagram-token.ts), so copy that file unchanged to
-- .dev.vars for the demo. The stored token is a dummy: test mode never sends.
DELETE FROM instagram_tokens WHERE seed_fingerprint = '49d17ec46855ddc7bf897c3121441698caaeab7ad6b126b9d87a8e536dc73ef1';
INSERT INTO instagram_tokens
  (seed_fingerprint, token_ciphertext, first_observed_at, last_checked_at, last_refreshed_at, next_refresh_at, expires_at, username, needs_reconnect, safe_error)
VALUES (
  '49d17ec46855ddc7bf897c3121441698caaeab7ad6b126b9d87a8e536dc73ef1',
  'v1.demo.demo',
  (strftime('%s', 'now') - 40 * 86400) * 1000,
  (strftime('%s', 'now') - 6 * 3600) * 1000,
  (strftime('%s', 'now') - 12 * 86400) * 1000,
  (strftime('%s', 'now') + 18 * 86400) * 1000,
  (strftime('%s', 'now') + 48 * 86400) * 1000,
  'demo.creator',
  0,
  NULL
);
