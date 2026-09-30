// Provides Reviewer-only cached code discovery with path, budget, and audit governance.
import { lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { ConfigurationError } from "../../shared/errors.js";
import { assertRoleFileAccess } from "../../infrastructure/filesystem/file-service-role-policy.js";
import { createReadFileTool } from "../../tools/agent-lifecycle-tools.js";
import { createSearchCodeTool } from "../../tools/search-code.js";
import { createSedLinesTool } from "../../tools/sed-lines.js";
import { readFileDefinition, searchCodeDefinition, sedLinesDefinition } from "../../tools/index.js";
import { createOwnerSearchTreeTool, ownerSearchTreeDefinition } from "../../tools/owner-search-tree.js";
import { createClaudeFileTools, claudeFileDefinitions } from "../../tools/claude-file-tools.js";

const MAX_OUTPUT_BYTES = 128_000;
const MAX_RESULT_BYTES = 16_000;
const MAX_FILE_BYTES = 64_000;
const MAX_WINDOW_LINES = 80;
const MAX_FILES = 80;
const reviewerReadFileDefinition = { ...readFileDefinition, description: "Read metadata and graph for one approved file. Use sed_lines or Read to inspect source lines.", input_schema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string", minLength: 1 } } } };
const reviewerSearchCodeDefinition = { ...searchCodeDefinition, description: "Search indexed code inside the fixed Reviewer scope selected by Node. Supply a query; the tool applies allowed prefixes automatically.", input_schema: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", minLength: 1, maxLength: 200 }, kind: { type: "string", enum: ["file", "symbol", "content"] }, limit: { type: "integer", minimum: 1, maximum: 20 }, projection: { type: "string", enum: ["minimal", "summary", "graph"] } } } };
const reviewerReadDefinition = { ...claudeFileDefinitions.find(({ name }) => name === "Read"), description: "Read an approved file source window with file_path, start_line, and end_line; maximum 80 lines." };

// Applies the Reviewer role policy and rejects symlink traversal for all review reads.
export async function assertReviewerReadPath(projectRoot, path) {
  if (typeof projectRoot !== "string" || !isAbsolute(projectRoot)) throw toolError("REVIEW_PROJECT_INVALID", "Reviewer project root must be absolute.");
  assertRoleFileAccess("reviewer", "read", path);
  let current = resolve(projectRoot);
  for (const part of path.split("/")) {
    current = resolve(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) { if (error.code === "ENOENT") break; throw error; }
    if (info.isSymbolicLink()) throw toolError("FILE_ROLE_FORBIDDEN", "Reviewer path contains a symbolic link.");
  }
}

// Creates per-review wrappers around existing read_file and search_tree implementations.
export function createReviewerForgeTools({ fileService, projectRoot, job, reviewer, codeSearch, codeCache, ticketEvidence, includeClaudeFileTools = false, projectLogger = () => {} }) {
  if (typeof fileService?.readForIndex !== "function" || !isAbsolute(projectRoot ?? "")) throw new ConfigurationError("Reviewer Forge tools require File Service and an absolute project root.");
  const scopedFiles = {
    readForIndex: async (input) => { await assertReviewerReadPath(projectRoot, input?.path); return fileService.readForIndex({ ...input, maxBytes: MAX_FILE_BYTES }); },
    listFiles: async (input) => filterPaths(await fileService.listFiles(input)),
    listDirectories: async (input) => filterPaths(await fileService.listDirectories(input))
  };
  const allowedPrefixes = [...new Set((job.payload?.changed_paths ?? []).map((path) => path.split("/").slice(0, -1).join("/")).filter(Boolean).concat(["workflows/agents/"]))];
  const toolContext = { task_id: job.task_id, correlation_id: job.correlation_id, request_id: job.request_id, agent_identity: { agent_id: reviewer.agent_id, role: "reviewer", provider: reviewer.provider }, capabilities: ["read_file", "search_code", "Read", "Glob", "Grep", "search_tree"], project_root: projectRoot, allowed_file_paths: job.payload?.changed_paths ?? [], allowed_prefixes: allowedPrefixes.length ? allowedPrefixes : ["backend/", "ui/", "schemas/", "workflows/"] };
  const implementations = {
    read_file: createReadFileTool({ fileService: scopedFiles, codeCache, maxChars: MAX_RESULT_BYTES }),
    ...(codeSearch?.search ? { search_code: createSearchCodeTool({ codeSearch, codeCache, projectLogger }) } : {}),
    ...((codeCache && ["codex", "openai"].includes(reviewer.provider)) ? { sed_lines: createSedLinesTool({ projectRoot, fileService: scopedFiles, codeCache, logger: { emit: projectLogger } }) } : {}),
    ...(includeClaudeFileTools && codeCache ? createClaudeFileTools({ fileService: scopedFiles, projectRoot, codeCache }) : {})
  };
  if (typeof fileService.listFiles === "function" && typeof fileService.listDirectories === "function") implementations.search_tree = createOwnerSearchTreeTool({ fileService: scopedFiles });
  const definitions = [reviewerReadFileDefinition, ...(implementations.search_code ? [reviewerSearchCodeDefinition] : []), ...(implementations.sed_lines ? [sedLinesDefinition] : []), ...(includeClaudeFileTools && codeCache ? claudeFileDefinitions.map((definition) => definition.name === "Read" ? reviewerReadDefinition : definition) : []), ...(implementations.search_tree ? [ownerSearchTreeDefinition] : [])];
  const context = { ...toolContext, capabilities: definitions.map(({ name }) => name) };
  let outputBytes = 0;
  const registry = Object.fromEntries(definitions.map(({ name }) => [name, { execute: async (input) => {
    const started = Date.now();
    try {
      if (name === "read_file") validateReadInput(input);
      const toolInput = name === "search_tree" ? boundedTreeInput(input) : name === "search_code" ? boundedSearchInput(input, context) : input;
      // The shared read_file discovery state is Coder-oriented; each Reviewer read is independent.
      const result = await implementations[name].execute(toolInput, { ...context });
      const verifiedResult = bindReviewEvidence(name, toolInput, result, ticketEvidence);
      const bytes = Buffer.byteLength(JSON.stringify(verifiedResult), "utf8");
      if (bytes > MAX_RESULT_BYTES || outputBytes + bytes > MAX_OUTPUT_BYTES) throw toolError("REVIEW_TOOL_BUDGET", "Reviewer read output budget exceeded.");
      outputBytes += bytes;
      audit(name, "success", { duration_ms: Date.now() - started, output_bytes: bytes, ...(verifiedResult.review_evidence ? { review_evidence: verifiedResult.review_evidence } : {}) });
      return verifiedResult;
    } catch (error) {
      audit(name, "failed", {
        duration_ms: Date.now() - started,
        error: {
          code: error.code ?? "REVIEW_TOOL_FAILED",
          message: error.message ?? "Reviewer Forge tool failed.",
          retryable: false,
          scope: "reviewer-forge-tools",
          requestId: job.request_id
        }
      });
      throw error;
    }
  } }]));
  return { definitions, registry, context };

  // Removes protected and symlinked paths from directory discovery.
  async function filterPaths(paths) {
    const safe = [];
    for (const path of paths) {
      try { await assertReviewerReadPath(projectRoot, path); safe.push(path); }
      catch (error) { if (error.code !== "FILE_ROLE_FORBIDDEN") throw error; }
    }
    return safe;
  }

  // Records Reviewer tool use without saving input paths, queries, or source text.
  function audit(tool, status, payload) {
    projectLogger({ event_name: "review.tool_call", level: status === "failed" ? "error" : "info", status, message: `Reviewer Forge tool ${tool} ${status}.`, task_id: job.task_id, correlation_id: job.correlation_id, source: "reviewer-forge-tools", payload: { request_id: job.request_id, agent_id: reviewer.agent_id, agent_name: reviewer.agent_name, reviewer_id: reviewer.agent_id, tool, ...payload } });
  }
}

// Binds a source window to the committed verification artifact or rejects stale content.
function bindReviewEvidence(name, input, result, ticketEvidence) {
  if (!ticketEvidence || !["sed_lines", "Read"].includes(name)) return result;
  const path = name === "Read" ? result.file_path : input.path;
  const file = ticketEvidence.files.find((item) => item.path === path);
  if (!file || file.deleted) return result;
  const { start_line: start, end_line: end } = input;
  const lines = file.content.split("\n");
  const selected = lines.slice(start - 1, end);
  const expected = name === "Read"
    ? selected.map((line, index) => `${String(start + index).padStart(6)}→${line}`).join("\n")
    : selected.join("\n") + (start <= lines.length ? "\n" : "");
  const actual = name === "Read" ? result.content : result.stdout;
  if (result.sha256 !== file.sha256 || actual !== expected) throw toolError("REVIEW_SOURCE_MISMATCH", `Reviewer source differs from verified commit: ${path}.`);
  return { ...result, review_evidence: { artifact_id: ticketEvidence.artifact.artifact_id, commit_sha: ticketEvidence.context.review_commit_sha, manifest_sha: ticketEvidence.context.manifest_sha, sha256: file.sha256 } };
}

// Bounds existing read_file windows while allowing live symbol resolution.
function validateReadInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.path !== "string") throw toolError("REVIEW_TOOL_INPUT", "Reviewer read_file requires a path.");
  if (input.offset !== undefined || input.limit !== undefined) {
    if (!Number.isInteger(input.offset) || input.offset < 1 || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_WINDOW_LINES) throw toolError("REVIEW_TOOL_INPUT", "Reviewer read_file window must contain at most 80 lines.");
  }
}

// Caps the existing search_tree result count for Reviewer discovery.
function boundedTreeInput(input) {
  if (input?.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_FILES)) throw toolError("REVIEW_TOOL_INPUT", "Reviewer search_tree limit must be at most 80 entries.");
  return { ...(input ?? {}), limit: input?.limit ?? MAX_FILES };
}

// Restricts Reviewer code search to Node-approved prefixes and bounded metadata results.
function boundedSearchInput(input, context) {
  if (!input || typeof input.query !== "string" || !input.query.trim()) throw toolError("REVIEW_TOOL_INPUT", "Reviewer search_code requires a query.");
  return { ...input, query: input.query.trim(), kind: input.kind ?? "content", limit: Math.min(input.limit ?? 10, 20), allowed_prefixes: context.allowed_prefixes, projection: input.projection ?? "summary" };
}

// Marks Reviewer policy failures with stable codes for SDK adapters.
function toolError(code, message) { return Object.assign(new ConfigurationError(message), { code }); }
