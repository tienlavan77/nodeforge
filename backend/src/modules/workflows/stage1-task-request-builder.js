import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";
import { assertValidEnvelope } from "../protocol/envelope-validator.js";

/** Build and validate the canonical Node task envelope for the stage-1 OpenAI flow. */
export function createStage1TaskRequestBuilder({ createRequestId = randomUUID, clock = () => new Date(), conventions = [] } = {}) {
  if (typeof createRequestId !== "function" || typeof clock !== "function") throw new ConfigurationError("Stage-1 request builder requires request ID and clock functions.");
  if (!Array.isArray(conventions) || conventions.some((value) => typeof value !== "string" || !value.trim())) throw new ConfigurationError("Stage-1 conventions must be non-empty strings.");
  return Object.freeze({ buildTaskRequest });

  function buildTaskRequest(ticket, { agentId = "builder", conversationId = `CONV-${ticket?.id ?? "TASK"}`, correlationId = `CORR-${ticket?.id ?? "TASK"}`, stepId = 1, parentId = null, relevantTree = [] } = {}) {
    assertTicket(ticket);
    if (typeof agentId !== "string" || !agentId) throw new ConfigurationError("Stage-1 request requires agentId.");
    if (!Number.isInteger(stepId) || stepId < 1) throw new ConfigurationError("Stage-1 request stepId must be positive.");
    const requestId = createRequestId();
    const payload = {
      schema_version: "1.4",
      task_id: ticket.id,
      step_id: stepId,
      conversation_mode: "hybrid",
      hybrid_window: 2,
      cache_config: { prompt_cache_key: `nodeforge-${agentId}`, mode: "explicit", ttl: "30m" },
      instruction_blocks: [
        { block_id: "stage1-conventions", content: conventions.length ? conventions.join("\n") : "Use Forge conventions and modify only files requested by the ticket.\n`representation=full_content` means: merge the requested change into the provided code and return the full final file content only. Keep all untouched code unchanged. Never return unified diffs, patches, or fragments.", cacheable: true }
      ],
      user_blocks: [
        { block_id: "task_context", content: `${ticket.title}\n\nObjective: ${ticket.objective}`, cacheable: false },
        { block_id: "acceptance_criteria", content: ticket.acceptance_criteria.map((criterion, index) => `${index + 1}. ${criterion}`).join("\n"), cacheable: false },
        ...(relevantTree.length ? [{ block_id: "code_graph_candidates", content: `Code Graph candidates (source only):\n${relevantTree.map((entry) => `- ${entry.path}`).join("\n")}`, cacheable: false }] : [])
      ],
      transcript_blocks: [],
      expected_submission: { type: "submit_code", representation: "full_content", transport: "function_tool", required_fields: ["explanation", "files"], is_final: false },
      metadata: { retry_of_step: null, previous_error: null, agent_id: agentId, project_id: ticket.project_id, conversation_id: conversationId, correlation_id: correlationId }
    };
    return assertValidEnvelope({ request_id: requestId, parent_id: parentId, type: "task", role: "node", payload, timestamp: clock().toISOString() });
  }
}

function assertTicket(ticket) {
  if (!ticket || typeof ticket !== "object" || typeof ticket.id !== "string" || !ticket.id || typeof ticket.project_id !== "string" || !ticket.project_id || typeof ticket.title !== "string" || !ticket.title || typeof ticket.objective !== "string" || !ticket.objective || !Array.isArray(ticket.acceptance_criteria) || ticket.acceptance_criteria.length === 0 || ticket.acceptance_criteria.some((item) => typeof item !== "string" || !item.trim())) throw new ConfigurationError("Stage-1 request requires ticket id, project_id, title, objective, and acceptance_criteria.");
}
