// Business purpose: verifies external CLI users can discover code and recover trustworthy receipts
// through every advertised Forge discovery and Git read tool.
// Technical description: creates an isolated Git project, executes MCP JSON-RPC requests against the
// project runtime, and checks discovery, schema lookup, disk freshness and ledger data minimization.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProjectMcpRuntime } from "../../src/transport/cli/mcp-serve.js";
import { uninstallMcpIntegration, getMcpIntegrationStatus } from "../../src/transport/cli/mcp-lifecycle.js";

// Business purpose: makes MCP failures actionable instead of hiding them behind undefined payloads.
// Technical description: dispatches a tools/call request and checks both JSON-RPC and tool errors.
async function callTool(runtime, name, args = {}) {
  const response = await runtime.handleJsonRpc({
    jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args }
  });
  assert.equal(response.error, undefined, JSON.stringify(response));
  assert.notEqual(response.result.isError, true, JSON.stringify(response));
  return JSON.parse(response.result.content[0].text);
}

// Business purpose: proves each discovery contract works with the external runtime authorization.
// Technical description: verifies search/list/tree/schema/Git calls and detects edited/deleted receipts.
test("MCP runtime executes all discovery and Git reads and marks stale receipts without raw search text", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-discovery-"));
  let runtime;
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/calc.js"), "// Adds two project values.\nexport function sum(a, b) { return a + b; }\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    runtime = await createProjectMcpRuntime({ projectRoot: root });
    assert.throws(() => uninstallMcpIntegration(root, { purge: true }), { code: "PROJECT_LOCKED" });
    assert.match((await callTool(runtime, "list_files")).stdout, /src\/calc.js/);
    assert.match(JSON.stringify(await callTool(runtime, "search_tree", { path: "src" })), /calc.js/);
    assert.match((await callTool(runtime, "search_text", { paths: ["src"], pattern: "sum" })).stdout, /sum/);
    assert.equal((await callTool(runtime, "git_status")).exit_code, 0);
    assert.equal((await callTool(runtime, "git_diff")).exit_code, 0);
    assert.ok(await callTool(runtime, "lookup_schema"));
    const metadata = await callTool(runtime, "read_file", { path: "src/calc.js" });
    const source = await callTool(runtime, "Read", { file_path: "src/calc.js", symbol: "sum" });
    assert.match(source.content, /function sum/);
    assert.equal(source.sha256, metadata.sha256);
    const digest = await callTool(runtime, "context_digest");
    const ledger = readFileSync(digest.ledger_path, "utf8");
    assert.equal(ledger.includes('"pattern"'), false);
    assert.equal(ledger.includes("return a + b"), false);
    writeFileSync(join(root, "src/calc.js"), "// Updates the project calculation.\nexport function sum(a, b) { return a - b; }\n");
    assert.equal((await getMcpIntegrationStatus(root)).index.status, "stale");
    assert.equal((await callTool(runtime, "context_digest")).active_file_checksums["src/calc.js"].disk_status, "modified_on_disk");
    rmSync(join(root, "src/calc.js"));
    assert.equal((await callTool(runtime, "context_digest")).active_file_checksums["src/calc.js"].disk_status, "deleted_on_disk");
  } finally {
    await runtime?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
