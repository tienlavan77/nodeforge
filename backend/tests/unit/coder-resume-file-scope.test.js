// Verifies both Coder providers restore ticket-owned guidance reads without granting workflow writes or private access.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createNodeforgeTaskExecutors } from "../../src/modules/supervisor/nodeforge-task-executors.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createReadFileTool } from "../../src/tools/governance/agent-lifecycle-tools.js";
import { createSedLinesTool } from "../../src/tools/discovery/sed-lines.js";
import { bindEngineeringTools } from "../../src/tools/engineering-tool-binding.js";

for (const provider of ["codex", "claude"]) {
  test(`${provider} Resume restores safe Node manifest paths and allows project-wide document mutations`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "coder-resume-scope-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const paths = ["CLAUDE.md", "AGENTS.md", "workflows/agents/coder/README.md", "workflows/agents/reviewer/README.md", "workflows/approved-guidance.md", "docs/accepted-guidance.md"];
    for (const path of paths) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), "# Approved guidance\n");
    }
    const fileService = createFileService({ projectRoot: root });
    const registry = {
      read_file: createReadFileTool({ fileService, projectRoot: root }),
      read_lines: createSedLinesTool({ projectRoot: root, toolName: "read_lines", logger: { emit() {} } }),
      write_diff: { execute: async () => ({ written: true }) }
    };
    const executionContext = { task_id: "T-RESUME", manifest_paths: [...paths, "../outside.md", ".forge/runtime/private.json", "backend/.env", "backend/node_modules/package/index.js"] };
    let issued;
    // Probes the actual executor-issued scope through the shared engineering binding before any provider request.
    const execute = async (request) => {
      const binding = provider === "codex" ? request.options.forgeTools : bindEngineeringTools({ registry, context: { ...issued, project_root: root, execution_context: executionContext } });
      for (const path of paths) {
        assert.ok(issued.allowed_file_paths.includes(path), path);
        await binding.registry.read_file.execute({ path });
        await binding.registry.read_lines.execute({ path, start_line: 1, end_line: 2 });
      }
      for (const path of executionContext.manifest_paths.slice(paths.length)) assert.ok(!issued.allowed_file_paths.includes(path), path);
      await assert.rejects(binding.registry.read_file.execute({ path: "workflows/unapproved.md" }), { code: "ENOENT" });
      for (const path of paths.filter((path) => path.startsWith("workflows/"))) {
        assert.deepEqual(await binding.registry.write_diff.execute({ path, content: "overwrite", before_checksum: null }), { written: true });
      }
      throw Object.assign(new Error("Scope probe complete"), { code: "SCOPE_PROBE_COMPLETE" });
    };
    const executors = createNodeforgeTaskExecutors({ projectRoot: root, projectLogger: () => {}, toolRegistry: registry,
      runtimeGovernance: { createExecutionContext: (input) => { issued = input; return input; } },
      codexSdkGateway: { execute }, claudeSdkGateway: { execute } });
    const request = { task_id: "T-RESUME", request_id: "REQ-RESUME", project_id: "PROJECT-A", ticket: { title: "Align guidance", objective: "Read approved documents" }, execution_context: executionContext,
      payload: { resume_from: { status: "failed", last_completed_turn: 14, changed_paths: ["backend/src/prompts.js"] } } };
    await assert.rejects(executors[provider === "codex" ? "runCodexTask" : "runToolTicket"]({ agent_id: "coder", role: "coder", provider }, request), { code: "SCOPE_PROBE_COMPLETE" });
  });

  test(`${provider} fresh execution can read both role rulebooks without borrowing another ticket's manifest`, async () => {
    let issued;
    const executors = createNodeforgeTaskExecutors({ projectRoot: process.cwd(), projectLogger: () => {}, toolRegistry: {},
      runtimeGovernance: { createExecutionContext: (input) => { issued = input; return input; } },
      codexSdkGateway: { execute: async () => { throw new Error("scope captured"); } },
      claudeSdkGateway: { execute: async () => { throw new Error("scope captured"); } } });
    await assert.rejects(executors[provider === "codex" ? "runCodexTask" : "runToolTicket"]({ agent_id: "coder", role: "coder", provider }, {
      task_id: "T-NEW", request_id: "REQ-NEW", ticket: { title: "Implement behavior" },
      execution_context: { task_id: "T-OTHER", manifest_paths: ["workflows/another-ticket.md"] },
      payload: { resume_from: { status: "failed", last_completed_turn: 1 } }
    }), /scope captured/);
    assert.ok(issued.allowed_file_paths.includes("workflows/agents/reviewer/README.md"));
    assert.ok(issued.allowed_file_paths.includes("workflows/agents/coder/README.md"));
    assert.ok(!issued.allowed_file_paths.includes("workflows/another-ticket.md"));
  });
}
