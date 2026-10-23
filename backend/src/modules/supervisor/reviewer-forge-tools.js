// Provides Reviewer-only cached code discovery with path, budget, and audit governance.
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { ConfigurationError } from "../../shared/errors.js";
import { assertRoleFileAccess } from "../../infrastructure/filesystem/file-service-role-policy.js";
import { createReadFileTool } from "../../tools/agent-lifecycle-tools.js";
import { createRgSearchTool } from "../../tools/rg-search.js";
import { createGitReadTools } from "../../tools/git-read-tools.js";
import { createOwnerSearchTreeTool } from "../../tools/owner-search-tree.js";
import { createRgFilesTool } from "../../tools/rg-files.js";
import { engineeringToolDefinitions } from "../../tools/engineering-tool-catalog.js";
import { extractorRegistry } from "../index/parser/index.js";
import { createCommittedReviewWindow } from "./committed-review-window.js";
import { createCommittedReviewSource } from "./reviewer-committed-source.js";
import { createReviewerSnapshotTools } from "./reviewer-snapshot-tools.js";
import { createVerificationReviewSource } from "./ticket-verification-review-source.js";
import { dependencyReadPath, isDependencyPath, readDependencyFile } from "../../infrastructure/filesystem/dependency-read.js";
import { listAgentFileTree } from "../../infrastructure/filesystem/agent-file-tree.js";

const BASE_OUTPUT_BYTES = 128_000;
const PER_FILE_OUTPUT_BYTES = 16_000;
const MAX_OUTPUT_BYTES_CAP = 384_000;
const MAX_RESULT_BYTES = 16_000;
const MAX_FILE_BYTES = 64_000;
const MAX_WINDOW_LINES = 250;
const MAX_FILES = 80;
// Applies the Reviewer role policy and rejects symlink traversal for all review reads.
export async function assertReviewerReadPath(projectRoot, path) {
  if (typeof projectRoot !== "string" || !isAbsolute(projectRoot)) throw toolError("REVIEW_PROJECT_INVALID", "Reviewer project root must be absolute.");
  assertRoleFileAccess("reviewer", "read", path);
  if (isDependencyPath(path)) { dependencyReadPath(projectRoot, path); return; }
  let current = resolve(projectRoot);
  for (const part of path.split("/")) {
    current = resolve(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) { if (error.code === "ENOENT") break; throw error; }
    if (info.isSymbolicLink()) throw toolError("FILE_ROLE_FORBIDDEN", "Reviewer path contains a symbolic link.");
  }
}

