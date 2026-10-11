// Binds the shared Forge contract to Node-issued ticket authority without borrowing owner permissions or ledgers.
import Ajv2020 from "ajv/dist/2020.js";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { ConfigurationError } from "../shared/errors.js";
import { authorizeTool, isAgentPathAllowed } from "./tool-authorization.js";
import { assertCoderWorkflowReadOnly, assertRoleFileAccess } from "../infrastructure/filesystem/file-service-role-policy.js";
import { ENGINEERING_CATALOG_VERSION, engineeringToolDefinitions, engineeringToolReadiness } from "./engineering-tool-catalog.js";
import { searchCodeDefinition, runTestDefinition, checkTestDefinition, reportDoneDefinition, respondToReviewDefinition } from "./index.js";
import { rgFilesDefinition, rgSearchDefinition, sedLinesDefinition } from "./agent-command-tools.js";

// Advertises locked tools explicitly and validates every call against the same schema before scoped dispatch.
export function bindEngineeringTools({ registry, context }) {
  if (!registry || !context?.task_id || !context?.execution_id || !context?.project_root || !context?.agent_identity?.agent_id || context.agent_identity.role !== "coder") throw failure("TOOL_SCOPE_INVALID", "Engineering binding requires a Node-issued Coder execution context.");
  if (!Array.isArray(context.allowed_file_paths) && !Array.isArray(context.allowed_prefixes)) throw failure("TOOL_SCOPE_INVALID", "Engineering binding requires an explicit file or prefix scope.");
  if (context.project_wide_access === true) throw failure("TOOL_SCOPE_INVALID", "Coder engineering binding cannot enable project-wide access.");
  const bound = { ...context, engineering_catalog_version: ENGINEERING_CATALOG_VERSION };
  for (const key of ["task_id", "execution_id", "project_root", "agent_identity", "capabilities", "allowed_file_paths", "allowed_prefixes"]) {
    const value = context[key];
    Object.defineProperty(bound, key, { value: value && typeof value === "object" ? Object.freeze(structuredClone(value)) : value, enumerable: true, configurable: false, writable: false });
  }
  const manifest = context.execution_context?.approved_baseline?.file_checksums;
  const mutablePaths = manifest ? new Set(Object.keys(manifest)) : null;
  const definitions = [...engineeringToolDefinitions(), searchCodeDefinition, runTestDefinition, checkTestDefinition, reportDoneDefinition, respondToReviewDefinition, rgFilesDefinition, rgSearchDefinition, sedLinesDefinition];
  const scopedRegistry = { ...registry };
  for (const definition of engineeringToolDefinitions()) if (typeof scopedRegistry[definition.name]?.execute !== "function") scopedRegistry[definition.name] = lockedTool(definition.name, "A compatible scoped Node service is unavailable for this execution.");
  const ajv = new Ajv2020({ strict: false, allErrors: true, coerceTypes: false, removeAdditional: false });
  const validators = new Map(definitions.map((definition) => [definition.name, (definition.input_schema.$id && ajv.getSchema(definition.input_schema.$id)) || ajv.compile(definition.input_schema)]));
  const readiness = engineeringToolReadiness({ capabilities: bound.capabilities, registry });
  const locked = new Map(readiness.tools.filter((tool) => tool.state === "locked").map((tool) => [tool.name, tool.reason]));
  const implementations = Object.fromEntries(definitions.map((definition) => [definition.name, { execute: async (input = {}) => {
    const validate = validators.get(definition.name);
    if (!validate(input)) throw failure("TOOL_INPUT_INVALID", `Invalid ${definition.name} arguments.`, validate.errors);
    if (locked.has(definition.name) || typeof scopedRegistry[definition.name]?.execute !== "function") throw failure("TOOL_LOCKED", locked.get(definition.name) ?? "A compatible execution-scoped service is unavailable.");
    authorizeTool(definition.name, bound);
    if (["read_file", "read_lines", "write_diff", "edit_diff", "sed_lines"].includes(definition.name)) {
      await assertPath(input.path, bound);
      if (["write_diff", "edit_diff"].includes(definition.name)) {
        assertCoderWorkflowReadOnly(bound.agent_identity?.role, "write", input.path);
        if (mutablePaths && !mutablePaths.has(input.path)) throw failure("PATH_FORBIDDEN", "Write path is outside the immutable approved manifest.");
      }
    }
    return scopedRegistry[definition.name].execute(input, bound);
  } }]));
  return { definitions, registry: implementations, context: bound, readiness };
}

// Rejects private, out-of-scope and symlinked file paths before ticket reads or mutations.
async function assertPath(path, context) {
  assertRoleFileAccess(context.agent_identity?.role, "read", path);
  if (!isAgentPathAllowed(path, context)) throw failure("PATH_FORBIDDEN", "Path is outside the execution scope.");
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
