/** Reuses the formal Reviewer's immutable snapshot readers for independent AM
 * evidence work, adding exact receipt/context reads without test or write tools.
 * The recovery checkpoint stores tool progress and the returned report only. */
import { createReviewerForgeTools } from "../review/reviewer-forge-tools.js";
import { createBlockerReviewerSource } from "./blocker-reviewer-source.js";
import { createBlockerEvidenceFiles } from "./blocker-evidence-files.js";
import { createDiscoveryProgress } from "./blocker-discovery-checkpoint.js";
import { createReadFileTool } from "../../../tools/governance/agent-lifecycle-tools.js";
import { createGitReadTools } from "../../../tools/discovery/git-read-tools.js";
import { createGitService } from "../../../infrastructure/git/git-service.js";
import { engineeringToolDefinitions } from "../../../tools/engineering-tool-catalog.js";
import { createLookupSchemaTool } from "../../../tools/discovery/lookup-schema-tool.js";
import { terminalAuditLogger } from "../../../core/terminal-log-format.js";

/** Builds role-scoped snapshot tools and bounded receipt windows. Every receipt
 * read rechecks its assigned hash, even when immutable source uses the cache. */
export async function createBlockerReviewerTools({ job, profile, projectRoot, fileService, projectLogger = () => {}, onDiscoveryCheckpoint, clock, deadline, abortSignal }) {
  const { source, artifact } = await createBlockerReviewerSource({ job, projectRoot });
  const base = createReviewerForgeTools({ fileService: source, projectRoot, reviewer: profile,
    job: { task_id: job.request.task_id, request_id: job.id, payload: { changed_paths: artifact.changed_paths ?? [] } }, projectLogger: terminalAuditLogger(projectLogger) });
  const { files, isEvidencePath } = createBlockerEvidenceFiles({ files: fileService, projectRoot, profile, taskId: job.request.task_id, job });
  // Displays receipt JSON as paged fields while retaining the original stored
  // checksum for citations; source-file physical line coordinates stay intact.
  const receiptReader = createReadFileTool({ fileService: { ...files, readForIndex: async (input) => {
    const file = await files.readForIndex(input);
    return { ...file, content: JSON.stringify(JSON.parse(file.content), null, 2) };
  } }, maxChars: 8000 });
  const progress = createDiscoveryProgress({ job, save: onDiscoveryCheckpoint, clock, deadline, abortSignal });
  const paths = new Set(progress.snapshot().paths ?? []);
  const git = createGitService({ projectRoot });
  const gitTools = createGitReadTools({ gitService: { status: (input) => git.status(input),
    diffWorkingTree: (input) => source.diffPatchFrom(artifact.base_sha, input) }, logger: { emit: terminalAuditLogger(projectLogger) } });
  const lookup = createLookupSchemaTool({ role: "reviewer", subject: job.reviewer_evidence.request.subject });
  const definitions = [...base.definitions.filter(({ name }) => ["read_file", "read_lines", "search_tree", "list_files", "search_text", "lookup_schema"].includes(name)),
    ...engineeringToolDefinitions().filter(({ name }) => ["git_status", "git_diff"].includes(name))];
  const context = { ...base.context, capabilities: definitions.map(({ name }) => name) };
  const registry = Object.fromEntries(definitions.map(({ name }) => [name, { execute: async (input = {}) => {
    const started = Date.now();
    projectLogger({ event_name: "supervisor.blocker_tool_call", status: "started", task_id: job.request.task_id,
      message: `Independent Reviewer ${name} started.`, payload: { agent_id: profile.agent_id, role: "reviewer", tool: name } });
    try {
      progress.assertActive();
      const receipt = ["read_file", "read_lines"].includes(name) && isEvidencePath(input.path);
      let result;
      if (name === "lookup_schema") result = await lookup.execute(input, context);
      else if (receipt) {
        const offset = input.offset ?? input.start_line ?? 1;
        const limit = input.limit ?? (input.end_line === undefined ? 80 : input.end_line - offset + 1);
        if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 80)
          throw Object.assign(new Error("Evidence windows require 1-80 lines."), { code: "READ_LINES_INPUT_INVALID" });
        result = await receiptReader.execute({ path: input.path, offset, limit },
          { ...context, allowed_file_paths: [input.path], allowed_prefixes: [] });
        result = { ...result, view_format: "formatted_json", source_checksum: "original_stored_bytes" };
        if (name === "read_lines") result = { ...result, stdout: result.content, stderr: "", exit_code: 0 };
      } else if (gitTools[name]) result = { ...await gitTools[name].execute(input, { ...context, allowed_file_paths: artifact.changed_paths ?? [], allowed_prefixes: [] }),
        ...(name === "git_diff" ? { source_commit_sha: source.reviewCommit } : { scope: "workspace_observation_only" }) };
      else result = await base.registry[name].execute(input);
      if (input.path) paths.add(input.path);
      if (name !== "lookup_schema") await progress.complete(name, input, result, paths);
      projectLogger({ event_name: "supervisor.blocker_tool_call", status: "success", task_id: job.request.task_id,
        message: `Independent Reviewer ${name} success.`, payload: { agent_id: profile.agent_id, agent_name: profile.agent_name, role: "reviewer", tool: name, duration_ms: Date.now() - started } });
      return result;
    } catch (error) {
      projectLogger({ event_name: "supervisor.blocker_tool_call", level: "error", status: "failed", task_id: job.request.task_id, error_code: error.code,
        message: `Independent Reviewer ${name} failed.`, payload: { agent_id: profile.agent_id, agent_name: profile.agent_name, role: "reviewer", tool: name, duration_ms: Date.now() - started, error: error.message } });
      throw error;
    }
  } }]));
  return { definitions, registry, context };
}
