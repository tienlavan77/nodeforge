/** Provides a role-bound, read-only response-contract lookup for every SDK.
 * Large contracts use explicit lossless pages instead of silent truncation. */
import Ajv2020 from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { authorizeTool } from "./tool-authorization.js";
import { agentSchemaEntries } from "../modules/governance/agent-schema-catalog.js";
import { agentSchemaDocument } from "../modules/governance/agent-schema-document.js";

export const lookupSchemaDefinition = Object.freeze({ name: "lookup_schema", description: "Look up the response contract for your current role and task. Use schema_id from your role README, {} for the task catalog, or intent/task to find candidates. Optional action narrows a decision contract. If complete=false, follow next_cursor and concatenate json_fragment pages before parsing; examples never establish evidence or authority.", input_schema: {
  type: "object", additionalProperties: false, properties: {
    schema_id: { type: "string", minLength: 1, maxLength: 120 }, task: { type: "string", minLength: 1, maxLength: 100 },
    intent: { type: "string", minLength: 1, maxLength: 500 }, action: { type: "string", minLength: 1, maxLength: 80 },
    cursor: { type: "string", minLength: 1, maxLength: 1000 }
  }
} });
const validate = new Ajv2020({ strict: false, allErrors: true }).compile(lookupSchemaDefinition.input_schema);
const PAGE = 9000;

/** Finds contracts only under the bound role. Task/intent searches are a local
 * metadata lookup and never invoke another model or inspect repository files. */
export function createLookupSchemaTool({ role, subject } = {}) {
  return { execute: async (input = {}, context = {}) => {
    authorizeTool("lookup_schema", context);
    if (!validate(input)) throw failure("SCHEMA_LOOKUP_INPUT_INVALID", "Invalid lookup_schema arguments; role and file paths are not accepted.");
    const currentRole = context.agent_identity?.role;
    if (!currentRole || role && role !== currentRole || !agentSchemaEntries(currentRole).length) throw failure("SCHEMA_LOOKUP_FORBIDDEN", "Lookup role differs from the Node-issued identity or has no schema catalog.");
    const entries = agentSchemaEntries(currentRole);
    if (!input.schema_id) {
      if (input.cursor || input.action) throw failure("SCHEMA_LOOKUP_INPUT_INVALID", "Select schema_id before action or pagination.");
      const terms = (input.intent ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
      const matches = entries.filter((entry) => !input.task || entry.task === input.task)
        .map((entry) => ({ entry, score: terms.filter((term) => `${entry.task} ${entry.purpose} ${entry.keywords}`.toLowerCase().includes(term)).length }))
        .filter(({ score }) => !terms.length || score > 0).sort((a, b) => b.score - a.score)
        .map(({ entry }) => ({ schema_id: entry.schema_id, role: entry.role, task: entry.task, delivery: entry.delivery, purpose: entry.purpose }));
      return { role: currentRole, matches, complete: true, instruction: "Choose schema_id by its task, purpose and delivery; then look up the exact contract. Do not infer a decision from search ranking." };
    }
    const entry = entries.find((item) => item.schema_id === input.schema_id);
    if (!entry) throw failure("SCHEMA_NOT_AVAILABLE", "Schema ID is unknown or unavailable for this role; call lookup_schema({}) for the role catalog.");
    if (input.task && entry.task !== input.task || input.intent) throw failure("SCHEMA_LOOKUP_INPUT_INVALID", "Use task/intent for discovery, then select its schema_id without a conflicting filter.");
    const result = agentSchemaDocument(entry, { action: input.action, subject });
    const text = JSON.stringify(result);
    if (Buffer.byteLength(JSON.stringify({ ...result, complete: true })) <= PAGE && !input.cursor) return { ...result, complete: true };
    const fingerprint = createHash("sha256").update(JSON.stringify({ role: currentRole, schema_id: entry.schema_id, action: input.action, hash: result.sha256 })).digest("hex");
    let offset = 0;
    if (input.cursor) {
      let cursor;
      try { cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString()); }
      catch (error) { throw failure("SCHEMA_CURSOR_INVALID", `Malformed schema cursor: ${error.name}.`); }
      if (!cursor || typeof cursor !== "object" || Array.isArray(cursor) || cursor.fingerprint !== fingerprint || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset >= text.length) throw failure("SCHEMA_CURSOR_INVALID", "Cursor does not match this role, schema or version.");
      offset = cursor.offset;
    }
    let end = Math.min(offset + PAGE, text.length);
    while (Buffer.byteLength(JSON.stringify(text.slice(offset, end))) > PAGE) end = offset + Math.floor((end - offset) * 0.8);
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1])) end -= 1;
    return { schema_id: entry.schema_id, sha256: result.sha256, encoding: "json_fragment", offset, total_characters: text.length,
      json_fragment: text.slice(offset, end), complete: end === text.length,
      next_cursor: end === text.length ? null : Buffer.from(JSON.stringify({ fingerprint, offset: end })).toString("base64url") };
  } };
}

/** Keeps lookup failures machine-readable without disguising unknown contracts
 * as approval failures or another technical investigation. */
function failure(code, message) { return Object.assign(new Error(message), { code }); }
