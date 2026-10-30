// Exposes complete ticket review records through existing read tools without truncating later findings.
import { statePath } from "../../../infrastructure/filesystem/forge-paths.js";
import { createQueryReviewTool, queryReviewDefinition } from "../../../tools/reporting/query-review-tool.js";
import { reviewQueryPrompt } from "./review-query-records.js";
import { createHash } from "node:crypto";
import { authorizeTool } from "../../../tools/governance/tool-authorization.js";

// Captures immutable, ticket-scoped review records and indexes their exact read locations.
export function createReviewExchangeEvidence(taskId, exchange) {
  if (!/^[A-Za-z0-9._:-]+$/.test(taskId ?? "")) throw failure("Invalid review ticket identity.");
  const prefix = `${statePath()}/review-evidence/${taskId}/`;
  const files = new Map();
  // Serializes one complete evidence record; historical records remain separately addressable.
  function add(name, value) {
    const path = `${prefix}${name}.json`;
    let content = JSON.stringify(value, null, 2);
    content = content.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
    for (const [key, secret] of Object.entries(process.env)) if (/(?:api.?key|secret|token|password|credential)/i.test(key)
      && typeof secret === "string" && secret.length >= 8) content = content.split(secret).join("[REDACTED]");
    const file = { path, content, total_lines: content.split("\n").length,
      sha256: `sha256:${createHash("sha256").update(content).digest("hex")}` };
    files.set(path, file);
    return { path, total_lines: file.total_lines, sha256: file.sha256 };
  }
  const findings = (exchange?.findings ?? []).map((entry, index) => {
    const { history = [], refinements = [], ...current } = entry;
    return { finding_id: entry.finding_id, status: entry.status, current: add(`findings/${index}/current`, current),
      history: history.map((record, position) => add(`findings/${index}/history/${position}`, record)),
      refinements: refinements.map((record, position) => add(`findings/${index}/refinements/${position}`, record)) };
  });
  const coderResponses = (exchange?.coder_responses ?? []).map((entry, index) => ({ idempotency_key: entry.idempotency_key,
    finding_ids: entry.responses?.map((response) => response.finding_id), ...add(`responses/${index}`, entry) }));
  const adjudications = (exchange?.adjudications ?? []).map((entry, index) => ({ finding_id: entry.finding_id,
    decision: entry.decision, response_id: entry.response_id, ...add(`adjudications/${index}`, entry) }));
  const index = { task_id: taskId, version: exchange?.version ?? 0, findings, coder_responses: coderResponses, adjudications };
  const indexFile = add("index", index);
  const prompt = reviewQueryPrompt(exchange);
  return { files, prompt, exchange, taskId, indexFile };

}

// Routes only exact snapshot paths through existing audited read tools; all other access keeps its normal policy.
export function attachReviewExchangeTools(tools, evidence, { job, reviewer, projectLogger = () => {} } = {}) {
  let bytes = 0;
  const context = { ...tools.context, capabilities: [...(tools.context?.capabilities ?? []), "query_review"] };
  const query = createQueryReviewTool({ load: async () => evidence.exchange, taskId: evidence.taskId, projectId: job.project_id });
  const registry = { ...tools.registry, query_review: { execute: async (input) => {
    const started = Date.now();
    try {
      const result = await query.execute(input, context);
      logQuery("success", { snapshot: result.snapshot, record_sha256: result.record_sha256, complete: result.complete, output_bytes: Buffer.byteLength(JSON.stringify(result)) });
      return result;
    } catch (error) { logQuery("failed", { error: { code: error.code, message: error.message } }); throw error; }
    // Records query receipts through the existing Reviewer log and terminal publisher.
    function logQuery(status, payload) {
      projectLogger({ event_name: "review.tool_call", source: "review-exchange-evidence", level: status === "failed" ? "error" : "info", status,
        task_id: job.task_id, correlation_id: job.correlation_id, message: `Reviewer Forge tool query_review ${status}.`,
        payload: { tool: "query_review", request_id: job.request_id, agent_id: reviewer?.agent_id, agent_name: reviewer?.agent_name,
          duration_ms: Date.now() - started, evidence_scope: "ticket_review_history", ...payload } });
    }
  } } };
  for (const name of ["read_file", "read_lines"]) {
    const original = registry[name];
    if (!original?.execute) continue;
    registry[name] = { ...original, execute: async (input = {}, context = {}) => {
      const file = evidence.files.get(input.path);
      if (!file) return original.execute(input, context);
      const started = Date.now();
      try {
        authorizeTool(name, { ...tools.context, ...context });
        const allowed = name === "read_file" ? ["path", "offset", "limit"] : ["path", "start_line", "end_line"];
        const start = name === "read_file" ? input.offset ?? 1 : input.start_line;
        const end = name === "read_file" ? start + (input.limit ?? 80) - 1 : input.end_line;
        if (Object.keys(input).some((key) => !allowed.includes(key)) || !Number.isSafeInteger(start) || start < 1
          || !Number.isSafeInteger(end) || end < start || end - start >= 80) throw failure("Review evidence reads require a window of 1-80 lines.");
        const content = file.content.split("\n").slice(start - 1, end).join("\n");
        const result = { path: file.path, total_lines: file.total_lines, sha256: file.sha256, evidence_scope: "ticket_review_history",
          ...(name === "read_file" ? { content, offset: start, limit: end - start + 1 } : { stdout: content, stderr: "", exit_code: 0, signal: null }) };
        const size = Buffer.byteLength(JSON.stringify(result));
        const budget = [...evidence.files.values()].reduce((sum, file) => sum + Buffer.byteLength(file.content), 128_000);
        if (size > 16_000 || bytes + size > budget) throw failure("Review evidence output budget exceeded; read a smaller window.");
        bytes += size;
        audit("success", { output_bytes: size });
        return result;
      } catch (error) { audit("failed", { error: { code: error.code, message: error.message } }); throw error; }
      // Keeps history reads visible in the same terminal and checkpoint stream as source reads.
      function audit(status, payload) {
        projectLogger({ event_name: "review.tool_call", level: status === "failed" ? "error" : "info", status,
          task_id: job.task_id, correlation_id: job.correlation_id, source: "review-exchange-evidence",
          message: `Reviewer Forge tool ${name} ${status}.`, payload: { tool: name, request_id: job.request_id,
            agent_id: reviewer?.agent_id, agent_name: reviewer?.agent_name, reviewer_id: reviewer?.agent_id,
            evidence_scope: "ticket_review_history", duration_ms: Date.now() - started, ...payload } });
      }
    } };
  }
  return { ...tools, registry, context, definitions: [...tools.definitions, queryReviewDefinition] };
}

// Rejects malformed history reads without granting broader runtime access.
function failure(message) { return Object.assign(new Error(message), { code: "REVIEW_EVIDENCE_READ_INVALID" }); }
