// Verifies manual ticket review receives existing discovery tools without changing commit checkout safeguards.
import assert from "node:assert/strict";
import test from "node:test";
import { resolveReviewOnlyWorkspace } from "../../src/modules/supervisor/review-only-workspace.js";

// Provides an in-memory review workspace with independent Code Search and read-only Git services.
function fixture() {
  const profile = { agent_id: "reviewer", enabled: true, status: "ready", role: "reviewer", provider: "openai" };
  const files = { listFiles: async () => ["src/ready.js"], listDirectories: async () => ["src"], readForIndex: async ({ path }) => ({ path, content: "const ready = true;", size_bytes: 19 }) };
  let request;
  const workspace = { path: "/project", base_commit: "base", branch: "ticket", worktreeFileService: files, codeSearch: { search: async () => ({ matches: [] }) },
    gitService: { getHead: async () => "commit", getCommitParent: async () => "parent", status: async () => "", diffWorkingTree: async () => "" } };
  const options = { resolveTicketWorkspace: async () => workspace, taskId: "ticket", commit: "commit", reviewer: {}, fileService: files,
    agentResolver: { resolveAvailable: () => profile }, gateways: { openaiSdkGateway: { execute: async (input) => { request = input; return { text: '{"verdict":"approved","findings":[]}' }; } } }, projectLogger: () => {} };
  return { options, workspace, getRequest: () => request };
}

test("manual workspace review forwards Code Search and Git into the SDK allowlist", async () => {
  const fixtureData = fixture();
  const resolved = await resolveReviewOnlyWorkspace(fixtureData.options);
  assert.equal(resolved.useWorkspace, true);
  assert.equal(resolved.reviewBase, "parent");
  await resolved.reviewWorker.review({ task_id: "ticket", agent_id: "coder", payload: { ticket: {}, changed_paths: ["src/ready.js"] } });
  const tools = fixtureData.getRequest().options.forgeTools;
  for (const name of ["search_tree", "list_files", "search_text", "read_file", "read_lines", "git_status", "git_diff"]) assert.equal(typeof tools.registry[name].execute, "function");
  assert.equal(tools.registry.commit_changes, undefined);
});

test("manual review retains fallback and stale checkout rejection", async () => {
  const { options, workspace } = fixture();
  const fallback = await resolveReviewOnlyWorkspace({ ...options, resolveTicketWorkspace: undefined, gitService: workspace.gitService, baseCommit: "explicit-base" });
  assert.equal(fallback.reviewWorker, options.reviewer);
  assert.equal(fallback.reviewBase, "explicit-base");
  await assert.rejects(() => resolveReviewOnlyWorkspace({ ...options, commit: "different", gitService: workspace.gitService }), { code: "REVIEW_COMMIT_NOT_CHECKED_OUT" });
});
