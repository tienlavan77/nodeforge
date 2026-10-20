// Reuses canonical read-only Forge tools for SL and Architecture blocker investigation.
import { createDiscoveryProgress } from "./blocker-discovery-checkpoint.js";
import { createRoleFileService } from "../../infrastructure/filesystem/file-service-role-policy.js";
import { createGitService } from "../../infrastructure/git/git-service.js";
import { createAgentCommandTools } from "../../tools/agent-command-tools.js";
import { createReadFileTool } from "../../tools/agent-lifecycle-tools.js";
import { createOwnerSearchTreeTool } from "../../tools/owner-search-tree.js";
import { createGitReadTools } from "../../tools/git-read-tools.js";
import { engineeringToolDefinitions } from "../../tools/engineering-tool-catalog.js";

const READ_TOOLS = ["search_tree", "list_files", "search_text", "read_file", "read_lines", "git_status", "git_diff"];

// Builds a bounded recovery registry from the same implementations and schemas used by other Forge agents.
export function blockerRecoveryTools({ fileService, projectRoot, profile, task_id, correlation_id, job, gitService = createGitService({ projectRoot }), projectLogger = () => {}, onDiscoveryCheckpoint, clock, deadline, abortSignal }) {
  const files = createRoleFileService({ fileService, projectRoot, role: profile.role });
  const cache = { read: (input) => files.readForIndex({ ...input, maxBytes: 128_000 }) };
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
    ...createAgentCommandTools({ projectRoot, fileService: files, codeCache: cache, projectLogger: () => {}, wrap: (tool) => tool }),
    search_tree: createOwnerSearchTreeTool({ fileService: files, role: profile.role }),
    read_file: createReadFileTool({ fileService: files, codeCache: cache, projectRoot }),
    ...createGitReadTools({ gitService: gitReads, logger: { emit: () => {} } })
  };
  const definitions = engineeringToolDefinitions().filter(({ name }) => READ_TOOLS.includes(name)).map((definition) => definition.name === "git_diff"
    ? { ...definition, description: "Read the patch from Node's fixed ticket baseline to current tracked source for inspected or declared files. Includes staged and committed changes. Accepts no arguments; current untracked source must be read with read_file/read_lines." } : definition);
  const registry = Object.fromEntries(definitions.map(({ name }) => [name, { execute: async (input = {}) => {
    audit(name, "started");
    try {
      progress.assertActive();
      let toolContext = { ...context };
      if (["read_file", "read_lines"].includes(name)) {
        await files.assertReadPath(input.path);
        toolContext = { ...context, allowed_file_paths: [input.path], allowed_prefixes: [] };
      }
      if (["git_status", "git_diff"].includes(name)) {
        if (paths.size > 80) throw new Error("Narrow recovery Git discovery to at most 80 source paths.");
        for (const path of paths) await files.assertReadPath(path);
        toolContext = { ...context, allowed_file_paths: [...paths], allowed_prefixes: [] };
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
      await progress.complete(name, input, result, paths);
      audit(name, "success");
      return result;
    } catch (error) {
      audit(name, "failed", { error_code: error.code ?? "BLOCKER_TOOL_FAILED" });
      throw error;
    }
  } }]));
  return { definitions, registry, context };

  // Emits canonical tool names without copying inspected content or queries into terminal logs.
  function audit(tool, status, extra = {}) {
    projectLogger({ event_name: "supervisor.blocker_tool_call", level: status === "failed" ? "error" : "info", status,
      message: `Blocker discovery ${tool} ${status}.`, task_id, correlation_id, source: "blocker-recovery-tools",
      payload: { agent_id: profile.agent_id, role: profile.role, tool, ...extra } });
  }
}
