// Verifies that independent review uses bounded Forge source evidence and strict verdicts.
import assert from "node:assert/strict";
import test from "node:test";
import { createReviewWorker } from "../../src/modules/supervisor/review-worker.js";
import { resolveReviewOnlyWorkspace } from "../../src/modules/supervisor/review-only-workspace.js";

// Supplies a read-only Reviewer and captures the prompt sent through the SDK.
function harness({ text = '{"verdict":"approved","findings":[]}', sourceSize = 12, staleOnSecondRead = false, patch = "" } = {}) {
  const calls = [];
  const events = [];
  let reads = 0;
  const worker = createReviewWorker({
    agentResolver: { resolveAvailable: () => ({ agent_id: "reviewer-1", agent_name: "Leader", provider: "openai", role: "reviewer" }) },
    openaiSdkGateway: { execute: async (input) => { calls.push(input); return { text }; } },
    fileService: { readForIndex: async ({ path, maxBytes }) => ({ path, sha256: staleOnSecondRead && ++reads > 1 ? "sha256:changed" : "sha256:abc", size_bytes: sourceSize, content: path === "workflows/agents/reviewer/README.md" ? "Reviewer rules: inspect evidence and return a verdict." : "const ok = true;", maxBytes }) },
    gitService: { diffPatchFrom: async () => patch },
    projectRoot: "/project",
    projectLogger: (entry) => events.push(entry)
  });
  return { worker, calls, events };
}

test("independent Reviewer approves only an explicit structured verdict", async () => {
  const { worker, calls, events } = harness({ patch: "diff --git a/src/a.js b/src/a.js" });
  const result = await worker.review({ task_id: "TASK-1", correlation_id: "CORR-1", request_id: "REVIEW-1", agent_id: "coder-1", payload: { ticket: { id: "TASK-1", acceptance_criteria: ["Works"] }, changed_paths: ["src/a.js"], base_commit: "abc123", verification: { status: "passed" } } });
  assert.equal(result.verdict, "approved");
  assert.equal(result.reviewer_id, "reviewer-1");
  assert.match(calls[0].prompt, /const ok = true/);
  assert.match(calls[0].prompt, /Works/);
  assert.match(calls[0].prompt, /diff --git/);
  assert.match(calls[0].prompt, /Reviewer rules: inspect evidence/);
  for (const event of events.filter(({ event_name }) => event_name.startsWith("review."))) assert.equal(event.payload.agent_name, "Leader");
});

// Loads local Reviewer policy when committed source omits ignored workflow files.
test("Reviewer reads local role rules while source remains bound to the committed File Service", async () => {
  const sourceReads = [];
  const rulesReads = [];
  let prompt;
  const worker = createReviewWorker({
    agentResolver: { resolveAvailable: () => ({ agent_id: "reviewer-1", agent_name: "Leader", provider: "openai", role: "reviewer" }) },
    openaiSdkGateway: { execute: async ({ prompt: value }) => { prompt = value; return { text: '{"verdict":"approved","findings":[]}' }; } },
    fileService: { readForIndex: async ({ path }) => { sourceReads.push(path); return { path, sha256: "sha256:source", size_bytes: 12, content: "const ok = 1;" }; } },
    rulesFileService: { readForIndex: async ({ path }) => { rulesReads.push(path); return { path, content: "Review the verified commit." }; } },
    projectRoot: "/project"
  });
  await worker.review({ task_id: "TASK-1", agent_id: "coder-1", payload: { ticket: { id: "TASK-1" }, changed_paths: ["src/a.js"] } });
  assert.deepEqual(sourceReads, ["src/a.js", "src/a.js"]);
  assert.deepEqual(rulesReads, ["workflows/agents/reviewer/README.md"]);
  assert.match(prompt, /Review the verified commit/);
});

