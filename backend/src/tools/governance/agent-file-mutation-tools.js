// Provides ledger-bound file deletion and dual-endpoint movement tools for supervised Coder executions.
// Enforces whole-file checksum verification, TicketChangeLedger journaling, cache invalidation, and
// occupied-destination refusal without imposing new-file line-budget or summary-header gates on moved files.
import { createHash } from "node:crypto";
import { isProtectedPath } from "../../infrastructure/filesystem/protected-path-policy.js";
import { isDependencyPath } from "../../infrastructure/filesystem/dependency-read.js";
import { assertCoderProjectAccess } from "../../infrastructure/filesystem/file-service-role-policy.js";
import { isAgentPathAllowed } from "./tool-authorization.js";
import { ConfigurationError } from "../../shared/errors.js";
import { resetExploration } from "../discovery/exploration-state.js";

const checksumPattern = /^sha256:[a-fA-F0-9]{64}$/;

// Computes the canonical sha256 checksum string used to verify existing file contents before mutation.
const checksum = (content) => `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;

// Creates a ConfigurationError with a machine-readable code and optional diagnostic metadata.
const error = (code, message, details = {}) => Object.assign(new ConfigurationError(message), { code, details });

// Formats structured checksum diagnostic details when a preflight read or checksum assertion fails.
const checksumDiagnostics = (beforeChecksum, targetExists) => ({
  target_exists: targetExists,
  before_checksum_present: beforeChecksum !== null && beforeChecksum !== undefined,
  before_checksum_format_valid: typeof beforeChecksum === "string" && checksumPattern.test(beforeChecksum)
});

// Validates that a relative path is canonical, non-protected, and outside dependency directories for mutations.
function safeMutationPath(value, operation, role) {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => !part || part === "." || part === "..") || isProtectedPath(value, { operation, role }) || role !== "coder" && isDependencyPath(value)) {
    throw error("PATH_FORBIDDEN", "Path is outside the permitted project scope.");
  }
  return value;
}

// Verifies that the agent's execution context authorizes the requested file mutation path.
function assertMutationAllowed(path, context, operation = "write") {
  const prefixes = context?.execution_context?.approved_baseline?.authorized_create_prefixes ?? context?.authorized_create_prefixes ?? [];
  const effectiveContext = operation === "write" && Array.isArray(prefixes) && prefixes.length
    ? { ...context, allowed_prefixes: [...(context.allowed_prefixes ?? []), ...prefixes] }
    : context;
  if (isAgentPathAllowed(path, effectiveContext, { operation })) return;
  throw error("PATH_FORBIDDEN", `Path is not approved: ${path}`);
}

// Appends a mutated path to the shared execution context so commit_changes and checkpoints stay synchronized.
function recordChangedPath(context, path) {
  if (!context || typeof context !== "object") return;
  const paths = Array.isArray(context.changed_paths) ? context.changed_paths : [];
  if (!paths.includes(path)) paths.push(path);
  context.changed_paths = paths;
}

// Creates the ledger-bound delete_file tool for Coder ticket executions.
// Verifies the source checksum and records a deletion entry (after: null) in TicketChangeLedger.
export function createDeleteFileTool({ fileService, codeCache, changeLedger } = {}) {
  if (typeof fileService?.readFile !== "function" || typeof fileService?.deleteFile !== "function") {
    throw new ConfigurationError("delete_file requires File Service readFile and deleteFile.");
  }
  return Object.freeze({ name: "delete_file", async execute(input = {}, context = {}) {
    if (!changeLedger || typeof changeLedger.write !== "function") {
      throw error("TOOL_LOCKED", "Coder delete_file requires an active TicketChangeLedger.");
    }
    const role = context.agent_identity?.role;
    const path = safeMutationPath(input.path, "delete", role);
    assertCoderProjectAccess(role, "delete", path);
    assertMutationAllowed(path, context, "delete");
    let current;
    try {
      current = await fileService.readFile({ path });
    } catch (cause) {
      if (cause?.code === "ENOENT") throw error("CHECKSUM_MISMATCH", `File does not exist: ${path}.`, checksumDiagnostics(input.before_checksum, false));
      throw error("READ_FAILED", `File could not be read: ${path}`, checksumDiagnostics(input.before_checksum, true));
    }
    const actual = checksum(current);
    if (typeof input.before_checksum !== "string" || input.before_checksum !== actual) {
      throw error("CHECKSUM_MISMATCH", `Checksum mismatch for ${path}.`, checksumDiagnostics(input.before_checksum, true));
    }
    const result = await changeLedger.write({ taskId: context.task_id ?? context.taskId, path, before: current, after: null });
    codeCache?.invalidate({ path });
    recordChangedPath(context, path);
    resetExploration(context);
    return { path, deleted: true, before_sha256: actual, sha256: null, ...(result?.revision !== undefined ? { revision: result.revision } : {}) };
  } });
}

// Creates the ledger-bound move_file tool for Coder ticket executions.
// Preserves moved file contents verbatim without applying 250-line or summary-comment gates, while journaling both paths in TicketChangeLedger.
export function createMoveFileTool({ fileService, codeCache, changeLedger } = {}) {
  if (typeof fileService?.readFile !== "function" || typeof fileService?.atomicWrite !== "function" || typeof fileService?.deleteFile !== "function") {
    throw new ConfigurationError("move_file requires File Service readFile, atomicWrite, and deleteFile.");
  }
  return Object.freeze({ name: "move_file", async execute(input = {}, context = {}) {
    if (!changeLedger || (typeof changeLedger.move !== "function" && typeof changeLedger.write !== "function")) {
      throw error("TOOL_LOCKED", "Coder move_file requires an active TicketChangeLedger.");
    }
    if (typeof input.from_path !== "string" || typeof input.to_path !== "string" || !input.from_path || !input.to_path || input.from_path === input.to_path) {
      throw error("INPUT_INVALID", "move_file requires distinct from_path and to_path strings.");
    }
    const role = context.agent_identity?.role;
    const fromPath = safeMutationPath(input.from_path, "delete", role);
    const toPath = safeMutationPath(input.to_path, "write", role);
    assertCoderProjectAccess(role, "delete", fromPath);
    assertCoderProjectAccess(role, "write", toPath);
    assertMutationAllowed(fromPath, context, "delete");
    assertMutationAllowed(toPath, context, "write");
    let current;
    try {
      current = await fileService.readFile({ path: fromPath });
    } catch (cause) {
      if (cause?.code === "ENOENT") throw error("CHECKSUM_MISMATCH", `Source file does not exist: ${fromPath}.`, checksumDiagnostics(input.before_checksum, false));
      throw error("READ_FAILED", `Source file could not be read: ${fromPath}`, checksumDiagnostics(input.before_checksum, true));
    }
    const actual = checksum(current);
    if (typeof input.before_checksum !== "string" || input.before_checksum !== actual) {
      throw error("CHECKSUM_MISMATCH", `Checksum mismatch for ${fromPath}.`, checksumDiagnostics(input.before_checksum, true));
    }
    let destinationExisting = null;
    try {
      destinationExisting = await fileService.readFile({ path: toPath });
    } catch (cause) {
      if (cause?.code !== "ENOENT") throw error("READ_FAILED", `Destination file could not be inspected: ${toPath}`);
    }
    if (destinationExisting !== null) {
      throw error("FILE_ALREADY_EXISTS", `Destination file already exists: ${toPath}.`);
    }
    const taskId = context.task_id ?? context.taskId;
    const result = typeof changeLedger.move === "function"
      ? await changeLedger.move({ taskId, fromPath, toPath, before: current })
      : await fallbackLedgerMove(changeLedger, { taskId, fromPath, toPath, before: current });
    codeCache?.invalidate({ path: fromPath });
    codeCache?.invalidate({ path: toPath });
    recordChangedPath(context, fromPath);
    recordChangedPath(context, toPath);
    resetExploration(context);
    return { from_path: fromPath, to_path: toPath, sha256: actual, moved: true, ...(result?.revision !== undefined ? { revision: result.revision } : {}) };
  } });
}

// Executes a two-step ledger write fallback when a custom changeLedger wrapper only exposes write().
async function fallbackLedgerMove(changeLedger, { taskId, fromPath, toPath, before }) {
  await changeLedger.write({ taskId, path: toPath, before: null, after: before });
  return changeLedger.write({ taskId, path: fromPath, before, after: null });
}
