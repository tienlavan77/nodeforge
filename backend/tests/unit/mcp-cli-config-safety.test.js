// Business purpose: verifies that external CLI integration preserves developer-owned configuration
// and routes native tools through Forge so compaction receipts remain trustworthy.
// Technical description: exercises install preflight, repeated install/uninstall, permission preservation,
// and the Claude PreToolUse JSON contract in isolated temporary project directories.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolveForgeCliCommand } from "../../src/transport/cli/mcp-config-merge.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { installMcpIntegration, uninstallMcpIntegration, runMcpLifecycleCli } from "../../src/transport/cli/mcp-lifecycle.js";

// Business purpose: keeps configuration regression checks isolated from the real workspace.
// Technical description: creates a temporary project and registers cleanup even when assertions fail.
function createProject(t) {
  const root = mkdtempSync(join(tmpdir(), "forge-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// Business purpose: verifies conflicts fail before any configuration can be partially installed.
// Technical description: supplies unmanaged server entries and malformed JSON and compares exact bytes.
test("MCP install preserves unmanaged Forge servers and rejects malformed settings before writes", (t) => {
  for (const [path, content] of [
    [".mcp.json", JSON.stringify({ mcpServers: { forge: { command: "my-forge" } } })],
    [".codex/config.toml", '[mcp_servers.forge]\ncommand = "my-forge"\n'],
    [".codex/config.toml", '[mcp_servers.forge\ncommand = "broken"\n'],
    [".codex/hooks.json", "{ broken codex hooks json"],
    [".codex/hooks.json", JSON.stringify({ hooks: { PreToolUse: "invalid" } })],
    [".claude/settings.local.json", "{ broken json"],
    [".claude/settings.local.json", JSON.stringify({ hooks: { PreToolUse: {} } })]
  ]) {
    const root = createProject(t);
    const fullPath = join(root, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
    assert.throws(() => installMcpIntegration(root));
    assert.equal(readFileSync(fullPath, "utf8"), content);
    for (const other of [".mcp.json", ".codex/config.toml", ".codex/hooks.json", ".claude/settings.local.json"]) {
      if (other !== path) assert.equal(existsSync(join(root, other)), false);
    }
  }
});

// Business purpose: prevents MCP registration from broadening existing developer permissions.
// Technical description: round-trips third-party servers, explicit disabled auto-approval and custom hooks across Claude and Codex.
test("MCP install is idempotent and uninstall restores existing permissions and third-party hooks", (t) => {
  const root = createProject(t);
  const original = {
    enableAllProjectMcpServers: false,
    enabledMcpjsonServers: ["other"],
    permissions: { allow: ["Bash(git status)"] },
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo other" }] }] }
  };
  const originalCodexHooks = {
    hooks: { PreToolUse: [{ matcher: "custom_tool", hooks: [{ type: "command", command: "echo codex-custom" }] }] }
  };
  mkdirSync(join(root, ".claude"));
  mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, ".claude/settings.local.json"), JSON.stringify(original));
  writeFileSync(join(root, ".codex/hooks.json"), JSON.stringify(originalCodexHooks));
  const codex = '# user comment\n[mcp_servers.other]\ncommand = "other"\n';
  writeFileSync(join(root, ".codex/config.toml"), codex);
  installMcpIntegration(root);
  installMcpIntegration(root);
  const settings = JSON.parse(readFileSync(join(root, ".claude/settings.local.json"), "utf8"));
  assert.equal(settings.enableAllProjectMcpServers, false);
  assert.deepEqual(settings.enabledMcpjsonServers, ["other", "forge"]);
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.equal(settings.hooks.SessionStart.length, 2);
  assert.match(settings.hooks.PreToolUse[0].matcher, /Edit/);
  const codexToml = readFileSync(join(root, ".codex/config.toml"), "utf8");
  assert.equal((codexToml.match(/\[mcp_servers\.forge\]/g) ?? []).length, 1);
  assert.equal((codexToml.match(/\[\[hooks\.PreToolUse\]\]/g) ?? []).length, 1);
  assert.equal((codexToml.match(/\[\[hooks\.SessionStart\]\]/g) ?? []).length, 1);
  const codexHooks = JSON.parse(readFileSync(join(root, ".codex/hooks.json"), "utf8"));
  assert.equal(codexHooks.hooks.PreToolUse.length, 2);
  assert.equal(codexHooks.hooks.SessionStart.length, 1);
  uninstallMcpIntegration(root);
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".claude/settings.local.json"), "utf8")), original);
  assert.deepEqual(JSON.parse(readFileSync(join(root, ".codex/hooks.json"), "utf8")), originalCodexHooks);
  assert.equal(readFileSync(join(root, ".codex/config.toml"), "utf8").trim(), codex.trim());
});

