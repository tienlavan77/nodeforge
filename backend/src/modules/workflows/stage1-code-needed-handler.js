import { createHash, randomUUID } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";
import { assertValidEnvelope } from "../protocol/envelope-validator.js";

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
    const requestedPaths = requested.flatMap((path) => path === "." || path.endsWith("/") ? relevantTree.slice(0, 3).map((entry) => entry.path) : [path]);
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
    const expectedSubmission = chooseExpectedSubmission(requestEnvelope.payload.expected_submission, resolved);
    const envelope = { request_id: createRequestId(), parent_id: response.request_id, type: "code_provide", role: "node", payload: { task_id: requestEnvelope.payload.task_id, step_id: requestEnvelope.payload.step_id + 1, files: resolved, ...(requestEnvelope.payload.cache_config ? { cache_config: structuredClone(requestEnvelope.payload.cache_config) } : {}), ...(expectedSubmission ? { expected_submission: expectedSubmission } : {}), task_context: { user_blocks: structuredClone(requestEnvelope.payload.user_blocks ?? []), instruction_blocks: structuredClone(requestEnvelope.payload.instruction_blocks ?? []) } }, timestamp: clock().toISOString() };
    return assertValidEnvelope(envelope);
  }
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
