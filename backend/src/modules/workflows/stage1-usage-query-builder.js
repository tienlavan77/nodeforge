import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";
import { assertValidEnvelope } from "../protocol/envelope-validator.js";

/** Builds the Node usage_query envelope for files created by the exchange. */
export function buildUsageQuery({ taskId, stepId, unwiredFiles, parentId = null, projectId, conversationId, correlationId, instructionBlocks = [], userBlocks = [], createRequestId = randomUUID, clock = () => new Date() } = {}) {
  if (typeof taskId !== "string" || !taskId || !Number.isInteger(stepId) || stepId < 1) throw new ConfigurationError("Usage query requires taskId and positive stepId.");
  if (!Array.isArray(unwiredFiles) || unwiredFiles.length === 0) throw new ConfigurationError("Usage query requires unwired files.");
  const files = unwiredFiles.map((file) => ({ path: file.path, status: "unwired", imported_by: [] }));
  const envelope = { request_id: createRequestId(), parent_id: parentId, type: "usage_query", role: "node", payload: { task_id: taskId, step_id: stepId, unwired_files: files, instruction_blocks: instructionBlocks, user_blocks: userBlocks, expected_output: { type: "usage_response", representation: "json", transport: "function_tool" }, metadata: { retry_of_step: null, previous_error: null, ...(projectId ? { project_id: projectId } : {}), ...(conversationId ? { conversation_id: conversationId } : {}), ...(correlationId ? { correlation_id: correlationId } : {}) } }, timestamp: clock().toISOString() };
  return assertValidEnvelope(envelope);
}
