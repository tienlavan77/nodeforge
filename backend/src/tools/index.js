// Summary: Exposes Forge-owned agent tools through one provider-neutral registry.

import { createRequire } from "node:module";
import { createReadTranscriptBlocksTool } from "./read-transcript-blocks.js";
import { authorizeTool } from "./tool-authorization.js";
import { createSelectCodeGraphCandidatesTool } from "./select-code-graph-candidates.js";
import { createSearchCodeTool } from "./search-code.js";
import { createReadCodeTool } from "./read-code.js";
import { createCheckTestTool, createReadFileTool, createWriteDiffTool, createEditDiffTool, createRunTestTool, createCommitChangesTool } from "./agent-lifecycle-tools.js";
import { createReportDoneTool } from "./agent-report-tool.js";
import { createGitReadTools } from "./git-read-tools.js";
import { createAgentCommandTools } from "./agent-command-tools.js";
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
export const readFileDefinition = Object.freeze({ name: "read_file", description: "Read one approved file through Node File Service and return its checksum.", input_schema: readFileInputSchema });
export const writeDiffDefinition = Object.freeze({ name: "write_diff", description: "Write a complete file through Node File Service after checksum validation. Content is capped at 8 KB; for larger or localized changes use edit_diff.", input_schema: writeDiffInputSchema });
export const editDiffDefinition = Object.freeze({ name: "edit_diff", description: "Replace an exact anchor string in one approved file after checksum validation. Use read_file {offset,limit} to find the anchor; anchor must be unique unless occurrence=\"all\".", input_schema: editDiffInputSchema });
export const runTestDefinition = Object.freeze({ name: "run_test", description: "Start the Node-owned test suite and return a job_id immediately; poll check_test with that job_id for the result.", input_schema: runTestInputSchema });
export const checkTestDefinition = Object.freeze({ name: "check_test", description: "Poll a started test job by job_id until it reports passed or failed.", input_schema: checkTestInputSchema });
export const commitChangesDefinition = Object.freeze({ name: "commit_changes", description: "Ask Node to commit approved changed paths.", input_schema: commitChangesInputSchema });
export const reportDoneDefinition = Object.freeze({ name: "report_done", description: "Record the completion summary through the existing Stage1 report service.", input_schema: reportDoneInputSchema });
export const gitStatusDefinition = Object.freeze({ name: "git_status", description: "Read project Git status in porcelain format through Node Git Service.", input_schema: gitStatusInputSchema });
export const gitDiffDefinition = Object.freeze({ name: "git_diff", description: "Read the unstaged working-tree patch through Node Git Service.", input_schema: gitDiffInputSchema });

