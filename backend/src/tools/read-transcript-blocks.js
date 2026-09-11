// Summary: Reads scoped transcript blocks and file context through Forge-owned services.

import { ConfigurationError } from "../shared/errors.js";
import { assertExecutionScope, checkRetrievalBudget, recordRetrieval } from "./retrieval-governance.js";

export function createReadTranscriptBlocksTool({ protocolStorage, fileService, maxChars = 50000 } = {}) {
  if (typeof protocolStorage?.get !== "function") throw new ConfigurationError("Transcript tool requires Protocol Storage.");
  if (typeof fileService?.readForIndex !== "function") throw new ConfigurationError("Transcript tool requires Forge File Service readForIndex.");
  return Object.freeze({ name: "read_transcript_blocks", execute });

  async function execute(input = {}, context = {}) {
    const taskId = context.task_id ?? context.taskId;
    const capabilities = new Set(context.capabilities ?? []);
    const transcriptBlocks = Array.isArray(context.transcript_blocks) ? context.transcript_blocks : [];
    if (typeof taskId !== "string" || !taskId) throw new ConfigurationError("Transcript tool requires the current task_id.");
    assertExecutionScope(context, taskId);
    if (!capabilities.has("read_transcript_blocks")) { const error = new ConfigurationError("Agent is not authorized to use read_transcript_blocks."); error.code = "TOOL_FORBIDDEN"; throw error; }
    const blockIds = new Set(Array.isArray(input.block_ids) ? input.block_ids : []);
    const rounds = new Set(Array.isArray(input.rounds) ? input.rounds : []);
    const include = input.include ?? "both";
    const requestedFiles = Array.isArray(input.file_paths) ? input.file_paths : [];
    const requestedMax = input.max_chars ?? maxChars;
    if (!Number.isInteger(requestedMax) || requestedMax < 1000 || requestedMax > maxChars) throw scopedError("READ_LIMIT_INVALID", `max_chars must be an integer between 1000 and ${maxChars}.`);
    const allowedFiles = new Set(context.allowed_file_paths ?? context.allowedFilePaths ?? []);
    if (!blockIds.size && !rounds.size && !requestedFiles.length) throw new ConfigurationError("Transcript tool requires block_ids, rounds, or file_paths.");
    if (blockIds.size > 20 || rounds.size > 20 || requestedFiles.length > 20) throw scopedError("READ_LIMIT_INVALID", "Transcript retrieval is limited to 20 blocks, rounds, or files per call.");
    if (requestedFiles.some((path) => !allowedFiles.has(path))) throw new ConfigurationError("Transcript tool file path is outside the approved context.");
    const selected = transcriptBlocks.filter((block) => (!blockIds.size || blockIds.has(block.block_id)) && (!rounds.size || rounds.has(block.round)));
    checkRetrievalBudget(context, requestedFiles.length * requestedMax + selectedBlockEstimate(selected, requestedMax), "read_transcript_blocks");
    const blocks = await Promise.all(selected.map((block) => resolveBlock(block, taskId, include, requestedMax, protocolStorage)));
    const files = await readFiles(requestedFiles, fileService, requestedMax);
    const result = { task_id: taskId, blocks, files };
    recordRetrieval(context, { bytes: Buffer.byteLength(JSON.stringify(result), "utf8"), tool: "read_transcript_blocks", kind: "transcript", taskId, resource: [...blockIds, ...requestedFiles].join(",") });
    return result;
  }
}

function scopedError(code, message) { const error = new ConfigurationError(message); error.code = code; return error; }

function selectedBlockEstimate(selectedBlocks, maxChars) {
  return selectedBlocks.length * maxChars;
}

async function resolveBlock(block, taskId, include, requestedMax, protocolStorage) {
  if (!block || typeof block !== "object" || !Number.isInteger(block.round) || typeof block.block_id !== "string") throw new ConfigurationError("Transcript tool received an invalid block.");
  const result = { block_id: block.block_id, round: block.round, instruction: block.instruction ?? "", response_summary: block.response_summary ?? "" };
  if (!block.in_window) return result;
  const prefix = "task/" + taskId + "/";
  if ((include === "request" || include === "both") && (!block.full_request_ref?.startsWith(prefix))) throw new ConfigurationError("Transcript request ref is outside the current task.");
  if ((include === "response" || include === "both") && (!block.full_response_ref?.startsWith(prefix))) throw new ConfigurationError("Transcript response ref is outside the current task.");
  if (include === "request" || include === "both") result.request = truncateValue((await protocolStorage.get(block.full_request_ref)).data, requestedMax);
  if (include === "response" || include === "both") result.response = truncateValue((await protocolStorage.get(block.full_response_ref)).data, requestedMax);
  return result;
}

async function readFiles(paths, fileService, maxChars) {
  return Promise.all(paths.map(async (path) => {
    const file = await fileService.readForIndex({ path });
    return { path: file.path, content: truncateValue(file.content, maxChars), sha256: file.sha256, size_bytes: file.size_bytes, language: file.language };
  }));
}

function truncateValue(value, maxChars) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (serialized.length <= maxChars) return value;
  return { truncated: true, preview: serialized.slice(0, maxChars) };
}
