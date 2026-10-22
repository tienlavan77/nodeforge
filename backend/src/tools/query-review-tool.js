// Retrieves exact ticket review evidence with explicit, lossless pagination for every provider.
import Ajv2020 from "ajv/dist/2020.js";
import { authorizeTool } from "./tool-authorization.js";
import { reviewQueryRecords } from "../modules/supervisor/review-query-records.js";
import { reviewRecordHash } from "../modules/supervisor/review-record-storage.js";

export const queryReviewDefinition = Object.freeze({ name: "query_review", description: "Search ticket review findings, reports, responses and adjudications, then get an exact revision. Results are read-only and losslessly paginated: follow next_cursor until complete=true. section is an optional JSON pointer; get returns json_fragment pages to concatenate before parsing.", input_schema: {
  type: "object", additionalProperties: false, required: ["action"], properties: {
    action: { type: "string", enum: ["search", "get"] },
    ticket_id: { type: "string", minLength: 1, maxLength: 200 }, project_id: { type: "string", minLength: 1, maxLength: 200 },
    kind: { type: "string", enum: ["finding", "report", "response", "adjudication", "draft", "rejected_report"] },
    id: { type: "string", minLength: 1, maxLength: 200 }, finding_id: { type: "string", pattern: "^REV-[1-9][0-9]*$" },
    revision: { type: "integer", minimum: 1 }, commit_sha: { type: "string", minLength: 1, maxLength: 100 },
    status: { type: "string", minLength: 1, maxLength: 100 }, query: { type: "string", minLength: 1, maxLength: 200 },
    after: { type: "string", minLength: 20, maxLength: 40, pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T" }, before: { type: "string", minLength: 20, maxLength: 40, pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T" },
    section: { type: "string", maxLength: 200, pattern: "^/" }, cursor: { type: "string", maxLength: 2000 },
    limit: { type: "integer", minimum: 1, maximum: 20 }
  }
} });
const validate = new Ajv2020({ strict: false, coerceTypes: false }).compile(queryReviewDefinition.input_schema);