export function createForgeToolRegistry({ protocolStorage, fileService, projectRoot, maxChars, codeSearch, relevantTreeSelector, freshnessChecker, enableReadCode = false, testService, gitService, reportService, onEvalCase, governance, projectLogger = () => {} } = {}) {
  const transcriptTool = createReadTranscriptBlocksTool({ protocolStorage, fileService, maxChars });
  const graphTool = createSelectCodeGraphCandidatesTool({ relevantTreeSelector, freshnessChecker });
  const retrievalBudgets = new Map();
  const lifecycle = {};
  Object.assign(lifecycle, createAgentCommandTools({ projectRoot, fileService, codeSearch, projectLogger, wrap }));
  if (fileService?.readForIndex && fileService?.readFile && fileService?.atomicWrite) lifecycle.read_file = wrap(createReadFileTool({ fileService, symbolLookup: codeSearch?.symbolsForFile?.bind(codeSearch), maxChars }), "read_file");
  if (fileService?.readFile && fileService?.atomicWrite) {
    lifecycle.write_diff = wrap(createWriteDiffTool({ fileService, maxChars }), "write_diff");
    lifecycle.edit_diff = wrap(createEditDiffTool({ fileService, maxChars }), "edit_diff");
  }
  if (testService?.startTests) lifecycle.run_test = wrap(createRunTestTool({ testService }), "run_test");
  if (testService?.getTestResult) lifecycle.check_test = wrap(createCheckTestTool({ testService }), "check_test");
  if (gitService?.commit) lifecycle.commit_changes = wrap(createCommitChangesTool({ gitService, logger: { emit: projectLogger } }), "commit_changes", false);
  if (gitService?.status && gitService?.diffWorkingTree) {
    const gitReadTools = createGitReadTools({ gitService, logger: { emit: projectLogger } });
    lifecycle.git_status = wrap(gitReadTools.git_status, "git_status", false);
    lifecycle.git_diff = wrap(gitReadTools.git_diff, "git_diff", false);
  }
  if (reportService?.buildFinalReport) lifecycle.report_done = wrap(createReportDoneTool({ reportService, onEvalCase }), "report_done");
  function wrap(tool, name, preauthorize = true) { return Object.freeze({ ...tool, async execute(input, context = {}) { const scoped = withDefaultBudget(context); if (preauthorize) authorizeTool(name, scoped); return dispatch(name, tool, input, scoped); } }); }
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
      terminalToolLine(name, input, context, { duration_ms: Date.now() - started, result });
      return result;
    }, (error) => {
      logToolEvent("failed", name, input, context, { duration_ms: Date.now() - started, error });
      terminalToolLine(name, input, context, { duration_ms: Date.now() - started, error });
      throw error;
    });
  }

  // One concise terminal line per finished tool call so an operator can watch
  // exactly what the agent ran and what came back. stdout keeps it next to the
  // dev-server log; never throws.
  function terminalToolLine(name, input = {}, context = {}, extra = {}) {
    try {
      const agent = context?.agent_identity?.agent_name ?? context?.agent_identity?.agent_id ?? "forge";
      const parts = [`[${agent}] ${toolDisplayName(name)}`, extra.error ? "FAIL" : "PASS"];
      const target = toolTarget(name, input);
      if (target) parts.push(target);
      parts.push(`${extra.duration_ms ?? 0}ms`);
      const count = resultCount(name, extra.result);
      if (count !== undefined) parts.push(`results=${count}`);
      const tail = extra.error ? (extra.error.code ?? "ERROR") : toolResultHint(name, extra.result);
      if (tail) parts.push(tail);
      const line = parts.join(" ").replace(/\s+/g, " ").slice(0, 180);
      process.stdout.write(`${line}\n`);
    // eslint-disable-next-line no-silent-catch -- Terminal logging is best-effort; never break tool dispatch.
    } catch {
      // Terminal logging is best-effort; never break the tool dispatch path.
    }
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

  // One concise terminal line per finished discovery tool call so an operator can
  // watch the search scope and the returned files, not just that a search ran.
  function toolDisplayName(name) {
    const labels = {
      select_code_graph_candidates: "chọn ứng viên mã nguồn",
      search_code: "tìm kiếm mã nguồn",
      read_file: "đọc tệp",
      read_code: "đọc mã nguồn",
      write_diff: "ghi tệp mới",
      edit_diff: "sửa tệp",
      run_test: "chạy kiểm thử",
      check_test: "kiểm tra kiểm thử",
      commit_changes: "commit thay đổi",
      report_done: "báo cáo hoàn tất",
      git_status: "xem trạng thái Git",
      git_diff: "xem thay đổi Git",
      read_transcript_blocks: "đọc phiên bản"
    };
    return labels[name] ?? name;
  }
  function toolTarget(name, input = {}) {
  if (name === "select_code_graph_candidates") return `q="${String(input.query ?? "").slice(0, 60)}" ctx="${String(input.context ?? "").slice(0, 60)}"`;
  if (name === "search_code") return `q="${String(input.query ?? "").slice(0, 60)}"`;
  const value = input.path ?? input.file_path ?? input.job_id ?? input.commit_id ?? input.query ?? input.kind;
  return typeof value === "string" && value ? value.replace(/\s+/g, " ").slice(0, 80) : "";
}

function toolResultHint(name, result) {
  if (result === null || result === undefined) return "";
  if (name === "git_status") return `${result.working_tree ?? "unknown"} files=${result.changed_files ?? 0}`;
  if (name === "git_diff") return result.has_changes ? "changes" : "clean";
  if (name === "select_code_graph_candidates") return pathHint(result.selected);
  if (name === "search_code") return pathHint(result.matches);
  if (name === "read_file" || name === "read_code") return result.path ? `${result.path}${result.sha256 ? " checksum" : ""}` : "read";
  if (name === "run_test" && typeof result.job_id === "string") return `job=${result.job_id}`;
  if (name === "check_test") {
    const status = result.status ?? result.state ?? result.result;
    return status ? String(status).slice(0, 40) : "";
  }
  if (name === "commit_changes") return result.commit_id ?? result.sha ?? "committed";
  if (name === "report_done") return result.status ?? "completed";
  if (typeof result === "object") return Object.keys(result).slice(0, 3).join(",");
  return String(result).slice(0, 60);
}

function resultCount(name, result) {
  if (!result || typeof result !== "object") return undefined;
  if (name === "select_code_graph_candidates" && Array.isArray(result.selected)) return result.selected.length;
  if (name === "search_code" && Array.isArray(result.matches)) return result.matches.length;
  return undefined;
}

function selectedPaths(items) {
  if (!Array.isArray(items) || !items.length) return [];
  return items.map((item) => item?.path).filter(Boolean);
}

function pathHint(items) {
  const paths = selectedPaths(items);
  if (!paths.length) return "0-results";
  return paths.slice(0, 4).join(",").slice(0, 100);
}

// Discovery detail is shared by the terminal line and project.log so an
// operator can audit what each search query/context actually returned.
function discoveryDetail(name, input = {}, result) {
  if (!result || typeof result !== "object") return null;
  if (name === "select_code_graph_candidates") {
    return { query: input.query ?? "", context: input.context ?? "", result_paths: selectedPaths(result.selected) };
  }
  if (name === "search_code") {
    return { query: input.query ?? "", kind: input.kind ?? "", result_paths: selectedPaths(result.matches) };
  }
  return null;
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
  const detail = status === "success" ? discoveryDetail(tool, input, extra.result) : null;
  if (detail) {
    payload.discovery = { ...detail, result_count: detail.result_paths.length, result_summary: detail.result_paths.length ? detail.result_paths.slice(0, 4).join(",") : "0-results" };
  }
  const message = detail
    ? `Forge tool ${tool} ${status} q="${String(detail.query ?? "").slice(0, 60)}"${detail.context !== undefined ? ` ctx="${String(detail.context).slice(0, 60)}"` : ""} -> ${detail.result_paths.length ? detail.result_paths.slice(0, 4).join(", ") : "0-results"}`
    : `Forge tool ${tool} ${status}.`;
  return {
    timestamp: new Date().toISOString(),
    event_name: `forge.tool_${status}`,
    level: status === "failed" ? "error" : "info",
    status,
    message,
    task_id: taskId,
    ...(context.ticket?.id ? { ticket_id: context.ticket.id } : {}),
    ...(context.correlation_id ? { correlation_id: context.correlation_id } : {}),
    source: "forge-tool-registry",
    ...(status === "failed" ? { error_code: payload.error_code } : {}),
    payload
  };
}