// Creates per-review wrappers around existing read_file, search_tree, review_diff, and run_review_check implementations.
export function createReviewerForgeTools({ fileService, projectRoot, job, reviewer, codeCache, gitService, ticketEvidence, projectLogger = () => {} }) {
  if (typeof fileService?.readForIndex !== "function" || !isAbsolute(projectRoot ?? "")) throw new ConfigurationError("Reviewer Forge tools require File Service and an absolute project root.");
  if (ticketEvidence && !fileService.committedReview) fileService = createVerificationReviewSource({ projectRoot,
    source: createCommittedReviewSource({ projectRoot, commit: ticketEvidence.context.review_commit_sha, baseCommit: ticketEvidence.context.base_sha }),
    getArtifact: async () => ticketEvidence.artifact, getTicketPaths: async () => ticketEvidence.paths ?? ticketEvidence.files.map((file) => file.path) });
  const snapshot = fileService.committedReview === true;
  if (snapshot && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(fileService.reviewCommit ?? "")) throw toolError("REVIEW_REVISION_INVALID", "Snapshot discovery requires a fixed review commit SHA.");
  if (snapshot && ticketEvidence && fileService.reviewCommit !== ticketEvidence.context.review_commit_sha) throw toolError("REVIEW_REVISION_INVALID", "Snapshot source does not match the review revision.");
  const manifestCount = Math.max(ticketEvidence?.paths?.length ?? 0, job?.payload?.changed_paths?.length ?? 0);
  const maxOutputBytes = Math.min(MAX_OUTPUT_BYTES_CAP, BASE_OUTPUT_BYTES + manifestCount * PER_FILE_OUTPUT_BYTES);
  const scopedFiles = {
    readForIndex: async (input) => { if (snapshot) { assertRoleFileAccess("reviewer", "read", input?.path); return fileService.readForIndex({ ...input, maxBytes: MAX_FILE_BYTES }); }
      await assertReviewerReadPath(projectRoot, input?.path); return isDependencyPath(input?.path)
      ? readDependencyFile({ ...input, projectRoot, maxBytes: MAX_FILE_BYTES }) : fileService.readForIndex({ ...input, maxBytes: MAX_FILE_BYTES }); },
    listFiles: async (input) => filterPaths(await fileService.listFiles(input)),
    listDirectories: async (input) => filterPaths(await fileService.listDirectories(input))
  };
  const reviewCache = ticketEvidence ? { ...(codeCache ?? {}), read: async ({ path }) => {
    const file = ticketEvidence.files.find((item) => item.path === path);
    if (!file || file.deleted) return snapshot ? scopedFiles.readForIndex({ path }) : codeCache?.read ? codeCache.read({ path }) : scopedFiles.readForIndex({ path });
    const live = await verifiedReviewFile(file, ticketEvidence, fileService, projectRoot);
    let cached = null;
    try { if (!snapshot && codeCache?.read) cached = await codeCache.read({ path }); }
    catch (error) { projectLogger({ event_name: "review.cache_unavailable", level: "warn", status: "failed", message: "Reviewer cache read failed; using verified source.", error_code: error.code ?? "CACHE_READ_FAILED" }); }
    const symbols = cached?.sha256 === file.sha256 && Array.isArray(cached.code_index?.symbols) && cached.code_index.symbols.length
      ? cached.code_index.symbols
      : extractorRegistry.extract(path, file.content).symbols;
    const indexStatus = cached?.sha256 === file.sha256 && cached.index_status && cached.index_status !== "unavailable" ? cached.index_status : "extracted";
    return { ...live, ...(cached ?? {}), content: file.content, sha256: file.sha256, content_sha256: file.sha256, size_bytes: Buffer.byteLength(file.content),
      cache: { status: "bypass", cached_at: null, expires_at: null }, index_status: indexStatus,
      code_index: { ...(cached?.code_index ?? {}), path, symbols }, code_graph: cached?.sha256 === file.sha256 ? cached.code_graph ?? {} : {} };
  } } : snapshot ? { read: (input) => scopedFiles.readForIndex(input) } : codeCache;
  // Review discovery covers project source and instructions; the delta is not a read permission boundary.
  const toolContext = { task_id: job.task_id, correlation_id: job.correlation_id, request_id: job.request_id, agent_identity: { agent_id: reviewer.agent_id, role: "reviewer", provider: reviewer.provider }, capabilities: ["search_tree", "list_files", "search_text", "read_file", "read_lines", "git_status", "git_diff", "review_diff", "run_review_check"], project_root: projectRoot };
  // Keeps text search under the same project, protected-path and symlink rules as direct reads.
  const searchCache = { read: async ({ path }) => {
    return scopedFiles.readForIndex({ path });
  } };
  const implementations = {
    read_file: createReadFileTool({ fileService: scopedFiles, codeCache: reviewCache, projectRoot, ...(snapshot ? { dependencyReader: (input) => scopedFiles.readForIndex(input) } : {}), maxChars: MAX_RESULT_BYTES }),
    search_text: createRgSearchTool({ projectRoot, codeCache: searchCache, toolName: "search_text", logger: { emit: projectLogger } }),
    ...(!snapshot && gitService?.status && gitService?.diffWorkingTree ? createGitReadTools({ gitService, logger: { emit: projectLogger } }) : {}),
    list_files: createRgFilesTool({ projectRoot, toolName: "list_files", logger: { emit: projectLogger } }),
    read_lines: createCommittedReviewWindow(scopedFiles, "read_lines"),
    ...(ticketEvidence?.context?.review_commit_sha && ticketEvidence?.context?.base_sha ? {
      review_diff: createReviewDiffTool({ projectRoot, ticketEvidence, job }),
      run_review_check: createRunReviewCheckTool()
    } : {})
  };
  if (snapshot) Object.assign(implementations, createReviewerSnapshotTools({ source: fileService, projectRoot }));
  if (typeof fileService.listFiles === "function" && typeof fileService.listDirectories === "function") implementations.search_tree = createOwnerSearchTreeTool({ fileService: scopedFiles });
  const extraDefinitions = [reviewDiffDefinition, runReviewCheckDefinition].filter(({ name }) => typeof implementations[name]?.execute === "function");
  const definitions = [...engineeringToolDefinitions().filter(({ name }) => typeof implementations[name]?.execute === "function"), ...extraDefinitions];
  const context = { ...toolContext, capabilities: definitions.map(({ name }) => name), max_output_bytes: maxOutputBytes };
  let outputBytes = 0;
  const registry = Object.fromEntries(definitions.map(({ name }) => [name, { execute: async (input) => {
    const started = Date.now();
    try {
      if (name === "read_file") validateReadInput(input);
      if (["read_file", "read_lines", "review_diff"].includes(name) && typeof input?.path === "string") {
        if (snapshot) assertRoleFileAccess("reviewer", "read", input.path); else await assertReviewerReadPath(projectRoot, input.path);
      }
      const toolInput = name === "search_tree" ? boundedTreeInput(input) : input;
      if (snapshot && name === "search_tree" && isDependencyPath(toolInput.path)) throw toolError("REVIEW_DEPENDENCY_EVIDENCE_MISSING", "Snapshot dependency discovery requires recorded environment evidence.");
      // The shared read_file discovery state is Coder-oriented; each Reviewer read is independent.
      let readContext = { ...context };
      if (["git_status", "git_diff"].includes(name)) {
        const paths = ticketEvidence?.paths ?? job.payload?.changed_paths ?? [];
        for (const path of paths) await assertReviewerReadPath(projectRoot, path);
        readContext = { ...context, allowed_file_paths: paths, allowed_prefixes: [] };
      }
      let result = name === "search_tree" && isDependencyPath(toolInput?.path)
        ? await listAgentFileTree({ projectRoot, path: toolInput.path, maxDepth: toolInput.max_depth ?? 3, limit: toolInput.limit ?? 200, assertReadPath: (path) => assertReviewerReadPath(projectRoot, path) })
        : await implementations[name].execute(toolInput, readContext);
      if (name === "list_files") {
        const paths = await filterPaths(result.stdout.split("\n").filter(Boolean));
        result = { ...result, stdout: paths.length ? `${paths.join("\n")}\n` : "" };
      }
      const verified = await bindReviewEvidence(name, toolInput, result, ticketEvidence, fileService, projectRoot);
      const verifiedResult = snapshot ? { ...verified, review_source: { commit_sha: fileService.reviewCommit,
        ...(ticketEvidence?.artifact.environment ? { environment: ticketEvidence.artifact.environment } : {}) } } : verified;
      const bytes = Buffer.byteLength(JSON.stringify(verifiedResult), "utf8");
      if (bytes > MAX_RESULT_BYTES || outputBytes + bytes > maxOutputBytes) throw toolError("REVIEW_TOOL_BUDGET", "Reviewer read output budget exceeded.");
      outputBytes += bytes;
      audit(name, "success", { duration_ms: Date.now() - started, output_bytes: bytes, ...(verifiedResult.review_evidence ? { review_evidence: verifiedResult.review_evidence } : {}) });
      return verifiedResult;
    } catch (error) {
      audit(name, "failed", { duration_ms: Date.now() - started,
        error: { code: error.code ?? "REVIEW_TOOL_FAILED", message: error.message ?? "Reviewer Forge tool failed.", retryable: false, scope: "reviewer-forge-tools", requestId: job.request_id } });
      throw error;
    }
  } }]));
  return { definitions, registry, context };

  // Removes protected and symlinked paths from directory discovery.
  async function filterPaths(paths) {
    const safe = [];
    for (const path of paths) {
      if (isDependencyPath(path)) continue;
      try { if (snapshot) assertRoleFileAccess("reviewer", "read", path); else await assertReviewerReadPath(projectRoot, path); safe.push(path); }
      catch (error) { if (error.code !== "FILE_ROLE_FORBIDDEN") throw error; }
    }
    return safe;
  }

  // Records Reviewer tool use without saving input paths, queries, or source text.
  function audit(tool, status, payload) {
    projectLogger({ event_name: "review.tool_call", level: status === "failed" ? "error" : "info", status, message: `Reviewer Forge tool ${tool} ${status}.`, task_id: job.task_id, correlation_id: job.correlation_id, source: "reviewer-forge-tools", payload: { request_id: job.request_id, agent_id: reviewer.agent_id, agent_name: reviewer.agent_name, reviewer_id: reviewer.agent_id, tool, ...payload } });
  }
}