// Creates a reader bound to one Node-issued ticket and project, never a caller-selected filesystem path.
export function createQueryReviewTool({ load, queryRecords, taskId, projectId }) {
  let previousExchange, previousRecords;
  const textCache = new Map();
  return { execute: async (input = {}, context = {}) => {
    authorizeTool("query_review", context);
    const boundTask = taskId ?? context.task_id;
    if (!validate(input)) throw failure("REVIEW_QUERY_INPUT_INVALID", "Invalid query_review arguments.");
    if (!["coder", "reviewer"].includes(context.agent_identity?.role) || context.task_id !== boundTask
      || (input.ticket_id && input.ticket_id !== boundTask) || (projectId && context.project_id && context.project_id !== projectId)
      || (input.project_id && input.project_id !== (projectId ?? context.project_id))) throw failure("REVIEW_QUERY_FORBIDDEN", "Review lookup is restricted to the issued project and ticket.");
    for (const key of ["after", "before"]) if (input[key] && !Number.isFinite(Date.parse(input[key]))) throw failure("REVIEW_QUERY_INPUT_INVALID", "Invalid review time filter.");
    const exchange = queryRecords ? await queryRecords(input) : await load();
    if (exchange?.task_id && exchange.task_id !== boundTask) throw failure("REVIEW_QUERY_FORBIDDEN", "Review store belongs to another ticket.");
    if (previousExchange !== exchange || !previousRecords) {
      previousExchange = exchange;
      previousRecords = queryRecords ? exchange : reviewQueryRecords(exchange ?? {});
      textCache.clear();
    }
    const records = previousRecords;
    const { cursor, ...filters } = input;
    const fingerprint = reviewRecordHash(filters);
    let offset = 0, expected = null;
    if (cursor) {
      try {
        const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (value.fingerprint !== fingerprint || !Number.isSafeInteger(value.offset) || value.offset < 0) throw failure("REVIEW_QUERY_CURSOR_INVALID", "Cursor does not match this query.");
        offset = value.offset; expected = value.snapshot;
      } catch (error) { throw failure("REVIEW_QUERY_CURSOR_INVALID", `Invalid review cursor: ${error.message}`); }
    }
    let snapshot, result, next;
    if (input.action === "search") {
      const selected = records.filter((record) => matches(record, input));
      snapshot = reviewRecordHash(selected.map(({ record_sha256 }) => record_sha256));
      if (offset > selected.length) throw failure("REVIEW_QUERY_CURSOR_INVALID", "Cursor exceeds search results.");
      const page = [];
      for (const record of selected.slice(offset, offset + (input.limit ?? 10))) {
        const metadata = { ...record }; delete metadata.body;
        if (Buffer.byteLength(JSON.stringify([...page, metadata])) > 10_000) break;
        page.push(metadata);
      }
      if (!page.length && offset < selected.length) throw failure("REVIEW_QUERY_METADATA_TOO_LARGE", "Review metadata exceeds the page limit; narrow the query to an exact record.");
      next = offset + page.length;
      result = { records: page, total: selected.length };
      if (next >= selected.length) next = null;
    } else {
      if (!input.kind || !input.id) throw failure("REVIEW_QUERY_INPUT_INVALID", "get requires kind and id; select revision for historical findings.");
      const selected = records.filter((record) => record.kind === input.kind && record.id === input.id
        && (input.revision === undefined || record.revision === input.revision));
      const record = selected.at(-1);
      if (!record) throw failure("REVIEW_RECORD_NOT_FOUND", "No matching review record exists in this ticket.");
      const textKey = `${record.record_sha256}:${input.section ?? ""}`;
      if (!textCache.has(textKey)) textCache.set(textKey, JSON.stringify(selectSection(record.body, input.section)));
      const text = textCache.get(textKey);
      snapshot = reviewRecordHash({ record: record.record_sha256, section: input.section ?? null });
      if (offset > text.length) throw failure("REVIEW_QUERY_CURSOR_INVALID", "Cursor exceeds record length.");
      next = reviewPageEnd(text, offset);
      result = { kind: record.kind, id: record.id, revision: record.revision, record_sha256: record.record_sha256,
        section: input.section ?? null, encoding: "json_fragment", offset, total_characters: text.length, json_fragment: text.slice(offset, next) };
      if (next >= text.length) next = null;
    }
    if (expected && snapshot !== expected) throw failure("REVIEW_QUERY_STALE", "Evidence changed; repeat the query against an exact revision.");
    return { task_id: boundTask, project_id: projectId ?? context.project_id ?? null, snapshot, ...result,
      complete: next === null, next_cursor: next === null ? null : Buffer.from(JSON.stringify({ fingerprint, snapshot, offset: next })).toString("base64url") };
  } };
}

// Uses the available result bytes efficiently without splitting a Unicode character or dropping JSON text.
function reviewPageEnd(text, offset) {
  let low = offset, high = Math.min(offset + 10_000, text.length);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(text.slice(offset, middle))) <= 10_000) low = middle;
    else high = middle - 1;
  }
  if (low < text.length && /[\uD800-\uDBFF]/.test(text[low - 1])) low -= 1;
  return low;
}

// Applies literal filters to full record content rather than truncated file snippets.
function matches(record, input) {
  return ["kind", "id", "revision", "commit_sha", "status"].every((key) => input[key] === undefined || record[key] === input[key])
    && (!input.finding_id || record.finding_ids.includes(input.finding_id))
    && (!input.after || record.recorded_at && Date.parse(record.recorded_at) >= Date.parse(input.after))
    && (!input.before || record.recorded_at && Date.parse(record.recorded_at) <= Date.parse(input.before))
    && (!input.query || JSON.stringify(record.body).toLowerCase().includes(input.query.toLowerCase()));
}

// Selects explicit JSON-pointer fields without traversing prototypes or exposing unrelated records.
function selectSection(body, pointer) {
  if (!pointer) return body;
  let value = body;
  for (const token of pointer.slice(1).split("/")) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!value || !Object.hasOwn(value, key) || ["__proto__", "constructor", "prototype"].includes(key)) throw failure("REVIEW_RECORD_NOT_FOUND", "Requested review section does not exist.");
    value = value[key];
  }
  return value;
}

// Returns stable, actionable review lookup failures to SDK adapters and terminal logs.
function failure(code, message) { return Object.assign(new Error(message), { code }); }
