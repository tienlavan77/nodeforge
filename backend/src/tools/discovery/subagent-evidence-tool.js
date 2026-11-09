// Business purpose: gives governed agents (AM, SE, RV, Coder) one consistent entry point to inspect durable per-agent and cross-shared evidence before searching disk.
// Technical description: snapshots the evidence store with cross-role handoff/plan merging, filters Coder evidence to ticket scope, verifies current disk sha256 freshness, and registers recordSourceMetadata and active_file_checksums for all fresh files.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { updateActiveFileChecksums } from "../../application/owner-context-compaction.js";
import { extractorRegistry } from "../../modules/index/parser/index.js";
import { recordSourceMetadata } from "./source-metadata-receipts.js";

export const subagentEvidenceDefinition = Object.freeze({
  name: "read_subagent_evidence",
  description: "Read durable and cross-shared file metadata, sha256 checksums, symbol maps, and subagent worker summaries for the active conversation, handoff, plan, or ticket.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      conversation_id: { type: "string", minLength: 1 },
      delegation_id: { type: "string", minLength: 1 }
    }
  }
});

// Business purpose: checks whether a file path is within the Coder's allowed ticket scope.
// Technical description: matches path against allowed_file_paths and allowed_prefixes when present on the context.
function isWithinCoderTicketScope(path, context = {}) {
  const role = context.agent_identity?.role ?? context.evidence_scope?.role;
  if (role !== "coder") return true;
  const allowedPaths = Array.isArray(context.allowed_file_paths) ? context.allowed_file_paths : [];
  const allowedPrefixes = Array.isArray(context.allowed_prefixes) ? context.allowed_prefixes : [];
  if (!allowedPaths.length && !allowedPrefixes.length) return true;
  return allowedPaths.includes(path) || allowedPrefixes.some((prefix) => {
    const clean = String(prefix).replace(/\/$/, "");
    return path === clean || path.startsWith(`${clean}/`);
  });
}

// Business purpose: computes the current sha256 and symbol map of a project file on disk or via fileService/codeCache.
// Technical description: reads the file through codeCache, fileService, or projectRoot filesystem to verify whether stored evidence is fresh or stale.
async function checkDiskFreshness(item, { context, fileService, codeCache, projectRoot } = {}) {
  const root = projectRoot ?? context?.project_root;
  try {
    if (codeCache?.read) {
      const cached = await codeCache.read({ path: item.path });
      if (cached?.sha256) {
        const symbols = Array.isArray(cached.code_index?.symbols) && cached.code_index.symbols.length
          ? cached.code_index.symbols
          : item.symbol_map ?? (typeof cached.content === "string" ? extractorRegistry.extract(item.path, cached.content).symbols : undefined);
        return { exists: true, sha256: cached.sha256, symbol_map: symbols, total_lines: typeof cached.content === "string" ? cached.content.split("\n").length : item.total_lines };
      }
    }
    if (fileService?.readForIndex) {
      const file = await fileService.readForIndex({ path: item.path });
      if (file && typeof file.content === "string") {
        const sha = file.sha256 ?? `sha256:${createHash("sha256").update(file.content).digest("hex")}`;
        const symbols = item.symbol_map ?? extractorRegistry.extract(item.path, file.content).symbols;
        return { exists: true, sha256: sha, symbol_map: symbols, total_lines: file.content.split("\n").length };
      }
    }
    if (fileService?.readFile) {
      const raw = await fileService.readFile({ path: item.path });
      if (typeof raw === "string" || Buffer.isBuffer(raw)) {
        const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;
        const sha = `sha256:${createHash("sha256").update(text).digest("hex")}`;
        const symbols = item.symbol_map ?? extractorRegistry.extract(item.path, text).symbols;
        return { exists: true, sha256: sha, symbol_map: symbols, total_lines: text.split("\n").length };
      }
    }
    if (root && typeof item.path === "string") {
      const fullPath = resolve(root, item.path);
      if (existsSync(fullPath)) {
        const buf = readFileSync(fullPath);
        const sha = `sha256:${createHash("sha256").update(buf).digest("hex")}`;
        const text = buf.toString("utf8");
        const symbols = item.symbol_map ?? extractorRegistry.extract(item.path, text).symbols;
        return { exists: true, sha256: sha, symbol_map: symbols, total_lines: text.split("\n").length };
      }
    }
    if (root && typeof item.path === "string" && !existsSync(resolve(root, item.path))) {
      return { exists: false, sha256: null, symbol_map: undefined, total_lines: undefined, error: "File does not exist on disk." };
    }
  } catch (error) {
    const message = String(error?.message ?? "Failed to inspect file on disk.");
    context?.project_logger?.({
      event_name: "subagent_evidence.freshness_check_failed",
      level: "warn",
      status: "stale",
      message: `Evidence freshness check failed for ${item.path}: ${message}`,
      conversation_id: context?.conversation_id ?? null,
      source: "subagent-evidence-tool",
      payload: { path: item.path, error_message: message }
    });
    return { exists: false, sha256: null, symbol_map: undefined, total_lines: undefined, error: message };
  }
  return { exists: false, sha256: null, symbol_map: undefined, total_lines: undefined, error: "Unable to verify file freshness on disk." };
}