// Ensures the independent review workspace passes local policy separately from committed source.
test("review-only workspace wires local Reviewer policy separately from committed source", async () => {
  const sourceReads = [];
  const rulesReads = [];
  let prompt;
  const source = { readForIndex: async ({ path }) => { sourceReads.push(path); return { path, sha256: "sha256:source", size_bytes: 12, content: "const ok = 1;" }; } };
  const rules = { readForIndex: async ({ path }) => { rulesReads.push(path); return { path, content: "Review the verified commit." }; } };
  const runtime = await resolveReviewOnlyWorkspace({
    resolveTicketWorkspace: async () => ({ projectRoot: "/project", path: "/project", base_commit: "a".repeat(40), branch: "ui-chat", worktreeFileService: source, fileService: rules, gitService: { getHead: async () => "b".repeat(40) } }),
    taskId: "TASK-1", commit: "b".repeat(40), baseCommit: "a".repeat(40), fileService: rules,
    gateways: { openaiSdkGateway: { execute: async ({ prompt: value }) => { prompt = value; return { text: '{"verdict":"approved","findings":[]}' }; } } },
    agentResolver: { resolveAvailable: () => ({ agent_id: "reviewer-1", agent_name: "Leader", provider: "openai", role: "reviewer" }) },
    runtimeGovernance: {}, projectLogger: () => {}
  });
  await runtime.reviewWorker.review({ task_id: "TASK-1", agent_id: "coder-1", payload: { ticket: { id: "TASK-1" }, changed_paths: ["src/a.js"] } });
  assert.equal(sourceReads.length >= 1, true);
  assert.equal(sourceReads.every((path) => path === "src/a.js"), true);
  assert.deepEqual(rulesReads, ["workflows/agents/reviewer/README.md"]);
  assert.match(prompt, /Review the verified commit/);
});

test("approval is rejected when source changes while the Reviewer is reading", async () => {
  const { worker } = harness({ staleOnSecondRead: true });
  await assert.rejects(() => worker.review({ task_id: "TASK-1", correlation_id: "CORR-1", request_id: "REVIEW-1", agent_id: "coder-1", payload: { ticket: { id: "TASK-1" }, changed_paths: ["src/a.js"] } }), (error) => error.code === "REVIEW_EVIDENCE_STALE");
});

test("approved review verifies the requested path when Code Cache omits path", async () => {
  const reads = [];
  const worker = createReviewWorker({
    agentResolver: { resolveAvailable: () => ({ agent_id: "reviewer-1", agent_name: "Leader", provider: "openai", role: "reviewer" }) },
    openaiSdkGateway: { execute: async () => ({ text: '{"verdict":"approved","findings":[]}' }) },
    fileService: { readForIndex: async () => { throw new Error("Cache should serve the review."); } },
    codeCache: { read: async ({ path }) => { reads.push(path); return { sha256: "sha256:abc", size_bytes: 12, content: path === "workflows/agents/reviewer/README.md" ? "Review evidence." : "const ok = 1;" }; } },
    projectRoot: "/project"
  });
  const result = await worker.review({ task_id: "TASK-1", correlation_id: "CORR-1", request_id: "REVIEW-1", agent_id: "coder-1", payload: { ticket: { id: "TASK-1" }, changed_paths: ["src/a.js"] } });
  assert.equal(result.verdict, "approved");
  assert.deepEqual(reads, ["src/a.js", "workflows/agents/reviewer/README.md", "src/a.js"]);
});

test("free-form or unsupported review evidence cannot approve a ticket", async () => {
  const { worker } = harness({ text: "looks good" });
  const job = { task_id: "TASK-1", correlation_id: "CORR-1", request_id: "REVIEW-1", agent_id: "coder-1", payload: { ticket: { id: "TASK-1" }, changed_paths: ["src/a.js"] } };
  await assert.rejects(() => worker.review(job), (error) => error.code === "REVIEW_VERDICT_INVALID");
  await assert.rejects(() => worker.review({ ...job, payload: { ...job.payload, changed_paths: [] } }), (error) => error.code === "REVIEW_EVIDENCE_INVALID");
});

test("accepts a JSON verdict wrapped in reviewer prose", async () => {
  const { worker } = harness({ text: "I'll review the supplied evidence.\n\n{\"verdict\":\"approved\",\"findings\":[]}\n\nReview complete." });
  const result = await worker.review({ task_id: "TASK-1", correlation_id: "CORR-1", request_id: "REVIEW-1", agent_id: "coder-1", payload: { ticket: { id: "TASK-1" }, changed_paths: ["src/a.js"] } });
  assert.equal(result.verdict, "approved");
});

