import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildWorker, commentPayload, createHarness, createRule } from "./worker-harness.mjs";

let built;
before(async () => { built = await buildWorker(); });
after(async () => { await built?.dispose(); });

test("connection checks require login and same-origin requests", async (t) => {
  const h = await createHarness(built.worker);
  t.after(() => h.dispose());
  assert.equal((await h.request("/admin/connection")).status, 401);
  assert.equal((await h.postForm("/admin/connection/check", {})).status, 303);
  const cookie = await h.login();
  const response = await h.request("/admin/connection/check", {
    method: "POST",
    headers: { cookie, origin: "https://untrusted.example.test" },
  });
  assert.equal(response.status, 403);
  assert.equal(h.calls.length, 0);
});

test("an admin can verify the account and view renewal dates without exposing the token", async (t) => {
  const h = await createHarness(built.worker, { GRAPH_API_BASE: "https://graph.instagram.com/v25.0" });
  t.after(() => h.dispose());
  h.setResponder(() => Response.json({ user_id: h.env.IG_USER_ID, username: "test_owner" }));
  const cookie = await h.login();
  const checked = await h.postForm("/admin/connection/check", {}, cookie);
  assert.equal(checked.status, 303);
  assert.equal(checked.headers.get("location"), "/admin#connection");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, "GET");
  assert.equal(h.calls[0].url.pathname, "/v25.0/me");
  const response = await h.request("/admin/connection", { headers: { cookie } });
  assert.equal(response.headers.get("cache-control"), "no-store");
  const text = await response.text();
  assert.equal(text.includes(h.env.INSTAGRAM_ACCESS_TOKEN), false);
  const status = JSON.parse(text);
  assert.equal(status.state, "healthy");
  assert.equal(status.username, "test_owner");
  assert.ok(Date.parse(status.nextRefreshAt) > Date.now() + 24 * 60 * 60 * 1000);
  const html = await (await h.request("/admin", { headers: { cookie } })).text();
  assert.match(html, /Instagram connection/);
  assert.match(html, /Connected/);
  assert.match(html, /Next renewal/);
  assert.equal(html.includes(h.env.INSTAGRAM_ACCESS_TOKEN), false);
  assert.equal(h.calls.length, 1, "Reading the dashboard must not make additional Meta requests");
  assert.equal(h.logs.some((line) => line.includes(h.env.INSTAGRAM_ACCESS_TOKEN)), false);
});

test("test mode disables manual and scheduled token checks", async (t) => {
  const h = await createHarness(built.worker, { DRY_RUN: "true" });
  t.after(() => h.dispose());
  const cookie = await h.login();
  await h.postForm("/admin/connection/check", {}, cookie);
  await built.worker.scheduled({ scheduledTime: Date.now(), cron: "0 6 * * *" }, h.env);
  assert.equal(h.calls.length, 0);
  const html = await (await h.request("/admin", { headers: { cookie } })).text();
  assert.match(html, /Connection checks and token renewal are off in test mode/);
});

test("missing Instagram credentials show a setup message instead of failing the dashboard", async (t) => {
  const h = await createHarness(built.worker, { IG_USER_ID: "", INSTAGRAM_ACCESS_TOKEN: "" });
  t.after(() => h.dispose());
  const cookie = await h.login();
  const response = await h.request("/admin", { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Set the INSTAGRAM_ACCESS_TOKEN and IG_USER_ID secrets/);
  assert.equal((await h.postForm("/admin/connection/check", {}, cookie)).status, 303);
  assert.equal(h.calls.length, 0);
});

test("scheduled renewal supplies the new token to both DMs and public replies", async (t) => {
  const h = await createHarness(built.worker, { GRAPH_API_BASE: "https://graph.instagram.com/v25.0" });
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; h.dispose(); });
  h.setResponder((call) => {
    const body = call.url.pathname === "/refresh_access_token"
      ? { access_token: "renewed-test-credential", expires_in: 60 * 24 * 60 * 60 }
      : call.url.pathname.endsWith("/me")
        ? { user_id: h.env.IG_USER_ID, username: "test_owner" }
        : { id: "test-reply", message_id: "test-message" };
    return Response.json(body);
  });
  const initialNow = Date.now();
  const cookie = await h.login();
  await createRule(h, cookie, {
    label: "Free guide", keywords: "GUIDE", reply_text: "Here is the guide.", public_reply_text: "Sent it to you!",
  });
  await h.postForm("/admin/connection/check", {}, cookie);
  Date.now = () => initialNow + 3 * 24 * 60 * 60 * 1000;
  await built.worker.scheduled({ scheduledTime: Date.now(), cron: "0 6 * * *" }, h.env);
  assert.equal(h.calls.filter((call) => call.url.pathname === "/refresh_access_token").length, 1);
  await h.webhook(commentPayload("after-token-renewal", "GUIDE"));
  const sends = h.calls.filter((call) => call.method === "POST");
  assert.equal(sends.length, 2);
  assert.ok(sends.some((call) => call.url.pathname.endsWith("/messages")));
  assert.ok(sends.some((call) => call.url.pathname.endsWith("/replies")));
  for (const call of sends) assert.equal(call.headers.get("authorization"), "Bearer renewed-test-credential");
  assert.equal(h.logs.some((line) => line.includes("renewed-test-credential")), false);
});
