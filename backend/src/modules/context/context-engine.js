import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ConfigurationError } from "../../shared/errors.js";
import { createSecretPathMatcher } from "./secret-paths.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../schemas/core/common.schema.json");
const contextSchema = require("../../../schemas/context/context.schema.json");

export class ContextStaleError extends ConfigurationError {
  constructor(message = "The Code Index changed while the Context Pack was being generated.") {
    super(message);
    this.name = "ContextStaleError";
    this.code = "CONTEXT_STALE";
  }
}

export function createContextEngine({ database, projectRoot, projectId, clock = () => new Date(), validatePack = createContextPackValidator(), config = {} } = {}) {
  if (!database?.all || typeof projectRoot !== "string" || projectRoot.length === 0 || typeof projectId !== "string" || projectId.length === 0) {
    throw new ConfigurationError("A Code Index database, project root, and project_id are required for Context Engine.");
  }
  if (typeof clock !== "function" || typeof validatePack !== "function") throw new ConfigurationError("Context Engine dependencies must be functions.");
  const isSecretPath = createSecretPathMatcher(config.secretsPatterns);

  return Object.freeze({ build });

  async function build(request = {}) {
    const normalized = normalizeRequest(request);
    const initialVersion = getIndexVersion();
    if (normalized.expectedIndexVersion !== undefined && normalized.expectedIndexVersion !== initialVersion) {
      throw new ContextStaleError(`Requested index_version ${normalized.expectedIndexVersion} does not match current ${initialVersion}.`);
    }

    const selected = selectIndexRecords(normalized);
    if (selected.symbols.length === 0 && selected.files.length === 0) throw new ConfigurationError("Context request did not match an indexed symbol, file, or line range.");
    const files = await materializeFiles(selected.files);
    const finalVersion = getIndexVersion();
    if (finalVersion !== initialVersion) throw new ContextStaleError();

    const dependencies = deduplicateDependencies(selected.dependencies);
    const actualTokenCount = estimateTokens(files, dependencies);
    if (actualTokenCount > normalized.maxTokens) {
      throw new ConfigurationError(`Context budget exceeded: approximately ${actualTokenCount} tokens requested, limit is ${normalized.maxTokens}. Narrow the symbol, path, or line-range selection.`);
    }
    const pack = {
      schema_version: "1.2.0",
      project_id: projectId,
      task_id: normalized.taskId,
      purpose: normalized.purpose,
      index_version: initialVersion,
      generated_at: clock().toISOString(),
      files,
      symbols: deduplicateSymbols(selected.symbols),
      dependencies,
      project_summary: summarizeSelection(selected),
      compression: {
        strategy: ["symbol_selection", "dependency_selection", "line_range_selection", "deduplication", "structural_summary"],
        source_preservation: true,
        minify_source: false
      },
      budget: {
        max_tokens: normalized.maxTokens,
        estimated_tokens: actualTokenCount,
        actual_token_count: actualTokenCount
      }
    };
    if (normalized.sessionId !== undefined) pack.session_id = normalized.sessionId;
    validatePack(pack);
    return Object.freeze(pack);
  }

  function selectIndexRecords(request) {
    const files = [];
    const symbols = [];
    const dependencies = [];
    const rangesByPath = new Map();
    const addFile = (file, reason, range) => {
      if (!file) return;
      if (isSecretPath(file.path)) return;
      const entry = rangesByPath.get(file.path) ?? { file, reasons: new Set(), ranges: [] };
      entry.reasons.add(reason);
      if (range) entry.ranges.push(range);
      rangesByPath.set(file.path, entry);
    };

    for (const selector of request.symbols) {
      const matches = selector.file
        ? database.all("SELECT s.symbol_id, s.name, s.kind, s.start_line, s.end_line, f.file_id, f.path, f.sha256 FROM symbols s JOIN files f ON f.file_id = s.file_id WHERE s.name = ? AND f.path = ? ORDER BY s.start_line", [selector.name, selector.file])
        : database.all("SELECT s.symbol_id, s.name, s.kind, s.start_line, s.end_line, f.file_id, f.path, f.sha256 FROM symbols s JOIN files f ON f.file_id = s.file_id WHERE s.name = ? ORDER BY f.path, s.start_line", [selector.name]);
      if (matches.length === 0) throw new ConfigurationError(`Indexed symbol not found: ${selector.name}${selector.file ? ` in ${selector.file}` : ""}`);
      for (const match of matches) {
        if (isSecretPath(match.path)) continue;
        const file = { file_id: match.file_id, path: match.path, sha256: match.sha256 };
        symbols.push({ file: match.path, name: match.name, kind: match.kind, start_line: match.start_line, end_line: match.end_line });
        addFile(file, "selected symbol", { start: match.start_line, end: match.end_line });
        if (request.includeDependencies) collectDependencies(match.file_id, file.path, addFile, dependencies);
      }
    }
    for (const lineRange of request.lineRanges) {
      if (isSecretPath(lineRange.path)) continue;
      const file = database.all("SELECT file_id, path, sha256 FROM files WHERE path = ?", [lineRange.path])[0];
      if (!file) throw new ConfigurationError(`Indexed file not found: ${lineRange.path}`);
      addFile(file, "requested line range", { start: lineRange.start, end: lineRange.end });
      if (request.includeDependencies) collectDependencies(file.file_id, file.path, addFile, dependencies);
    }
    for (const path of request.paths) {
      if (isSecretPath(path)) continue;
      const file = database.all("SELECT file_id, path, sha256 FROM files WHERE path = ?", [path])[0];
      if (!file) throw new ConfigurationError(`Indexed file not found: ${path}`);
      addFile(file, "selected file");
      if (request.includeDependencies) collectDependencies(file.file_id, file.path, addFile, dependencies);
    }
    for (const entry of rangesByPath.values()) files.push(entry);
    return { files, symbols, dependencies };
  }

  function collectDependencies(fileId, sourcePath, addFile, dependencies) {
    const rows = database.all(
      `SELECT target.file_id, target.path, target.sha256, target_symbol.name, target_symbol.kind, target_symbol.start_line, target_symbol.end_line
       FROM dependency_edges edge
       JOIN files target ON target.file_id = edge.target_file_id
       LEFT JOIN symbols target_symbol ON target_symbol.file_id = target.file_id
       WHERE edge.source_file_id = ? AND edge.is_broken = 0
       ORDER BY target.path, target_symbol.start_line, target_symbol.name`,
      [fileId]
    );
    for (const row of rows) {
      if (isSecretPath(row.path)) continue;
      addFile({ file_id: row.file_id, path: row.path, sha256: row.sha256 }, "dependency signature");
      const symbol = row.name ?? row.path;
      dependencies.push({ symbol, signature: row.name ? `${row.kind ?? "symbol"} ${row.name}` : row.path, file: row.path });
    }
    return sourcePath;
  }

  async function materializeFiles(entries) {
    const result = [];
    for (const entry of entries) {
      const content = await readIndexedContent(entry.file.path, entry.file.sha256, entry.ranges);
      const contentMode = entry.ranges.length > 0 ? "excerpt" : "signature";
      result.push({
        path: entry.file.path,
        reason: [...entry.reasons].join("; "),
        ...(content ? { content, content_mode: contentMode } : {}),
        ...(entry.ranges.length > 0 ? { start_line: Math.min(...entry.ranges.map(({ start }) => start)), end_line: Math.max(...entry.ranges.map(({ end }) => end)) } : {}),
        ...(entry.file.sha256 ? { sha256: entry.file.sha256 } : {})
      });
    }
    return result;
  }

  async function readIndexedContent(path, expectedHash, ranges) {
    const absolutePath = resolve(projectRoot, path);
    const relativePath = relative(projectRoot, absolutePath);
    if (!relativePath || relativePath.startsWith("..") || resolve(projectRoot, relativePath) !== absolutePath) throw new ConfigurationError("Context path must stay within the project root.");
    const source = await readFile(absolutePath, "utf8");
    if (expectedHash && createHash("sha256").update(source).digest("hex") !== expectedHash) {
      throw new ContextStaleError(`Indexed content is stale for ${path}.`);
    }
    if (ranges.length === 0) {
      const signatureRows = database.all("SELECT kind, name FROM symbols WHERE file_id = (SELECT file_id FROM files WHERE path = ?) ORDER BY start_line, name", [path]);
      return signatureRows.map(({ kind, name }) => `${kind} ${name}`).join("\n");
    }
    const lines = source.split(/\r?\n/);
    const start = Math.max(1, Math.min(...ranges.map(({ start: value }) => value)));
    const end = Math.min(lines.length, Math.max(...ranges.map(({ end: value }) => value)));
    return lines.slice(start - 1, end).join("\n");
  }

  function getIndexVersion() {
    const row = database.all("SELECT version FROM index_metadata LIMIT 1")[0];
    return `IDX-${row?.version ?? 0}`;
  }
}

