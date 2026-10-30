// Grants owner conversation tools using the same Forge registry contracts as SDK execution.
import { createHash } from "node:crypto";
import { authorizeTool } from "../governance/tool-authorization.js";
import { ownerRoleTools, ownerWritePaths, authorizeOwnerTool } from "./owner-role-tool-policy.js";
import { createAgentCommandTools } from "../governance/agent-command-tools.js";
import { createReadFileTool, createWriteDiffTool, createEditDiffTool } from "../governance/agent-lifecycle-tools.js";
import { engineeringToolDefinitions } from "../engineering-tool-catalog.js";
import { createOwnerSearchTreeTool } from "./owner-search-tree.js";
import { createRoleFileService } from "../../infrastructure/filesystem/file-service-role-policy.js";
import { createOwnerDeleteFileTool, createOwnerMoveFileTool } from "./owner-delete-file.js";
import { createGitReadTools } from "../discovery/git-read-tools.js";
import { createOwnerEngineerTools } from "./owner-engineer-tools.js";
import { createLookupSchemaTool } from "../discovery/lookup-schema-tool.js";
import { formatForgeToolCommand } from "../../application/system-engineer-sdk-transcript.js";

// Creates the role-scoped Forge tool registry used by owner SDK conversations.
export function createOwnerConversationTools({ role, projectRoot, fileService, codeCache, codeSearch, gitService, testService, conversationStateStore, conversationId, projectLogger, eventSink, context }) {
  const allowed = ownerRoleTools(role).filter((name) => !context?.planning_input_only || ["search_tree", "list_files", "search_text", "read_file", "read_lines", "git_status", "git_diff", "lookup_schema"].includes(name));
  const scopedFiles = createRoleFileService({ fileService, role, projectRoot });
  const scopedCache = codeCache && { ...codeCache, read: async ({ path }) => {
    await scopedFiles.assertReadPath(path);
    if (role === "system_engineer" && /^(?:node_modules|\.forge)(?:\/|$)/.test(path)) return scopedFiles.readForIndex({ path });
    return codeCache.read({ path });
  } };
  const base = createAgentCommandTools({ projectRoot, fileService: scopedFiles, codeSearch, codeCache: scopedCache, projectLogger: () => {}, wrap: (tool) => tool });
  const implementations = {
    lookup_schema: createLookupSchemaTool({ role }),
    ...base,
    search_tree: createOwnerSearchTreeTool({ fileService: scopedFiles, role }),
    read_file: createReadFileTool({ fileService: scopedFiles, codeCache: scopedCache, projectRoot, symbolLookup: codeSearch?.symbolsForFile?.bind(codeSearch) }),
    write_diff: createWriteDiffTool({ fileService: scopedFiles, codeCache }),
    edit_diff: createEditDiffTool({ fileService: scopedFiles, codeCache }),
    delete_file: createOwnerDeleteFileTool({ fileService: scopedFiles, codeCache: scopedCache }),
    move_file: createOwnerMoveFileTool({ fileService: scopedFiles, codeCache: scopedCache })
  };
  if (["architecture_manager", "system_engineer", "reviewer"].includes(role) && typeof gitService?.status === "function" && typeof gitService?.diffWorkingTree === "function") Object.assign(implementations, createGitReadTools({ gitService, logger: { emit: () => {} } }));
  const engineerTools = role === "system_engineer" ? createOwnerEngineerTools({ testService, gitService, conversationStateStore }) : { definitions: [], implementations: {} };
  Object.assign(implementations, engineerTools.implementations);
  const definitions = engineeringToolDefinitions().map((definition) => role === "system_engineer" && definition.name === "search_text" ? { ...definition, input_schema: { ...definition.input_schema, properties: { ...definition.input_schema.properties, paths: { type: "array", minItems: 1, items: { type: "string", pattern: "^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*(?:/[A-Za-z0-9_-][A-Za-z0-9._-]*)*|\\.forge(?:/[A-Za-z0-9_-][A-Za-z0-9._-]*)*)$" } } } } } : definition)
    .filter(({ name }) => allowed.includes(name) && typeof implementations[name]?.execute === "function");
  const registry = Object.fromEntries(definitions.map((definition) => [definition.name, { execute: async (input, toolContext = context) => {
    const started = Date.now();
    const log = (status, error, result) => {
      const timestamp = new Date().toISOString();
      projectLogger?.({ timestamp, event_name: "owner.tool_call", level: error ? "error" : "info", status, message: `Owner Forge tool ${definition.name} ${status}.`, task_id: toolContext.task_id, correlation_id: toolContext.correlation_id, conversation_id: toolContext.conversation_id ?? conversationId, source: "owner-conversation-tools", ...(error ? { error_code: error.code ?? "TOOL_EXECUTION_FAILED" } : {}), payload: { tool: definition.name, agent_id: toolContext.agent_identity?.agent_id, agent_name: toolContext.agent_identity?.agent_name, agent_role: role, provider: toolContext.agent_identity?.provider, ...(status !== "started" ? { duration_ms: Date.now() - started } : {}), ...(typeof input?.path === "string" ? { path: input.path } : {}), ...(error ? { error_message: String(error.message ?? "").slice(0, 240), input_keys: Object.keys(input ?? {}), offset: Number.isInteger(input?.offset) ? input.offset : null, limit: Number.isInteger(input?.limit) ? input.limit : null, symbol_state: input?.symbol == null ? "absent" : input.symbol === "" ? "empty" : "named" } : {}), ...(result ? { result: summarizeResult(result) } : {}) } });
      const commandText = formatForgeToolCommand(definition.name, input, true);
      if (typeof toolContext.agent_identity?.agent_id === "string") eventSink?.({ event_type: "agent.activity", task_id: toolContext.task_id, conversation_id: toolContext.conversation_id ?? conversationId, timestamp, payload: { agent_id: toolContext.agent_identity.agent_id, conversation_id: toolContext.conversation_id ?? conversationId, correlation_id: toolContext.correlation_id, activity_type: status === "started" ? "tool_started" : error ? "tool_failed" : "tool_completed", status: status === "started" ? "working" : error ? "failed" : "success", summary: commandText ? `Forge tool ${definition.name} ${status}: ${commandText}` : `Forge tool ${definition.name} ${status}`, tool_name: definition.name } });
    };
    try {
      log("started");
      authorizeTool(definition.name, toolContext);
      await authorizeOwnerTool(definition.name, input, toolContext, projectRoot);
      const result = await implementations[definition.name].execute(input, toolContext);
      if (["write_diff", "edit_diff", "delete_file", "move_file"].includes(definition.name) && conversationStateStore && conversationId) {
        const previous = (await conversationStateStore.get(conversationId))?.owner_changed_paths ?? [];
        await conversationStateStore.update(conversationId, { owner_changed_paths: [...new Set([...previous, ...(toolContext.changed_paths ?? [])])], owner_last_commit_sha: null });
      }
      const checkFailed = definition.name === "run_check" && result?.status === "failed";
      log(checkFailed ? "failed" : "success", checkFailed ? Object.assign(new Error("Project verification failed."), { code: "CHECK_FAILED" }) : null, result);
      return result;
    } catch (error) { log("failed", error); throw error; }
  } }]));
  return { definitions, registry };
}

