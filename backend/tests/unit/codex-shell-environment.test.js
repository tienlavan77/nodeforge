// Verifies deployed Node tools execute in the real Codex sandbox with the same
// filesystem policy as production, without using a model or gateway credential.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { createCodexSdkGateway } from "../../src/modules/agent/codex-sdk-gateway.js";
import { codexFilesystemEntries, codexNodeRuntime, codexShellEnvironment } from "../../src/modules/agent/codex-shell-environment.js";

// PATH normalization must survive restricted caller environments without duplicate toolchain entries.
test("Codex shell selects the deployed runtime and uses project-local package-manager caches", (t) => {
  const root = "/project";
  const { bin } = codexNodeRuntime();
  const env = codexShellEnvironment({ PATH: `/custom/bin:${bin}:/usr/bin` }, root);
  assert.equal(env.PATH, `${bin}:/custom/bin:/usr/bin`);
  assert.equal(env.npm_config_cache, "/project/.forge/runtime/nf/sdk-cache/npm");
  assert.equal(env.XDG_CACHE_HOME, "/project/.forge/runtime/nf/sdk-cache");

  const scratch = resolve(".forge/scratch");
  mkdirSync(scratch, { recursive: true });
  const groupedRoot = mkdtempSync(join(scratch, "codex-grouped-runtime-"));
  t.after(() => rmSync(groupedRoot, { recursive: true, force: true }));
  mkdirSync(join(groupedRoot, ".forge/runtime/nf"), { recursive: true });
  writeFileSync(join(groupedRoot, ".forge/runtime/runtime-layout.json"), JSON.stringify({ version: 1, layout: "grouped", status: "ready", moves: [] }));
  writeFileSync(join(groupedRoot, ".forge/runtime/nf/nf-runtime-layout.json"), JSON.stringify({ version: 1, layout: "grouped", status: "ready", moves: [] }));
  const groupedEnv = codexShellEnvironment({ PATH: "/usr/bin" }, groupedRoot);
  assert.equal(groupedEnv.XDG_CACHE_HOME, resolve(groupedRoot, ".forge/runtime/nf/sdk/sdk-cache"));
  assert.equal(groupedEnv.npm_config_cache, resolve(groupedRoot, ".forge/runtime/nf/sdk/sdk-cache/npm"));
});

// Ensures Codex SDK Gateway resolves CODEX_HOME (mode 0o700) and cache paths from execution cwd across all agent roles.
test("Codex SDK Gateway resolves isolated CODEX_HOME and sdk-cache per execution cwd across all roles", async (t) => {
  const scratch = resolve(".forge/scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "codex-gateway-cwd-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".forge/runtime/nf"), { recursive: true });
  writeFileSync(join(root, ".forge/runtime/runtime-layout.json"), JSON.stringify({ version: 1, layout: "grouped", status: "ready", moves: [] }));
  writeFileSync(join(root, ".forge/runtime/nf/nf-runtime-layout.json"), JSON.stringify({ version: 1, layout: "grouped", status: "ready", moves: [] }));

  let captured;
  const gateway = createCodexSdkGateway({
    configuration: { getById: (id) => ({ agent_id: id, agent_name: id, role: id, gateway_url: "https://gateway.test/v1", credential_ref: "secret", enabled: true, status: "ready" }) },
    credentialResolver: () => "gateway-key",
    terminalOutput: { write() {} },
    CodexClass: class FakeCodex {
      constructor(options) { captured = options; }
      startThread() { return { id: "thread-role", runStreamed: async () => ({ events: (async function* () { yield { type: "turn.completed", usage: null }; })() }) }; }
    }
  });

  for (const role of ["system_engineer", "architecture_manager", "sprint_leader", "coder", "reviewer"]) {
    await gateway.execute({ agentId: role, correlationId: `CORR-${role}`, cwd: root, prompt: "Inspect" });
    const expectedHome = resolve(root, ".forge/runtime/nf/sdk/codex-homes", role);
    const expectedCache = resolve(root, ".forge/runtime/nf/sdk/sdk-cache");
    assert.equal(captured.env.CODEX_HOME, expectedHome);
    assert.equal(statSync(expectedHome).mode & 0o777, 0o700);
    assert.equal(captured.env.XDG_CACHE_HOME, expectedCache);
    assert.equal(captured.env.npm_config_cache, resolve(expectedCache, "npm"));
  }
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
