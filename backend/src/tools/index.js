// Summary: Exposes Forge-owned agent tools through one provider-neutral registry.
import { createQueryReviewTool } from "./query-review-tool.js";

import { createRequire } from "node:module";
import { createReadTranscriptBlocksTool } from "./read-transcript-blocks.js";
import { authorizeTool } from "./tool-authorization.js";
import { createSelectCodeGraphCandidatesTool } from "./select-code-graph-candidates.js";
import { createSearchCodeTool } from "./search-code.js";
import { createReadCodeTool } from "./read-code.js";
import { createCheckTestTool, createReadFileTool, createWriteDiffTool, createEditDiffTool, createDeleteFileTool, createMoveFileTool, createRunTestTool, createCommitChangesTool } from "./agent-lifecycle-tools.js";
import { createReportDoneTool } from "./agent-report-tool.js";
import { createTicketReportCommit } from "./ticket-report-commit.js";
import { createRespondToReviewTool, respondToReviewInputSchema } from "./respond-to-review-tool.js";
import { createGitReadTools } from "./git-read-tools.js";
import { createAgentCommandTools } from "./agent-command-tools.js";
import { createTicketPushTool } from "./ticket-push-tool.js";
import { engineeringToolImplementations } from "./engineering-tool-implementations.js";
import { createClaudeFileTools } from "./claude-file-tools.js";
import { createRoleFileService } from "../infrastructure/filesystem/file-service-role-policy.js";
import { formatToolLogEvent } from "./tool-log-event.js";
import { terminalAuditLogger } from "../core/terminal-log-format.js";
export { rgFilesDefinition, rgSearchDefinition, sedLinesDefinition } from "./agent-command-tools.js";

const require = createRequire(import.meta.url);
const readTranscriptInputSchema = require("../../../schemas/agent/tools/read-transcript-blocks.schema.json");
const selectGraphInputSchema = require("../../../schemas/agent/tools/select-code-graph-candidates.schema.json");
const searchCodeInputSchema = require("../../../schemas/agent/tools/search-code.schema.json");
const readCodeInputSchema = require("../../../schemas/agent/tools/read-code.schema.json");
const readFileInputSchema = require("../../../schemas/agent/tools/read-file.schema.json");
const writeDiffInputSchema = require("../../../schemas/agent/tools/write-diff.schema.json");
const editDiffInputSchema = require("../../../schemas/agent/tools/edit-diff.schema.json");
const runTestInputSchema = require("../../../schemas/agent/tools/run-test.schema.json");
const checkTestInputSchema = require("../../../schemas/agent/tools/check-test.schema.json");
const commitChangesInputSchema = require("../../../schemas/agent/tools/commit-changes.schema.json");
const reportDoneInputSchema = require("../../../schemas/agent/tools/report-done.schema.json");
const gitStatusInputSchema = require("../../../schemas/agent/tools/git-status.schema.json");
const gitDiffInputSchema = require("../../../schemas/agent/tools/git-diff.schema.json");

export const readTranscriptBlocksDefinition = Object.freeze({
  name: "read_transcript_blocks",
  description: "Read approved transcript rounds and approved project files through Forge services.",
  input_schema: readTranscriptInputSchema
});

