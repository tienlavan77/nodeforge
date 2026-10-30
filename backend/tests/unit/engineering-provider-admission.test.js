// Proves unsupported Coder providers cannot become greeting-only successes or acquire launch ownership.
import assert from "node:assert/strict";
import test from "node:test";
import { createNodeforgeTaskIntegration } from "../../src/modules/supervisor/nodeforge-task-integration.js";
import { assertEngineeringProvider, selectTicketCoder, selectDirectCoder } from "../../src/modules/supervisor/ticket/ticket-agent-provider-routing.js";

// Tracks the real submission boundaries without launching an SDK or writing a production queue.
function integrationFixture(provider) {
  const counts = { claims: 0, queue: 0, launch: 0, events: 0 };
  const profile = { agent_id: "SIGNED", role: "coder", provider, enabled: true, status: "ready" };
  const integration = createNodeforgeTaskIntegration({
    projectRoot: process.cwd(), supervisorManager: { startTask: async () => ({}) }, eventBus: { publish: async () => { counts.events += 1; } },
    agentResolver: { list: () => [profile], resolveAvailable: () => profile },
    agentOccupancy: { getByTask: () => null, claim: async () => { counts.claims += 1; return { claim_id: "CLAIM", agent_id: profile.agent_id }; } },
    handoffQueue: { enqueue: async () => { counts.queue += 1; return { id: "JOB" }; } },
    openaiSdkGateway: { execute: async () => { counts.launch += 1; return { text: "hello" }; } },
    ollamaSdkGateway: { execute: async () => { counts.launch += 1; return { text: "hello" }; } }
  });
  return { counts, integration, ticket: { id: "TICKET", project_id: "PROJECT", required_role: "coder", execution_policy: { review_gate: "off" }, execution_contract: { coder: profile.agent_id } } };
}

test("unsupported provider admission rejects before claim, queue, SDK and task outcome", async () => {
  for (const provider of ["unknown", "custom", "devquote"]) {
    const { integration, counts, ticket } = integrationFixture(provider);
    await assert.rejects(integration.submitTicket({ ticket }), { code: "ENGINEERING_PROVIDER_UNSUPPORTED" });
    assert.deepEqual(counts, { claims: 0, queue: 0, launch: 0, events: 0 });
  }
});

test("unsupported SDK path is rejected even when occupancy is not configured", async () => {
  const profile = { agent_id: "UNSUPPORTED", role: "coder", provider: "unknown" };
  await assert.rejects(selectTicketCoder({ resolver: { resolveAvailable: () => profile }, ticket: {}, payload: {}, taskId: "TASK", ownerId: "SUP", role: "coder" }), { code: "ENGINEERING_PROVIDER_UNSUPPORTED" });
});

test("supported existing transports remain admitted without changing profile or falling back", () => {
  for (const provider of ["claude", "anthropic", "codex", "ollama", "openai", "xai", "alibaba", "zhipu", "deepseek"]) {
    const profile = { agent_id: "FIXED", provider, role: "coder" };
    assert.doesNotThrow(() => assertEngineeringProvider(profile));
    assert.equal(profile.provider, provider);
    assert.equal(profile.role, "coder");
  }
  assert.throws(() => assertEngineeringProvider({ role: "coder" }), { code: "ENGINEERING_PROVIDER_UNSUPPORTED" });
});

// Admission preserves the signed compatible-provider identity instead of
// selecting Codex or Claude when an Ollama/OpenAI Coder was requested.
test("compatible Coder admission and direct selection preserve the configured provider", async () => {
  for (const provider of ["ollama", "openai", "xai", "alibaba", "zhipu", "deepseek"]) {
    const profile = { agent_id: "SIGNED", role: "coder", provider, enabled: true, status: "ready" };
    const resolver = { list: () => [profile], resolveAvailable: () => profile };
    const result = await selectTicketCoder({ resolver, ticket: { execution_contract: { coder: "SIGNED" } }, payload: {}, taskId: "TASK", ownerId: "SUP" });
    assert.equal(result.selected, profile);
    assert.equal(selectDirectCoder(resolver), profile);
  }
});

test("review resume does not require or launch a Coder provider transport", async () => {
  const profile = { agent_id: "REVIEW", role: "coder", enabled: true, provider: "openai" };
  const result = await selectTicketCoder({ resolver: { list: () => [profile] }, ticket: {}, taskId: "TASK", ownerId: "SUP", role: "coder", payload: { review_resume: { agent_id: "REVIEW", provider: "openai" } } });
  assert.equal(result.selected.agent_id, profile.agent_id);
  assert.equal(result.claim, null);
});
