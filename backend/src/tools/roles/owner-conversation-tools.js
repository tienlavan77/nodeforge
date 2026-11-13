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
import { createGitWorkflowTools } from "./git-workflow-tools.js";
import { createOwnerEngineerTools } from "./owner-engineer-tools.js";
import { createSourceReadTool } from "../discovery/source-read.js";
import { createSelectCodeGraphCandidatesTool } from "../discovery/select-code-graph-candidates.js";
import { createSubagentEvidenceTool } from "../discovery/subagent-evidence-tool.js";
import { sharedSubagentEvidenceStore, syncToolResultToEvidenceStore } from "../discovery/subagent-evidence-sync.js";
import { createLookupSchemaTool } from "../discovery/lookup-schema-tool.js";
import { formatForgeToolActivitySummary } from "../../application/system-engineer-sdk-transcript.js";
import { extractOwnerToolPathMeta, recordDiscoveryCompactStep, updateActiveFileChecksums } from "../../application/owner-context-compaction.js";

// Creates the role-scoped Forge tool registry used by owner SDK conversations.
export function createOwnerConversationTools({ role, projectRoot, fileService, codeCache, codeSearch, relevantTreeSelector, freshnessChecker, gitService, testService, commandService, conversationStateStore, conversationId, projectLogger, eventSink, context, delegateSubagentExecutor, evidenceStore = sharedSubagentEvidenceStore, readOnlyExplorer = false }) {
  const explorerTools = ["select_code_graph_candidates", "search_tree", "list_files", "search_text", "read_file", "Read", "git_status", "git_diff", "git_log", "git_show", "git_blame"];
  const planningTools = ["select_code_graph_candidates", "search_tree", "list_files", "search_text", "read_file", "read_subagent_evidence", "Read", "git_status", "git_diff", "git_log", "git_show", "git_blame", "git_branch", "lookup_schema"];
  const allowed = ownerRoleTools(role).filter((name) => (readOnlyExplorer ? explorerTools.includes(name) : true) && (!context?.planning_input_only || planningTools.includes(name)));
  const scopedFiles = createRoleFileService({ fileService, role, projectRoot });
  const scopedCache = codeCache && { ...codeCache, read: async ({ path }) => {
    await scopedFiles.assertReadPath(path);
    if (role === "system_engineer" && (/^node_modules(?:\/|$)/.test(path) || (/^\.forge(?:\/|$)/.test(path) && !codeSearch?.fileMetadata?.(path)))) return scopedFiles.readForIndex({ path });
    return codeCache.read({ path });
  } };
  const base = createAgentCommandTools({ projectRoot, fileService: scopedFiles, codeSearch, codeCache: scopedCache, projectLogger: () => {}, wrap: (tool) => tool });
  const implementations = {
    read_subagent_evidence: createSubagentEvidenceTool({ evidenceStore, fileService: scopedFiles, codeCache: scopedCache, projectRoot }),
    lookup_schema: createLookupSchemaTool({ role }),
    select_code_graph_candidates: createSelectCodeGraphCandidatesTool({ relevantTreeSelector, freshnessChecker, fileService: scopedFiles, codeCache: scopedCache, projectRoot, evidenceStore }),
    ...base,
    search_tree: createOwnerSearchTreeTool({ fileService: scopedFiles, role }),
    read_file: createReadFileTool({ fileService: scopedFiles, codeCache: scopedCache, projectRoot, symbolLookup: codeSearch?.symbolsForFile?.bind(codeSearch) }),
    Read: createSourceReadTool({ fileService: scopedFiles, codeCache: scopedCache, projectRoot }),
    write_diff: createWriteDiffTool({ fileService: scopedFiles, codeCache }),
    edit_diff: createEditDiffTool({ fileService: scopedFiles, codeCache }),
    delete_file: createOwnerDeleteFileTool({ fileService: scopedFiles, codeCache: scopedCache }),
    move_file: createOwnerMoveFileTool({ fileService: scopedFiles, codeCache: scopedCache })
  };
  if (["architecture_manager", "system_engineer", "sprint_leader", "reviewer"].includes(role) && typeof gitService?.status === "function" && typeof gitService?.diffWorkingTree === "function") {
    Object.assign(implementations, createGitReadTools({ gitService, logger: { emit: () => {} } }));
    const workflow = createGitWorkflowTools({ gitService, projectRoot, conversationStateStore, conversationId });
    if (workflow.git_branch) implementations.git_branch = workflow.git_branch;
  }
  const engineerTools = role === "system_engineer" ? createOwnerEngineerTools({ testService, gitService, conversationStateStore, projectRoot, commandService, conversationId, logger: { emit: (ev) => projectLogger?.({ timestamp: new Date().toISOString(), ...ev }) } }) : { definitions: [], implementations: {} };
  Object.assign(implementations, engineerTools.implementations);
  // Subagent delegation is temporarily disabled while the parent-worker model is redesigned.
  // The parent agent must continue directly with Forge discovery tools.
  const asyncDefinitions = [];
  const baseDefinitions = engineeringToolDefinitions();
  const definitions = baseDefinitions.map((definition) => role === "system_engineer" && definition.name === "search_text" ? { ...definition, input_schema: { ...definition.input_schema, properties: { ...definition.input_schema.properties, paths: { type: "array", minItems: 1, items: { type: "string", pattern: "^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*(?:/[A-Za-z0-9_-][A-Za-z0-9._-]*)*|\\.forge(?:/[A-Za-z0-9_-][A-Za-z0-9._-]*)*)$" } } } } } : definition)
    .filter(({ name }) => (allowed.includes(name) || asyncDefinitions.some((item) => item.name === name)) && typeof implementations[name]?.execute === "function");
  const registry = Object.fromEntries(definitions.map((definition) => [definition.name, { execute: async (input, toolContext = context) => {
    const started = Date.now();
    const log = (status, error, result) => {
      const timestamp = new Date().toISOString();
      projectLogger?.({ timestamp, event_name: "owner.tool_call", level: error ? "error" : "info", status, message: `Owner Forge tool ${definition.name} ${status}.`, task_id: toolContext.task_id, correlation_id: toolContext.correlation_id, conversation_id: toolContext.conversation_id ?? conversationId, source: "owner-conversation-tools", ...(error ? { error_code: error.code ?? "TOOL_EXECUTION_FAILED" } : {}), payload: { tool: definition.name, agent_id: toolContext.agent_identity?.agent_id, agent_name: toolContext.agent_identity?.agent_name, agent_role: role, provider: toolContext.agent_identity?.provider, ...(status !== "started" ? { duration_ms: Date.now() - started } : {}), ...(typeof input?.path === "string" ? { path: input.path } : {}), ...(error ? { error_message: String(error.message ?? "").slice(0, 240), input_keys: Object.keys(input ?? {}), offset: Number.isInteger(input?.offset) ? input.offset : null, limit: Number.isInteger(input?.limit) ? input.limit : null, symbol_state: input?.symbol == null ? "absent" : input.symbol === "" ? "empty" : "named" } : {}), ...(result ? { result: summarizeResult(result) } : {}) } });
      const summarized = result ? summarizeResult(result) : undefined;
      const subagentLabel = toolContext.subagentId ?? (typeof toolContext.agent_identity?.agent_id === "string" && toolContext.agent_identity.agent_id.includes(":sub:") ? toolContext.agent_identity.agent_id.split(":sub:").at(-1) : null);
      const baseSummary = formatForgeToolActivitySummary(definition.name, input, status, summarized, status !== "started" ? Date.now() - started : undefined, error?.code);
      const summaryText = subagentLabel ? `[subagent:${subagentLabel}] ${baseSummary}` : baseSummary;
      if (typeof toolContext.agent_identity?.agent_id === "string") eventSink?.({ event_type: "agent.activity", task_id: toolContext.task_id, conversation_id: toolContext.conversation_id ?? conversationId, timestamp, payload: { agent_id: toolContext.agent_identity.agent_id, ...(toolContext.agent_identity.parent_agent_id ? { parent_agent_id: toolContext.agent_identity.parent_agent_id, subagent_id: toolContext.agent_identity.agent_id } : {}), conversation_id: toolContext.conversation_id ?? conversationId, correlation_id: toolContext.correlation_id, activity_type: status === "started" ? "tool_started" : error ? "tool_failed" : "tool_completed", status: status === "started" ? "working" : error ? "failed" : "success", summary: summaryText, tool_name: definition.name } });
    };
    try {
      log("started");
      authorizeTool(definition.name, toolContext);
      await authorizeOwnerTool(definition.name, input, toolContext, projectRoot);
      const result = await implementations[definition.name].execute(input, toolContext);
      if (!readOnlyExplorer) {
        syncToolResultToEvidenceStore({ toolName: definition.name, input, result, context: { ...toolContext, conversation_id: toolContext.conversation_id ?? conversationId }, evidenceStore, projectRoot });
      }
      if (conversationStateStore && conversationId) {
        const currentState = (await conversationStateStore.get?.(conversationId)) ?? {};
        const isMutating = ["write_diff", "edit_diff", "delete_file", "move_file"].includes(definition.name);
        const discoveryUpdate = recordDiscoveryCompactStep(currentState, { toolName: definition.name, input, result });
        const stepMeta = extractOwnerToolPathMeta(definition.name, input);
        const isDelegationResult = definition.name === "delegate_subagent" || definition.name === "collect_subagent_results";
        const delegatedChecksums = isDelegationResult && Array.isArray(result?.observed_files)
          ? result.observed_files.reduce((checksums, file) => updateActiveFileChecksums(checksums, { toolName: "read_file", step: { tool_name: "read_file", path: file.path }, result: { path: file.path, sha256: file.sha256, total_lines: file.total_lines } }), currentState.active_file_checksums)
          : definition.name === "read_subagent_evidence" && Array.isArray(result?.evidence)
            ? result.evidence.filter((file) => file.fresh).reduce((checksums, file) => updateActiveFileChecksums(checksums, { toolName: "read_file", step: { tool_name: "read_file", path: file.path }, result: { path: file.path, sha256: file.sha256, total_lines: file.total_lines } }), currentState.active_file_checksums)
            : definition.name === "select_code_graph_candidates"
              ? (result.selected ?? []).filter((file) => file.receipt?.status === "verified").reduce((checksums, file) => updateActiveFileChecksums(checksums, { toolName: "read_file", step: { tool_name: "read_file", path: file.path }, result: file }), currentState.active_file_checksums)
              : currentState.active_file_checksums;
        const activeFileChecksums = discoveryUpdate?.active_file_checksums
          ?? (isMutating ? updateActiveFileChecksums(currentState.active_file_checksums, { toolName: definition.name, step: { tool_name: definition.name, ...stepMeta }, result }) : delegatedChecksums);
        if (isMutating || discoveryUpdate || definition.name === "select_code_graph_candidates" || definition.name === "read_subagent_evidence" || definition.name === "collect_subagent_results") {
          const previous = currentState.owner_changed_paths ?? [];
          await conversationStateStore.update?.(conversationId, {
            ...(isMutating ? { owner_changed_paths: [...new Set([...previous, ...(toolContext.changed_paths ?? [])])], owner_last_commit_sha: null } : {}),
            ...(activeFileChecksums ? { active_file_checksums: activeFileChecksums } : {}),
            ...(isDelegationResult && result?.subagent_usage !== undefined ? { subagent_usage: result?.subagent_usage ?? 0 } : {}),
            ...(discoveryUpdate?.discovery_receipts ? { discovery_receipts: discoveryUpdate.discovery_receipts } : {})
          });
        }
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
