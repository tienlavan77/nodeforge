// Summary: Verifies System Engineer coding, checks, scoped commits, pushes, and terminal audit through Forge services.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeLogger } from "../../src/core/runtime-logger.js";
import { createOwnerConversationTools } from "../../src/tools/owner-conversation-tools.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";

test("System Engineer uses Node services for edit, checks, exact-path commit, push, and terminal logs", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "nodeforge-owner-engineer-"));
  try {
    const files = createFileService({ projectRoot });
    const path = "src/example.js";
    const original = "// Existing module summary.\nconst value = 1;\n";
    await files.atomicWrite({ path, content: original, replace: true });
    const state = ownerStateStore("CONV-ENGINEER");
    const committed = [];
    const pushed = [];
    const checks = [];
    const events = [];
    const activities = [];
    const lines = [];
    const logger = createRuntimeLogger({ logEvent: (event) => events.push(event), output: { write: (line) => lines.push(line) } });
    const context = { task_id: "CORR-ENGINEER", correlation_id: "CORR-ENGINEER", conversation_id: "CONV-ENGINEER", project_root: projectRoot, agent_identity: { agent_id: "engineer", agent_name: "Engineer", role: "system_engineer", provider: "codex" } };
    const { definitions, registry } = createOwnerConversationTools({
      role: "system_engineer", projectRoot, fileService: files, conversationStateStore: state, conversationId: "CONV-ENGINEER", context, projectLogger: logger.emit, eventSink: (event) => activities.push(event),
      gitService: { status: async () => "", diffWorkingTree: async () => "", commit: async (message, options) => { committed.push({ message, ...options }); return { sha: "a".repeat(40) }; }, pushCommit: async (sha) => { pushed.push(sha); return { sha, remote: "origin", branch: "ui-chat" }; } },
      testService: { runCheck: async (input) => { checks.push(input); return { status: "passed", breakdown: [{ kind: "lint", status: "passed", exit_code: 0 }] }; } }
    });
    context.capabilities = definitions.map(({ name }) => name);
    const before = `sha256:${createHash("sha256").update(original).digest("hex")}`;
    await registry.edit_diff.execute({ path, before_checksum: before, anchor: "const value = 1;", replacement: "const value = 2;" }, context);
    const check = await registry.run_check.execute({ type: "lint", command: "pnpm exec eslint src/example.js" }, context);
    assert.equal(check.status, "passed");
    assert.equal(check.breakdown[0].exit_code, 0);
    assert.deepEqual(check.changed_paths, [path]);
    await assert.rejects(() => registry.run_check.execute({ type: "test", command: "pnpm test" }, context), { code: "INPUT_INVALID" });
    const commit = await registry.commit_changes.execute({ message: "Update example value" }, context);
    assert.equal(commit.sha, "a".repeat(40));
    assert.deepEqual(committed, [{ message: "Update example value", paths: [path] }]);
    await registry.push_commit.execute({ commit_sha: commit.sha }, context);
    assert.deepEqual(pushed, [commit.sha]);
    assert.equal(checks[0].command, "pnpm exec eslint src/example.js");
    assert.ok(events.some((event) => event.event_name === "owner.tool_call" && event.status === "success" && event.payload.tool === "commit_changes"));
    assert.deepEqual(activities.filter((event) => event.payload.tool_name === "edit_diff").map((event) => event.payload.activity_type), ["tool_started", "tool_completed"]);
    assert.ok(activities.every((event) => event.event_type === "agent.activity" && event.payload.conversation_id === "CONV-ENGINEER" && event.payload.agent_id === "engineer"));
    assert.ok(activities.every((event) => !JSON.stringify(event).includes("const value")));
    assert.ok(lines.some((line) => line.includes("[Engineer] (codex) edit_diff PASS")));
    assert.ok(lines.some((line) => line.includes("[Engineer] (codex) push_commit PASS")));
  } finally { await rm(projectRoot, { recursive: true, force: true }); }
});

// Provides persistent per-conversation changed paths for the owner coding workflow.
function ownerStateStore(conversationId) {
  let state = { conversation_id: conversationId, owner_changed_paths: [] };
  return { get: async () => structuredClone(state), update: async (_id, changes) => { state = { ...state, ...structuredClone(changes) }; return structuredClone(state); } };
}
