import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createReadFileTool, createWriteDiffTool, createEditDiffTool, createCommitChangesTool, createReportDoneTool } from "../../src/tools/governance/agent-lifecycle-tools.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-tools-v2-"));
  const fileService = createFileService({ projectRoot: root });
  return { root, fileService };
}
test("read_file returns metadata for non-Markdown files and up to 250 lines for Markdown with whole-file checksum", async () => {
  const { fileService } = await harness();
  const tool = createReadFileTool({ fileService });
  const big = Array.from({ length: 30 }, (_, i) => `line-${i + 1}`).join("\n");
  await fileService.atomicWrite({ path: "big.txt", content: big, replace: true });
  const full = await tool.execute({ path: "big.txt" }, {});
  assert.equal(full.total_lines, 30);
  assert.equal(full.content, undefined);
  await fileService.atomicWrite({ path: "doc.md", content: big, replace: true });
  const doc = await tool.execute({ path: "doc.md" }, {});
  assert.equal(doc.content, big);
  assert.equal(doc.total_lines, 30);
  assert.equal(doc.limit, 30);
  assert.equal(doc.truncated, false);
  assert.equal(doc.sha256, full.sha256, "checksum must be the whole-file hash");
  await assert.rejects(() => tool.execute({ path: "big.txt", offset: 1, limit: 80 }, {}), (error) => error.code === "INPUT_INVALID");
});
test("read_file returns metadata for large code files and truncates Markdown beyond 250 lines", async () => {
  const { fileService } = await harness();
  const tool = createReadFileTool({ fileService });
  const big = Array.from({ length: 600 }, (_, i) => `line-${i + 1}`).join("\n");
  await fileService.atomicWrite({ path: "large.txt", content: big, replace: true });
  const full = await tool.execute({ path: "large.txt" }, {});
  assert.equal(full.total_lines, 600);
  assert.equal(full.content, undefined);
  assert.match(full.notice, /Read with file_path and symbol/);
  assert.deepEqual(full.symbol_map, []);
  assert.equal(full.sha256, `sha256:${createHash("sha256").update(big).digest("hex")}`);
  await fileService.atomicWrite({ path: "large.md", content: big, replace: true });
  const md = await tool.execute({ path: "large.md" }, {});
  assert.equal(md.limit, 250);
  assert.equal(md.truncated, true);
  assert.equal(md.content.split("\n").length, 250);
});
test("read_file returns metadata for an 81-line project file", async () => {
  const { fileService } = await harness();
  const content = Array.from({ length: 81 }, (_, index) => `line-${index + 1}`).join("\n");
  await fileService.atomicWrite({ path: "project.js", content, replace: true });
  const read = createReadFileTool({ fileService });
  const metadata = await read.execute({ path: "project.js" }, {});
  assert.equal(metadata.content, undefined);
  assert.equal(metadata.total_lines, 81);
  assert.equal(metadata.code_lines, 81);
});
test("coder can read and edit project workflows under current project-access policy", async () => {
  const { fileService } = await harness();
  await fileService.atomicWrite({ path: "workflows/agents/coder/README.md", content: "Coder rules\n", replace: true });
  const context = { agent_identity: { role: "coder" }, allowed_prefixes: ["workflows/"] };
  const read = await createReadFileTool({ fileService }).execute({ path: "workflows/agents/coder/README.md" }, context);
  assert.equal(read.content, "Coder rules\n");
  assert.equal(read.total_lines, 2);
  assert.equal(read.code_lines, 1);
  await assert.rejects(() => createReadFileTool({ fileService }).execute({ path: "workflows/agents/coder/README.md", offset: 1, limit: 251 }, context), (error) => error.code === "INPUT_INVALID");
  await createEditDiffTool({ fileService }).execute({ path: "workflows/agents/coder/README.md", before_checksum: read.sha256, anchor: "Coder", replacement: "Other" }, context);
  assert.equal(await fileService.readFile({ path: "workflows/agents/coder/README.md" }), "Other rules\n");
  const content = "<!-- Defines workflow guidance for this isolated Coder permission fixture. -->\nRules\n";
  await createWriteDiffTool({ fileService }).execute({ path: "workflows/new.md", before_checksum: null, content }, context);
  assert.equal(await fileService.readFile({ path: "workflows/new.md" }), content);
  for (const path of ["../outside.md", ".git/config"]) {
    await assert.rejects(() => createWriteDiffTool({ fileService }).execute({ path, before_checksum: null, content }, context), (error) => error.code === "PATH_FORBIDDEN");
  }
});
test("repeated reads hit EXPLORATION_STAGNANT and a successful edit resets the streak", async () => {
  const { fileService } = await harness();
  const read = createReadFileTool({ fileService });
  const edit = createEditDiffTool({ fileService });
  await fileService.atomicWrite({ path: "code.js", content: "const a = 1;\nconst b = 2;\n", replace: true });
  const context = { task_id: "T-STAG" }, input = { path: "code.js" };
  const before = await read.execute(input, context);
  await read.execute(input, context);
  await read.execute(input, context);
  await assert.rejects(() => read.execute(input, context), (error) => error.code === "EXPLORATION_STAGNANT");
  await edit.execute({ path: "code.js", before_checksum: before.sha256, anchor: "const b = 2;", replacement: "const b = 3;" }, context);
  await read.execute(input, context);
  await read.execute(input, context);
  await assert.rejects(() => read.execute(input, context), (error) => error.code === "EXPLORATION_STAGNANT");
});
test("write_diff enforces 250-line limit for .md and 400 code_lines for code with CONTENT_TOO_LARGE", async () => {
  const { fileService } = await harness();
  const tool = createWriteDiffTool({ fileService });
  await assert.rejects(() => tool.execute({ path: "big.md", content: `${Array.from({ length: 251 }, () => "x").join("\n")}\n`, before_checksum: null }, {}), (error) => {
    assert.equal(error.code, "CONTENT_TOO_LARGE"); assert.equal(error.details.line_count, 251); assert.equal(error.details.limit, 250); return true;
  });
  await assert.rejects(() => tool.execute({ path: "big.txt", content: `${Array.from({ length: 401 }, () => "x").join("\n")}\n`, before_checksum: null }, {}), (error) => {
    assert.equal(error.code, "CONTENT_TOO_LARGE"); assert.equal(error.details.line_count, 401); assert.equal(error.details.limit, 400); return true;
  });
  await tool.execute({ path: "ok.md", content: `<!-- Boundary fixture -->\n${Array.from({ length: 250 }, () => "x").join("\n")}\n`, before_checksum: null }, {});
  await tool.execute({ path: "ok.txt", content: `// Boundary fixture\n${Array.from({ length: 400 }, () => "x").join("\n")}\n`, before_checksum: null }, {});
  await tool.execute({ path: "wide.txt", content: `// Wide fixture\n${"x".repeat(8193)}\n`, before_checksum: null }, {});
});
test("write_diff rejects replacing an existing file over 250 lines (.md) or 400 code_lines (code)", async () => {
  const { fileService } = await harness();
  const tool = createWriteDiffTool({ fileService });
  for (const [path, limit] of [["large.md", 250], ["large.css", 400]]) {
    const original = `${Array.from({ length: limit + 1 }, () => "x").join("\n")}\n`;
    await fileService.atomicWrite({ path, content: original, replace: true });
    const before = await createReadFileTool({ fileService }).execute({ path }, {});
    await assert.rejects(() => tool.execute({ path, content: "small\n", before_checksum: before.sha256 }, {}), (error) => {
      assert.equal(error.code, "DESTRUCTIVE_OVERWRITE"); assert.equal(error.details.current_lines, limit + 1); assert.equal(error.details.limit, limit); return true;
    });
    assert.equal(await fileService.readFile({ path }), original);
  }
});
test("edit_diff replaces a unique anchor, verifies checksum, and reports errors", async () => {
  const { fileService } = await harness();
  const read = createReadFileTool({ fileService });
  const write = createWriteDiffTool({ fileService });
  const edit = createEditDiffTool({ fileService });
  await write.execute({ path: "code.js", content: "// Test code file\nconst a = 1;\nconst b = 2;\n", before_checksum: null }, {});
  const before = await read.execute({ path: "code.js" }, {});
  const result = await edit.execute({ path: "code.js", before_checksum: before.sha256, anchor: "const b = 2;", replacement: "const b = 3;" }, {});
  assert.equal(result.replaced_count, 1);
  const after = await read.execute({ path: "code.js" }, {});
  assert.equal(await fileService.readFile({ path: "code.js" }), "// Test code file\nconst a = 1;\nconst b = 3;\n");
  assert.notEqual(after.sha256, before.sha256);

  await assert.rejects(() => edit.execute({ path: "code.js", before_checksum: before.sha256, anchor: "x", replacement: "y" }, {}), (error) => error.code === "CHECKSUM_MISMATCH");
  await assert.rejects(() => edit.execute({ path: "code.js", before_checksum: after.sha256, anchor: "missing text", replacement: "y" }, {}), (error) => error.code === "ANCHOR_NOT_FOUND");
  await assert.rejects(() => edit.execute({ path: "code.js", before_checksum: after.sha256, anchor: "const", replacement: "let" }, {}), (error) => {
    assert.equal(error.code, "ANCHOR_NOT_UNIQUE");
    assert.equal(error.details.occurrences, 2);
    return true;
  });
  await assert.rejects(() => edit.execute({ path: "ghost.js", before_checksum: null, anchor: "x", replacement: "y" }, {}), (error) => error.code === "CHECKSUM_MISMATCH");
});
test("edit_diff with occurrence=all replaces every match and skips uniqueness check", async () => {
  const { fileService } = await harness();
  const read = createReadFileTool({ fileService });
  const edit = createEditDiffTool({ fileService });
  await fileService.atomicWrite({ path: "multi.txt", content: "TODO\nkeep\nTODO\n", replace: true });
  const before = await read.execute({ path: "multi.txt" }, {});
  const result = await edit.execute({ path: "multi.txt", before_checksum: before.sha256, anchor: "TODO", replacement: "DONE", occurrence: "all" }, {});
  assert.equal(result.replaced_count, 2);
  const after = await read.execute({ path: "multi.txt" }, {});
  assert.notEqual(after.sha256, before.sha256);
  assert.equal(await fileService.readFile({ path: "multi.txt" }), "DONE\nkeep\nDONE\n");
});
test("write_diff and edit_diff record changed paths and commit_changes uses them", async () => {
  const { fileService } = await harness();
  const context = { task_id: "T-CHANGE", capabilities: ["commit_changes"], changed_paths: [], allowed_file_paths: ["new-file.txt", "multi.txt"] };
  const read = createReadFileTool({ fileService });
  const write = createWriteDiffTool({ fileService });
  const edit = createEditDiffTool({ fileService });
  const committed = [];
  const commit = createCommitChangesTool({ gitService: { commit: async (message, { paths }) => { committed.push({ message, paths }); return { sha: "SHA-1" }; } } });

  await write.execute({ path: "new-file.txt", content: "// Test fixture\nhello\n", before_checksum: null }, context);
  await fileService.atomicWrite({ path: "multi.txt", content: "TODO\n", replace: true });
  await edit.execute({ path: "multi.txt", before_checksum: (await read.execute({ path: "multi.txt" }, {})).sha256, anchor: "TODO", replacement: "DONE" }, context);

  await commit.execute({ message: "feat: apply agent changes" }, context);
  assert.deepEqual(committed[0].paths, ["new-file.txt", "multi.txt"]);
  assert.equal(committed[0].message, "feat: apply agent changes");
});
test("commit_changes without any applied change reports SCOPE_INVALID", async () => {
  const context = { task_id: "T-EMPTY", capabilities: ["commit_changes"], changed_paths: [] };
  const commit = createCommitChangesTool({ gitService: { commit: async () => { throw new Error("must not be called"); } } });
  await assert.rejects(() => commit.execute({ message: "empty" }, context), (error) => error.code === "SCOPE_INVALID");
});

