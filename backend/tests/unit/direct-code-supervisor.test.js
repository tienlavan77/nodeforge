// Confirms Supervisor sends direct dashboard text to a ready governed coder without a target file.
import assert from "node:assert/strict";
import test from "node:test";
import { createNodeforgeTaskIntegration } from "../../src/modules/supervisor/nodeforge-task-integration.js";

for (const provider of ["codex", "claude"]) {
  test(`direct Code selects a ${provider} coder and lets it discover the target`, async () => {
    const profile = { agent_id: `${provider}-coder`, agent_name: "Coder", role: "coder", provider, enabled: true, status: "ready" };
    let received;
    const gateway = { execute: async (request) => {
      received = request;
      if (provider === "codex") {
        for (const tool of ["rg_files", "write_diff", "commit_changes", "report_done"]) await request.onEvent({ type: "item.completed", item: { id: tool, type: "mcp_tool_call", server: "forge", tool, status: "completed" } });
        return { text: "Coder completed." };
      }
      return { messages: [{ type: "assistant", message: { content: ["mcp__forge__Glob", "mcp__forge__write_diff", "mcp__forge__commit_changes", "mcp__forge__report_done"].map((name) => ({ type: "tool_use", id: name, name })) } }] };
    } };
    const integration = createNodeforgeTaskIntegration({
      projectRoot: process.cwd(), supervisorManager: { startTask: async () => ({}) }, eventBus: { publish: async () => {} },
      agentResolver: { list: () => [{ agent_id: "openai-coder", role: "coder", provider: "openai", enabled: true, status: "ready" }, profile], resolveAvailable: () => { throw new Error("Direct Code must select a coding SDK."); } },
      handoffQueue: { enqueue: async () => ({ id: "JOB-CODE" }) }, toolRegistry: { Glob: { execute: async () => ({}) }, write_diff: { execute: async () => ({}) }, commit_changes: { execute: async () => ({}) }, report_done: { execute: async () => ({}) } },
      runtimeGovernance: { createExecutionContext: (input) => input }, ...(provider === "codex" ? { codexSdkGateway: gateway } : { claudeSdkGateway: gateway })
    });
    const text = "chỉnh sửa UI để nhả chữ mượt";
    const ticket = { id: "CODE-TEST", project_id: "PROJECT-1", title: text, objective: text, acceptance_criteria: [], required_role: "coder" };
    const result = await integration.submitTicket({ ticket, task_id: ticket.id, request_id: "REQ-CODE", correlation_id: "CORR-CODE", payload: { text, direct_code: true } });
    assert.equal(result.agent_id, profile.agent_id);
    assert.equal(result.status, "completed");
    assert.match(received.prompt, /chỉnh sửa UI để nhả chữ mượt/);
    assert.match(received.prompt, /workflows\/agents\/coder\/README\.md/);
    assert.match(received.prompt, /schemas\//);
    assert.match(received.prompt, /must not access docs\//);
    const context = provider === "codex" ? received.options.forgeTools.context : null;
    if (context) {
      assert.equal(context.target_path, null);
      assert.ok(context.allowed_prefixes.includes("ui/"));
      assert.ok(context.allowed_prefixes.includes("schemas/"));
      assert.ok(context.allowed_prefixes.includes("workflows/"));
      assert.equal(context.allowed_prefixes.includes("docs/"), false);
      assert.ok(context.allowed_file_paths.includes("vocabulary/glossary.md"));
      assert.ok(context.allowed_file_paths.includes("workflows/agents/coder/README.md"));
      assert.equal(received.options.forgeTools.definitions.some((tool) => tool.name === "select_code_graph_candidates"), false);
      assert.doesNotMatch(received.prompt, /select_code_graph_candidates/);
    } else {
      assert.deepEqual(received.options.tools, []);
      assert.ok(received.options.mcpServers.forge);
      assert.ok(received.options.allowedTools.includes("mcp__forge__Glob"));
      assert.equal(received.options.allowedTools.includes("mcp__forge__select_code_graph_candidates"), false);
      assert.doesNotMatch(received.prompt, /select_code_graph_candidates/);
    }
  });
}

test("direct Code resume selects the original provider profile", async () => {
  let selectedAgent;
  const integration = createNodeforgeTaskIntegration({
    projectRoot: process.cwd(), supervisorManager: { startTask: async () => ({}) }, eventBus: { publish: async () => {} },
    agentResolver: { list: () => [
      { agent_id: "codex-first", role: "coder", provider: "codex", enabled: true, status: "ready" },
      { agent_id: "claude-original", role: "coder", provider: "claude", enabled: true, status: "ready" }
    ], resolveAvailable: () => undefined },
    handoffQueue: { enqueue: async () => ({ id: "JOB-RESUME" }) },
    toolRegistry: { report_done: { execute: async () => ({}) } },
    runtimeGovernance: { createExecutionContext: (input) => input },
    claudeSdkGateway: { execute: async (request) => { selectedAgent = request.agentId; return { messages: [{ type: "assistant", message: { content: ["write_diff", "commit_changes", "report_done"].map((name) => ({ type: "tool_use", name: `mcp__forge__${name}` })) } }] }; } }
  });
  const ticket = { id: "CODE-RESUME", project_id: "PROJECT-1", title: "Continue", objective: "Continue", acceptance_criteria: [], required_role: "coder" };
  await integration.submitTicket({ ticket, task_id: ticket.id, payload: { direct_code: true, resume_from: { agent_id: "claude-original", provider: "claude", status: "in_progress", last_completed_turn: 25 } } });
  assert.equal(selectedAgent, "claude-original");
});

for (const retainedReviewer of [false, true]) test(`ticket Coder remains claimed through review and approval with ${retainedReviewer ? "a retained" : "a ready"} Reviewer`, async () => {
  const coder = { agent_id: "coder-1", agent_name: "Coder", role: "coder", provider: "codex", enabled: true, status: "ready" };
  const otherCoder = { ...coder, agent_id: "coder-earlier" };
  const reviewer = { agent_id: "reviewer-1", agent_name: "Reviewer", role: "reviewer", provider: "codex", enabled: true, status: retainedReviewer ? "working" : "ready" };
  const otherReviewer = { ...reviewer, agent_id: "reviewer-earlier", status: "ready" };
  const published = []; const releases = []; const coderRequests = []; const reviewCheckpoints = [];
  let active = null; let reviewerClaim = retainedReviewer ? { claim_id: "REVIEW-CLAIM-1", agent_id: reviewer.agent_id, task_id: "TASK-REVIEW", supervisor_id: "SUP-TASK-REVIEW" } : null; let reviews = 0;
  const gateway = { execute: async (input) => {
    if (input.agentId === reviewer.agent_id) {
      assert.ok(active, "Coder claim must remain active during review");
      reviews += 1;
      return { text: reviews === 1 ? '{"verdict":"request_changes","findings":["Handle empty input"]}' : '{"verdict":"approved","findings":[]}' };
    }
    coderRequests.push(input);
    for (const tool of ["write_diff", "commit_changes", "report_done"]) await input.onEvent({ type: "item.completed", item: { id: tool, type: "mcp_tool_call", server: "forge", tool, status: "completed" } });
    return { text: "Coder submitted the change." };
  } };
  const integration = createNodeforgeTaskIntegration({
    projectRoot: process.cwd(), supervisorManager: { startTask: async () => ({}) }, eventBus: { publish: async (event) => published.push(event) },
    agentResolver: { list: (role) => role === "coder" ? [otherCoder, coder] : [otherReviewer, reviewer], resolveAvailable: (role) => role === "reviewer" ? otherReviewer : otherCoder },
    agentOccupancy: { getByTask: (_taskId, role) => role === "reviewer" ? reviewerClaim : active, claim: async ({ agentId, taskId, supervisorId, role }) => { if (role === "reviewer") { reviewerClaim ??= { claim_id: "REVIEW-CLAIM-1", agent_id: agentId, task_id: taskId, supervisor_id: supervisorId }; return reviewerClaim; } active ??= { claim_id: "CLAIM-1", agent_id: agentId, task_id: taskId, supervisor_id: supervisorId }; return active; }, release: async (input) => { releases.push(input); if (input.claimId === "REVIEW-CLAIM-1") reviewerClaim = null; else active = null; } },
    handoffQueue: { enqueue: async () => ({ id: "JOB-1" }) }, toolRegistry: { write_diff: { execute: async () => ({}) }, commit_changes: { execute: async () => ({}) }, report_done: { execute: async () => ({}) } },
    runtimeGovernance: { createExecutionContext: (input) => input }, checkpointStore: { load: async () => ({ changed_paths: ["backend/src/a.js"], status: "completed" }), save: async () => {}, saveReview: async (entry) => reviewCheckpoints.push(entry), completeReview: async () => {} },
    fileService: { readForIndex: async ({ path }) => ({ path, content: "export const value = true;", sha256: "sha256:abc", size_bytes: 26 }) }, codexSdkGateway: gateway
  });
  const ticket = { id: "TASK-REVIEW", project_id: "PROJECT", objective: "Update backend/src/a.js", acceptance_criteria: ["Handle empty input"], required_role: "coder", execution_contract: { coder: coder.agent_id, reviewer: reviewer.agent_id } };
  const result = await integration.submitTicket({ ticket, task_id: ticket.id, request_id: "REQ-1", correlation_id: "CORR-1", required_role: "coder", payload: { text: ticket.objective } });
  assert.equal(result.status, "completed");
  assert.equal(result.agent_id, coder.agent_id);
  assert.equal(coderRequests.length, 2);
  assert.match(coderRequests[1].prompt, /Handle empty input/);
  assert.equal(releases.length, 2);
  assert.equal(reviewCheckpoints[0].reviewer_id, reviewer.agent_id);
  assert.equal(reviewCheckpoints[0].reviewer_name, reviewer.agent_name);
  assert.equal(reviewCheckpoints[0].provider, reviewer.provider);
  assert.deepEqual(releases.map((item) => item.reason), ["review_completed", "accepted"]);
  assert.equal(published.at(-1).type, "task.completed");
});

test("review resume skips Coder dispatch after report_done", async () => {
  const coder = { agent_id: "coder-1", agent_name: "Coder", role: "coder", provider: "codex", enabled: true, status: "working" };
  const reviewer = { agent_id: "reviewer-1", agent_name: "Reviewer", role: "reviewer", provider: "codex", enabled: true, status: "ready" };
  let coderCalls = 0; let handoffs = 0; const saved = [];
  const claim = { claim_id: "CODER-CLAIM", agent_id: coder.agent_id, task_id: "TASK-REVIEW", supervisor_id: "SUP-TASK-REVIEW" };
  const integration = createNodeforgeTaskIntegration({
    projectRoot: process.cwd(), supervisorManager: { startTask: async () => ({}) }, eventBus: { publish: async () => {} },
    agentResolver: { list: (role) => role === "coder" ? [coder] : [reviewer], resolveAvailable: (role) => role === "reviewer" ? reviewer : undefined },
    agentOccupancy: { getByTask: (_taskId, role) => role === "reviewer" ? null : claim, claim: async ({ role }) => role === "reviewer" ? { claim_id: "REVIEW-CLAIM", agent_id: reviewer.agent_id } : claim, release: async () => {} },
    handoffQueue: { enqueue: async () => { handoffs += 1; return { id: "JOB" }; } },
    checkpointStore: { load: async () => ({ status: "completed", changed_paths: ["backend/src/a.js"] }), saveReview: async (entry) => saved.push(entry), completeReview: async () => {} },
    fileService: { readForIndex: async ({ path }) => ({ path, content: "export const value = true;", sha256: "sha256:abc", size_bytes: 26 }) },
    codexSdkGateway: { execute: async ({ agentId }) => { if (agentId === coder.agent_id) coderCalls += 1; return { text: '{"verdict":"approved","findings":[]}' }; } }
  });
  const ticket = { id: "TASK-REVIEW", project_id: "PROJECT", objective: "Update backend/src/a.js", required_role: "coder" };
  const result = await integration.submitTicket({ ticket, task_id: ticket.id, request_id: "REQ-RESUME", payload: { review_resume: { agent_id: coder.agent_id, provider: coder.provider, review_attempt: 1, changed_paths: ["backend/src/a.js"] } } });
  assert.equal(result.status, "completed");
  assert.equal(coderCalls, 0);
  assert.equal(handoffs, 0);
  assert.equal(saved[0].review_attempt, 1);
});

test("rejected commit blocks automatic Coder resume and releases the claim", async () => {
  const coder = { agent_id: "coder-1", agent_name: "Coder", role: "coder", provider: "codex", enabled: true, status: "ready" };
  const saved = []; const released = []; const published = [];
  const integration = createNodeforgeTaskIntegration({
    projectRoot: process.cwd(), supervisorManager: { startTask: async () => ({}) }, eventBus: { publish: async (event) => published.push(event) },
    agentResolver: { resolveAvailable: () => coder, list: () => [coder] },
    agentOccupancy: { getByTask: () => null, claim: async () => ({ claim_id: "CLAIM-1", agent_id: coder.agent_id }), release: async (input) => released.push(input) },
    handoffQueue: { enqueue: async () => ({ id: "JOB-1" }) }, toolRegistry: {},
    runtimeGovernance: { createExecutionContext: (input) => input },
    checkpointStore: { load: async () => ({ task_id: "TASK-BLOCKED", status: "in_progress" }), save: async (record) => saved.push(record) },
    codexSdkGateway: { execute: async ({ onEvent }) => {
      await onEvent({ type: "item.completed", item: { type: "mcp_tool_call", server: "forge", tool: "edit_diff", status: "completed" } });
      await onEvent({ type: "item.completed", item: { type: "mcp_tool_call", server: "forge", tool: "commit_changes", status: "failed", error: { message: "This action was rejected due to unacceptable risk." } } });
      return { text: "" };
    } }
  });
  await assert.rejects(() => integration.submitTicket({ ticket: { id: "TASK-BLOCKED", objective: "Edit backend/src/a.js", required_role: "coder" }, task_id: "TASK-BLOCKED" }), (error) => error.code === "COMMIT_APPROVAL_REJECTED");
  assert.equal(saved.at(-1).status, "blocked");
  assert.equal(released.at(-1).reason, "commit_approval_rejected");
  assert.equal(published.at(-1).type, "task.needs_human_review");
});
