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

Meta setup is the fiddly part. The click path below is for the current Meta dashboard pattern where Instagram setup lives under **Use cases**.

This starter is built for **Instagram API with Instagram Login**:

```text
https://graph.instagram.com/v25.0/{IG_USER_ID}/messages
```

Do not choose the Facebook Page token / `graph.facebook.com/{PAGE_ID}/messages` path unless you plan to adapt the code.

#### 5.1. Prepare the Instagram account

1. Open the Instagram account you want to test with.
2. Make sure it is a **Business** or **Creator** account.
   - Mobile app: Profile -> menu -> Settings and privacy -> Account type and tools -> Switch to professional account.
3. Make the account **public** while setting up the app. Meta's tester/token flow often fails silently for private accounts.
4. Confirm you can log in to this Instagram account directly. You will need to accept a tester invitation from this account.

#### 5.2. Create the Meta app with the Instagram use case

1. Go to [Meta for Developers](https://developers.facebook.com/apps/).
2. Click **Create App**.
3. On the use case screen, choose **Manage messaging and content on Instagram**.
   - It may appear under a **Content management** category.
   - If Meta asks what you want the app to do, this is the option you want.
4. Click **Next**.
5. Enter an app name and contact email.
6. If Meta asks for a business portfolio, choose one or skip it for local testing.
7. Click **Create app**.
8. Click **Go to dashboard**.

If you already created a blank app, open the app dashboard and use:

```text
Use cases -> Manage messaging and content on Instagram -> Customize
```

That should add the Instagram product and the **API setup with Instagram login** screen.

#### 5.3. Add the Instagram tester account

In development mode, Meta only lets app roles and testers authenticate. Add your Instagram account as a tester before generating tokens.

1. In the Meta app dashboard, open **App roles** or **Roles** in the left sidebar.
2. Click **Roles** if there is a nested roles page.
3. Click **Add people**.
4. Choose **Instagram Tester**.
5. Enter the Instagram username without `@`.
6. Click **Add**.
7. The account will usually show as **Pending**.

Now accept the invite from Instagram:

1. Log in to that Instagram account on web or mobile.
2. Go to **Settings**.
3. Open **Website permissions**.
4. Open **Apps and websites**.
5. Open **Tester invitations**.
6. Find your Meta app and click **Accept**.
7. Go back to the Meta app dashboard and refresh. The tester should now show as active.

If you see `Insufficient developer role`, this invite was not accepted or you are logged into the wrong Instagram account.

#### 5.4. Authenticate the Instagram account and generate a token

1. In the Meta app dashboard, open:

```text
Use cases -> Manage messaging and content on Instagram -> Customize
```

2. Find **API setup with Instagram login**.
   - In some dashboards it appears as `Instagram -> API setup with Instagram login`.
3. Find the **Instagram accounts** or **Generate access tokens** section.
4. Click **Add account** or **Add Instagram account**.
5. Log in with the same Instagram Business/Creator account you added as a tester.
6. Approve the requested permissions.
7. Back in the dashboard, click **Generate token** for that account.
8. Copy the token. This becomes `INSTAGRAM_ACCESS_TOKEN`.

The permissions you want for this starter are:

```text
instagram_business_basic
instagram_business_manage_comments
instagram_business_manage_messages
```

`instagram_business_manage_comments` is needed for comment webhooks/public replies. `instagram_business_manage_messages` is needed for the private reply DM.

#### 5.5. Get the Instagram user ID

If Meta shows an Instagram user ID beside the connected account, copy it. That value becomes `IG_USER_ID`.

If not, run:

```bash
curl -G "https://graph.instagram.com/v25.0/me" \
  --data-urlencode "fields=id,username" \
  --data-urlencode "access_token=PASTE_INSTAGRAM_ACCESS_TOKEN"
```

Use the returned `id` as `IG_USER_ID`.

#### 5.6. Copy the app secret

In the Meta app dashboard:

```text
App settings -> Basic -> App secret
```

Click **Show**, copy it, and use it as `INSTAGRAM_APP_SECRET`.

The Worker uses this to verify Meta webhook signatures. If your dashboard shows an Instagram-specific app secret under the Instagram setup page, use that value.

#### 5.7. Configure the webhook

Deploy the Worker before this step, because Meta will immediately call your URL to verify it.

1. In Meta's app dashboard, open:

```text
Use cases -> Manage messaging and content on Instagram -> Customize
```

2. Find the **Webhooks** section.
   - In some dashboards this is under `Instagram -> Webhooks`.
   - In older dashboards this is under `Products -> Webhooks`.
3. Click **Configure**.
4. Callback URL:

```text
https://manychat-lite-cloudflare.<your-subdomain>.workers.dev/webhook
```

5. Verify token: paste the same value you set as `WEBHOOK_VERIFY_TOKEN`.
6. Click **Verify and save** or **Save**.
7. Click **Manage** for webhook fields.
8. Subscribe to **comments**.
9. Optional: subscribe to **live_comments** if you want to support Instagram Live comments later.

This app only needs `comments` to trigger comment auto-DMs. It does not need the `messages` webhook unless you extend the app to continue conversations after the user replies.

#### 5.8. Set the matching Cloudflare secrets

```bash
npx wrangler secret put WEBHOOK_VERIFY_TOKEN
npx wrangler secret put INSTAGRAM_APP_SECRET
npx wrangler secret put INSTAGRAM_ACCESS_TOKEN
npx wrangler secret put IG_USER_ID
npx wrangler secret put ADMIN_TOKEN
```

Use this mapping:

| Worker secret | Where it comes from |
| --- | --- |
| `WEBHOOK_VERIFY_TOKEN` | A random string you invent, also pasted into Meta's webhook setup |
| `INSTAGRAM_APP_SECRET` | Meta app dashboard -> App settings -> Basic -> App secret |
| `INSTAGRAM_ACCESS_TOKEN` | Instagram use case -> API setup with Instagram login -> Generate token |
| `IG_USER_ID` | Connected Instagram account ID, or `/me?fields=id,username` response |
| `ADMIN_TOKEN` | A password you invent for this Worker's `/admin` dashboard |
| `OWNER_IG_USERNAME` | Optional Instagram username to ignore, without `@` |

#### 5.9. Test the Meta side

1. Keep `DRY_RUN` set to `"true"` in `wrangler.jsonc`.
2. Deploy:

```bash
npm run deploy
```

3. Tail logs:

```bash
npx wrangler tail
```

4. Comment one of your rule keywords, such as `GUIDE`, on a fresh post from another Instagram account.
5. Look for `dry_run_private_reply` in the logs.
6. If that works, set `DRY_RUN` to `"false"`, deploy again, and test a fresh comment.

#### 5.10. Common Meta setup problems

- **No "Generate token" button**: confirm the app has the Instagram use case customized, the Instagram account is public, the account is Business/Creator, and the tester invitation was accepted.
- **`Insufficient developer role`**: add the Instagram account under App roles -> Instagram Tester, then accept the invite from Instagram -> Settings -> Website permissions -> Apps and websites -> Tester invitations.
- **Webhook verification fails**: confirm the Worker is deployed, the callback URL ends in `/webhook`, and the verify token exactly matches `WEBHOOK_VERIFY_TOKEN`.
- **Webhook verifies but no comments arrive**: confirm you subscribed to the `comments` field and are commenting on content owned by the connected Instagram account.
- **Dry run works but no DM sends**: confirm `DRY_RUN` is `"false"`, the token has message permissions, the comment is less than 7 days old, and you have not already sent a private reply to that comment.
- **Works for your account but not other creators**: that is expected in development mode. For other people's accounts, you need Meta app review, Advanced Access, and a real OAuth onboarding flow.

Meta setup and app review are the hardest parts of this project. The code is small; the platform permissions are the work.

Useful official Meta docs to keep open:

- [Create an Instagram app](https://developers.facebook.com/documentation/instagram-platform/create-an-instagram-app)
- [Instagram webhooks](https://developers.facebook.com/documentation/instagram-platform/webhooks)
- [Private replies](https://developers.facebook.com/documentation/instagram-platform/private-replies)
- [App roles and testers](https://developers.facebook.com/documentation/development/build-and-test/app-roles)
- [Rate limits](https://developers.facebook.com/docs/graph-api/overview/rate-limiting/)

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
