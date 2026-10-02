import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Run the real npm deploy script in an isolated project with a fake Wrangler.
// No Cloudflare credentials or network requests are used by these tests.
async function deployFixture(t, failMigration) {
  const directory = await mkdtemp(join(tmpdir(), "manychat-deploy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  await writeFile(join(directory, "package.json"), JSON.stringify({ scripts: packageJson.scripts }));
  const binaryDirectory = join(directory, "node_modules", ".bin");
  await mkdir(binaryDirectory, { recursive: true });
  const stub = join(directory, "fake-wrangler.mjs");
  await writeFile(stub, `import { appendFileSync } from "node:fs";
appendFileSync(process.env.DEPLOY_TEST_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "d1" && process.env.DEPLOY_TEST_FAIL === "true") process.exit(17);
`);
  if (process.platform === "win32") {
    await writeFile(join(binaryDirectory, "wrangler.cmd"), `@"${process.execPath}" "${stub}" %*\r\n`);
  } else {
    const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";
    await writeFile(join(binaryDirectory, "wrangler"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(stub)} "$@"\n`, { mode: 0o755 });
  }
  const log = join(directory, "commands.jsonl");
  // npm_execpath comes from npm test; support running this file directly, too.
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : (process.platform === "win32" ? "npm.cmd" : "npm");
  const args = npmCli ? [npmCli, "run", "deploy"] : ["run", "deploy"];
  const result = spawnSync(command, args, {
    cwd: directory, encoding: "utf8", shell: !npmCli && process.platform === "win32",
    env: { ...process.env, DEPLOY_TEST_LOG: log, DEPLOY_TEST_FAIL: String(failMigration) }
  });
  assert.ifError(result.error);
  const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return { result, calls };
}

test("deploy applies remote migrations through DB before publishing", async (t) => {
  const { result, calls } = await deployFixture(t, false);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(calls, [["d1", "migrations", "apply", "DB", "--remote"], ["deploy"]]);
});

test("a failed migration stops deploy before publishing the Worker", async (t) => {
  const { result, calls } = await deployFixture(t, true);
  assert.notEqual(result.status, 0);
  assert.deepEqual(calls, [["d1", "migrations", "apply", "DB", "--remote"]]);
});
