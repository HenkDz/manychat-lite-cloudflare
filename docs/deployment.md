# Deployment

## Deploy to Cloudflare

[Deploy this template](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2FHenkDz%2Fmanychat-lite-cloudflare)

1. Prepare the Meta Instagram app and Business/Creator account using [the Meta guide](../README.md#5-configure-meta). Get an Instagram Login token with `instagram_business_basic`, `instagram_business_manage_comments` and `instagram_business_manage_messages`, its account `user_id`, and the app secret.
2. Open the deployment link, sign in to Cloudflare, authorize its Git integration, and choose a repository, Worker and D1 database name. Review your account's applicable limits and pricing before deploying.
3. Fill in all five required secrets; the template supplies no shared passwords or credentials. Accept `npm run deploy` as the deploy command; leave the build command empty. The source has no frontend build step or runtime dependencies.
4. Deploy. Cloudflare provisions the `DB` database and writes its ID into the copied configuration. The deploy command applies migrations `0001` through `0007` via `DB`, then publishes the Worker. A failed migration stops publication. The existing daily token-renewal cron is also configured.
5. Open the deployed URL's `/admin`, log in with your admin token, and follow **Setup**. Copy its callback URL to Meta, enter the same webhook verify token, subscribe the webhook fields, and subscribe the Instagram account to your app as described in the Meta guide.
6. Create a rule. Test a fresh keyword comment from another account and confirm a **Test match** in Activity. Incoming webhook signatures are checked even in test mode.
7. To send real replies, set `DRY_RUN` to `"false"` in your copied `wrangler.jsonc`, commit the change and redeploy. Do not rely on a dashboard variable override: the repository configuration is the source of truth. Check the connection from the dashboard to verify the account and start token renewal. Check a fresh real reply before relying on automation.

## Required values

The deploy screen discovers the secrets in `.dev.vars.example`; descriptions are in `package.json` under `cloudflare.bindings`. Its values are deliberately empty so every installation supplies its own credentials. Fake local demo credentials are isolated in `.dev.vars.local.example`.

| Secret | Source / purpose |
| --- | --- |
| `ADMIN_TOKEN` | Your unique strong dashboard password. Store it in a password manager. |
| `WEBHOOK_VERIFY_TOKEN` | A separate strong random value; also enter it in Meta's callback verification form. |
| `INSTAGRAM_APP_SECRET` | Your Instagram app secret; verifies webhook HMAC signatures. |
| `INSTAGRAM_ACCESS_TOKEN` | Your Instagram Login bootstrap token; keep it configured because renewed tokens in D1 are encrypted using a derived key. |
| `IG_USER_ID` | Token account's professional `user_id`, not a Facebook Page or Meta app ID. |

For CLI deployments, use `wrangler secret put NAME` as shown in the README. For deployed Workers, edit encrypted secrets in Cloudflare's Worker Settings. Never commit real values to `.dev.vars.example`, source, or Wrangler `vars`. An optional `OWNER_IG_USERNAME` secret can be added after deployment; it supports self-comment filtering and DM links before the first connection check.

The deployment does not create Meta credentials, subscribe your Instagram account, complete app review, or provide multi-tenant OAuth. Development-mode access remains limited to the Meta app's roles/testers. See the README's Meta guide for subscription calls, tester invitations and reconnect instructions.

## CLI and updates

Use Node 22.13+ and `npm ci`. The CLI alternative in the README explicitly creates D1 and sets its ID before migration. The template's empty `database_id` enables automatic provisioning in Deploy to Cloudflare; do not run remote migrations against an unchanged template locally and expect them to create a database.

`npm run deploy` always migrates before publishing. `npm run db:migrate:remote` references the binding, so renamed databases work. Cloudflare's copied repository must retain its real provisioned ID. To adopt this change in an existing installation, retain the existing Worker name, account and D1 ID, and keep its configured secrets. Pending migrations are applied once using D1's migration tracking table; no demo data is loaded remotely.

For local preview only:

```sh
npm ci
cp .dev.vars.local.example .dev.vars
npm run db:migrate:local
npm run dev
```

Keep fake values and test mode for local preview. The README has local demo and signed webhook examples. `.dev.vars*` and `.env*` are ignored except the tracked example files.

## Troubleshooting

- **Migrations cannot find DB:** keep the `DB` binding and verify the copied config contains the provisioned database ID. For the CLI path, create D1 first and set its ID. Keep the detected deploy command rather than replacing it with `wrangler deploy`.
- **Deploy screen asks for DRY_RUN or a username:** use this version of `.dev.vars.example`, which contains only five required secret assignments with empty values. Test mode is a Wrangler variable and the username is optional.
- **Admin login fails:** use the exact `ADMIN_TOKEN` you supplied, or replace that encrypted secret in Worker Settings. No anonymous setup endpoint can set a password.
- **Webhook verification fails:** use the deployed `/webhook` URL and exactly matching verify token. Localhost is not a public callback.
- **Webhook verifies but no activity arrives:** subscribe both the callback fields and the professional account to the app. Confirm tester roles, permissions and account ownership in the Meta guide.
- **No connection check in test mode:** intentional. Checks, renewal, starter publishing and all outbound Instagram requests remain disabled until live mode. Test webhook matching first, then check the connection after enabling live mode.
- **Template button shows old code:** the main README button follows the repository's default branch. Changes on a draft PR require the feature-branch deployment link from that PR until merged.

## Validation and limits

`npm test` applies every migration to isolated SQLite and exercises the Worker with mocked Instagram calls. `npm run test:runtime` checks token and DM tools in local workerd. `npm run check` type-checks and bundles with Wrangler's non-deploying dry run. Local D1 migration apply/list verifies Wrangler discovers and applies the SQL files, including repeat application without pending migrations.

These checks do not create a live Worker, create remote resources, authorize a Git integration, validate real Instagram credentials, or prove a live Deploy to Cloudflare dashboard run. Only an authorized live deployment can verify Cloudflare's cloning, provisioning, secret-entry screen and Workers Builds execution end to end.

## Official Cloudflare references

- [Deploy buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/): Git cloning, resource provisioning, secret discovery, binding descriptions and migration deploy scripts.
- [Wrangler automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning): bindings without resource IDs and provisioning behavior.
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/): migration tracking and apply commands.
- [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/): encrypted credentials and local development files.
