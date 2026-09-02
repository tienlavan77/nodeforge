import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";
import { assertValidEnvelope } from "../protocol/envelope-validator.js";
import { requestedSubmissionFormat } from "./submission-format.js";
import { STRUCTURED_PATCH_PROMPT } from "./structured-patch-prompt.js";

/** Build and validate the canonical Node task envelope for the stage-1 OpenAI flow. */
export function createStage1TaskRequestBuilder({ createRequestId = randomUUID, clock = () => new Date(), conventions = [] } = {}) {
  if (typeof createRequestId !== "function" || typeof clock !== "function") throw new ConfigurationError("Stage-1 request builder requires request ID and clock functions.");
  if (!Array.isArray(conventions) || conventions.some((value) => typeof value !== "string" || !value.trim())) throw new ConfigurationError("Stage-1 conventions must be non-empty strings.");
  return Object.freeze({ buildTaskRequest });

  function buildTaskRequest(ticket, { agentId = "builder", conversationId = `CONV-${ticket?.id ?? "TASK"}`, correlationId = `CORR-${ticket?.id ?? "TASK"}`, stepId = 1, parentId = null, relevantTree = [], submissionFormat, cacheConfig } = {}) {
    assertTicket(ticket);
    if (typeof agentId !== "string" || !agentId) throw new ConfigurationError("Stage-1 request requires agentId.");
    if (!Number.isInteger(stepId) || stepId < 1) throw new ConfigurationError("Stage-1 request stepId must be positive.");
    const requestId = createRequestId();
    const format = requestedSubmissionFormat({ submissionFormat, ...ticket });
    const formatGuidance = format === "unified_diff"
      ? "Return unified_diff only: use ---/+++ headers, ranged @@ -old,count +new,count @@ hunks, and context lines. Do not use markdown fences, bare @@, or *** Begin Patch."
      : format === "apply_patch"
        ? "Return apply_patch only: wrap with *** Begin Patch/*** End Patch, use *** Update File: path and context lines in every hunk. Do not use unified diff headers or additions without context."
        : format === "structured_patch"
          ? STRUCTURED_PATCH_PROMPT
          : format === "per_file"
            ? `${STRUCTURED_PATCH_PROMPT} For each file, choose structured_patch when before_checksum is a sha256 string, and full_content only when before_checksum is null and exists is false.`
            : "Return full_content only: complete final file contents, with no diff, patch, snippet, placeholder, or truncation.";
    const payload = {
      schema_version: "1.4",
      task_id: ticket.id,
      step_id: stepId,
      conversation_mode: "hybrid",
      hybrid_window: 2,
      cache_config: cacheConfig ? structuredClone(cacheConfig) : { prompt_cache_key: `forge:${ticket.project_id}:${ticket.sprint_id ?? "default"}:${ticket.id}`, mode: "explicit", ttl: "30m" },
      instruction_blocks: [
        { block_id: "stage1-conventions", content: `${conventions.length ? conventions.join("\n") : "Use Forge conventions and modify only files requested by the ticket."}\nNode owns state, filesystem, and checksums. Use only what Node explicitly provides. ${formatGuidance} If the current file context is missing or ambiguous, return code_needed. For every existing file, copy before_checksum exactly from Node-provided context; never recompute or guess it.`, cacheable: true }
      ],
      user_blocks: [
        { block_id: "task_context", content: `${ticket.title}\n\nObjective: ${ticket.objective}`, cacheable: false },
        { block_id: "acceptance_criteria", content: ticket.acceptance_criteria.map((criterion, index) => `${index + 1}. ${criterion}`).join("\n"), cacheable: false },
        ...(relevantTree.length ? [{ block_id: "code_graph_candidates", content: `Code Graph candidates (source only):\n${relevantTree.map((entry) => `- ${entry.path}`).join("\n")}`, cacheable: false }] : [])
      ],
      transcript_blocks: [],
      expected_submission: { type: "submit_code", representation: format, transport: "function_tool", required_fields: ["explanation", "files"] },
      metadata: { retry_of_step: null, previous_error: null, agent_id: agentId, project_id: ticket.project_id, conversation_id: conversationId, correlation_id: correlationId }
    };
    return assertValidEnvelope({ request_id: requestId, parent_id: parentId, type: "task", role: "node", payload, timestamp: clock().toISOString() });
  }
}

function assertTicket(ticket) {
  if (!ticket || typeof ticket !== "object" || typeof ticket.id !== "string" || !ticket.id || typeof ticket.project_id !== "string" || !ticket.project_id || typeof ticket.title !== "string" || !ticket.title || typeof ticket.objective !== "string" || !ticket.objective || !Array.isArray(ticket.acceptance_criteria) || ticket.acceptance_criteria.length === 0 || ticket.acceptance_criteria.some((item) => typeof item !== "string" || !item.trim())) throw new ConfigurationError("Stage-1 request requires ticket id, project_id, title, objective, and acceptance_criteria.");
}
