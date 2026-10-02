import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare, createFetchMock } from "miniflare";

// Verify Web Crypto, request options and D1 in Cloudflare's actual runtime (workerd).
// All credentials are fake and every outbound request is intercepted; no network is used.
const fakeMeta = createFetchMock();
fakeMeta.disableNetConnect();
const graph = fakeMeta.get("https://graph.instagram.com");
graph.intercept({ path: /^\/v25\.0\/me\?/, method: "GET" })
  .reply(200, { user_id: "runtime-account", username: "runtime_test" }).persist();
graph.intercept({ path: /^\/refresh_access_token\?/, method: "GET" })
  .reply(200, { access_token: "runtime-renewed-token", expires_in: 5184000 }).persist();
const expectedStarters = [
  { question: "Get the guide", payload: "DM_REPLY__rule-1" },
  { question: "Ask a question", payload: "DM_REPLY__text-ask" },
];
let postedStarterBody;
graph.intercept({
  path: /^\/v25\.0\/100001\?/, method: "GET",
  headers: { authorization: "Bearer runtime-renewed-token" },
}).reply(200, { username: "runtime_reader", is_user_follow_business: true });
graph.intercept({ path: /^\/v25\.0\/100002\?/, method: "GET" })
  .reply(302, "", { headers: { location: "https://untrusted.example.test/profile" } });
graph.intercept({
  path: "/v25.0/runtime-account/messenger_profile", method: "POST",
  headers: { authorization: "Bearer runtime-renewed-token" },
}).reply((options) => {
  // Miniflare forwards request bodies as streams, not strings for body matching.
  postedStarterBody = new Response(options.body).json();
  return { statusCode: 200, data: { success: true } };
});
graph.intercept({ path: "/v25.0/me/messenger_profile?fields=ice_breakers", method: "GET" })
  .reply(200, { data: [{ ice_breakers: [{ locale: "default", call_to_actions: expectedStarters }] }] });

const bundled = await build({
  stdin: {
    contents: `import { maintainInstagramAccessToken, getInstagramAccessToken } from './src/instagram-token.ts';
      import { getDmFeatureSettings, saveDmFeatureSettings, lookupInstagramProfile, publishIceBreakers, getIceBreakersPublicationStatus } from './src/dm-features.ts';
      export default { async fetch(request, env) {
        const url = new URL(request.url);
        const now = Number(url.searchParams.get('now'));
        if (url.pathname === '/profile') return Response.json(await lookupInstagramProfile(env, url.searchParams.get('id'), now));
        if (url.pathname === '/save-starters') {
          const settings = await getDmFeatureSettings(env.DB);
          settings.startersEnabled = true;
          settings.starters = [{ title: 'Get the guide', reply: 'rule-1' }, { title: 'Ask a question', reply: 'text-ask' }];
          await saveDmFeatureSettings(env.DB, settings);
          return Response.json(settings);
        }
        if (url.pathname === '/publish') return Response.json(await publishIceBreakers(env, undefined, now));
        if (url.pathname === '/publication') return Response.json(await getIceBreakersPublicationStatus(env.DB));
        const status = await maintainInstagramAccessToken(env, now);
        return Response.json({ status, token: await getInstagramAccessToken(env, now) });
      } };`,
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", logLevel: "silent",
});
const mf = new Miniflare({
  modules: true, compatibilityDate: "2026-06-30", script: bundled.outputFiles[0].text,
  d1Databases: ["DB"], fetchMock: fakeMeta,
  bindings: {
    INSTAGRAM_ACCESS_TOKEN: "runtime-initial-token", IG_USER_ID: "runtime-account",
    GRAPH_API_BASE: "https://graph.instagram.com/v25.0",
  },
});
try {
  const db = await mf.getD1Database("DB");
  const migrations = (await readdir("migrations")).filter((filename) => filename.endsWith(".sql")).sort();
  for (const filename of migrations) {
    const sql = await readFile(`migrations/${filename}`, "utf8");
    // Repository migrations end each statement with a semicolon and a newline.
    for (const statement of sql.split(/;\s*(?:\r?\n|$)/)) {
      if (statement.replace(/^\s*--.*$/gm, "").trim()) await db.prepare(statement).run();
    }
  }
  const now = Date.now();
  const initial = await (await mf.dispatchFetch(`http://localhost/?now=${now}`)).json();
  assert.equal(initial.status.state, "healthy", initial.status.error);
  assert.equal(initial.token, "runtime-initial-token");
  const renewed = await (await mf.dispatchFetch(`http://localhost/?now=${now + 3 * 86400000}`)).json();
  assert.equal(renewed.status.state, "healthy", renewed.status.error);
  assert.equal(renewed.token, "runtime-renewed-token");
  assert.equal(renewed.status.expiresAt, new Date(now + 63 * 86400000).toISOString());
  const stored = await db.prepare("SELECT token_ciphertext FROM instagram_tokens").first();
  assert.match(stored.token_ciphertext, /^v1\./);
  assert.equal(stored.token_ciphertext.includes("runtime-renewed-token"), false);
  console.log("Cloudflare runtime: account check, encrypted storage and token renewal passed.");

  const profile = await (await mf.dispatchFetch(`http://localhost/profile?id=100001&now=${now}`)).json();
  assert.equal(profile.isFollower, true, profile.error);
  assert.equal(profile.username, "runtime_reader");
  const cached = await (await mf.dispatchFetch(`http://localhost/profile?id=100001&now=${now + 1000}`)).json();
  assert.deepEqual(cached, profile, "The second lookup must use D1; the network mock only accepts one request");
  const redirected = await (await mf.dispatchFetch(`http://localhost/profile?id=100002&now=${now}`)).json();
  assert.equal(redirected.isFollower, null);
  assert.match(redirected.error, /unexpected (redirect|response)/, "Redirect responses must fail safely in workerd");
  assert.equal(JSON.stringify(redirected).includes("runtime-renewed-token"), false);
  const beforePublish = await (await mf.dispatchFetch("http://localhost/publication")).json();
  assert.equal(beforePublish.state, "not_published");
  await mf.dispatchFetch("http://localhost/save-starters");
  const published = await (await mf.dispatchFetch(`http://localhost/publish?now=${now}`, { method: "POST" })).json();
  assert.equal(published.state, "synced", published.error);
  assert.ok(postedStarterBody, "Starter publication must make the expected POST request");
  assert.deepEqual(await postedStarterBody, {
    platform: "instagram",
    ice_breakers: [{ locale: "default", call_to_actions: expectedStarters }],
  });
  assert.equal(published.syncedAt, new Date(now).toISOString());
  assert.deepEqual(await (await mf.dispatchFetch("http://localhost/publication")).json(), published);
  fakeMeta.assertNoPendingInterceptors();
  console.log("Cloudflare runtime: profile lookup and cache, redirect rejection and verified starter publication passed.");
} finally {
  await mf.dispose();
  await fakeMeta.close();
}