// Binds a canonical source window to the verified artifact after checking live source integrity.
async function bindReviewEvidence(name, input, result, ticketEvidence, fileService, projectRoot) {
  if (!ticketEvidence || !["read_lines", "read_file"].includes(name)) return result;
  const path = input.path;
  const file = ticketEvidence.files.find((item) => item.path === path);
  if (!file || file.deleted) {
    if (!fileService.committedReview) throw toolError("REVIEW_SOURCE_MISMATCH", "Source outside ticket evidence requires a pinned snapshot.");
    const source = await fileService.readForIndex({ path, maxBytes: MAX_FILE_BYTES });
    return { ...result, sha256: source.sha256, review_evidence: { artifact_id: ticketEvidence.artifact.artifact_id,
      commit_sha: ticketEvidence.context.review_commit_sha, manifest_sha: ticketEvidence.context.manifest_sha, sha256: source.sha256,
      source: source.source ?? "review_commit", ...(source.source === "verification_environment" ? { environment: ticketEvidence.artifact.environment } : {}) } };
  }
  await verifiedReviewFile(file, ticketEvidence, fileService, projectRoot);
  let source = {};
  if (name === "read_file" && typeof result.content === "string") {
    source = { content: canonicalReviewWindow(file.content, result.offset, result.offset + result.limit - 1, false, input.offset === undefined ? 250 : MAX_WINDOW_LINES, false) };
  } else if (name === "read_lines") {
    source = { stdout: canonicalReviewWindow(file.content, input.start_line, input.end_line, false) };
  }
  return { ...result, ...source, sha256: file.sha256, total_lines: file.content.split("\n").length, ...(name === "read_file" ? { content_sha256: file.sha256, size_bytes: Buffer.byteLength(file.content) } : {}), review_evidence: { artifact_id: ticketEvidence.artifact.artifact_id, commit_sha: ticketEvidence.context.review_commit_sha, manifest_sha: ticketEvidence.context.manifest_sha, sha256: file.sha256 } };
}

