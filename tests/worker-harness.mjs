import { createHmac } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// Exercise the real Worker and SQL migrations without a server or live Meta calls.
// Node 22.13+ supplies SQLite; the adapter implements the D1 methods the Worker uses.
export async function buildModule(entryPoint) {
  const directory = await mkdtemp(join(tmpdir(), "manychat-lite-tests-"));
  const output = join(directory, "bundle.mjs");
  try {
    await build({
      entryPoints: [entryPoint],
      outfile: output,
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      logLevel: "silent",
    });
    const module = await import(pathToFileURL(output).href);
    return { module, dispose: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function buildWorker() {
  const { module, dispose } = await buildModule("src/index.ts");
  return { worker: module.default, dispose };
}

class Statement {
  constructor(sqlite, sql, bindings = []) {
    this.sqlite = sqlite;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new Statement(this.sqlite, this.sql, bindings);
  }

  async first(column) {
    const row = this.sqlite.prepare(this.sql).get(...this.bindings);
    if (!row) return null;
    return column ? row[column] : { ...row };
  }

  async all() {
    return {
      results: this.sqlite.prepare(this.sql).all(...this.bindings).map((row) => ({ ...row })),
      success: true,
      meta: {},
    };
  }

  async run() {
    const result = this.sqlite.prepare(this.sql).run(...this.bindings);
    return {
      results: [],
      success: true,
      meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
    };
  }
}

export async function createHarness(worker, overrides = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const filenames = (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort();
  for (const filename of filenames) {
    sqlite.exec(await readFile(join("migrations", filename), "utf8"));
  }
  const db = {
    prepare: (sql) => new Statement(sqlite, sql),
    async exec(sql) {
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  // Every credential here is a fake test value.
  const env = {
    DB: db,
    WEBHOOK_VERIFY_TOKEN: "test-webhook-verify-token",
    META_APP_SECRET: "test-meta-app-secret",
    INSTAGRAM_ACCESS_TOKEN: "test-instagram-access-token",
    IG_USER_ID: "test-instagram-account",
    ADMIN_TOKEN: "test-dashboard-password",
    OWNER_IG_USERNAME: "test_owner",
    GRAPH_API_BASE: "https://graph.example.test/v25.0",
    KEYWORD: "guide",
    PRIVATE_REPLY_TEXT: "A fallback reply",
    DRY_RUN: "false",
    ...overrides,
  };
  const calls = [];
  const logs = [];
  const originalFetch = globalThis.fetch;
  // Keep the Worker's structured logs out of test output; set DEBUG_WORKER_LOGS=1 to print them.
  const originalConsole = { log: console.log, warn: console.warn, error: console.error };
  if (!process.env.DEBUG_WORKER_LOGS) {
    for (const level of ["log", "warn", "error"]) {
      console[level] = (...args) => { logs.push(args.map(String).join(" ")); };
    }
  }
  let respond = () => new Response(JSON.stringify({ message_id: "outgoing-test-id" }), {
    headers: { "content-type": "application/json" },
  });
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const rawBody = await request.text();
    const call = {
      url: new URL(request.url),
      method: request.method,
      headers: request.headers,
      body: rawBody ? JSON.parse(rawBody) : null,
    };
    calls.push(call);
    return respond(call);
  };

  async function request(path, init = {}) {
    const pending = [];
    const response = await worker.fetch(new Request(`https://dashboard.example.test${path}`, init), env, {
      waitUntil(promise) { pending.push(promise); },
      passThroughOnException() {},
    });
    await Promise.all(pending);
    return response;
  }

  async function postForm(path, fields, cookie) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      for (const item of Array.isArray(value) ? value : [value]) body.append(key, item);
    }
    return request(path, {
      method: "POST",
      headers: cookie ? { cookie } : {},
      body,
    });
  }

  return {
    env,
    calls,
    logs,
    db,
    query: (sql, ...bindings) => {
      const result = sqlite.prepare(sql).get(...bindings);
      return result ? { ...result } : null;
    },
    queryAll: (sql, ...bindings) => sqlite.prepare(sql).all(...bindings).map((row) => ({ ...row })),
    setResponder(callback) { respond = callback; },
    request,
    postForm,
    async login() {
      const response = await postForm("/admin/login", { token: env.ADMIN_TOKEN });
      const cookie = response.headers.get("set-cookie");
      if (!cookie) throw new Error("Login did not return a session cookie");
      return cookie.split(";")[0];
    },
    async webhook(payload, signatureOverride) {
      const body = JSON.stringify(payload);
      const signature = createHmac("sha256", env.INSTAGRAM_APP_SECRET ?? env.META_APP_SECRET)
        .update(body).digest("hex");
      return request("/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signatureOverride ?? `sha256=${signature}`,
        },
        body,
      });
    },
    dispose() {
      globalThis.fetch = originalFetch;
      Object.assign(console, originalConsole);
      sqlite.close();
    },
  };
}

export function commentPayload(id, text = "GUIDE", username = "reader") {
  return {
    object: "instagram",
    entry: [{
      id: "test-instagram-account",
      changes: [{ field: "comments", value: { id, text, from: { id: `${username}-id`, username }, media: { id: "media-1" } } }],
    }],
  };
}

export function messagePayload(id, text = "GUIDE") {
  return {
    object: "instagram",
    entry: [{
      id: "test-instagram-account",
      messaging: [{
        sender: { id: "reader-account" },
        recipient: { id: "test-instagram-account" },
        timestamp: Date.now(),
        message: { mid: id, text },
      }],
    }],
  };
}

// Creates a keyword rule through the dashboard and returns its database row.
export async function createRule(harness, cookie, fields) {
  const response = await harness.postForm("/admin/rules", { active: "on", ...fields }, cookie);
  if (response.status !== 303) throw new Error(`Rule was not created: ${await response.text()}`);
  return harness.query("SELECT * FROM rules WHERE label = ? ORDER BY id DESC LIMIT 1", fields.label);
}
