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

// Creates the role-scoped Forge tool registry used by owner SDK conversations.
export function createOwnerConversationTools({ role, projectRoot, fileService, codeSearch, projectLogger, context }) {
  const allowed = ownerRoleTools(role);
  const scopedFiles = createRoleFileService({ fileService, role, projectRoot });
  const base = createAgentCommandTools({ projectRoot, fileService: scopedFiles, codeSearch, projectLogger, wrap: (tool) => tool });
  const implementations = {
    ...base,
    search_tree: createOwnerSearchTreeTool({ fileService: scopedFiles }),
    read_file: createReadFileTool({ fileService: scopedFiles, symbolLookup: codeSearch?.symbolsForFile?.bind(codeSearch) }),
    write_diff: createWriteDiffTool({ fileService: scopedFiles }),
    edit_diff: createEditDiffTool({ fileService: scopedFiles }),
    delete_file: createOwnerDeleteFileTool({ fileService: scopedFiles })
  };
  const definitions = [ownerSearchTreeDefinition, rgFilesDefinition, rgSearchDefinition, sedLinesDefinition, readFileDefinition, writeDiffDefinition, editDiffDefinition, ownerDeleteFileDefinition]
    .filter(({ name }) => allowed.includes(name) && typeof implementations[name]?.execute === "function");
  const registry = Object.fromEntries(definitions.map((definition) => [definition.name, { execute: async (input, toolContext = context) => {
    const log = (status, error, result) => projectLogger?.({ event_name: "owner.tool_call", level: error ? "error" : "info", status, message: `Owner Forge tool ${definition.name} ${status}.`, task_id: toolContext.task_id, correlation_id: toolContext.correlation_id, source: "owner-conversation-tools", ...(error ? { error_code: error.code ?? "TOOL_EXECUTION_FAILED" } : {}), payload: { tool: definition.name, agent_id: toolContext.agent_identity?.agent_id, ...(result ? { result: summarizeResult(result) } : {}) } });
    try {
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
