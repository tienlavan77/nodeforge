// Registers Forge-owned discovery and document tools for an owner conversation role.
import { createReadFileTool, createWriteDiffTool, createEditDiffTool } from "./agent-lifecycle-tools.js";
import { createRgFilesTool } from "./rg-files.js";
import { createSearchTreeTool } from "./search-tree.js";
import { createSedLinesTool } from "./sed-lines.js";
import { readFileDefinition, writeDiffDefinition, editDiffDefinition } from "./index.js";
import { rgFilesDefinition, searchTreeDefinition, sedLinesDefinition } from "./agent-command-tools.js";
import { authorizeOwnerTool, ownerRoleTools } from "./owner-role-tool-policy.js";

const PRIVATE_PATH = /(^|\/)(?:\.env(?:\.|$)|(?:secret|secrets|credential|credentials|private|id_rsa|id_ed25519)(?:[._-]|$)|[^/]+\.(?:pem|key|p12|pfx)$)/i;
const MAX_FILES = 60;
const DEFINITIONS = [rgFilesDefinition, searchTreeDefinition, readFileDefinition, sedLinesDefinition, writeDiffDefinition, editDiffDefinition];

// Creates only the tools permitted to the role, rechecking every call before Forge executes it.
export function createOwnerConversationTools({ role, projectRoot, fileService, projectLogger, context }) {
  const allowed = ownerRoleTools(role);
  const logger = { emit: projectLogger };
  const implementations = {
    rg_files: createRgFilesTool({ projectRoot, logger }),
    search_tree: createSearchTreeTool({ projectRoot, logger }),
    read_file: createReadFileTool({ fileService }),
    sed_lines: createSedLinesTool({ projectRoot, fileService, logger }),
    write_diff: createWriteDiffTool({ fileService }),
    edit_diff: createEditDiffTool({ fileService })
  };
  const definitions = DEFINITIONS.filter((definition) => allowed.includes(definition.name)
    && (!["write_diff", "edit_diff"].includes(definition.name) || context.allowed_write_paths?.length));
  const registry = Object.fromEntries(definitions.map((definition) => [definition.name, { execute: async (input) => {
    const started = Date.now();
    try {
      await authorizeOwnerTool(definition.name, input, context, projectRoot);
      const scoped = input?.path ? { ...context, allowed_file_paths: [input.path], allowed_prefixes: [] } : context;
      const result = await implementations[definition.name].execute(input, scoped);
      if (definition.name === "rg_files") {
        if (result.exit_code !== 0 && result.exit_code !== 1) throw new Error("Project file listing failed.");
        const paths = result.stdout.split("\n").filter((path) => path && !PRIVATE_PATH.test(path));
        projectLogger?.({ event_name: "owner.tool_completed", level: "info", status: "success", message: "Owner conversation tool completed.",
          task_id: context.task_id, correlation_id: context.correlation_id, source: "owner-conversation-tools",
          payload: { tool: definition.name, agent_id: context.agent_identity?.agent_id, count: paths.length, duration_ms: Date.now() - started } });
        return { count: paths.length, paths: paths.slice(0, MAX_FILES), truncated: paths.length > MAX_FILES };
      }
      if (definition.name === "sed_lines" && result.exit_code !== 0) throw new Error("Project line read failed.");
      projectLogger?.({ event_name: "owner.tool_completed", level: "info", status: "success", message: "Owner conversation tool completed.",
        task_id: context.task_id, correlation_id: context.correlation_id, source: "owner-conversation-tools",
        payload: { tool: definition.name, agent_id: context.agent_identity?.agent_id, path: input?.path, duration_ms: Date.now() - started } });
      return result;
    } catch (error) {
      projectLogger?.({ event_name: "owner.tool_failed", level: "error", status: "failed", message: "Owner conversation tool failed.",
        task_id: context.task_id, correlation_id: context.correlation_id, source: "owner-conversation-tools", error_code: error.code ?? "OWNER_TOOL_FAILED",
        payload: { tool: definition.name, agent_id: context.agent_identity?.agent_id, path: input?.path, duration_ms: Date.now() - started } });
      throw error;
    }
  } } ]));
  return { definitions, registry };
}
