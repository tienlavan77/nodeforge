// Exercises real Forge wrappers to prevent duplicated operator lines across
// Coder, owner conversations, SL planning and recovery, and independent review.
// Every test uses an isolated project and verifies the audit trail still exists.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createForgeToolRegistry } from "../../src/tools/index.js";
import { createOwnerConversationTools } from "../../src/tools/roles/owner-conversation-tools.js";
import { createSprintLeaderForgeTools } from "../../src/tools/roles/sprint-leader-forge-tools.js";
import { createReviewerForgeTools } from "../../src/modules/supervisor/review/reviewer-forge-tools.js";
import { blockerRecoveryTools } from "../../src/modules/supervisor/blocker/blocker-recovery-tools.js";
import { createRuntimeLogger } from "../../src/core/runtime-logger.js";

/** Builds real project readers and captures each audit/display stream while
 * keeping all source, temporary files and simulated Git results off production. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-terminal-tools-"));
  await mkdir(join(root, "backend/src"), { recursive: true });
  await writeFile(join(root, "backend/src/example.js"), "// Example source for scoped reader tests.\nexport const answer = 42;\n");
  const lines = [], events = [], fileService = createFileService({ projectRoot: root });
  const logger = createRuntimeLogger({ logEvent: (event) => events.push(event), output: { write: (line) => lines.push(line) } });
  const profile = { agent_id: "example-agent", agent_name: "Example", role: "coder", provider: "codex" };
  const context = { task_id: "TICKET-LOG", correlation_id: "CORR-LOG", project_id: "PROJECT-LOG", agent_identity: profile,
    allowed_prefixes: ["backend/"], allowed_file_paths: ["backend/src/example.js"], capabilities: ["read_lines", "git_status", "run_check"] };
  return { root, lines, events, fileService, profile, context, projectLogger: logger.emit,
    close: () => rm(root, { recursive: true, force: true }) };
}

test("Coder Git reads produce one operator result with internal audit events retained", async () => {
  const f = await fixture();
  try {
    const registry = createForgeToolRegistry({ projectRoot: f.root, fileService: f.fileService, protocolStorage: { get: async () => null },
      gitService: { status: async () => " M backend/src/example.js\n", diffWorkingTree: async () => "" }, projectLogger: f.projectLogger });
    await registry.git_status.execute({}, f.context);
    assert.equal(f.lines.length, 1);
    assert.match(f.lines[0], /\[Coder\/Example\] git_status.*files=1.* - SUCCESS/);
    assert(f.events.some((event) => event.event_name === "forge.git_status_completed"));
    assert(f.events.some((event) => event.event_name === "forge.tool_started"));
    assert(f.events.some((event) => event.event_name === "forge.tool_success"));
    f.lines.length = 0;
    await assert.rejects(registry.git_status.execute({ invalid: true }, f.context), { code: "GIT_READ_INPUT_INVALID" });
    assert.equal(f.lines.length, 1);
    assert.match(f.lines[0], /GIT_READ_INPUT_INVALID: git_status.* - FAIL/);
  } finally { await f.close(); }
});

test("a returned failed check is FAIL rather than a successful tool transport", async () => {
  const f = await fixture();
  try {
    const registry = createForgeToolRegistry({ projectRoot: f.root, fileService: f.fileService, protocolStorage: { get: async () => null },
      testService: { runCheck: async () => ({ status: "failed", exit_code: 1 }) }, projectLogger: f.projectLogger });
    const result = await registry.run_check.execute({ type: "test", command: "node --test example.test.js" }, f.context);
    assert.equal(result.status, "failed");
    assert.equal(f.lines.length, 1);
    assert.match(f.lines[0], /CHECK_FAILED: run_check.*exit=1.* - FAIL/);
  } finally { await f.close(); }
});

test("owner, SL planning, recovery and Reviewer readers share the same single result layout", async () => {
  const f = await fixture();
  try {
    for (const [role, label] of [["system_engineer", "SE"], ["architecture_manager", "AM"], ["sprint_leader", "SL"], ["reviewer", "Reviewer"]]) {
      f.lines.length = 0;
      const profile = { ...f.profile, role }, context = { ...f.context, agent_identity: profile };
      const tools = createOwnerConversationTools({ role, projectRoot: f.root, fileService: f.fileService, context, projectLogger: f.projectLogger });
      context.capabilities = tools.definitions.map(({ name }) => name);
      await tools.registry.read_lines.execute({ path: "backend/src/example.js", start_line: 1, end_line: 2 }, context);
      assert.equal(f.lines.length, 1, role);
      assert.ok(f.lines[0].includes(`[${label}/Example] read_lines`));
      assert.match(f.lines[0], /duration=\d+ms.* - SUCCESS/);
    }
    f.lines.length = 0;
    const sl = createSprintLeaderForgeTools({ projectRoot: f.root, fileService: f.fileService, profile: { ...f.profile, role: "sprint_leader" }, correlationId: "CORR-SL", projectLogger: f.projectLogger });
    await sl.registry.read_lines.execute({ path: "backend/src/example.js", start_line: 1, end_line: 2 });
    assert.equal(f.lines.length, 1);
    assert.match(f.lines[0], /\[SL\/Example\] read_lines.* - SUCCESS/);
    f.lines.length = 0;
    const recovery = blockerRecoveryTools({ projectRoot: f.root, fileService: f.fileService, profile: { ...f.profile, role: "architecture_manager" },
      task_id: "TICKET-LOG", correlation_id: "CORR-AM", projectLogger: f.projectLogger });
    await recovery.registry.read_lines.execute({ path: "backend/src/example.js", start_line: 1, end_line: 2 });
    assert.equal(f.lines.length, 1);
    assert.match(f.lines[0], /\[AM\/Example\] read_lines.* - SUCCESS/);
    f.lines.length = 0;
    const reviewer = createReviewerForgeTools({ projectRoot: f.root, fileService: f.fileService, reviewer: { ...f.profile, role: "reviewer" },
      job: { task_id: "TICKET-LOG", correlation_id: "CORR-RV", request_id: "REQ-RV", payload: { changed_paths: ["backend/src/example.js"] } }, projectLogger: f.projectLogger });
    await reviewer.registry.list_files.execute({});
    assert.equal(f.lines.length, 1);
    assert.match(f.lines[0], /\[Reviewer\/Example\] list_files.* - SUCCESS/);
  } finally { await f.close(); }
});
