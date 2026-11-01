// Business purpose: verifies that the Forge MCP CLI lifecycle (`forge mcp install`, `forge mcp status`, `forge mcp uninstall`), stdio MCP server (`forge mcp-serve`), Session Compact Ledger, and `context_digest` tool preserve third-party user configurations, enforce safe `--keep-index` and `--purge` lock checks, serve symbol-scoped code discovery with SHA-256 checksums, and detect disk file modifications for context compaction recovery.
// Technical description: exercises `runCli` across `mcp install`, `mcp status`, `mcp uninstall` (with and without `--purge`), `mcp context-digest`, and `mcp-serve` over in-memory stdio streams on temporary project directories.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runCli } from "../../src/transport/cli/index.js";
import { createProjectMcpRuntime } from "../../src/transport/cli/mcp-serve.js";

// Business purpose: creates a temporary project workspace with sample source and Markdown files so CLI lifecycle and MCP server tests run in complete isolation.
// Technical description: allocates a temp directory under `os.tmpdir()`, writes sample JS and Markdown files, and returns a cleanup callback.
function createTempProject() {
  const root = mkdtempSync(join(tmpdir(), "nf-mcp-cli-test-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "calc.js"),
    "// Business purpose: provides basic arithmetic operations for unit testing.\n// Technical description: exports addNumbers and multiplyNumbers functions.\nexport function addNumbers(a, b) { return a + b; }\nexport function multiplyNumbers(a, b) { return a * b; }\n",
    "utf8"
  );
  writeFileSync(join(root, "README.md"), "# Sample Project\n\nThis project tests Forge MCP CLI integration.\n", "utf8");
  return { root, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}

// Business purpose: captures stdout and stderr output from `runCli` invocations so tests can parse JSON responses and verify zero stdout pollution.
// Technical description: collects written string chunks into buffers and returns the exit code alongside `stdout` and `stderr` strings.
async function invokeCli(args, { cwd, stdin } = {}) {
  let out = "";
  let err = "";
  const stdout = { write(chunk) { out += String(chunk); } };
  const stderr = { write(chunk) { err += String(chunk); } };
  const code = await runCli(args, { cwd, stdin, stdout, stderr });
  return { code, stdout: out, stderr: err };
}

test("O2: forge mcp install, status, and uninstall on empty project creates and cleans up managed config files", async () => {
  const project = createTempProject();
  try {
    const installRes = await invokeCli(["mcp", "install", "--project", project.root], { cwd: project.root });
    assert.equal(installRes.code, 0, installRes.stderr);
    assert.equal(JSON.parse(installRes.stdout).status, "installed");
    assert.equal(existsSync(join(project.root, ".mcp.json")), true);
    assert.equal(existsSync(join(project.root, ".claude", "settings.local.json")), true);
    assert.equal(existsSync(join(project.root, ".codex", "config.toml")), true);
    assert.equal(existsSync(join(project.root, ".codex", "hooks.json")), true);

    const status = JSON.parse((await invokeCli(["mcp", "status", "--project", project.root], { cwd: project.root })).stdout);
    assert.equal(status.claude_cli.installed, true);
    assert.equal(status.claude_cli.configured, true);
    assert.equal(status.claude_cli.mcp_json_installed, true);
    assert.equal(status.claude_cli.hooks_installed, true);
    assert.equal(status.codex_cli.installed, true);
    assert.equal(status.codex_cli.configured, true);
    assert.equal(status.codex_cli.mcp_server_installed, true);
    assert.equal(status.codex_cli.hooks_installed, true);
    assert.equal(status.codex_cli.pre_tool_hook_installed, true);
    assert.equal(status.codex_cli.session_start_hook_installed, true);
    assert.equal(status.index.status, "uninitialized");

    writeFileSync(join(project.root, ".codex", "hooks.json"), JSON.stringify({ _nodeforge_created_file: true, hooks: {} }), "utf8");
    const partialCodexStatus = JSON.parse((await invokeCli(["mcp", "status", "--project", project.root], { cwd: project.root })).stdout);
    assert.equal(partialCodexStatus.codex_cli.mcp_server_installed, true);
    assert.equal(partialCodexStatus.codex_cli.hooks_installed, false);
    assert.equal(partialCodexStatus.codex_cli.configured, false);
    assert.equal(partialCodexStatus.codex_cli.installed, false);

    await invokeCli(["mcp", "install", "--project", project.root], { cwd: project.root });
    const hookInput = new PassThrough();
    hookInput.end(JSON.stringify({ tool_name: "apply_patch", tool_input: { patch: "*** Begin Patch" } }));
    const hookRes = await invokeCli(["mcp", "pre-tool-hook", "--project", project.root], { cwd: project.root, stdin: hookInput });
    assert.equal(hookRes.code, 0, hookRes.stderr);
    const hookOut = JSON.parse(hookRes.stdout);
    assert.equal(hookOut.decision, "block");
    assert.equal(hookOut.hookSpecificOutput.permissionDecision, "deny");
    assert.match(hookOut.hookSpecificOutput.permissionDecisionReason, /mcp__forge__edit_diff/);

    const uninstallRes = await invokeCli(["mcp", "uninstall", "--project", project.root], { cwd: project.root });
    assert.equal(uninstallRes.code, 0, uninstallRes.stderr);
    const uninstalled = JSON.parse(uninstallRes.stdout);
    assert.equal(uninstalled.status, "uninstalled");
    assert.equal(uninstalled.keep_index, true);
    assert.equal(existsSync(join(project.root, ".mcp.json")), false);
    assert.equal(existsSync(join(project.root, ".claude", "settings.local.json")), false);
    assert.equal(existsSync(join(project.root, ".codex", "config.toml")), false);
    assert.equal(existsSync(join(project.root, ".codex", "hooks.json")), false);
  } finally {
    project.cleanup();
  }
});

test("O2: forge mcp install and uninstall preserve third-party MCP servers, permissions, and hooks", async () => {
  const project = createTempProject();
  try {
    mkdirSync(join(project.root, ".claude"), { recursive: true });
    mkdirSync(join(project.root, ".codex"), { recursive: true });
    writeFileSync(join(project.root, ".mcp.json"), JSON.stringify({ mcpServers: { github: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] } } }, null, 2), "utf8");
    writeFileSync(join(project.root, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(git status:*)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo custom-bash-hook" }] }] } }, null, 2), "utf8");
    writeFileSync(join(project.root, ".codex", "config.toml"), "model = \"gpt-5\"\n\n[mcp_servers.custom_server]\ncommand = \"custom-mcp\"\nenabled = true\n", "utf8");

    const installRes = await invokeCli(["mcp", "install", "--project", project.root]);
    assert.equal(installRes.code, 0, installRes.stderr);

    const mcpJsonAfterInstall = JSON.parse(readFileSync(join(project.root, ".mcp.json"), "utf8"));
    assert.ok(mcpJsonAfterInstall.mcpServers.github);
    assert.equal(mcpJsonAfterInstall.mcpServers.forge._managed_by, "nodeforge");

    const claudeAfterInstall = JSON.parse(readFileSync(join(project.root, ".claude", "settings.local.json"), "utf8"));
    assert.deepEqual(claudeAfterInstall.permissions, { allow: ["Bash(git status:*)"] });
    assert.equal(claudeAfterInstall.hooks.PreToolUse.length, 2);
    assert.ok(claudeAfterInstall.hooks.PreCompact);
    assert.ok(claudeAfterInstall.hooks.SessionStart);

    const codexAfterInstall = readFileSync(join(project.root, ".codex", "config.toml"), "utf8");
    assert.match(codexAfterInstall, /\[mcp_servers\.custom_server\]/);
    assert.match(codexAfterInstall, /\[mcp_servers\.forge\]/);
    assert.match(codexAfterInstall, /\[\[hooks\.PreToolUse\]\]/);
    assert.match(codexAfterInstall, /\[\[hooks\.SessionStart\]\]/);

    const uninstallRes = await invokeCli(["mcp", "uninstall", "--project", project.root]);
    assert.equal(uninstallRes.code, 0, uninstallRes.stderr);

    const mcpJsonAfterUninstall = JSON.parse(readFileSync(join(project.root, ".mcp.json"), "utf8"));
    assert.ok(mcpJsonAfterUninstall.mcpServers.github);
    assert.equal(mcpJsonAfterUninstall.mcpServers.forge, undefined);

    const claudeAfterUninstall = JSON.parse(readFileSync(join(project.root, ".claude", "settings.local.json"), "utf8"));
    assert.deepEqual(claudeAfterUninstall.permissions, { allow: ["Bash(git status:*)"] });
    assert.equal(claudeAfterUninstall.hooks.PreToolUse.length, 1);
    assert.equal(claudeAfterUninstall.hooks.PreToolUse[0].matcher, "Bash");
    assert.equal(claudeAfterUninstall.hooks.PreCompact, undefined);
    assert.equal(claudeAfterUninstall.hooks.SessionStart, undefined);

    const codexAfterUninstall = readFileSync(join(project.root, ".codex", "config.toml"), "utf8");
    assert.match(codexAfterUninstall, /\[mcp_servers\.custom_server\]/);
    assert.doesNotMatch(codexAfterUninstall, /\[mcp_servers\.forge\]/);
    assert.doesNotMatch(codexAfterUninstall, /\[\[hooks\.PreToolUse\]\]/);
    assert.doesNotMatch(codexAfterUninstall, /\[\[hooks\.SessionStart\]\]/);
  } finally {
    project.cleanup();
  }
});

test("O1 & O3: forge mcp-serve serves discovery tools and context_digest over stdio JSON-RPC and tracks disk changes in Session Compact Ledger", { timeout: 20000 }, async (t) => {
  const project = createTempProject();
  try {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let stderrText = "";
    stderr.on("data", (chunk) => { stderrText += String(chunk); });

    const lines = [];
    let buffer = "";
    const waiters = [];
    stdout.on("data", (chunk) => {
      buffer += String(chunk);
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) {
          const parsed = JSON.parse(line);
          if (waiters.length > 0) waiters.shift()(parsed);
          else lines.push(parsed);
        }
        idx = buffer.indexOf("\n");
      }
    });
    const nextResponse = () => (lines.length > 0 ? Promise.resolve(lines.shift()) : new Promise((r) => waiters.push(r)));

    const servePromise = runCli(["mcp-serve", "--project", project.root], { cwd: project.root, stdin, stdout, stderr });
    t.after(async () => { stdin.end(); await servePromise; });

    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })}\n`);
    const initResp = await nextResponse();
    assert.equal(initResp.id, 1);
    assert.equal(initResp.result.serverInfo.name, "nodeforge");

    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    const listResp = await nextResponse();
    const toolNames = listResp.result.tools.map((t) => t.name);
    for (const expectedTool of ["read_file", "Read", "search_text", "search_tree", "list_files", "lookup_schema", "context_digest"]) {
      assert.ok(toolNames.includes(expectedTool), `Missing tool ${expectedTool}`);
    }

    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_file", arguments: { path: "src/calc.js" } } })}\n`);
    const metaPayload = JSON.parse((await nextResponse()).result.content[0].text);
    assert.equal(metaPayload.path, "src/calc.js", JSON.stringify(metaPayload));
    assert.match(metaPayload.sha256, /^sha256:[a-f0-9]{64}$/);
    const initialSha = metaPayload.sha256;
    assert.ok(metaPayload.symbol_map.some((s) => s.name === "addNumbers"));

    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "Read", arguments: { file_path: "src/calc.js", symbol: "addNumbers" } } })}\n`);
    const symPayload = JSON.parse((await nextResponse()).result.content[0].text);
    assert.equal(symPayload.symbol, "addNumbers");
    assert.equal(symPayload.sha256, initialSha);
    assert.match(symPayload.content, /return a \+ b;/);

    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "context_digest", arguments: {} } })}\n`);
    const digest1 = JSON.parse((await nextResponse()).result.content[0].text);
    assert.equal(digest1.active_file_checksums["src/calc.js"].sha256, initialSha);
    assert.equal(digest1.active_file_checksums["src/calc.js"].disk_status, "unchanged");

    writeFileSync(join(project.root, "src", "calc.js"), `${readFileSync(join(project.root, "src", "calc.js"), "utf8")}\nexport const EXTRA = 42;\n`, "utf8");

    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "context_digest", arguments: {} } })}\n`);
    const digest2 = JSON.parse((await nextResponse()).result.content[0].text);
    assert.equal(digest2.active_file_checksums["src/calc.js"].disk_status, "modified_on_disk");
    assert.equal(digest2.active_file_checksums["src/calc.js"].recorded_sha256, initialSha);
    assert.notEqual(digest2.active_file_checksums["src/calc.js"].sha256, initialSha);
    assert.ok(digest2.stale_paths.includes("src/calc.js"));

    stdin.end();
    assert.equal(await servePromise, 0, stderrText);

    const hookDigestRes = await invokeCli(["mcp", "context-digest", "--project", project.root]);
    assert.equal(hookDigestRes.code, 0);
    assert.match(hookDigestRes.stdout, /Compact Receipt Digest/);
    assert.match(hookDigestRes.stdout, /modified_on_disk/);
  } finally {
    project.cleanup();
  }
});

test("O2: forge mcp uninstall --keep-index preserves runtime while --purge removes it and respects active process locks", async () => {
  const project = createTempProject();
  try {
    await invokeCli(["mcp", "install", "--project", project.root]);
    const runtime = await createProjectMcpRuntime({ projectRoot: project.root });
    await runtime.handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "src/calc.js" } } });
    await runtime.close();

    const statusBefore = JSON.parse((await invokeCli(["mcp", "status", "--project", project.root])).stdout);
    assert.equal(statusBefore.index.status, "fresh");
    assert.equal(statusBefore.compact_ledger.initialized, true);
    assert.equal(statusBefore.compact_ledger.tracked_files_count, 1);

    const keepRes = await invokeCli(["mcp", "uninstall", "--project", project.root]);
    assert.equal(keepRes.code, 0);
    assert.equal(existsSync(join(project.root, ".forge", "runtime")), true);

    const lockPath = join(project.root, ".forge", "runtime", "nf", ".nodeforge-watcher.lock");
    mkdirSync(join(project.root, ".forge", "runtime", "nf"), { recursive: true });
    writeFileSync(lockPath, `${process.pid}\n`, "utf8");

    const blockedPurge = await invokeCli(["mcp", "uninstall", "--purge", "--project", project.root]);
    assert.equal(blockedPurge.code, 1);
    assert.match(blockedPurge.stderr, /Cannot purge project runtime while an active process holds lock/);
    assert.equal(existsSync(join(project.root, ".forge", "runtime")), true);

    rmSync(lockPath, { force: true });
    const purgeRes = await invokeCli(["mcp", "uninstall", "--purge", "--project", project.root]);
    assert.equal(purgeRes.code, 0, purgeRes.stderr);
    assert.equal(JSON.parse(purgeRes.stdout).purged, true);
    assert.equal(existsSync(join(project.root, ".forge", "runtime")), false);
  } finally {
    project.cleanup();
  }
});