// Business purpose: gives governed agents one consistent entry point to reuse parallel and cross-role discovery.
// Technical description: validates the injected store, merges scoped role stores, verifies sha256 freshness, and registers source metadata receipts for fresh files.
export function createSubagentEvidenceTool({ evidenceStore, fileService = null, codeCache = null, projectRoot = null } = {}) {
  if (typeof evidenceStore?.snapshot !== "function") throw new Error("read_subagent_evidence requires an evidence store.");
  return {
    definition: subagentEvidenceDefinition,
    async execute(input = {}, context = {}) {
      const scope = context.evidence_scope ?? {};
      const conversationId = String(scope.conversationId ?? context.conversation_id ?? context.task_id ?? "");
      const delegationId = String(scope.delegationId ?? context.execution_id ?? context.task_id ?? "");
      const allowedConversations = new Set([
        conversationId,
        String(context.conversation_id ?? ""),
        String(scope.linkedConversationId ?? ""),
        String(context.task_id ?? "")
      ].filter(Boolean));
      if (input.conversation_id && allowedConversations.size > 0 && !allowedConversations.has(input.conversation_id)) {
        throw Object.assign(new Error("Evidence access is restricted to the runtime-bound execution scope."), { code: "EVIDENCE_SCOPE_FORBIDDEN" });
      }
      if (!conversationId && !delegationId) throw new Error("conversation_id and delegation_id are required.");
      const snapshot = evidenceStore.snapshot({
        projectId: scope.projectId ?? context.project_id ?? null,
        projectRoot: projectRoot ?? context.project_root ?? null,
        role: scope.role ?? context.agent_identity?.role ?? null,
        conversationId,
        linkedConversationId: scope.linkedConversationId ?? null,
        handoffId: scope.handoffId ?? null,
        planId: scope.planId ?? null,
        ticketId: scope.ticketId ?? context.task_id ?? null,
        delegationId: input.delegation_id ?? delegationId
      });
      const scopedEvidence = snapshot.evidence.filter((item) => isWithinCoderTicketScope(item.path, context));
      const verifiedEvidence = [];
      for (const item of scopedEvidence) {
        const disk = await checkDiskFreshness(item, { context, fileService, codeCache, projectRoot });
        const fresh = disk.exists === true && disk.sha256 === item.sha256;
        const symbolMap = Array.isArray(item.symbol_map) && item.symbol_map.length ? item.symbol_map : disk.symbol_map;
        const symbols = Array.isArray(item.symbols) && item.symbols.length
          ? item.symbols
          : Array.isArray(symbolMap)
            ? [...new Set(symbolMap.map((s) => s?.name).filter(Boolean))]
            : undefined;
        if (fresh) {
          recordSourceMetadata(context, { path: item.path, sha256: item.sha256, symbol_map: Array.isArray(symbolMap) ? symbolMap : [] });
          context.active_file_checksums = updateActiveFileChecksums(context.active_file_checksums, {
            toolName: "read_file",
            step: { tool_name: "read_file", path: item.path },
            result: { path: item.path, sha256: item.sha256, total_lines: item.total_lines ?? disk.total_lines }
          });
        }
        verifiedEvidence.push({
          path: item.path,
          sha256: item.sha256,
          fresh,
          stale: !fresh,
          ...(disk.error ? { freshness_error: disk.error } : {}),
          ...(Number.isInteger(item.total_lines ?? disk.total_lines) ? { total_lines: item.total_lines ?? disk.total_lines } : {}),
          ...(symbols ? { symbols } : {}),
          ...(Array.isArray(symbolMap) ? { symbol_map: symbolMap } : {}),
          ...(item.code_graph ? { code_graph: item.code_graph } : {}),
          ...(Array.isArray(item.symbols_read) ? { symbols_read: item.symbols_read } : {}),
          source_worker_id: item.source_worker_id ?? null,
          source_role: item.source_role ?? snapshot.role ?? null,
          delegation_id: item.delegation_id ?? snapshot.delegation_id,
          version: item.version ?? snapshot.version
        });
      }
      return {
        conversation_id: snapshot.conversation_id,
        delegation_id: snapshot.delegation_id,
        version: snapshot.version,
        ...(Array.isArray(snapshot.durability_errors) && snapshot.durability_errors.length ? { durability_errors: snapshot.durability_errors } : {}),
        workers: snapshot.workers.map(({ worker_id, parent_agent_id, role, agent_type, objective, status, heartbeat_at, result }) => ({
          worker_id,
          parent_agent_id,
          ...(role ? { role } : {}),
          agent_type,
          objective,
          status,
          ...(status === "fallback_to_parent" || result?.fallback_to_parent ? { fallback_to_parent: true } : {}),
          heartbeat_at,
          result
        })),
        evidence: verifiedEvidence
      };
    }
  };
}
