// Summary: Exposes Forge-owned agent tools through one provider-neutral registry.

import { createRequire } from "node:module";
import { createReadTranscriptBlocksTool } from "./read-transcript-blocks.js";
import { authorizeTool } from "./tool-authorization.js";
import { createSelectCodeGraphCandidatesTool } from "./select-code-graph-candidates.js";
import { createSearchCodeTool } from "./search-code.js";
import { createReadCodeTool } from "./read-code.js";
import { createCheckTestTool, createReadFileTool, createWriteDiffTool, createEditDiffTool, createRunTestTool, createCommitChangesTool, createReportDoneTool } from "./agent-lifecycle-tools.js";

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

export const readTranscriptBlocksDefinition = Object.freeze({
  name: "read_transcript_blocks",
  description: "Read approved transcript rounds and approved project files through Forge services.",
  input_schema: readTranscriptInputSchema
});

export const selectCodeGraphCandidatesDefinition = Object.freeze({ name: "select_code_graph_candidates", description: "Ask Node to find up to four files related to an Agent-provided search intent.", input_schema: selectGraphInputSchema });
export const searchCodeDefinition = Object.freeze({ name: "search_code", description: "Search Forge Code Search by file, symbol, or content (kind=\"content\" returns text snippets from FTS with matching lines) and return scoped metadata.", input_schema: searchCodeInputSchema });
export const readCodeDefinition = Object.freeze({ name: "read_code", description: "Read exactly one Node-approved file or symbol through Forge File Service.", input_schema: readCodeInputSchema });
export const readFileDefinition = Object.freeze({ name: "read_file", description: "Read one approved file through Node File Service and return its checksum.", input_schema: readFileInputSchema });
export const writeDiffDefinition = Object.freeze({ name: "write_diff", description: "Write a complete file through Node File Service after checksum validation. Content is capped at 8 KB; for larger or localized changes use edit_diff.", input_schema: writeDiffInputSchema });
export const editDiffDefinition = Object.freeze({ name: "edit_diff", description: "Replace an exact anchor string in one approved file after checksum validation. Use read_file {offset,limit} to find the anchor; anchor must be unique unless occurrence=\"all\".", input_schema: editDiffInputSchema });
export const runTestDefinition = Object.freeze({ name: "run_test", description: "Start the Node-owned test suite and return a job_id immediately; poll check_test with that job_id for the result.", input_schema: runTestInputSchema });
export const checkTestDefinition = Object.freeze({ name: "check_test", description: "Poll a started test job by job_id until it reports passed or failed.", input_schema: checkTestInputSchema });
export const commitChangesDefinition = Object.freeze({ name: "commit_changes", description: "Ask Node to commit approved changed paths.", input_schema: commitChangesInputSchema });
export const reportDoneDefinition = Object.freeze({ name: "report_done", description: "Record the completion summary through the existing Stage1 report service.", input_schema: reportDoneInputSchema });

