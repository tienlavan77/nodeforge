// Grants owner conversation tools using the same Forge registry contracts as SDK execution.
import { authorizeTool } from "./tool-authorization.js";
import { ownerRoleTools, ownerWritePaths, authorizeOwnerTool } from "./owner-role-tool-policy.js";
import { createAgentCommandTools } from "./agent-command-tools.js";
import { createReadFileTool, createWriteDiffTool, createEditDiffTool } from "./agent-lifecycle-tools.js";
import { rgFilesDefinition, rgSearchDefinition, sedLinesDefinition } from "./agent-command-tools.js";
import { readFileDefinition, writeDiffDefinition, editDiffDefinition } from "./index.js";
import { createOwnerSearchTreeTool, ownerSearchTreeDefinition } from "./owner-search-tree.js";
import { createRoleFileService } from "../infrastructure/filesystem/file-service-role-policy.js";
import { createOwnerDeleteFileTool, ownerDeleteFileDefinition } from "./owner-delete-file.js";
import { createGitReadTools } from "./git-read-tools.js";

const OWNER_GIT_READ_DEFINITIONS = Object.freeze(["git_status", "git_diff"].map((name) => ({ name, description: name === "git_status" ? "Read the project Git working-tree status." : "Read the project Git diff.", input_schema: { type: "object", properties: {}, additionalProperties: false } })));

// Creates the role-scoped Forge tool registry used by owner SDK conversations.
export function createOwnerConversationTools({ role, projectRoot, fileService, codeCache, codeSearch, gitService, projectLogger, context }) {
  const allowed = ownerRoleTools(role);
  const scopedFiles = createRoleFileService({ fileService, role, projectRoot });
  const scopedCache = codeCache && { ...codeCache, read: async ({ path }) => { await scopedFiles.assertReadPath(path); return codeCache.read({ path }); } };
  const base = createAgentCommandTools({ projectRoot, fileService: scopedFiles, codeSearch, codeCache: scopedCache, projectLogger, wrap: (tool) => tool });
  const implementations = {
    ...base,
    search_tree: createOwnerSearchTreeTool({ fileService: scopedFiles }),
    read_file: createReadFileTool({ fileService: scopedFiles, codeCache: scopedCache, symbolLookup: codeSearch?.symbolsForFile?.bind(codeSearch) }),
    write_diff: createWriteDiffTool({ fileService: scopedFiles, codeCache }),
    edit_diff: createEditDiffTool({ fileService: scopedFiles, codeCache }),
    delete_file: createOwnerDeleteFileTool({ fileService: scopedFiles, codeCache: scopedCache })
  };
  if (role === "system_engineer" && gitService?.status && gitService?.diffWorkingTree) Object.assign(implementations, createGitReadTools({ gitService, logger: { emit: projectLogger } }));
  const definitions = [ownerSearchTreeDefinition, rgFilesDefinition, rgSearchDefinition, sedLinesDefinition, readFileDefinition, writeDiffDefinition, editDiffDefinition, ownerDeleteFileDefinition]
    .concat(role === "system_engineer" && gitService?.status && gitService?.diffWorkingTree ? OWNER_GIT_READ_DEFINITIONS : [])
    .filter(({ name }) => allowed.includes(name) && typeof implementations[name]?.execute === "function");
  const registry = Object.fromEntries(definitions.map((definition) => [definition.name, { execute: async (input, toolContext = context) => {
    const log = (status, error, result) => projectLogger?.({ timestamp: new Date().toISOString(), event_name: "owner.tool_call", level: error ? "error" : "info", status, message: `Owner Forge tool ${definition.name} ${status}.`, task_id: toolContext.task_id, correlation_id: toolContext.correlation_id, source: "owner-conversation-tools", ...(error ? { error_code: error.code ?? "TOOL_EXECUTION_FAILED" } : {}), payload: { tool: definition.name, agent_id: toolContext.agent_identity?.agent_id, agent_name: toolContext.agent_identity?.agent_name, provider: toolContext.agent_identity?.provider, ...(error ? { error_message: String(error.message ?? "").slice(0, 240), input_keys: Object.keys(input ?? {}), offset: Number.isInteger(input?.offset) ? input.offset : null, limit: Number.isInteger(input?.limit) ? input.limit : null, symbol_state: input?.symbol == null ? "absent" : input.symbol === "" ? "empty" : "named" } : {}), ...(result ? { result: summarizeResult(result) } : {}) } });
    try {
      log("started");
      authorizeTool(definition.name, toolContext);
      await authorizeOwnerTool(definition.name, input, toolContext, projectRoot);
      const result = await implementations[definition.name].execute(input, toolContext);
      log("success", null, result);
      return result;
    } catch (error) { log("failed", error); throw error; }
  } }]));
  return { definitions, registry };
}

export { ownerWritePaths };

// Records result size and status without persisting project source text or search queries.
function summarizeResult(result) {
  if (!result || typeof result !== "object") return { returned: result !== undefined };
  return { ...(Array.isArray(result.files) ? { files: result.files.length } : {}), ...(Array.isArray(result.matches) ? { matches: result.matches.length } : {}), ...(typeof result.total === "number" ? { total: result.total } : {}), ...(typeof result.total_lines === "number" ? { total_lines: result.total_lines } : {}), ...(typeof result.truncated === "boolean" ? { truncated: result.truncated } : {}), ...(typeof result.exit_code === "number" ? { exit_code: result.exit_code } : {}) };
}
