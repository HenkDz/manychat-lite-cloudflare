import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildWorker, createHarness } from "./worker-harness.mjs";

let built;
before(async () => { built = await buildWorker(); });
after(async () => { await built?.dispose(); });

test("deployment checklist is private, shows the callback, and never exposes credentials", async (t) => {
  const h = await createHarness(built.worker, { DRY_RUN: "true" });
  t.after(() => h.dispose());
  const anonymous = await (await h.request("/admin")).text();
  assert.doesNotMatch(anonymous, /Finish Instagram setup|Webhook callback URL/);
  const cookie = await h.login();
  const page = await (await h.request("/admin", { headers: { cookie } })).text();
  assert.match(page, /Finish Instagram setup/);
  assert.match(page, /https:\/\/dashboard\.example\.test\/webhook/);
  assert.match(page, /All required credential names are configured/);
  assert.match(page, /messaging_postbacks/);
  for (const key of ["ADMIN_TOKEN", "WEBHOOK_VERIFY_TOKEN", "META_APP_SECRET", "INSTAGRAM_ACCESS_TOKEN"]) {
    assert.ok(!page.includes(h.env[key]), `${key} must stay secret`);
  }
  assert.equal(h.calls.length, 0);
});

test("setup identifies missing Instagram secrets without contacting Meta", async (t) => {
  const h = await createHarness(built.worker, {
    DRY_RUN: "true", WEBHOOK_VERIFY_TOKEN: "", META_APP_SECRET: "", INSTAGRAM_ACCESS_TOKEN: "", IG_USER_ID: ""
  });
  t.after(() => h.dispose());
  const cookie = await h.login();
  const page = await (await h.request("/admin", { headers: { cookie } })).text();
  assert.match(page, /Missing credentials/);
  assert.match(page, /WEBHOOK_VERIFY_TOKEN, INSTAGRAM_APP_SECRET, INSTAGRAM_ACCESS_TOKEN, IG_USER_ID/);
  assert.equal(h.calls.length, 0);
});