export const selectCodeGraphCandidatesDefinition = Object.freeze({ name: "select_code_graph_candidates", description: "Ask Node to find up to eight files related to an Agent-provided search intent.", input_schema: selectGraphInputSchema });
export const searchCodeDefinition = Object.freeze({ name: "search_code", description: "Search Forge Code Search by file, symbol, or content (kind=\"content\" returns text snippets from FTS with matching lines) and return scoped metadata.", input_schema: searchCodeInputSchema });
export const readCodeDefinition = Object.freeze({ name: "read_code", description: "Read exactly one Node-approved file or symbol through Forge File Service.", input_schema: readCodeInputSchema });
// read_file validates its input schema; the tool registry does not apply a strict result schema.
export const readFileDefinition = Object.freeze({ name: "read_file", description: "Read Markdown content and whole-file sha256 (up to 250 lines) with path only; use offset/limit for more Markdown. Symbol is ignored for Markdown. For source files, path only returns indexed metadata and graph; pass symbol or offset/limit to receive up to 250 source lines.", input_schema: readFileInputSchema });
export const writeDiffDefinition = Object.freeze({ name: "write_diff", description: "Write a complete file through Node File Service after checksum validation. Content is limited to 250 lines; for localized changes use edit_diff.", input_schema: writeDiffInputSchema });
export const editDiffDefinition = Object.freeze({ name: "edit_diff", description: "Replace an exact anchor string in one approved file after checksum validation. Use read_file {offset,limit} to find the anchor; anchor must be unique unless occurrence=\"all\".", input_schema: editDiffInputSchema });
export const runTestDefinition = Object.freeze({ name: "run_test", description: "Start the Node-owned test suite and return a job_id immediately; poll check_test with that job_id for the result.", input_schema: runTestInputSchema });
export const checkTestDefinition = Object.freeze({ name: "check_test", description: "Poll a started test job by job_id until it reports passed or failed.", input_schema: checkTestInputSchema });
export const commitChangesDefinition = Object.freeze({ name: "commit_changes", description: "Ask Node to commit ticket ledger paths; supply a message, not file paths.", input_schema: commitChangesInputSchema });
export const reportDoneDefinition = Object.freeze({ name: "report_done", description: "Submit a completion summary for Node verification, or status blocked with blocker reason_code, owner_action and source evidence to request a decision without claiming completion.", input_schema: reportDoneInputSchema });
export const respondToReviewDefinition = Object.freeze({ name: "respond_to_review", description: "Submit a Coder response to open Reviewer findings without closing them. For missing committed test evidence, include typed verification_requests; Node runs them and returns receipts to Reviewer.", input_schema: respondToReviewInputSchema });
export { ownerDeleteFileDefinition as deleteFileDefinition, ownerMoveFileDefinition as moveFileDefinition } from "./owner-delete-file.js";
export const gitStatusDefinition = Object.freeze({ name: "git_status", description: "Read project Git status in porcelain format through Node Git Service.", input_schema: gitStatusInputSchema });
export const gitDiffDefinition = Object.freeze({ name: "git_diff", description: "Read the unstaged working-tree patch through Node Git Service.", input_schema: gitDiffInputSchema });

