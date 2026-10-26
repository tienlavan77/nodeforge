// Verifies deployed Node tools execute in the real Codex sandbox with the same
// filesystem policy as production, without using a model or gateway credential.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { codexFilesystemEntries, codexNodeRuntime, codexShellEnvironment } from "../../src/modules/agent/codex-shell-environment.js";

// PATH normalization must survive restricted caller environments without duplicate toolchain entries.
test("Codex shell selects the deployed runtime and uses project-local package-manager caches", () => {
  const root = "/project";
  const { bin } = codexNodeRuntime();
  const env = codexShellEnvironment({ PATH: `/custom/bin:${bin}:/usr/bin` }, root);
  assert.equal(env.PATH, `${bin}:/custom/bin:/usr/bin`);
  assert.equal(env.npm_config_cache, "/project/.forge/runtime/nf/sdk-cache/npm");
  assert.equal(env.XDG_CACHE_HOME, "/project/.forge/runtime/nf/sdk-cache");
});

// This deployment smoke test checks symlinked npm/pnpm scripts, crypto startup,
// native writes and audit read-only access inside the installed Linux sandbox.
test("Node, npm, npx and pnpm work inside native and audit Codex sandboxes", {
  skip: process.platform !== "linux" || !existsSync("/opt/node-26/lib/node_modules/@openai/codex/bin/codex.js")
}, async () => {
  const root = await mkdtemp(resolve(".forge/test-tmp/codex-node-"));
  try {
    for (const access of ["write", "read"]) {
      const profile = access === "write" ? "engineer" : "audit";
      const env = { ...process.env, ...codexShellEnvironment({ PATH: "/usr/bin:/bin" }, root) };
      delete env.NODE_TEST_CONTEXT;
      delete env.NODE_TEST_IPC;
      const script = `set -e
command -v node npm npx pnpm
node --version
npm --version
npx --version
pnpm --version
node -e 'console.log(process.execPath); console.log(require("node:crypto").createHash("sha256").update("sandbox").digest("hex"))'
if test -r /etc/shadow; then exit 91; fi
if test -r /etc/ssl/private; then exit 92; fi
if test -r /home/tienlavan/.codex/config.toml; then exit 93; fi
if test -w /opt/node-26/bin/node; then exit 94; fi
${access === "write" ? 'node -e \'require("node:fs").writeFileSync("probe.txt", "ok")\'' : 'if test -w probe.txt; then exit 95; fi'}`;
      // Capture through a regular stdout descriptor: this sandbox binary drops
      // JavaScript stdout when invoked with Node's socket-backed capture pipes.
      const outputPath = resolve(root, `output-${access}.txt`);
      const output = await open(outputPath, "w");
      try {
        const result = spawnSync("/opt/node-26/bin/node", ["/opt/node-26/lib/node_modules/@openai/codex/bin/codex.js", "sandbox",
          "-c", `permissions.${profile}.filesystem={${codexFilesystemEntries(root, access).join(",")}}`,
          "-P", profile, "--", "/bin/bash", "--noprofile", "--norc", "-c", script],
        { cwd: root, env, stdio: ["ignore", output.fd, "pipe"], encoding: "utf8", timeout: 30_000 });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        const stdout = await readFile(outputPath, "utf8");
        assert.match(stdout, /\/opt\/node-26\/bin\/node/);
        assert.match(stdout, /v26\./);
        assert.equal(stdout.trim().split("\n").length, 10, stdout);
      } finally { await output.close(); }
    }
    assert.equal(await readFile(resolve(root, "probe.txt"), "utf8"), "ok");
  } finally { await rm(root, { recursive: true, force: true }); }
});