export function createContextPackValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(contextSchema);
  const validate = ajv.getSchema(contextSchema.$id);
  return (pack) => {
    if (!validate(pack)) throw new ConfigurationError(`Invalid Context Pack: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
    return true;
  };
}

function normalizeRequest(request) {
  const symbols = (request.symbols ?? (request.symbol ? [request.symbol] : [])).map((selector) => typeof selector === "string" ? { name: selector } : selector);
  const lineRanges = request.line_ranges ?? request.lineRanges ?? [];
  const paths = request.paths ?? (request.path ? [request.path] : []);
  if (typeof request.task_id !== "string" && typeof request.taskId !== "string") throw new ConfigurationError("Context request requires task_id.");
  if (symbols.some(({ name }) => typeof name !== "string" || name.length === 0)) throw new ConfigurationError("Context symbol selectors require a name.");
  for (const range of lineRanges) {
    if (typeof range?.path !== "string" || !Number.isInteger(range.start_line ?? range.start) || !Number.isInteger(range.end_line ?? range.end)) throw new ConfigurationError("Context line ranges require path, start_line, and end_line.");
    const start = range.start_line ?? range.start;
    const end = range.end_line ?? range.end;
    if (start < 1 || end < start) throw new ConfigurationError("Context line range is invalid.");
  }
  return {
    taskId: request.task_id ?? request.taskId,
    sessionId: request.session_id ?? request.sessionId,
    purpose: request.purpose ?? "custom",
    symbols,
    lineRanges: lineRanges.map((range) => ({ path: range.path, start: range.start_line ?? range.start, end: range.end_line ?? range.end })),
    paths,
    includeDependencies: request.include_dependencies ?? request.includeDependencies ?? true,
    expectedIndexVersion: request.index_version ?? request.indexVersion,
    maxTokens: request.budget?.max_tokens ?? request.max_tokens ?? defaultBudget(request)
  };
}

function defaultBudget(request) {
  const role = String(request.agent_role ?? request.agentRole ?? request.domain ?? "").toLowerCase();
  if (role.includes("reviewer")) return 30000;
  if (role.includes("builder")) return 40000;
  return 12000;
}

function deduplicateSymbols(symbols) {
  const seen = new Set();
  return symbols.filter((symbol) => {
    const key = `${symbol.file}\u0000${symbol.name}\u0000${symbol.start_line}\u0000${symbol.end_line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deduplicateDependencies(dependencies) {
  const seen = new Set();
  return dependencies.filter((dependency) => {
    const key = `${dependency.file}\u0000${dependency.symbol}\u0000${dependency.signature}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Approximation only: source bytes and dependency signatures divided by four.
function estimateTokens(files, dependencies) {
  const contentLength = files.reduce((total, file) => total + (file.content?.length ?? 0), 0);
  const dependencyLength = dependencies.reduce((total, dependency) => total + dependency.signature.length, 0);
  return Math.ceil((contentLength + dependencyLength) / 4);
}

function summarizeSelection({ files, symbols, dependencies }) {
  return `Selected ${symbols.length} symbol(s), ${files.length} indexed file(s), and ${dependencies.length} dependency signature(s).`;
}
