import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createHumanDecisionService } from "../../src/application/human-decision-service.js";
import { createOwnerChatService } from "../../src/application/owner-chat-service.js";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createAgentCommunicationBus } from "../../src/modules/governance/agent-communication-bus.js";
import { createAgentCommunicationStore } from "../../src/modules/governance/agent-communication-store.js";
import { createArchitectureDecisionStore } from "../../src/modules/governance/architecture-decision-store.js";
import { createArchitectureKnowledgeModel } from "../../src/modules/governance/architecture-knowledge-model.js";
import { createArchitectureManager } from "../../src/modules/governance/architecture-manager.js";
import { createArchitectureManagerAdapter } from "../../src/modules/governance/architecture-manager-adapter.js";
import { createRoadmapStore } from "../../src/modules/governance/roadmap-store.js";
import { createSprintPlanProjection } from "../../src/modules/governance/sprint-plan-projection.js";
import { createTicketProvenanceTracker } from "../../src/modules/governance/ticket-provenance-tracker.js";
import { createConversationAuditHistoryService } from "../../src/application/conversation-audit-history-service.js";
import { createArchitectureWorkspaceService } from "../../src/application/architecture-workspace-service.js";
import { createProjectDashboardService } from "../../src/application/project-dashboard-service.js";
import { createConversationStream } from "../../src/transport/sse/conversation-stream.js";
import { createHttpApi } from "../../src/transport/http/server.js";

test("verifies the complete Human Governance loop through Node, persistence, audit, SSE, and restart", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "nodeforge-human-governance-142-"));
  let database = await openIndexDatabase(root);
  try {
    let composition = createComposition(database);
    const owner = {
      message_id: "MSG-142-OWNER", correlation_id: "CORR-142-CHAT", timestamp: "2026-08-21T17:00:00Z",
      payload: { text: "Create a governed architecture plan." }
    };
    assert.equal((await request(composition.api, "POST", "/projects/PROJECT-142/conversations/CONV-142/messages", owner)).status, 202);

    const streamResponse = responseStub();
    const connection = composition.stream.connect({ projectId: "PROJECT-142", conversationId: "CONV-142", response: streamResponse });
    const streamMessages = parseSse(streamResponse.chunks);
    assert.deepEqual(streamMessages.map(({ message_type }) => message_type), ["owner.message", "architecture.working", "architecture.message.received"]);
    assert(streamMessages.every(({ correlation_id }) => correlation_id === "CORR-142-CHAT"));
    connection.close();

    const workspace = await request(composition.api, "GET", "/projects/PROJECT-142/architecture-workspace");
    const dashboard = await request(composition.api, "GET", "/projects/PROJECT-142/dashboard");
    assert.equal(workspace.status, 200);
    assert.equal(workspace.body.decisions[0].id, "DECISION-MSG-142-OWNER");
    assert.equal(dashboard.status, 200);

    const proposalId = "DECISION-MSG-142-OWNER";
    for (const [id, decision, reason] of [["HUMAN-142-APPROVE", "APPROVE"], ["HUMAN-142-REJECT", "REJECT", "Needs rollback."], ["HUMAN-142-CHANGE", "CHANGE_REQUEST", "Clarify constraints."]]) {
      const result = await request(composition.api, "POST", "/projects/PROJECT-142/decisions", { decision_id: id, type: "human_governance", actor: "project-owner", actor_role: "project_owner", proposal_id: proposalId, decision, ...(reason ? { reason } : {}), correlation_id: `CORR-${id}`, timestamp: "2026-08-21T17:01:00Z" });
      assert.equal(result.status, 201);
    }
    assert.equal((await request(composition.api, "POST", "/projects/PROJECT-142/decisions", { decision_id: "HUMAN-142-APPROVE", type: "human_governance", actor: "project-owner", actor_role: "project_owner", proposal_id: proposalId, decision: "APPROVE", correlation_id: "CORR-DUP", timestamp: "2026-08-21T17:02:00Z" })).status, 409);
    assert.equal((await request(composition.api, "POST", "/projects/PROJECT-142/decisions", { decision_id: "HUMAN-142-BAD", type: "human_governance", actor: "project-owner", actor_role: "project_owner", proposal_id: proposalId, decision: "REJECT", correlation_id: "CORR-BAD", timestamp: "2026-08-21T17:02:00Z" })).status, 400);

    composition.bus.send({ id: "MSG-142-SECRET", project_id: "PROJECT-142", sender: { id: "NODE", role: "node" }, recipient: { id: "NODE", role: "node" }, message_type: "system.audit", conversation_id: "CONV-142", correlation_id: "CORR-142-SECRET", payload: { api_key: "super-secret", visible: "safe" }, timestamp: "2026-08-21T17:03:00Z" });
    const history = await request(composition.api, "GET", "/projects/PROJECT-142/history?conversationId=CONV-142&correlationId=CORR-HUMAN-142");
    assert.equal(history.status, 200);
    assert(history.body.items.every((item) => !JSON.stringify(item).includes("super-secret")));
    const decisionHistory = await request(composition.api, "GET", "/projects/PROJECT-142/history?correlationId=CORR-HUMAN-142-APPROVE");
    assert.equal(decisionHistory.body.items[0].type, "human.decision.recorded");

    await database.close();
    database = await openIndexDatabase(root);
    composition = createComposition(database);
    assert.equal(composition.decisions.getById("HUMAN-142-APPROVE").decision, "APPROVE");
    assert.deepEqual(composition.communications.getByConversationId("CONV-142").map(({ id }) => id).slice(0, 3), ["MSG-142-OWNER", "MSG-ARCHITECTURE-WORKING-MSG-142-OWNER", "MSG-ARCHITECTURE-MESSAGE-MSG-142-OWNER"]);
    const replay = responseStub();
    const replayConnection = composition.stream.connect({ projectId: "PROJECT-142", conversationId: "CONV-142", response: replay, afterMessageId: "MSG-ARCHITECTURE-WORKING-MSG-142-OWNER" });
    assert.equal(parseSse(replay.chunks)[0].message_id, "MSG-ARCHITECTURE-MESSAGE-MSG-142-OWNER");
    replayConnection.close();
  } finally { await database?.close(); await rm(root, { recursive: true, force: true }); }
});