// The durable ticket ledger determines commit scope even when the agent omits paths.
test("commit_changes derives exact paths from the ticket ledger", async () => {
  const committed = [];
  const context = { task_id: "T-LEDGER", capabilities: ["commit_changes"], allowed_file_paths: ["backend/src/a.js"] };
  const commit = createCommitChangesTool({ changeLedger: { snapshot: async () => ({ entries: { "backend/src/a.js": {} } }) }, gitService: { commit: async (_message, options) => { committed.push(options.paths); return { sha: "SHA-LEDGER" }; } } });
  await commit.execute({ message: "fix: ticket change" }, context);
  assert.deepEqual(committed, [["backend/src/a.js"]]);
  await assert.rejects(commit.execute({ message: "fix: ticket change", paths: ["backend/src/other.js"] }, context), { code: "SCOPE_INVALID" });
});

function fakeReportService({ changedPaths = [], verifyResult = { pass: true, ready_for_review: true }, criteria = ["build passes and lints cleanly"] } = {}) {
  const ticketHolder = { criteria, changedPaths: changedPaths.slice(), verifyResult };
  return {
    setCriteria: (values) => { ticketHolder.criteria = values; },
    setVerify: (value) => { ticketHolder.verifyResult = value; },
    buildFinalReport: async ({ ticket, status, verifyResult: vr, filesChanged }) => {
      const crit = ticket.acceptance_criteria ?? ticketHolder.criteria;
      const verified = crit.map((criterion) => ({ criterion, node_verified: /syntax|build|compile|test|lint/i.test(criterion) && vr ? Boolean(vr.pass ?? vr.ready_for_review) : null }));
      return { ticket, status, files_changed: filesChanged, criteria_check: verified, verify_result: vr };
    },
    saveReport: async () => {},
    writeReportFile: async () => {}
  };
}
test("report_done blocks a real ticket whose only change is the tool-lab marker", async () => {
  const report = createReportDoneTool({ reportService: fakeReportService({ verifyResult: { pass: true, ready_for_review: true }, criteria: ["Add header status to watcher"] }) });
  await assert.rejects(() => report.execute({ summary: "done" }, { ticket: { id: "T-WATCH", title: "Add Agent Process Status to the Watcher Header", objective: "Update the watcher UI", acceptance_criteria: ["Watcher header aligned right"] }, changed_paths: ["backend/tool-lab-target.txt"] }), (error) => error.code === "REPORT_SCOPE_INVALID");
});
test("report_done blocks a UI ticket that did not change a UI path", async () => {
  const report = createReportDoneTool({ reportService: fakeReportService() });
  await assert.rejects(() => report.execute({ summary: "done" }, { ticket: { id: "T-UI", title: "Add Agent Process Status to the Watcher Header", objective: "Update the watcher UI", acceptance_criteria: ["Watcher header aligned right"] }, changed_paths: ["backend/scripts/helper.mjs"] }), (error) => error.code === "REPORT_SCOPE_INVALID");
});
test("report_done allows a UI ticket that changed a ui/nextjs path", async () => {
  const report = createReportDoneTool({ reportService: fakeReportService() });
  const result = await report.execute({ summary: "done" }, { ticket: { id: "T-UI-OK", title: "Add Agent Process Status to the Watcher Header", objective: "Update the watcher UI", acceptance_criteria: ["build passes"] }, changed_paths: ["ui/nextjs/components/NodeForgePanels.jsx"], verify_result: { pass: true, ready_for_review: true } });
  assert.ok(result);
});
test("report_done accepts a directory target when a file inside it changed", async () => {
  const report = createReportDoneTool({ reportService: fakeReportService() });
  const result = await report.execute({ summary: "done" }, { ticket: { id: "T-DIR", title: "Add modal dialog", objective: "Update ui/nextjs/components", acceptance_criteria: ["build passes"] }, target_path: "ui/nextjs/components", changed_paths: ["ui/nextjs/components/Dialog.jsx"], verify_result: { pass: true, ready_for_review: true } });
  assert.ok(result);
});
test("report_done blocks completed when a build/test criterion is not node-verified", async () => {
  const report = createReportDoneTool({ reportService: fakeReportService({ verifyResult: null, criteria: ["The watcher header includes an agent process status area aligned to the right.", "The UI build passes after the header change."] }) });
  await assert.rejects(() => report.execute({ summary: "done" }, { ticket: { id: "T-UNVERIFIED", title: "Add Agent Process Status to the Watcher Header", objective: "Update the watcher UI", acceptance_criteria: ["The UI build passes after the header change."] }, changed_paths: ["ui/nextjs/components/NodeForgePanels.jsx"] }), (error) => error.code === "REPORT_UNVERIFIED");
});
test("report_done allows tool-lab mode to record backend/tool-lab-target.txt", async () => {
  const report = createReportDoneTool({ reportService: fakeReportService({ criteria: ["Tool lab marker"] }) });
  const result = await report.execute({ summary: "done" }, { ticket: { id: "CODEX-TOOL-LAB-1", title: "Tool lab", objective: "Run lab", acceptance_criteria: ["lab"] }, lab_mode: true, changed_paths: ["backend/tool-lab-target.txt"], verify_result: null });
  assert.ok(result);
});
test("report_done does not require every sprint leader candidate file", async () => {
  const report = createReportDoneTool({ reportService: fakeReportService() });
  const ticket = { id: "T-PATCH", title: "Pin conversations", objective: "Pin conversations", acceptance_criteria: ["build passes"], candidate_files: [{ path: "backend/src/application/conversation-crud-service.js", role: "PATCH", symbol: "persistConversationPin", reason: "edit persistConversationPin" }, { path: "ui/nextjs/components/ConversationsBlock.jsx", role: "PATCH", symbol: "PinButton", reason: "edit PinButton" }] };
  const result = await report.execute({ summary: "done" }, { ticket, changed_paths: ["backend/src/application/conversation-crud-service.js"], verify_result: { pass: true, ready_for_review: true } });
  assert.ok(result);
});
test("report_done ignores legacy candidate role metadata", async () => {
  const report = createReportDoneTool({ reportService: fakeReportService() });
  const ticket = { id: "T-PATCH-REUSE", title: "Pin conversations", objective: "Pin conversations", acceptance_criteria: ["build passes"], candidate_files: [{ path: "backend/src/application/conversation-crud-service.js", role: "PATCH", symbol: "persistConversationPin", reason: "edit persistConversationPin" }, { path: "ui/nextjs/lib/node-client.js", role: "REUSE", symbol: "createConversation", reason: "reuse createConversation" }] };
  const result = await report.execute({ summary: "done" }, { ticket, changed_paths: ["backend/src/application/conversation-crud-service.js"], verify_result: { pass: true, ready_for_review: true } });
  assert.ok(result);
});
