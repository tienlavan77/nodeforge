// Separates discovery authority from ticket mutation authority without trusting serialized agent input.
// Node must supply an authoritative policy identity and a live authorization callback; this module
// does not approve a policy, choose revocation timing, or enable a new provider access route.
import { ConfigurationError } from "../shared/errors.js";
import { isAbsolute } from "node:path";
import { assertRoleFileAccess } from "../infrastructure/filesystem/file-service-role-policy.js";

// Retains private Node provenance without serializing executable authority into resumable agent data.
const issued = new WeakMap();
// Reserves standard instruction files for governance even when a ticket lists them as mutable paths.
const GOVERNANCE_FILES = new Set(["AGENTS.md", "CLAUDE.md", "ARCHITECTURE.md"]);

// Issues an execution-local grant from trusted Node configuration, not ticket text or checkpoints.
// Serialized copies intentionally lose provenance and must be reconciled by Node before execution.
export function issueExecutionFileAccess({ context, readPaths = [], readPrefixes = [], policyIdentity, authorizeCurrent, authorizeDocsWrite, authorizeResume }) {
  if (!context?.task_id || !context.execution_id || !isAbsolute(context.project_root ?? "") || !context.agent_identity?.agent_id
    || !["coder", "reviewer"].includes(context.agent_identity.role)
    || typeof policyIdentity?.id !== "string" || !policyIdentity.id || typeof policyIdentity.revision !== "string" || !policyIdentity.revision || !/^sha256:[a-f0-9]{64}$/.test(policyIdentity.sha256 ?? "")
    || typeof authorizeCurrent !== "function") throw failure("Node file access requires execution identity, policy provenance and a current-authority resolver.");
  if (context.resume_checkpoint && (typeof authorizeResume !== "function"
    || authorizeResume({ task_id: context.task_id, execution_id: context.execution_id, policy: policyIdentity }) !== true)) throw failure("Resume requires Node reconciliation of checkpoint provenance and current authority.");
  const grant = Object.freeze({ version: 2, policy: Object.freeze({ id: policyIdentity.id, revision: policyIdentity.revision, sha256: policyIdentity.sha256 }),
    read_paths: scope(readPaths), read_prefixes: scope(readPrefixes),
    write_paths: scope(context.allowed_file_paths ?? []), write_prefixes: scope([...(context.allowed_prefixes ?? []),
      ...(context.execution_context?.approved_baseline?.authorized_create_prefixes ?? context.authorized_create_prefixes ?? [])]) });
  issued.set(grant, { task_id: context.task_id, execution_id: context.execution_id, project_root: context.project_root,
    agent_id: context.agent_identity.agent_id, role: context.agent_identity.role, authorizeCurrent, authorizeDocsWrite });
  assertExecutionFileAccess({ ...context, file_access_policy: grant, file_access_version: 2 });
  return grant;
}

// Rejects unknown, copied, revoked or cross-execution grants before any tool runs, including cache hits.
// Legacy callers without a version retain their existing scoped policy and receive no new read grant.
export function assertExecutionFileAccess(context) {
  if (context.file_access_version === undefined && context.file_access_policy === undefined) return;
  const grant = context.file_access_policy;
  const record = grant && issued.get(grant);
  if (context.file_access_version !== 2 || !record || record.task_id !== context.task_id || record.execution_id !== context.execution_id
    || record.project_root !== context.project_root || record.agent_id !== context.agent_identity?.agent_id || record.role !== context.agent_identity?.role) throw failure("File access grant has no valid Node provenance for this execution.");
  if (record.authorizeCurrent({ task_id: record.task_id, execution_id: record.execution_id, agent_id: record.agent_id, role: record.role, policy: grant.policy }) !== true) throw failure("File access authority is unavailable, revoked or requires reconciliation.");
}

// Applies role protection before the independent read/write allowlists; null delegates only to legacy policy.
// Documentation writes require Node classification in addition to an exact write grant.
export function executionFileAccessAllowed(path, context, operation = "read") {
  if (context.file_access_version === undefined && context.file_access_policy === undefined) return null;
  assertExecutionFileAccess(context);
  if (!["read", "write"].includes(operation) || !canonical(path)) return false;
  try { assertRoleFileAccess(context.agent_identity.role, "read", path); }
  catch (error) { if (error.code === "FILE_ROLE_FORBIDDEN") return false; throw error; }
  const grant = context.file_access_policy;
  if (operation === "read") return contains(path, grant.read_paths, grant.read_prefixes);
  if (context.agent_identity.role !== "coder" || path.startsWith("workflows/") || path === "workflows"
    || path === "vocabulary/glossary.md" || path.split("/").some((part) => GOVERNANCE_FILES.has(part))
    || path.split("/").includes("node_modules")) return false;
  if (path === "docs" || path.startsWith("docs/")) {
    const classifier = issued.get(grant).authorizeDocsWrite;
    if (!grant.write_paths.includes(path) || typeof classifier !== "function"
      || classifier({ path, policy: grant.policy, task_id: context.task_id, execution_id: context.execution_id }) !== true) return false;
  }
  return contains(path, grant.write_paths, grant.write_prefixes);
}

// Exposes only validated discovery scopes so tree/index consumers cannot borrow mutation prefixes.
export function executionReadScope(context) {
  assertExecutionFileAccess(context);
  return context.file_access_version === 2
    ? { paths: context.file_access_policy.read_paths, prefixes: context.file_access_policy.read_prefixes }
    : { paths: context.allowed_file_paths ?? [], prefixes: context.allowed_prefixes ?? [] };
}

// Copies and normalizes trusted scope entries so later caller mutations cannot expand an issued grant.
function scope(entries) {
  if (!Array.isArray(entries)) throw failure("File access scope must be an explicit array.");
  const normalized = entries.map((entry) => typeof entry === "string" ? entry.replace(/\/$/, "") : entry);
  if (normalized.some((entry) => !canonical(entry))) throw failure("File access scope contains a non-canonical path.");
  return Object.freeze([...new Set(normalized)]);
}

// Rejects path aliases before prefix matching to prevent traversal from impersonating an authorized path.
function canonical(path) {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.includes("\\")
    && [...path].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    && path.split("/").every((part) => part && part !== "." && part !== "..");
}

// Matches complete path components, never a sibling whose name only starts with the same prefix.
function contains(path, paths, prefixes) {
  return paths.includes(path) || prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

// Reports missing authority without returning file contents, secrets or an implicit broader fallback.
function failure(message) {
  return Object.assign(new ConfigurationError(message), { code: "FILE_ACCESS_POLICY_INVALID" });
}