function createComposition(database) {
  const communications = createAgentCommunicationStore({ database });
  const bus = createAgentCommunicationBus({ store: communications });
  const decisions = createArchitectureDecisionStore({ database });
  const roadmaps = createRoadmapStore({ database });
  const knowledge = createArchitectureKnowledgeModel({ decisions });
  const manager = createArchitectureManager({ decisions, knowledge, roadmaps, bus, nodeId: "NODE" });
  createArchitectureManagerAdapter({ manager, bus, nodeId: "NODE" });
  const sprintPlans = createSprintPlanProjection({ roadmaps });
  const provenance = createTicketProvenanceTracker({ roadmaps, decisions });
  const eventStore = { getAll: () => [] };
  const history = createConversationAuditHistoryService({ communications, eventStore });
  const api = createHttpApi({
    runtimeService: runtimeStub(),
    ownerChatService: createOwnerChatService({ bus }),
    humanDecisionService: createHumanDecisionService({ decisions, bus }),
    conversationStream: createConversationStream({ bus, communicationStore: communications }),
    conversationAuditHistoryService: history,
    architectureWorkspaceService: createArchitectureWorkspaceService({ knowledge, roadmaps, sprintPlans }),
    projectDashboardService: createProjectDashboardService({ roadmaps, sprintPlans, provenance })
  });
  return { api, stream: createConversationStream({ bus, communicationStore: communications }), bus, decisions, communications };
}

function runtimeStub() { return { startTask: () => ({}), pauseSession: () => ({}), resumeSession: () => ({}), getSession: () => ({}), getProjectMemory: () => ({}) }; }
async function request(api, method, url, body) { const input = Readable.from(body ? [JSON.stringify(body)] : []); input.method = method; input.url = url; input.headers = {}; const response = responseStub(); await api.handler(input, response); return { status: response.status, body: response.chunks.length ? JSON.parse(response.chunks.join("")) : undefined }; }
function responseStub() { return { status: 0, chunks: [], headers: {}, writeHead(status, headers = {}) { this.status = status; this.headers = headers; }, write(chunk) { this.chunks.push(chunk); }, end(chunk) { if (chunk) this.chunks.push(chunk); this.ended = true; } }; }
function parseSse(chunks) { return chunks.map((chunk) => JSON.parse(chunk.split("\ndata: ")[1].split("\n\n")[0])); }
