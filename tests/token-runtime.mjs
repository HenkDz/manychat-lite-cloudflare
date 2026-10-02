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

const bundled = await build({
  stdin: {
    contents: `import { maintainInstagramAccessToken, getInstagramAccessToken } from './src/instagram-token.ts';
      export default { async fetch(request, env) {
        const url = new URL(request.url);
        const now = Number(url.searchParams.get('now'));
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
  fakeMeta.assertNoPendingInterceptors();
} finally {
  await mf.dispose();
  await fakeMeta.close();
}
