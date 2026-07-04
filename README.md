# ManyChat-Lite on Cloudflare

A tiny, self-hosted starter for building a ManyChat-style Instagram comment auto-DM tool on Cloudflare Workers.

It listens for Instagram comment webhooks, matches comment text against dashboard-managed keyword rules, and sends one Meta Private Reply DM back to the commenter. It is intentionally small: one Worker, one D1 database, and a built-in admin dashboard.

This project is not affiliated with ManyChat or Meta.

## What It Does

```text
Instagram comment webhook
-> verify Meta webhook signature
-> extract comment_id, username, media_id, and comment text
-> store the comment in D1 so it is only processed once
-> match active keyword rules
-> send a Meta Private Reply DM
-> optionally send a public comment reply
-> record send status, errors, and analytics
```

The starter defaults to `DRY_RUN=true`, so it logs matches without sending DMs until you explicitly go live.

## Features

- Instagram comment webhook verification
- Meta request signature validation
- Keyword-based auto-DM rules
- Optional link-button DMs
- Optional public comment replies
- Comment deduping
- Owner-comment ignore option
- Simple password-protected admin dashboard
- Rule analytics and recent activity logs
- Retry button for failed sends
- Cloudflare D1 migrations

## Architecture

```text
Meta Instagram Webhook
        |
        v
Cloudflare Worker /webhook
        |
        v
D1: comment_events + rules
        |
        v
Meta Instagram Graph API private reply

Admin Dashboard /admin
        |
        v
Create rules, edit rules, inspect activity, retry failures
```

For one creator, this is enough. For a real SaaS clone, keep this repo as the single-account prototype and add multi-tenant OAuth, billing, customer onboarding, and per-account token storage.

## Quick Start

### 1. Install

```bash
npm install
```

### 2. Create a D1 Database

```bash
npx wrangler login
npx wrangler d1 create manychat-lite-cloudflare
```

Copy the returned `database_id` into `wrangler.jsonc`, replacing `REPLACE_WITH_D1_DATABASE_ID`.

Then apply migrations:

```bash
npx wrangler d1 migrations apply manychat-lite-cloudflare --remote
```

### 3. Set Secrets

```bash
npx wrangler secret put WEBHOOK_VERIFY_TOKEN
npx wrangler secret put INSTAGRAM_APP_SECRET
npx wrangler secret put INSTAGRAM_ACCESS_TOKEN
npx wrangler secret put IG_USER_ID
npx wrangler secret put ADMIN_TOKEN
```

Use any long random string for `WEBHOOK_VERIFY_TOKEN`; paste the same value into Meta when adding your webhook callback.

Use `ADMIN_TOKEN` to log in to `/admin`.

Optional:

```bash
npx wrangler secret put OWNER_IG_USERNAME
```

That prevents your own comments from triggering auto-DMs.

### 4. Deploy

```bash
npm run check
npm run deploy
```

Your endpoints will be:

```text
https://manychat-lite-cloudflare.<your-subdomain>.workers.dev/
https://manychat-lite-cloudflare.<your-subdomain>.workers.dev/admin
https://manychat-lite-cloudflare.<your-subdomain>.workers.dev/webhook
```

### 5. Configure Meta

In your Meta developer app:

1. Add Instagram API access.
2. Use an Instagram Business or Creator account.
3. Generate an Instagram access token with the permissions needed to read/manage comments and send private replies.
4. Add the Worker `/webhook` URL as a webhook callback.
5. Use your `WEBHOOK_VERIFY_TOKEN` as the webhook verify token.
6. Subscribe to Instagram comment events.

Meta setup and app review are the hardest parts of this project. The code is small; the platform permissions are the work.

### 6. Add a Rule

Open `/admin`, log in with `ADMIN_TOKEN`, and create a rule:

- Tag: `Lead magnet`
- Terms: `GUIDE, checklist`
- Message: `Thanks for commenting. Here is the guide.`
- Button link: `https://example.com/guide`
- Button label: `Open guide`

Comment `GUIDE` on a fresh Instagram post and watch logs:

```bash
npx wrangler tail
```

If `DRY_RUN=true`, you should see a `dry_run_private_reply` log. When ready, set `DRY_RUN` to `"false"` in `wrangler.jsonc`, deploy again, and test with a real comment.

## Turning This Into a ManyChat-Style SaaS

This repo is the single-account core. To support other creators, add these layers:

1. **OAuth onboarding**
   Let creators connect their Instagram professional account through Meta OAuth instead of manually pasting tokens.

2. **Tenant model**
   Add tables for `users`, `workspaces`, `connected_instagram_accounts`, `access_tokens`, `rules`, `events`, and `subscriptions`.

3. **Webhook routing**
   Route incoming webhook events by Instagram account ID, then load that account's rules and tokens.

4. **Secure token storage**
   Store long-lived tokens encrypted. Rotate and revoke them cleanly.

5. **Background delivery**
   Use Cloudflare Queues for retries, rate-limit handling, and webhook bursts.

6. **Billing**
   Add a plan model such as free trial, creator, and agency. Limit by connected accounts, rule count, or monthly matched comments.

7. **Meta review**
   Prepare a privacy policy, data deletion instructions, screencast, test account, and clear explanation of how your app uses Instagram permissions.

8. **Abuse controls**
   Add per-account send limits, audit logs, opt-out language, and safeguards against spammy keyword campaigns.

## Suggested Database Tables for SaaS

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE connected_instagram_accounts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  ig_user_id TEXT NOT NULL,
  username TEXT,
  encrypted_access_token TEXT NOT NULL,
  token_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  ig_account_id TEXT NOT NULL,
  label TEXT NOT NULL,
  keywords TEXT NOT NULL,
  reply_text TEXT NOT NULL,
  public_reply_text TEXT,
  link_url TEXT,
  link_button_label TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE comment_events (
  comment_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  ig_account_id TEXT NOT NULL,
  media_id TEXT,
  username TEXT,
  comment_text TEXT NOT NULL DEFAULT '',
  matched INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  matched_rule_id INTEGER,
  matched_keyword TEXT,
  error TEXT,
  received_at TEXT NOT NULL,
  sent_at TEXT
);
```

## Useful Commands

```bash
npm run dev
npm run check
npm run deploy
npm run types
```

```bash
npx wrangler d1 execute manychat-lite-cloudflare --remote --command "SELECT comment_id, username, status, received_at, sent_at FROM comment_events ORDER BY received_at DESC LIMIT 20"
```

```bash
npx wrangler d1 execute manychat-lite-cloudflare --remote --command "SELECT label, keywords, active FROM rules ORDER BY id"
```

## Important Limits

- Meta Private Replies are not general cold DMs.
- A private reply is tied to a user commenting on your Instagram professional account's content.
- Send one helpful reply per comment.
- Keep `DRY_RUN=true` until webhook delivery and matching are verified.
- Expect Meta app review to take more time than deploying the code.

## Files to Start With

- `src/index.ts` - Worker, webhook handler, Meta API calls, dashboard UI
- `migrations/` - D1 schema and starter rule
- `wrangler.jsonc` - Cloudflare Worker config
- `.dev.vars.example` - local development secret template
