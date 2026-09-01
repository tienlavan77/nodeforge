/** Minimal stage-1 ticket and OpenAI profile used by the mock state-machine tests. */
export const stage1Ticket = Object.freeze({
  id: "FORGE-STAGE1-001",
  project_id: "PROJECT-STAGE1",
  roadmap_id: "ROADMAP-STAGE1",
  sprint_id: "SPRINT-STAGE1",
  title: "Add stage-1 fixture marker",
  objective: "Create one small file through the Node-Agent happy path.",
  acceptance_criteria: ["The fixture marker file is created with the requested content."],
  priority: "normal",
  dependencies: [],
  provenance: Object.freeze({ source: "project_owner", source_id: "FORGE-STAGE1-001", created_at: "2026-08-31T00:00:00Z" })
});

export const stage1AgentProfile = Object.freeze({
  agent_id: "builder",
  agent_name: "Builder",
  gateway_url: "https://gateway.example.test/v1/responses",
  credential_ref: "runtime:builder",
  enabled: true,
  status: "configured",
  provider: "openai",
  model: "gpt-5.6-terra",
  created_at: "2026-08-31T00:00:00Z",
  updated_at: "2026-08-31T00:00:00Z"
});

export const stage1Target = Object.freeze({
  path: "tests/fixtures/stage1-marker.txt",
  content: "stage-1 fixture marker\n"
});

/**
 * Deterministic two-round Agent mock. `requests` exposes the exact envelopes
 * received by the mock so integration tests can inspect Node's request content.
 */
export function createStage1MockAgent() {
  const requests = [];
  return Object.freeze({ requests, respond });

  async function respond(envelope) {
    requests.push(structuredClone(envelope));
    const parentId = envelope?.request_id;
    if (envelope?.type === "task") {
      return responseEnvelope(parentId, "code_needed", {
        files_requested: [stage1Target.path],
        reason: "Need the target file before writing the fixture marker."
      });
    }
    if (envelope?.type === "code_provide") {
      return responseEnvelope(parentId, "submit_code_response", {
        explanation: "Create the stage-1 fixture marker.",
        files: [{ path: stage1Target.path, language: "text", format: "full_content", content: stage1Target.content, exists: false }]
      });
    }
    throw new Error(`Stage-1 mock does not support request type: ${envelope?.type ?? "<missing>"}`);
  }
}

function responseEnvelope(parentId, type, payload) {
  return {
    request_id: `33333333-3333-4333-8333-${String(Date.now()).slice(-12).padStart(12, "0")}`,
    parent_id: parentId,
    type,
    role: "agent",
    payload,
    timestamp: new Date().toISOString()
  };
}
