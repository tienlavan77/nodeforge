/** Reuses the formal Reviewer's immutable snapshot readers for independent AM
 * evidence work, adding exact receipt/context reads without test or write tools.
 * The recovery checkpoint stores tool progress and the returned report only. */
import { createReviewerForgeTools } from "../review/reviewer-forge-tools.js";
import { createBlockerReviewerSource } from "./blocker-reviewer-source.js";
import { createBlockerEvidenceFiles } from "./blocker-evidence-files.js";
import { createDiscoveryProgress } from "./blocker-discovery-checkpoint.js";
import { createSourceReadTool } from "../../../tools/discovery/source-read.js";
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
  const receiptFiles = { ...files, readForIndex: async (input) => {
    const file = await files.readForIndex(input);
    return { ...file, content: JSON.stringify(JSON.parse(file.content), null, 2) };
  } };
  const receiptMetadata = createReadFileTool({ fileService: receiptFiles });
  const receiptReader = createSourceReadTool({ fileService: receiptFiles, projectRoot });
  const progress = createDiscoveryProgress({ job, save: onDiscoveryCheckpoint, clock, deadline, abortSignal });
  const paths = new Set(progress.snapshot().paths ?? []);
  const git = createGitService({ projectRoot });
  const gitTools = createGitReadTools({ gitService: { status: (input) => git.status(input),
    diffWorkingTree: (input) => source.diffPatchFrom(artifact.base_sha, input) }, logger: { emit: terminalAuditLogger(projectLogger) } });
  const lookup = createLookupSchemaTool({ role: "reviewer", subject: job.reviewer_evidence.request.subject });
  const definitions = [...base.definitions.filter(({ name }) => ["read_file", "Read", "search_tree", "list_files", "search_text", "lookup_schema"].includes(name)),
    ...engineeringToolDefinitions().filter(({ name }) => ["git_status", "git_diff"].includes(name))];
  const context = { ...base.context, capabilities: definitions.map(({ name }) => name) };
  const registry = Object.fromEntries(definitions.map(({ name }) => [name, { execute: async (input = {}) => {
    const started = Date.now();
    const path = name === "Read" ? input.file_path : input.path;
    projectLogger({ event_name: "supervisor.blocker_tool_call", status: "started", task_id: job.request.task_id,
      message: `Independent Reviewer ${name} started.`, payload: { agent_id: profile.agent_id, role: "reviewer", tool: name } });
    try {
      progress.assertActive();
      const receipt = ["read_file", "Read"].includes(name) && isEvidencePath(path);
      let result;
      if (name === "lookup_schema") result = await lookup.execute(input, context);
      else if (receipt) {
        result = await (name === "Read" ? receiptReader : receiptMetadata).execute(input,
          { ...context, allowed_file_paths: [path], allowed_prefixes: [] });
        result = { ...result, view_format: "formatted_json", source_checksum: "original_stored_bytes" };
      } else if (gitTools[name]) result = { ...await gitTools[name].execute(input, { ...context, allowed_file_paths: artifact.changed_paths ?? [], allowed_prefixes: [] }),
        ...(name === "git_diff" ? { source_commit_sha: source.reviewCommit } : { scope: "workspace_observation_only" }) };
      else result = await base.registry[name].execute(input);
      if (path) paths.add(path);
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