export function createForgeToolRegistry({ protocolStorage, fileService, projectRoot, maxChars, codeSearch, codeCache, relevantTreeSelector, freshnessChecker, enableReadCode = false, testService, gitService, changeLedger, executionContexts, reviewFindings, reportService, onEvalCase, governance, projectLogger = () => {} } = {}) {
  const transcriptTool = createReadTranscriptBlocksTool({ protocolStorage, fileService, maxChars });
  const graphTool = createSelectCodeGraphCandidatesTool({ relevantTreeSelector, freshnessChecker });
  const retrievalBudgets = new Map();
  const lifecycle = {};
  Object.assign(lifecycle, createAgentCommandTools({ projectRoot, fileService, codeSearch, codeCache, projectLogger: terminalAuditLogger(projectLogger), wrap }));
  Object.assign(lifecycle, engineeringToolImplementations({ registry: lifecycle, fileService, projectRoot, wrap }));
  if (fileService?.readForIndex && fileService?.listFiles && fileService?.readFile && fileService?.atomicWrite && fileService?.deleteFile && projectRoot) {
    const scopedFiles = createRoleFileService({ fileService, role: "coder", projectRoot });
    const scopedCache = codeCache && { ...codeCache, read: async ({ path }) => { await scopedFiles.assertReadPath(path); return codeCache.read({ path }); } };
    for (const [name, tool] of Object.entries(createClaudeFileTools({ fileService: scopedFiles, projectRoot, codeCache: scopedCache }))) lifecycle[name] = wrap(tool, name);
  }
  if (fileService?.readForIndex && fileService?.readFile && fileService?.atomicWrite) lifecycle.read_file = wrap(createReadFileTool({ fileService, codeCache, projectRoot, symbolLookup: codeSearch?.symbolsForFile?.bind(codeSearch), maxChars }), "read_file");
  if (fileService?.readFile && fileService?.atomicWrite) {
    lifecycle.write_diff = wrap(createWriteDiffTool({ fileService, codeCache, changeLedger, maxChars }), "write_diff");
    lifecycle.edit_diff = wrap(createEditDiffTool({ fileService, codeCache, changeLedger, maxChars }), "edit_diff");
    if (fileService?.deleteFile && changeLedger) {
      lifecycle.delete_file = wrap(createDeleteFileTool({ fileService, codeCache, changeLedger }), "delete_file");
      lifecycle.move_file = wrap(createMoveFileTool({ fileService, codeCache, changeLedger }), "move_file");
    }
  }
  if (testService?.startTests) lifecycle.run_test = wrap(createRunTestTool({ testService }), "run_test");
  if (testService?.getTestResult) lifecycle.check_test = wrap(createCheckTestTool({ testService }), "check_test");
  if (testService?.runCheck) lifecycle.run_check = wrap({
    // Runs the shared focused-check contract through the ticket's verification service.
    execute: async (input, context) => testService.runCheck({ ...input, taskId: context.task_id, sessionId: context.session_id, signal: context.abortSignal })
  }, "run_check");
  if (gitService?.commit) lifecycle.commit_changes = wrap(createCommitChangesTool({ gitService, changeLedger, logger: { emit: terminalAuditLogger(projectLogger) } }), "commit_changes", false);
  if (gitService?.pushCommit && changeLedger?.snapshot && executionContexts?.load) lifecycle.push_commit = wrap(createTicketPushTool({ gitService, changeLedger, executionContexts }), "push_commit");
  if (gitService?.status && gitService?.diffWorkingTree) {
    const gitReadTools = createGitReadTools({ gitService, logger: { emit: terminalAuditLogger(projectLogger) } });
    lifecycle.git_status = wrap(gitReadTools.git_status, "git_status", false);
    lifecycle.git_diff = wrap(gitReadTools.git_diff, "git_diff", false);
  }
  if (reportService?.buildFinalReport) lifecycle.report_done = wrap(createReportDoneTool({ reportService, verificationService: testService?.assertPassedArtifact ? testService : null, reviewFindings, onEvalCase }), "report_done");
  if (lifecycle.report_done && gitService?.reconcileRestoredCommit && changeLedger?.load && changeLedger?.snapshot && executionContexts)
    lifecycle.report_done = Object.freeze({ ...lifecycle.report_done, reconcileCommit: createTicketReportCommit({ gitService, changeLedger, executionContexts }) });
  if (reviewFindings?.recordResponse && testService?.assertPassedArtifact) lifecycle.respond_to_review = wrap(createRespondToReviewTool({ reviewFindings, verificationService: testService }), "respond_to_review");
  if (reviewFindings?.load) lifecycle.query_review = wrap(createQueryReviewTool({ load: reviewFindings.loadQuery ?? reviewFindings.load, queryRecords: reviewFindings.queryRecords }), "query_review");
  function wrap(tool, name, preauthorize = true) { return Object.freeze({ ...tool, async execute(input, context = {}) { const scoped = withDefaultBudget(context); if (preauthorize) authorizeTool(name, scoped); return dispatch(name, tool, input, scoped, context); } }); }
  const registry = {
    read_transcript_blocks: Object.freeze({ ...transcriptTool, async execute(input, context = {}) { const scoped = withDefaultBudget(context); authorizeTool("read_transcript_blocks", scoped); return dispatch("read_transcript_blocks", transcriptTool, input, scoped, context); } }),
    select_code_graph_candidates: Object.freeze({ ...graphTool, async execute(input, context = {}) { const scoped = withDefaultBudget(context); authorizeTool("select_code_graph_candidates", scoped); return dispatch("select_code_graph_candidates", graphTool, input, scoped, context); } })
  };
  if (codeSearch?.search) {
    const searchTool = createSearchCodeTool({ codeSearch, codeCache, projectLogger });
    registry.search_code = Object.freeze({ ...searchTool, async execute(input, context = {}) { const scoped = withDefaultBudget(context); authorizeTool("search_code", scoped); return dispatch("search_code", searchTool, input, scoped, context); } });
  }
  if (enableReadCode) {
    const readCodeTool = createReadCodeTool({ fileService, codeCache, maxChars });
    registry.read_code = Object.freeze({ ...readCodeTool, async execute(input, context = {}) { const scoped = withDefaultBudget(context); authorizeTool("read_code", scoped); return dispatch("read_code", readCodeTool, input, scoped, context); } });
  }
  function withDefaultBudget(context = {}) { if (governance) return context;
    if (context.context_budget || context.retrieval_budget || context.consume_retrieval || context.consumeRetrieval) return context;
    const taskId = context.task_id ?? context.taskId;
    if (typeof taskId !== "string" || !taskId) return context;
    let budget = retrievalBudgets.get(taskId);
    if (!budget) { budget = { max_bytes: 200000, max_calls: 20, used_bytes: 0, used_calls: 0 }; retrievalBudgets.set(taskId, budget); }
    return { ...context, context_budget: budget };
  }
  function dispatch(name, tool, input, context, callerContext = context) {
    const started = Date.now();
    logToolEvent("started", name, input, context);
    const execute = async () => governance?.dispatch ? governance.dispatch(name, input, context, (toolInput, toolContext) => tool.execute(toolInput, toolContext)) : tool.execute(input, context);
    return (async () => {
      try {
        const result = await execute();
        if (executionContexts && changeLedger && ["write_diff", "edit_diff", "delete_file", "move_file", "commit_changes"].includes(name)) {
          const taskId = context.task_id ?? context.taskId;
          const manifest = await changeLedger.snapshot(taskId);
          let current = await executionContexts.syncManifest(taskId, manifest);
          if (name === "commit_changes" && !(result.repeated && current.verification_source?.ticket_commit_sha === result.sha) && (current.state !== "verified" || current.review_commit_sha !== result.sha)) current = await executionContexts.update(taskId, current.version, { state: "committed", review_commit_sha: result.sha, verification_artifact_id: null, verification_source: null });
          context.execution_context = current;
          if (callerContext && typeof callerContext === "object") {
            callerContext.execution_context = current;
            if (Array.isArray(context.changed_paths)) callerContext.changed_paths = context.changed_paths;
          }
        }
        const checkFailed = ["run_check", "check_test"].includes(name) && result?.status === "failed";
        logToolEvent(checkFailed ? "failed" : "success", name, input, context, { duration_ms: Date.now() - started, result,
          ...(checkFailed ? { error: { code: result.error?.code ?? "CHECK_FAILED" } } : {}) });
        return result;
      } catch (error) {
        logToolEvent("failed", name, input, context, { duration_ms: Date.now() - started, error });
        throw error;
      }
    })();
  }

  function logToolEvent(status, tool, input, context = {}, extra = {}) {
    try {
      projectLogger(formatToolLogEvent(status, tool, input, context, extra));
    } catch (error) {
      projectLogger({ event_name: "forge.tool_log_failed", level: "error", status: "failed", message: "Forge tool log write failed.", task_id: context.task_id ?? context.taskId ?? `TOOL-${tool}`, source: "forge-tool-registry", error_code: error.code ?? "TOOL_LOG_FAILED", payload: { tool, error: error.message } });
    }
  }
  Object.assign(registry, lifecycle);
  return Object.freeze(registry);
}
