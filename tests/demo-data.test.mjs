import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { buildWorker, createHarness } from "./worker-harness.mjs";

// scripts/demo-data.sql must keep working with the migrations, the dashboard
// and the placeholder values in .dev.vars.example that the README tells people to use.
let built;
before(async () => { built = await buildWorker(); });
after(async () => { await built?.dispose(); });

async function exampleVars() {
  const text = await readFile(".dev.vars.example", "utf8");
  return Object.fromEntries(text.split("\n")
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]));
}

test("the local demo data loads after the migrations and fills every dashboard section", async (t) => {
  const vars = await exampleVars();
  assert.equal(vars.DRY_RUN, "true", ".dev.vars.example keeps test mode on");
  const h = await createHarness(built.worker, { ...vars, GRAPH_API_BASE: "https://graph.instagram.com/v25.0" });
  t.after(() => h.dispose());
  const sql = await readFile("scripts/demo-data.sql", "utf8");
  await h.db.exec(sql);
  await h.db.exec(sql);
  assert.equal(h.query("SELECT COUNT(*) AS count FROM rules WHERE id BETWEEN 101 AND 104").count, 4, "Re-running replaces the demo rows");
  assert.equal(h.query("SELECT COUNT(*) AS count FROM comment_events").count, 8);
  assert.equal(h.query("SELECT COUNT(*) AS count FROM message_events").count, 6);
  assert.equal(h.query("SELECT COUNT(*) AS count FROM instagram_tokens").count, 1);

  const cookie = await h.login();
  const json = await (await h.request("/admin/dm-features", { headers: { cookie } })).json();
  assert.equal(json.settings.startersEnabled, true, "Demo DM settings must pass validation");
  assert.equal(json.settings.starters.length, 4);
  assert.equal(json.settings.storyRules.length, 3);
  assert.equal(json.settings.customReplies.length, 2);

  const connection = await (await h.request("/admin/connection", { headers: { cookie } })).json();
  assert.equal(connection.state, "healthy", "The demo connection record must match the .dev.vars.example placeholders");
  assert.equal(connection.username, "demo.creator");
  assert.ok(connection.nextRefreshAt && connection.expiresAt && connection.lastRefreshedAt);

  const html = await (await h.request("/admin", { headers: { cookie } })).text();
  for (const expected of [
    "Free photo guide", "Lightroom presets", "Workshop waitlist", "Podcast episode",
    "@demo_reader_1", "@demo_reader_10", "Conversation starter", "Story reply", "Link source: newsletter",
    "Custom replies", "Collaborations", "Any story reply with GUIDE",
    "https://ig.me/demo.creator?ref=rule-101__website", "@demo.creator", "Instagram connection",
  ]) {
    assert.ok(html.includes(expected), `Dashboard should show ${expected}`);
  }
  const connectionPanel = html.match(/<section id="connection"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.equal((connectionPanel.match(/<time /g) ?? []).length, 4, "Every connection date is filled");
  assert.equal(h.calls.length, 0, "Loading demo data never calls Instagram");
});
