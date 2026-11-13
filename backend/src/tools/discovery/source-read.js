// Provides every Forge agent with one governed source reader so discovery metadata
// cannot become an unbounded code channel. Reads use the live Code Cache when
// available, retain role and execution boundaries, and resolve symbols against
// current source before returning exactly the selected symbol or a bounded document window.
import { isAbsolute, relative, resolve, sep } from "node:path";
import { assertDelegatedDiscoveryRequired } from "./delegated-discovery-policy.js";
import { ConfigurationError } from "../../shared/errors.js";
import { assertExecutionFileAccess } from "../execution-file-access.js";
import { isAgentPathAllowed } from "../governance/tool-authorization.js";
import { sourceMetadataSymbol, recordSourceSymbolRead } from "./source-metadata-receipts.js";
import { createHash } from "node:crypto";
import { extractorRegistry } from "../../modules/index/parser/index.js";
import { recordRead, discoveryNotice } from "./exploration-state.js";
import { readDeduplicationKey, readWithDeduplication } from "./read-deduplication.js";

// Advertises a provider-neutral read contract with mutually exclusive symbol and line selectors.
export const sourceReadDefinition = Object.freeze({ name: "Read",
  description: "Read .md documents by inclusive start_line/end_line (maximum 80 lines). Code requires read_file metadata and scoped code_graph first, then file_path and a symbol from its symbol_map. Code line windows are forbidden; returns the complete selected symbol without a line-count cap. Returns numbered content and whole-file sha256.",
  input_schema: { type: "object", required: ["file_path"], additionalProperties: false,
    properties: { file_path: { type: "string", minLength: 1 }, symbol: { type: "string", minLength: 1 }, start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 } },
    oneOf: [{ required: ["symbol"] }, { required: ["start_line", "end_line"] }] }
});

// Reads exact source evidence for implementation and review without shell access;
// rechecks scope after asynchronous reads so revoked authority cannot deliver code.
export function createSourceReadTool({ fileService, projectRoot, codeCache }) {
  return { execute: async (input = {}, context = {}) => {
    assertDelegatedDiscoveryRequired(context, "Read", input);
    assertExecutionFileAccess(context);
    if (Object.keys(input).some((key) => !["file_path", "symbol", "start_line", "end_line"].includes(key))) throw invalid("Read accepts file_path and either symbol or start_line/end_line.");
    const value = input.file_path;
    if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")) throw invalid("Read requires a valid file_path.");
    const path = isAbsolute(value) ? relative(resolve(projectRoot), resolve(value)).split(sep).join("/") : value.replace(/^\.\//, "");
    if (!path || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) throw invalid("Read path is outside the project.");
    if (!isAgentPathAllowed(path, context)) throw invalid("Read path is outside the issued scope.");
    const bySymbol = input.symbol !== undefined;
    if (!/\.md$/i.test(path) && !bySymbol) throw invalid("Code line windows are forbidden. Call read_file, inspect code_graph and symbol_map, then Read with file_path and symbol.");
    if (/\.md$/i.test(path) && bySymbol) throw invalid("Markdown requires start_line/end_line instead of symbol.");
    if (bySymbol && (typeof input.symbol !== "string" || !input.symbol || input.start_line !== undefined || input.end_line !== undefined)) throw invalid("Read symbol cannot be combined with line bounds.");
    let start = input.start_line, end = input.end_line;
    if (!bySymbol && (!Number.isInteger(start) || start < 1 || !Number.isInteger(end) || end < start || end - start + 1 > 80)) throw invalid("Read requires an inclusive window of at most 80 lines.");
    const readKey = readDeduplicationKey({ projectRoot, projectId: context.project_id, conversationId: context.conversation_id, delegationId: context.execution_id ?? context.task_id, path, tool: "source", symbol: bySymbol ? input.symbol : `${start}-${end}` });
    // Symbol delivery always re-reads the authorized source, never a cached body or supplied hash.
    const file = bySymbol
      ? await fileService.readForIndex({ path, maxBytes: 1_000_000 })
      : await readWithDeduplication({ key: readKey, context, path, read: () => codeCache ? codeCache.read({ path }) : fileService.readForIndex({ path, maxBytes: 1_000_000 }) });
    if (typeof file?.content !== "string") throw invalid("Current source bytes are unavailable.");
    file.sha256 = `sha256:${createHash("sha256").update(file.content).digest("hex")}`;
    assertExecutionFileAccess(context);
    if (!isAgentPathAllowed(path, context)) throw invalid("Read authority changed before delivery.");
    if (bySymbol) {
      const symbol = sourceMetadataSymbol(context, path, input.symbol, file.sha256);
      if (!symbol) throw invalid("Read requires current read_file metadata and a symbol from its symbol_map. Inspect code_graph before selecting code.");
      const currentSymbol = extractorRegistry.extract(path, file.content).symbols?.find((item) => item.name === input.symbol);
      start = symbol.start_line; end = symbol.end_line;
      if (!Number.isInteger(start) || start < 1 || !Number.isInteger(end) || end < start || end > file.content.split("\n").length
        || !currentSymbol || currentSymbol.start_line !== start || currentSymbol.end_line !== end) throw invalid("Read symbol has invalid or stale source bounds; refresh read_file metadata.");
    }
    const lines = file.content.split("\n");
    if (start > lines.length) throw invalid(`Read start_line exceeds the file (${lines.length} lines).`);
    if (bySymbol) recordSourceSymbolRead(context, path, input.symbol, file.sha256);
    recordRead(context, { path, window: bySymbol ? input.symbol : `${start}-${end}` });
    const observed = Array.isArray(context.observed_files) ? context.observed_files : [];
    const current = observed.find((item) => item.path === path);
    const symbolsRead = bySymbol ? [input.symbol] : [];
    if (current) { current.sha256 = file.sha256; current.symbols_read = [...new Set([...(current.symbols_read ?? []), ...symbolsRead])]; }
    else context.observed_files = [...observed, { path, sha256: file.sha256, symbols_read: symbolsRead, source_tool: "Read" }];
    return { path, file_path: path, content: lines.slice(start - 1, end).map((line, index) => `${String(start + index).padStart(6)}→${line}`).join("\n"), sha256: file.sha256, observed_file: { path, sha256: file.sha256, symbols_read: symbolsRead },
      start_line: start, end_line: Math.min(end, lines.length), total_lines: lines.length, truncated: end < lines.length, ...(bySymbol ? { symbol: input.symbol } : {}),
      ...(codeCache ? { cache: file.cache, index_status: file.index_status } : {}), read_deduplication: file.read_deduplication, discovery_budget: discoveryNotice(context) };
  } };
}

// Gives all providers the same actionable failure when a requested read is invalid.
function invalid(message) { return Object.assign(new ConfigurationError(message), { code: "READ_INPUT_INVALID" }); }