export function createForgeToolRegistry({ protocolStorage, fileService, maxChars, codeSearch, relevantTreeSelector, enableReadCode = false, testService, gitService, reportService, governance, projectLogger = () => {} } = {}) {
  const transcriptTool = createReadTranscriptBlocksTool({ protocolStorage, fileService, maxChars });
  const graphTool = createSelectCodeGraphCandidatesTool({ relevantTreeSelector });
  const retrievalBudgets = new Map();
  const lifecycle = {};
  if (fileService?.readForIndex && fileService?.readFile && fileService?.atomicWrite) lifecycle.read_file = wrap(createReadFileTool({ fileService, symbolLookup: codeSearch?.symbolsForFile?.bind(codeSearch), maxChars }), "read_file");
  if (fileService?.readFile && fileService?.atomicWrite) {
    lifecycle.write_diff = wrap(createWriteDiffTool({ fileService, maxChars }), "write_diff");
    lifecycle.edit_diff = wrap(createEditDiffTool({ fileService, maxChars }), "edit_diff");
  }
  if (testService?.startTests) lifecycle.run_test = wrap(createRunTestTool({ testService }), "run_test");
  if (testService?.getTestResult) lifecycle.check_test = wrap(createCheckTestTool({ testService }), "check_test");
  if (gitService?.commit) lifecycle.commit_changes = wrap(createCommitChangesTool({ gitService }), "commit_changes");
  if (reportService?.buildFinalReport) lifecycle.report_done = wrap(createReportDoneTool({ reportService }), "report_done");
  function wrap(tool, name) { return Object.freeze({ ...tool, async execute(input, context = {}) { const scoped = withDefaultBudget(context); authorizeTool(name, scoped); return dispatch(name, tool, input, scoped); } }); }
  const registry = {
    read_transcript_blocks: Object.freeze({ ...transcriptTool, async execute(input, context = {}) { const scoped = withDefaultBudget(context); authorizeTool("read_transcript_blocks", scoped); return dispatch("read_transcript_blocks", transcriptTool, input, scoped); } }),
    select_code_graph_candidates: Object.freeze({ ...graphTool, async execute(input, context = {}) { const scoped = withDefaultBudget(context); authorizeTool("select_code_graph_candidates", scoped); return dispatch("select_code_graph_candidates", graphTool, input, scoped); } })
  };
  if (codeSearch?.search) {
    const searchTool = createSearchCodeTool({ codeSearch });
    registry.search_code = Object.freeze({ ...searchTool, async execute(input, context = {}) { const scoped = withDefaultBudget(context); authorizeTool("search_code", scoped); return dispatch("search_code", searchTool, input, scoped); } });
  }
  if (enableReadCode) {
    const readCodeTool = createReadCodeTool({ fileService, maxChars });
    registry.read_code = Object.freeze({ ...readCodeTool, async execute(input, context = {}) { const scoped = withDefaultBudget(context); authorizeTool("read_code", scoped); return dispatch("read_code", readCodeTool, input, scoped); } });
  }
  function withDefaultBudget(context = {}) { if (governance) return context;
    if (context.context_budget || context.retrieval_budget || context.consume_retrieval || context.consumeRetrieval) return context;
    const taskId = context.task_id ?? context.taskId;
    if (typeof taskId !== "string" || !taskId) return context;
    let budget = retrievalBudgets.get(taskId);
    if (!budget) { budget = { max_bytes: 200000, max_calls: 20, used_bytes: 0, used_calls: 0 }; retrievalBudgets.set(taskId, budget); }
    return { ...context, context_budget: budget };
  }
  function dispatch(name, tool, input, context) {
    const started = Date.now();
    logToolEvent("started", name, input, context);
    const execute = async () => governance?.dispatch ? governance.dispatch(name, input, context, (toolInput, toolContext) => tool.execute(toolInput, toolContext)) : tool.execute(input, context);
    return execute().then((result) => {
      logToolEvent("success", name, input, context, { duration_ms: Date.now() - started, result });
      return result;
    }, (error) => {
      logToolEvent("failed", name, input, context, { duration_ms: Date.now() - started, error });
      throw error;
    });
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

function formatToolLogEvent(status, tool, input, context, extra) {
  const taskId = context.task_id ?? context.taskId ?? `TOOL-${tool}`;
  const executionId = context.execution_id ?? context.executionId;
  const payload = {
    tool,
    ...(executionId ? { execution_id: executionId } : {}),
    ...(context.agent_identity?.agent_id ? { agent_id: context.agent_identity.agent_id } : {}),
    ...(context.session_id ? { session_id: context.session_id } : {}),
    ...(extra.duration_ms !== undefined ? { duration_ms: extra.duration_ms } : {})
  };
  if (status === "failed") {
    payload.error_code = extra.error?.code ?? "TOOL_EXECUTION_FAILED";
    if (extra.error?.details && typeof extra.error.details === "object") {
      Object.assign(payload, extra.error.details);
    }
  }
  return {
    timestamp: new Date().toISOString(),
    event_name: `forge.tool_${status}`,
    level: status === "failed" ? "error" : "info",
    status,
    message: `Forge tool ${tool} ${status}.`,
    task_id: taskId,
    ...(context.ticket?.id ? { ticket_id: context.ticket.id } : {}),
    ...(context.correlation_id ? { correlation_id: context.correlation_id } : {}),
    source: "forge-tool-registry",
    ...(status === "failed" ? { error_code: payload.error_code } : {}),
    payload
  };
}