// Verifies artifact bytes against the current file before a Reviewer sees ticket source.
async function verifiedReviewFile(file, evidence, fileService, projectRoot) {
  if (fileService.committedReview) assertRoleFileAccess("reviewer", "read", file.path); else await assertReviewerReadPath(projectRoot, file.path);
  let live;
  try { live = await fileService.readForIndex({ path: file.path, maxBytes: MAX_FILE_BYTES }); }
  catch (error) { throw Object.assign(toolError("REVIEW_SOURCE_MISMATCH", `Reviewer source could not be verified: ${file.path}.`), { cause: error }); }
  const hash = (content) => typeof content === "string" ? `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}` : null;
  if (hash(live?.content) !== file.sha256 || hash(file.content) !== file.sha256 || evidence.artifact.file_checksums[file.path] !== file.sha256) throw toolError("REVIEW_SOURCE_MISMATCH", `Reviewer source differs from verified commit: ${file.path}.`);
  return live;
}

// Formats committed source with the exact line boundaries used by Reviewer tools.
function canonicalReviewWindow(content, start, end, numbered, maxLines = MAX_WINDOW_LINES, trailingNewline = true) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start + 1 > maxLines) throw toolError("REVIEW_TOOL_INPUT", "Reviewer source window exceeds its line limit.");
  const lines = content.split("\n");
  const selected = lines.slice(start - 1, end);
  return numbered ? selected.map((line, index) => `${String(start + index).padStart(6)}→${line}`).join("\n") : selected.join("\n") + (trailingNewline && start <= lines.length ? "\n" : "");
}