test("selects the valid verdict object when response contains another malformed object", async () => {
  const { worker } = harness({ text: "Tool note: {invalid}\nFinal: {\"verdict\":\"approved\",\"findings\":[]}" });
  const result = await worker.review({ task_id: "TASK-1", correlation_id: "CORR-1", request_id: "REVIEW-1", agent_id: "coder-1", payload: { ticket: { id: "TASK-1" }, changed_paths: ["src/a.js"] } });
  assert.equal(result.verdict, "approved");
});

test("Claude Reviewer receives the same Forge-only SDK boundary as other roles", async () => {
  let request;
  const content = "const ok = true;";
  const worker = createReviewWorker({
    agentResolver: { resolveAvailable: () => ({ agent_id: "reviewer-1", agent_name: "Leader", provider: "claude", role: "reviewer" }) },
    claudeSdkGateway: { execute: async (input) => { request = input; return { text: JSON.stringify({ verdict: "request_changes", findings: [{ failure: "Dialog does not close", acceptance_criterion: "Dialog closes", evidence_refs: ["src/a.js:1"], minimum_change_scope: "Fix dialog handler" }] }) }; } },
    fileService: { readForIndex: async ({ path }) => ({ path, sha256: "sha256:abc", size_bytes: content.length, content: path === "workflows/agents/reviewer/README.md" ? "Review the changed source." : content }), listFiles: async () => ["src/a.js"], listDirectories: async () => ["src"] },
    codeCache: { read: async ({ path }) => ({ path, sha256: "sha256:abc", size_bytes: content.length, content: path === "workflows/agents/reviewer/README.md" ? "Review the changed source." : content }) },
    projectRoot: "/project"
  });
  await worker.review({ task_id: "TASK-1", correlation_id: "CORR-1", request_id: "REVIEW-1", agent_id: "coder-1", payload: { ticket: { id: "TASK-1" }, changed_paths: ["src/a.js"] } });
  assert.deepEqual(request.options.tools, []);
  assert.deepEqual(request.options.allowedTools, ["mcp__forge__search_tree", "mcp__forge__list_files", "mcp__forge__search_text", "mcp__forge__read_file", "mcp__forge__read_lines", "mcp__forge__query_review"]);
  assert.equal(request.options.mcpServers.forge.type, "sdk");
});

test("Reviewer records per-tool checkpoint progress and failure state", async () => {
  const savedCheckpoints = [];
  const content = "const ok = true;\n";
  const worker = createReviewWorker({
    agentResolver: { resolveAvailable: () => ({ agent_id: "reviewer-1", agent_name: "Leader", provider: "codex", role: "reviewer" }) },
    codexSdkGateway: {
      execute: async (input) => {
        input.onSessionReady?.("thread-rev-1");
        if (input.options.forgeTools.registry.read_file) await input.options.forgeTools.registry.read_file.execute({ path: "src/a.js" });
        else {
          assert.equal(input.resumeThreadId, "thread-rev-1");
          assert.deepEqual(input.options.forgeTools.definitions, []);
        }
        return { text: '{"verdict":"request_changes","findings":["legacy string"]}' };
      }
    },
    fileService: {
      readForIndex: async ({ path }) => ({ path, sha256: "sha256:abc", size_bytes: content.length, content: path === "workflows/agents/reviewer/README.md" ? "Review the changed source." : content }),
      listFiles: async () => ["src/a.js"],
      listDirectories: async () => ["src"]
    },
    checkpoints: { saveReview: async (cp) => { savedCheckpoints.push(cp); return cp; } },
    projectRoot: "/project"
  });
  await assert.rejects(
    () => worker.review({ task_id: "TASK-CP-1", correlation_id: "CORR-1", request_id: "REVIEW-CP-1", agent_id: "coder-1", payload: { ticket: { id: "TASK-CP-1" }, changed_paths: ["src/a.js"] } }),
    (error) => error.code === "REVIEW_VERDICT_INVALID"
  );
  const inProgress = savedCheckpoints.find((cp) => cp.status === "in_progress" && cp.last_completed_turn === 1);
  assert.ok(inProgress);
  assert.equal(inProgress.thread_id, "thread-rev-1");
  assert.equal(inProgress.last_tool, "read_file");
  const failed = savedCheckpoints.at(-1);
  assert.equal(failed.status, "failed");
  assert.equal(failed.last_completed_turn, 1);
  assert.equal(failed.last_error.code, "REVIEW_VERDICT_INVALID");
});
