import { createHash, randomUUID } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";
import { assertValidEnvelope } from "../protocol/envelope-validator.js";
import { buildStage1InstructionBlocks, CODE_REQUIRE_INSTRUCTION, STRUCTURED_PATCH_CONTRACT } from "./stage1-instructions.js";

/** Resolve requested files through Code Index, then read content through File Service. */
export function createStage1CodeNeededHandler({ files, fileService, relevantTree = [], createRequestId = randomUUID, clock = () => new Date() } = {}) {
  if (typeof files?.findByPath !== "function") throw new ConfigurationError("Code-needed handler requires Code Index file lookup.");
  if (typeof fileService?.readFile !== "function") throw new ConfigurationError("Code-needed handler requires File Service readFile.");
  return Object.freeze({ handleCodeNeeded });

  async function handleCodeNeeded(response, { requestEnvelope } = {}) {
    if (response?.type !== "code_needed" || response.role !== "agent") throw new ConfigurationError("Code-needed handler requires an Agent code_needed response.");
    if (!requestEnvelope?.payload?.task_id || !Number.isInteger(requestEnvelope.payload.step_id)) throw new ConfigurationError("Code-needed handler requires the originating task request.");
    const requested = response.payload?.files_requested;
    if (!Array.isArray(requested) || requested.length === 0) throw new ConfigurationError("code_needed requires files_requested.");
    const requestedPaths = requested.flatMap((entry) => {
      const path = typeof entry === "string" ? entry : entry?.path;
      if (typeof path !== "string" || !path) throw new ConfigurationError("code_needed files_requested entries require a path.");
      return path === "." || path.endsWith("/") ? relevantTree.slice(0, 3).map((candidate) => candidate.path) : [path];
    });
    const resolved = [];
    for (const path of [...new Set(requestedPaths)]) {
      if (path === "." || path.endsWith("/")) continue;
      const index = files.findByPath(path);
      if (!index) { resolved.push({ path, exists: false, content: null, size_bytes: 0, before_checksum: null, index: null }); continue; }
      const content = await fileService.readFile({ path });
      const actualChecksum = `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
      const indexedChecksum = normalizeChecksum(index.sha256);
      if (indexedChecksum && indexedChecksum !== actualChecksum) {
        const error = new ConfigurationError(`Indexed checksum is stale for ${path}.`);
        error.code = "CONTEXT_STALE";
        throw error;
      }
      resolved.push({
        path,
        exists: true,
        content,
        ...(typeof index.language === "string" && index.language ? { language: index.language } : {}),
        size_bytes: index.size_bytes ?? Buffer.byteLength(content, "utf8"),
        before_checksum: indexedChecksum ?? actualChecksum
      });
    }
    const planningFollowup = requestEnvelope.type === "planning";
    const executionPlan = planningFollowup ? buildExecutionPlan(response.payload.plan, resolved) : null;
    const inheritedUserBlocks = structuredClone(requestEnvelope.payload.user_blocks ?? requestEnvelope.payload.task_context?.user_blocks ?? []).filter((block) => block?.block_id !== "code_graph_candidates");
    const envelope = { request_id: createRequestId(), parent_id: response.request_id, type: planningFollowup ? "code_provide" : "planning", role: "node", payload: { task_id: requestEnvelope.payload.task_id, step_id: requestEnvelope.payload.step_id + 1, ...(planningFollowup ? { plan: executionPlan } : { files: resolved }), ...(requestEnvelope.payload.cache_config ? { cache_config: structuredClone(requestEnvelope.payload.cache_config) } : {}), ...(planningFollowup ? { expected_output: { type: "submit_code_response", transport: "function_tool" } } : { expected_output: { type: "planning", representation: "json", transport: "function_tool" } }), task_context: { user_blocks: [...inheritedUserBlocks], instruction_blocks: [...buildStage1InstructionBlocks({ includePlanning: !planningFollowup, includeConventions: false }), ...(planningFollowup ? [{ block_id: "code_require", content: CODE_REQUIRE_INSTRUCTION, cacheable: false }, { block_id: "structured-patch-contract", content: STRUCTURED_PATCH_CONTRACT, cacheable: true }] : [])] } }, timestamp: clock().toISOString() };
    return assertValidEnvelope(envelope);
  }
}

function buildExecutionPlan(plan, files) {
  if (!Array.isArray(plan) || plan.length === 0) throw new ConfigurationError("Planning response requires a non-empty plan.");
  const byPath = new Map(files.map((file) => [file.path, file]));
  return plan.map((item) => {
    const file = byPath.get(item.path);
    if (!file) throw new ConfigurationError(`Plan path has no Node-provided context: ${item.path}.`);
    if (item.action === "NEW") {
      if (file.exists) throw new ConfigurationError(`Plan marks an existing file as NEW: ${item.path}.`);
      return { path: item.path, action: "NEW", representation: "full_content", before_checksum: null, reason: item.reason, current_content: null };
    }
    if (item.action === "MODIFY") {
      if (!file.exists || typeof file.content !== "string" || typeof file.before_checksum !== "string") throw new ConfigurationError(`Plan MODIFY requires current file context: ${item.path}.`);
      return { path: item.path, action: "MODIFY", representation: "structured_patch", before_checksum: file.before_checksum, reason: item.reason, current_content: file.content };
    }
    if (item.action === "READ_ONLY") {
      if (!file.exists || typeof file.content !== "string") throw new ConfigurationError(`Plan READ_ONLY requires current file context: ${item.path}.`);
      return { path: item.path, action: "READ_ONLY", representation: "none", before_checksum: null, reason: item.reason, current_content: file.content };
    }
    throw new ConfigurationError(`Unsupported plan action for ${item.path}.`);
  });
}

function normalizeChecksum(value) {
  if (typeof value !== "string" || !value) return null;
  return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

function chooseExpectedSubmission(existing, files) {
  const requested = existing?.representation;
  if (requested && !["full_content", "structured_patch"].includes(requested)) return structuredClone(existing);
  const allExisting = files.length > 0 && files.every((file) => file.exists === true);
  const allNew = files.length > 0 && files.every((file) => file.exists === false);
  const base = existing && ["structured_patch", "per_file"].includes(requested) ? structuredClone(existing) : { type: "submit_code", transport: "function_tool", required_fields: ["explanation", "files"] };
  return { ...base, representation: allExisting ? "structured_patch" : allNew ? "full_content" : "per_file" };
}