// Bounds existing read_file windows while allowing live symbol resolution.
function validateReadInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.path !== "string") throw toolError("REVIEW_TOOL_INPUT", "Reviewer read_file requires a path.");
  if (input.offset !== undefined || input.limit !== undefined) {
    if (!Number.isInteger(input.offset) || input.offset < 1 || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_WINDOW_LINES) throw toolError("REVIEW_TOOL_INPUT", "Reviewer read_file window must contain at most 250 lines.");
  }
}

// Caps the existing search_tree result count for Reviewer discovery.
function boundedTreeInput(input) {
  if (input?.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_FILES)) throw toolError("REVIEW_TOOL_INPUT", "Reviewer search_tree limit must be at most 80 entries.");
  return { ...(input ?? {}), limit: input?.limit ?? MAX_FILES };
}

// Produces a bounded per-file diff between base_sha (or previous_review_commit) and review_commit_sha.
function createReviewDiffTool({ projectRoot, ticketEvidence, job }) {
  return { execute: async (input = {}) => {
    if (!input || typeof input !== "object" || typeof input.path !== "string" || !input.path.trim()) throw toolError("REVIEW_TOOL_INPUT", "review_diff requires a file path.");
    const base = input.base === "previous_review" && job?.payload?.previous_review_commit ? job.payload.previous_review_commit : ticketEvidence.context.base_sha;
    const commit = ticketEvidence.context.review_commit_sha;
    const patch = await createCommittedReviewSource({ projectRoot, commit, baseCommit: base }).diffPatchFrom(base, { paths: [input.path] });
    return { path: input.path, base_commit: base, commit_sha: commit, patch: patch.slice(0, MAX_RESULT_BYTES - 1024),
      review_evidence: { artifact_id: ticketEvidence.artifact.artifact_id, commit_sha: commit, manifest_sha: ticketEvidence.context.manifest_sha } };
  } };
}

// Keeps the diagnostic tool fail-closed until a real subprocess boundary can enforce the
// artifact's recorded environment; an archive and post-run checks do not provide isolation.
function createRunReviewCheckTool() {
  return { execute: async () => {
    throw toolError("REVIEW_CHECK_ISOLATION_UNSUPPORTED", "Reviewer checks are unavailable until subprocess isolation and recorded source, dependency and toolchain provenance are enforced. Do not substitute native shell or live dependencies.");
  } };
}

const reviewDiffDefinition = Object.freeze({ name: "review_diff", description: "Read the committed diff for one file between base_sha (or previous_review_commit) and review_commit_sha.", input_schema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string", minLength: 1 }, base: { type: "string", enum: ["base_sha", "previous_review"] } } } });
const runReviewCheckDefinition = Object.freeze({ name: "run_review_check", description: "Currently unavailable: returns REVIEW_CHECK_ISOLATION_UNSUPPORTED, never a verification pass. Do not fall back to native commands.", input_schema: { type: "object", additionalProperties: false, required: ["type", "command"], properties: { type: { type: "string", enum: ["test", "lint", "typecheck"] }, command: { type: "string", minLength: 1, maxLength: 1000 } } } });

// Marks Reviewer policy failures with stable codes for SDK adapters.
function toolError(code, message) { return Object.assign(new ConfigurationError(message), { code }); }
