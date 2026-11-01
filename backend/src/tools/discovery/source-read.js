// Provides every Forge agent with one governed source reader so discovery metadata
// cannot become an unbounded code channel. Reads use the live Code Cache when
// available, retain role and execution boundaries, and resolve symbols against
// current source before returning at most 80 numbered physical lines.
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ConfigurationError } from "../../shared/errors.js";
import { assertExecutionFileAccess } from "../execution-file-access.js";
import { isAgentPathAllowed } from "../governance/tool-authorization.js";
import { resolveSymbolWindow } from "./agent-file-index-view.js";
import { recordRead, discoveryNotice } from "./exploration-state.js";

// Advertises a provider-neutral read contract with mutually exclusive symbol and line selectors.
export const sourceReadDefinition = Object.freeze({ name: "Read",
  description: "Read current source from Code Cache by file_path plus either symbol or inclusive start_line/end_line. Maximum 80 physical lines; larger symbols require explicit windows. Returns numbered content and whole-file sha256. Use read_file first for metadata and symbol names.",
  input_schema: { type: "object", required: ["file_path"], additionalProperties: false,
    properties: { file_path: { type: "string", minLength: 1 }, symbol: { type: "string", minLength: 1 }, start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 } },
    oneOf: [{ required: ["symbol"] }, { required: ["start_line", "end_line"] }] }
});

// Reads exact source evidence for implementation and review without shell access;
// rechecks scope after asynchronous reads so revoked authority cannot deliver code.
export function createSourceReadTool({ fileService, projectRoot, codeCache }) {
  return { execute: async (input = {}, context = {}) => {
    assertExecutionFileAccess(context);
    if (Object.keys(input).some((key) => !["file_path", "symbol", "start_line", "end_line"].includes(key))) throw invalid("Read accepts file_path and either symbol or start_line/end_line.");
    const value = input.file_path;
    if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")) throw invalid("Read requires a valid file_path.");
    const path = isAbsolute(value) ? relative(resolve(projectRoot), resolve(value)).split(sep).join("/") : value.replace(/^\.\//, "");
    if (!path || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) throw invalid("Read path is outside the project.");
    if (!isAgentPathAllowed(path, context)) throw invalid("Read path is outside the issued scope.");
    const bySymbol = input.symbol !== undefined;
    if (bySymbol && (typeof input.symbol !== "string" || !input.symbol || input.start_line !== undefined || input.end_line !== undefined)) throw invalid("Read symbol cannot be combined with line bounds.");
    let start = input.start_line, end = input.end_line;
    if (!bySymbol && (!Number.isInteger(start) || start < 1 || !Number.isInteger(end) || end < start || end - start + 1 > 80)) throw invalid("Read requires an inclusive window of at most 80 lines.");
    const file = codeCache ? await codeCache.read({ path }) : await fileService.readForIndex({ path, maxBytes: 1_000_000 });
    assertExecutionFileAccess(context);
    if (!isAgentPathAllowed(path, context)) throw invalid("Read authority changed before delivery.");
    if (bySymbol) {
      const symbol = resolveSymbolWindow(file, path, input.symbol);
      if (!symbol) throw invalid("Read symbol is absent from current source; refresh read_file metadata.");
      start = symbol.start_line; end = symbol.end_line;
      if (!Number.isInteger(start) || start < 1 || !Number.isInteger(end) || end < start || end - start + 1 > 80) throw invalid("Read symbol exceeds 80 lines; use explicit start_line/end_line windows.");
    }
    const lines = file.content.split("\n");
    if (start > lines.length) throw invalid(`Read start_line exceeds the file (${lines.length} lines).`);
    recordRead(context, { path, window: bySymbol ? input.symbol : `${start}-${end}` });
    return { path, file_path: path, content: lines.slice(start - 1, end).map((line, index) => `${String(start + index).padStart(6)}→${line}`).join("\n"), sha256: file.sha256,
      start_line: start, end_line: Math.min(end, lines.length), total_lines: lines.length, truncated: end < lines.length, ...(bySymbol ? { symbol: input.symbol } : {}),
      ...(codeCache ? { cache: file.cache, index_status: file.index_status } : {}), discovery_budget: discoveryNotice(context) };
  } };
}

// Gives all providers the same actionable failure when a requested read is invalid.
function invalid(message) { return Object.assign(new ConfigurationError(message), { code: "READ_INPUT_INVALID" }); }