export { ownerWritePaths };

// Records result size and status without persisting project source text or search queries.
function summarizeResult(result) {
  if (!result || typeof result !== "object") return { returned: result !== undefined };
  const checkResult = result.result ?? (Array.isArray(result.breakdown) ? result : null);
  const contentText = result.content?.find?.((item) => item?.type === "text")?.text;
  const writeReceipt = typeof contentText === "string" ? /Written '([^']+)' \((sha256:[a-f0-9]+)\)/.exec(contentText) : null;
  return {
    ...(typeof result.path === "string" ? { path: result.path } : {}), ...(typeof result.sha256 === "string" ? { sha256: result.sha256 } : {}),
    ...(Array.isArray(result.files) ? { files: result.files.length } : {}), ...(Array.isArray(result.matches) ? { matches: result.matches.length } : {}),
    ...(typeof result.total === "number" ? { total: result.total } : {}), ...(typeof result.total_lines === "number" ? { total_lines: result.total_lines } : {}),
    ...(typeof result.truncated === "boolean" ? { truncated: result.truncated } : {}), ...(typeof result.exit_code === "number" ? { exit_code: result.exit_code } : {}),
    ...(typeof result.job_id === "string" ? { job_id: result.job_id } : {}), ...(typeof result.status === "string" ? { status: result.status } : {}), ...(Array.isArray(result.changed_paths) ? { changed_files: result.changed_paths.length } : {}),
    ...(typeof result.sha === "string" ? { commit_sha: result.sha } : {}), ...(Array.isArray(result.paths) ? { changed_files: result.paths.length } : {}),
    ...(typeof result.branch === "string" ? { branch: result.branch } : {}), ...(typeof result.remote === "string" ? { remote: result.remote } : {}),
    ...(writeReceipt ? { path: writeReceipt[1], sha256: writeReceipt[2] } : {}), ...(typeof contentText === "string" ? { result_bytes: Buffer.byteLength(contentText), result_sha256: digest(contentText) } : {}),
    ...(checkResult && typeof checkResult === "object" ? { verification: { status: checkResult.status, checks: (checkResult.breakdown ?? []).map(({ kind, status, exit_code, command }) => ({ kind, status, exit_code, command })) } } : {}),
    ...(typeof result.stdout === "string" ? { stdout_bytes: Buffer.byteLength(result.stdout), stdout_lines: result.stdout ? result.stdout.split(/\r?\n/).filter(Boolean).length : 0, stdout_sha256: digest(result.stdout) } : {}),
    ...(typeof result.stderr === "string" ? { stderr_bytes: Buffer.byteLength(result.stderr), stderr_sha256: digest(result.stderr) } : {}),
    ...(typeof result.output === "string" ? { output_bytes: Buffer.byteLength(result.output), output_sha256: digest(result.output) } : {})
  };
}

// Digests returned text for audit without persisting source matches or test output in logs.
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
