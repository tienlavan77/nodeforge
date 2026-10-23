// Binds the shared Forge contract to Node-issued ticket authority without borrowing owner permissions or ledgers.
import Ajv2020 from "ajv/dist/2020.js";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { ConfigurationError } from "../shared/errors.js";
import { authorizeTool, isAgentPathAllowed } from "./tool-authorization.js";
import { assertExecutionFileAccess } from "./execution-file-access.js";
import { assertCoderWorkflowReadOnly, assertRoleFileAccess } from "../infrastructure/filesystem/file-service-role-policy.js";
import { ENGINEERING_CATALOG_VERSION, coderToolDefinitions, engineeringToolDefinitions, engineeringToolReadiness } from "./engineering-tool-catalog.js";

// Advertises locked tools explicitly and validates every call against the same schema before scoped dispatch.
export function bindEngineeringTools({ registry, context }) {
  if (!registry || !context?.task_id || !context?.execution_id || !context?.project_root || !context?.agent_identity?.agent_id || context.agent_identity.role !== "coder") throw failure("TOOL_SCOPE_INVALID", "Engineering binding requires a Node-issued Coder execution context.");
  if (!Array.isArray(context.allowed_file_paths) && !Array.isArray(context.allowed_prefixes)) throw failure("TOOL_SCOPE_INVALID", "Engineering binding requires an explicit file or prefix scope.");
  if (context.project_wide_access === true) throw failure("TOOL_SCOPE_INVALID", "Coder engineering binding cannot enable project-wide access.");
  assertExecutionFileAccess(context);
  if (context.file_access_version === 2 && context.agent_identity.provider === "codex") throw failure("FILE_ACCESS_PROVIDER_UNSUPPORTED", "Versioned ticket file access requires disabling native filesystem tools; Codex CLI ticket execution is not admitted.");
  const bound = { ...context, engineering_catalog_version: ENGINEERING_CATALOG_VERSION };
  for (const key of ["task_id", "execution_id", "project_root", "agent_identity", "capabilities", "allowed_file_paths", "allowed_prefixes"]) {
    const value = context[key];
    Object.defineProperty(bound, key, { value: value && typeof value === "object" ? Object.freeze(structuredClone(value)) : value, enumerable: true, configurable: false, writable: false });
  }
  for (const key of ["file_access_policy", "file_access_version"]) Object.defineProperty(bound, key, { value: context[key], enumerable: true, writable: false, configurable: false });
  const manifest = structuredClone(context.execution_context?.approved_baseline?.file_checksums);
  const mutablePaths = manifest ? new Set(Object.keys(manifest)) : null;
  const createPrefixes = structuredClone(context.execution_context?.approved_baseline?.authorized_create_prefixes
    ?? context.authorized_create_prefixes
    ?? []);
  const mutableFileBudget = context.execution_context?.approved_baseline?.mutable_file_budget
    ?? context.mutable_file_budget
    ?? null;
  const definitions = coderToolDefinitions();
  const scopedRegistry = { ...registry };
  for (const definition of engineeringToolDefinitions()) if (typeof scopedRegistry[definition.name]?.execute !== "function") scopedRegistry[definition.name] = lockedTool(definition.name, "A compatible scoped Node service is unavailable for this execution.");
  const ajv = new Ajv2020({ strict: false, allErrors: true, coerceTypes: false, removeAdditional: false });
  const validators = new Map(definitions.map((definition) => [definition.name, (definition.input_schema.$id && ajv.getSchema(definition.input_schema.$id)) || ajv.compile(definition.input_schema)]));
  const readiness = engineeringToolReadiness({ capabilities: bound.capabilities, registry,
    lockedReasons: bound.file_access_version === 2 ? { run_check: "Versioned file access is not yet certified for verification subprocesses." } : {} });
  const locked = new Map(readiness.tools.filter((tool) => tool.state === "locked").map((tool) => [tool.name, tool.reason]));
  const implementations = Object.fromEntries(definitions.map((definition) => [definition.name, { execute: async (input = {}) => {
    const validate = validators.get(definition.name);
    if (!validate(input)) throw failure("TOOL_INPUT_INVALID", `Invalid ${definition.name} arguments.`, validate.errors);
    if (locked.has(definition.name) || typeof scopedRegistry[definition.name]?.execute !== "function") throw failure("TOOL_LOCKED", locked.get(definition.name) ?? "A compatible execution-scoped service is unavailable.");
    authorizeTool(definition.name, bound);
    if (["read_file", "read_lines", "write_diff", "edit_diff"].includes(definition.name)) {
      const isWrite = ["write_diff", "edit_diff"].includes(definition.name);
      await assertPath(input.path, bound, isWrite ? "write" : "read");
      if (isWrite) {
        assertCoderWorkflowReadOnly(bound.agent_identity?.role, "write", input.path);
        const inCreatePrefix = Array.isArray(createPrefixes) && createPrefixes.some((prefix) => {
          const clean = String(prefix).replace(/\/+$/, "");
          return clean && (input.path === clean || input.path.startsWith(`${clean}/`));
        });
        if (mutablePaths && !mutablePaths.has(input.path) && !inCreatePrefix) throw failure("PATH_FORBIDDEN", "Write path is outside the immutable approved manifest.");
        if (Number.isInteger(mutableFileBudget) && mutableFileBudget > 0) {
          const tracked = new Set([...(mutablePaths ?? []), ...(bound.changed_paths ?? []), input.path]);
          if (tracked.size > mutableFileBudget) throw failure("PATH_FORBIDDEN", "Write path exceeds the ticket mutable file budget.");
        }
      }
    }
    const result = await scopedRegistry[definition.name].execute(input, bound);
    assertExecutionFileAccess(bound);
    return result;
  } }]));
  return { definitions, registry: implementations, context: bound, readiness };
}

// Rejects private, out-of-scope and symlinked file paths before ticket reads or mutations.
async function assertPath(path, context, operation = "read") {
  assertRoleFileAccess(context.agent_identity?.role, "read", path);
  const effectiveContext = operation === "write" && Array.isArray(context.authorized_create_prefixes) && context.authorized_create_prefixes.length
    ? { ...context, allowed_prefixes: [...(context.allowed_prefixes ?? []), ...context.authorized_create_prefixes] }
    : context;
  if (!isAgentPathAllowed(path, effectiveContext, { operation })) throw failure("PATH_FORBIDDEN", "Path is outside the execution scope.");
  let current = resolve(context.project_root);
  for (const part of path.split("/")) {
    current = resolve(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) { if (error.code === "ENOENT") break; throw error; }
    if (info.isSymbolicLink()) throw failure("PATH_FORBIDDEN", "Engineering file path contains a symbolic link.");
  }
}

// Returns stable errors without upgrading a missing service or grant into provider fallback.
function failure(code, message, details) {
  return Object.assign(new ConfigurationError(message), { code, ...(details ? { details } : {}) });
}

// Keeps locked canonical operations visible to providers with an explicit refusal reason.
function lockedTool(name, reason) {
  return Object.freeze({ execute: async () => { throw failure("TOOL_LOCKED", `${name} is locked: ${reason}`); } });
}