// Business purpose: ensures native discovery and mutation cannot bypass Forge checksum receipts in Claude CLI or Codex CLI.
// Technical description: validates hook stdout for fallback (no stdin), Claude/Codex built-in tools (`Read`, `apply_patch`, `read_file`), and shell commands (blocking direct file reads/writes while allowing safe test/build runs).
test("MCP pre-tool hook returns a structured deny decision pointing to Forge and evaluates stdin payloads", async () => {
  const runHook = async (payload) => {
    let stdout = "";
    let stderr = "";
    const stdin = payload === undefined ? null : {
      isTTY: false,
      async text() { return JSON.stringify(payload); }
    };
    const code = await runMcpLifecycleCli(["mcp", "pre-tool-hook"], {
      stdin,
      stdout: { write: (text) => { stdout += text; } },
      stderr: { write: (text) => { stderr += text; } }
    });
    assert.equal(code, 0);
    assert.equal(stderr, "");
    return JSON.parse(stdout);
  };

  const fallback = await runHook(undefined);
  assert.equal(fallback.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(fallback.hookSpecificOutput.permissionDecision, "deny");
  assert.match(fallback.hookSpecificOutput.permissionDecisionReason, /mcp__forge__/);

  for (const [toolName, expectedToolHint] of [
    ["Read", /mcp__forge__read_file/],
    ["Grep", /mcp__forge__search_text/],
    ["Glob", /mcp__forge__list_files/],
    ["Edit", /mcp__forge__edit_diff/],
    ["Write", /mcp__forge__write_diff/],
    ["apply_patch", /mcp__forge__edit_diff/],
    ["read_file", /mcp__forge__read_file/],
    ["list_dir", /mcp__forge__search_tree/],
    ["write_file", /mcp__forge__write_diff/],
    ["edit_file", /mcp__forge__edit_diff/]
  ]) {
    const denied = await runHook({ tool_name: toolName, tool_input: {} });
    assert.equal(denied.decision, "block");
    assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
    assert.match(denied.hookSpecificOutput.permissionDecisionReason, expectedToolHint);
  }

  for (const badCmd of [
    "cat src/index.js",
    "rg pattern backend/src",
    "sed -i 's/a/b/g' src/index.js",
    "echo 'x' > src/index.js",
    "rm src/index.js"
  ]) {
    const shellDenied = await runHook({ tool_name: "exec_command", tool_input: { command: badCmd } });
    assert.equal(shellDenied.hookSpecificOutput.permissionDecision, "deny", `Expected deny for: ${badCmd}`);
    assert.match(shellDenied.hookSpecificOutput.permissionDecisionReason, /mcp__forge__/);
  }

  for (const safeCmd of [
    "node --test backend/tests/unit/mcp-cli-config-safety.test.js",
    "npm test",
    "git status"
  ]) {
    const shellAllowed = await runHook({ tool_name: "Bash", tool_input: { command: safeCmd } });
    assert.equal(shellAllowed.decision, "allow", `Expected allow for: ${safeCmd}`);
    assert.equal(shellAllowed.hookSpecificOutput.permissionDecision, "allow");
  }
});

// Business purpose: keeps installed CLI hooks usable in developer paths with spaces and apostrophes.
// Technical description: executes both generated commands in a POSIX shell and verifies literal
// argument delivery, including a variable-like path segment that must never expand in the shell.
test("MCP hook commands preserve shell metacharacters in project and script paths", (t) => {
  const root = join(createProject(t), "owner's $FORGE_HOOK_LITERAL");
  mkdirSync(root);
  const script = join(root, "print args.mjs");
  writeFileSync(script, "console.log(JSON.stringify(process.argv.slice(2)));");
  const commands = resolveForgeCliCommand(root, { cliScriptPath: script });
  for (const [command, action] of [[commands.digestHookCommand, "context-digest"], [commands.preToolHookCommand, "pre-tool-hook"]]) {
    const output = execFileSync("/bin/sh", ["-c", command], {
      env: { ...process.env, FORGE_HOOK_LITERAL: "expanded" }, encoding: "utf8"
    });
    assert.deepEqual(JSON.parse(output), ["mcp", action, "--project", root]);
  }
});
