import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";
import { assertValidEnvelope } from "../protocol/envelope-validator.js";
import { filterCriteriaForRole } from "./criteria-filter.js";

/** Builds the status_check request after code and wiring exchanges. */
export function buildStatusCheck({ taskId, stepId, filesChanged = [], criteria = [], role = "coder", parentId = null, projectId, conversationId, correlationId, instructionBlocks = [], userBlocks = [], createRequestId = randomUUID, clock = () => new Date() } = {}) {
  if (typeof taskId !== "string" || !taskId || !Number.isInteger(stepId) || stepId < 1) throw new ConfigurationError("Status check requires taskId and positive stepId.");
  const acceptanceCriteria = filterCriteriaForRole(criteria, role);
  const files = filesChanged.map((file) => ({ path: file.path, action: file.action === "modified" ? "modified" : file.action === "created" ? "created" : "patched" }));
  const envelope = { request_id: createRequestId(), parent_id: parentId, type: "status_check", role: "node", payload: { task_id: taskId, step_id: stepId, acceptance_criteria: acceptanceCriteria, files_changed: files, instruction_blocks: instructionBlocks, user_blocks: userBlocks, expected_output: { type: "status_response", representation: "json", transport: "function_tool" }, metadata: { retry_of_step: null, previous_error: null, ...(projectId ? { project_id: projectId } : {}), ...(conversationId ? { conversation_id: conversationId } : {}), ...(correlationId ? { correlation_id: correlationId } : {}) } }, timestamp: clock().toISOString() };
  return assertValidEnvelope(envelope);
}
