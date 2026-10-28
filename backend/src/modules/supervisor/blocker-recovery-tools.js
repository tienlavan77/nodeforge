// Reuses canonical read-only Forge tools for SL and Architecture blocker investigation.
import { createDiscoveryProgress } from "./blocker-discovery-checkpoint.js";
import { createRoleFileService } from "../../infrastructure/filesystem/file-service-role-policy.js";
import { createGitService } from "../../infrastructure/git/git-service.js";
import { createAgentCommandTools } from "../../tools/agent-command-tools.js";
import { createReadFileTool } from "../../tools/agent-lifecycle-tools.js";
import { createOwnerSearchTreeTool } from "../../tools/owner-search-tree.js";
import { createGitReadTools } from "../../tools/git-read-tools.js";
import { engineeringToolDefinitions } from "../../tools/engineering-tool-catalog.js";
import { createBlockerEvidenceFiles } from "./blocker-evidence-files.js";
import { createCodeCacheService } from "../context/code-cache-service.js";
import { createLookupSchemaTool } from "../../tools/lookup-schema-tool.js";

const READ_TOOLS = ["search_tree", "list_files", "search_text", "read_file", "read_lines", "git_status", "git_diff", "lookup_schema"];

// Builds a bounded recovery registry from the same implementations and schemas used by other Forge agents.
export function blockerRecoveryTools({ fileService, codeCache, projectRoot, profile, task_id, correlation_id, job, gitService = createGitService({ projectRoot }), projectLogger = () => {}, onDiscoveryCheckpoint, clock, deadline, abortSignal }) {
  const { files, isEvidencePath } = createBlockerEvidenceFiles({
    files: createRoleFileService({ fileService, projectRoot, role: profile.role }), projectRoot, profile, taskId: task_id, job });
  const sourceCache = codeCache ?? createCodeCacheService({ projectId: projectRoot,
    fileService: { readForIndex: (input) => files.readForIndex({ ...input, maxBytes: 128_000 }) }, logger: projectLogger });
  const cache = { read: async ({ path }) => {
    await files.assertReadPath(path);
    // Receipts and context grants must be revalidated against their current assignment on every read.
    if (isEvidencePath(path)) return files.readForIndex({ path, maxBytes: 128_000 });
    const file = await sourceCache.read({ path });
    if (file.size_bytes > 128_000) throw Object.assign(new Error("Recovery source exceeds the read budget."), { code: "FILE_TOO_LARGE" });
    return file;
  } };
  const baseline = job?.request?.execution_context?.base_sha;
  const paths = new Set([...(job?.request?.ticket?.execution_policy?.contract_evidence ?? []), ...(job?.evidence ?? [])]
    .map((ref) => typeof ref === "object" ? ref?.path ?? ref?.reference : ref)
    .filter((path) => typeof path === "string" && path.length > 0).map((path) => path.replace(/:\d+(?::\d+)?$/, "")));
  const context = { task_id, correlation_id, project_root: projectRoot, agent_identity: { agent_id: profile.agent_id, role: profile.role }, capabilities: READ_TOOLS };
  const progress = createDiscoveryProgress({ job, save: onDiscoveryCheckpoint, clock, deadline, abortSignal,
    onRenew: (payload) => projectLogger({ event_name: "supervisor.blocker_budget_renewed", level: "info", status: "success", task_id, correlation_id,
      message: "Discovery allowance renewed at its saved checkpoint; continuing the same agent invocation.", payload: { role: profile.role, ...payload } }) });
  for (const path of progress.snapshot().paths ?? []) paths.add(path);
  // Pins recovery Git reads to the retained execution without accepting model-supplied revisions or commands.
  const gitReads = {
    status: (input) => gitService.status(input),
    diffWorkingTree: (input) => {
      if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(baseline ?? "")) throw new Error("Recovery git_diff requires Node's immutable execution baseline.");
      return gitService.diffPatchFrom(baseline, input);
    }
  };
  const implementations = {
    lookup_schema: createLookupSchemaTool({ role: profile.role, subject: job?.reviewer_evidence?.request?.subject }),
    ...createAgentCommandTools({ projectRoot, fileService: files, codeCache: cache, projectLogger: () => {}, wrap: (tool) => tool }),
    search_tree: createOwnerSearchTreeTool({ fileService: files, role: profile.role }),
    read_file: createReadFileTool({ fileService: files, codeCache: cache, projectRoot }),
    ...createGitReadTools({ gitService: gitReads, logger: { emit: () => {} } })
  };
  const definitions = engineeringToolDefinitions().filter(({ name }) => READ_TOOLS.includes(name)).map((definition) => definition.name === "git_diff"
    ? { ...definition, description: "Read the patch from Node's fixed ticket baseline to current tracked source for inspected or declared files. Includes staged and committed changes. Accepts no arguments; current untracked source must be read with read_file/read_lines." } : definition);
  const registry = Object.fromEntries(definitions.map(({ name }) => [name, { execute: async (input = {}) => {
    const started = Date.now();
    audit(name, "started");
    try {
      progress.assertActive();
      let toolContext = { ...context };
      if (["read_file", "read_lines"].includes(name)) {
        await files.assertReadPath(input.path);
        toolContext = { ...context, allowed_file_paths: [input.path], allowed_prefixes: [] };
      }
      if (["git_status", "git_diff"].includes(name)) {
        const sourcePaths = [...paths].filter((path) => !isEvidencePath(path));
        if (sourcePaths.length > 80) throw new Error("Narrow recovery Git discovery to at most 80 source paths.");
        for (const path of sourcePaths) await files.assertReadPath(path);
        toolContext = { ...context, allowed_file_paths: sourcePaths, allowed_prefixes: [] };
      }
      let result = await implementations[name].execute(input, toolContext);
      if (name === "list_files") {
        const safe = [];
        for (const path of result.stdout.split("\n").filter(Boolean)) {
          try { await files.assertReadPath(path); safe.push(path); }
          catch (error) { if (error.code !== "FILE_ROLE_FORBIDDEN") throw error; }
        }
        result = { ...result, stdout: safe.length ? `${safe.join("\n")}\n` : "" };
      }
      if (["read_file", "read_lines"].includes(name)) paths.add(input.path);
      if (name === "git_diff") result = { ...result, baseline_commit: baseline };
      if (name !== "lookup_schema") await progress.complete(name, input, result, paths);
      audit(name, "success", { duration_ms: Date.now() - started });
      return result;
    } catch (error) {
      const path = input?.path;
      const logPath = ["read_file", "read_lines"].includes(name) && typeof path === "string" && path.length <= 512
        && /^[A-Za-z0-9._:/-]+$/.test(path) && !path.startsWith("/") && path.split("/").every((part) => part && part !== "." && part !== "..");
      audit(name, "failed", { duration_ms: Date.now() - started, error_code: error.code ?? "BLOCKER_TOOL_FAILED", error_message: error.message, ...(logPath ? { path } : {}) });
      throw error;
    }
  } }]));
  return { definitions, registry, context };

  // Emits canonical tool names without copying inspected content or queries into terminal logs.
  function audit(tool, status, extra = {}) {
    projectLogger({ event_name: "supervisor.blocker_tool_call", level: status === "failed" ? "error" : "info", status,
      message: `Blocker discovery ${tool} ${status}.`, task_id, correlation_id, source: "blocker-recovery-tools",
      payload: { agent_id: profile.agent_id, agent_name: profile.agent_name, role: profile.role, tool, ...extra } });
  }
}
