// Recreates Claude's Read, Glob, and Grep file discovery calls under Forge File Service governance.
import picomatch from "picomatch";
import { runInNewContext } from "node:vm";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ConfigurationError } from "../shared/errors.js";
import { isAgentPathAllowed } from "./tool-authorization.js";

const MAX_FILES = 3000;
const MAX_OUTPUT = 500;
const MAX_READ_LINES = 80;
const pathSchema = { type: "string", minLength: 1 };

export const claudeFileDefinitions = Object.freeze([
  { name: "Read", description: "Read project source between inclusive start_line and end_line from Code Cache and return numbered lines and a whole-file checksum. Use read_file first for the current symbol map.", input_schema: { type: "object", required: ["file_path", "start_line", "end_line"], additionalProperties: false, properties: { file_path: pathSchema, start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 } } } },
  { name: "Glob", description: "Find project files matching a glob pattern under an optional directory path. Ignored and private files are excluded.", input_schema: { type: "object", required: ["pattern"], additionalProperties: false, properties: { pattern: pathSchema, path: pathSchema } } },
  { name: "Grep", description: "Search project file contents with a regular expression. Supports Claude-style output_mode, context, file filters, and pagination.", input_schema: { type: "object", required: ["pattern"], additionalProperties: false, properties: { pattern: pathSchema, path: pathSchema, glob: pathSchema, type: pathSchema, output_mode: { type: "string", enum: ["content", "files_with_matches", "count"] }, "-A": { type: "integer", minimum: 0, maximum: 100 }, "-B": { type: "integer", minimum: 0, maximum: 100 }, "-C": { type: "integer", minimum: 0, maximum: 100 }, "-n": { type: "boolean" }, "-i": { type: "boolean" }, head_limit: { type: "integer", minimum: 1, maximum: MAX_OUTPUT }, offset: { type: "integer", minimum: 0 }, multiline: { type: "boolean" } } } }
]);

// Creates governed Claude-shaped readers without exposing direct filesystem calls to an agent.
export function createClaudeFileTools({ fileService, projectRoot, codeCache }) {
  if (!fileService?.readForIndex || !fileService?.listFiles || !projectRoot) throw new ConfigurationError("Claude file tools require File Service and project root.");
  return {
    Read: { execute: (input, context) => read(input, context) },
    Glob: { execute: (input, context) => glob(input, context) },
    Grep: { execute: (input, context) => grep(input, context) }
  };

  // Reads bounded text lines while preserving the File Service checksum for later edits.
  async function read(input = {}, context = {}) {
    const path = scopedPath(input.file_path, false);
    assertScope(path, context);
    const start = input.start_line;
    const end = input.end_line;
    if (!Number.isInteger(start) || start < 1 || !Number.isInteger(end) || end < start || end - start + 1 > MAX_READ_LINES || input.offset !== undefined || input.limit !== undefined) throw invalid("Read start_line or end_line is invalid (maximum 80 lines).");
    const file = codeCache ? await codeCache.read({ path }) : await fileService.readForIndex({ path, maxBytes: 1_000_000 });
    const lines = file.content.split("\n");
    if (start > lines.length) throw invalid(`Read start_line exceeds the file (${lines.length} lines).`);
    const slice = lines.slice(start - 1, end);
    return { file_path: path, content: slice.map((line, index) => `${String(start + index).padStart(6)}→${line}`).join("\n"), sha256: file.sha256, total_lines: lines.length, truncated: end < lines.length, ...(codeCache ? { cache: file.cache, index_status: file.index_status } : {}) };
  }

  // Matches visible project files using Claude's pattern and optional search directory.
  async function glob(input = {}, context = {}) {
    const pattern = validPattern(input.pattern);
    const directory = scopedPath(input.path ?? ".", true);
    const matcher = picomatch(pattern, { dot: false });
    const files = await visibleFiles(directory);
    const matches = files.filter((path) => within(path, directory) && inScope(path, context) && (matcher(path) || matcher(relativePath(path, directory))));
    return { files: matches.slice(0, MAX_OUTPUT), total: matches.length, truncated: matches.length > MAX_OUTPUT };
  }

  // Searches bounded, File Service approved text files and returns Claude's three output modes.
  async function grep(input = {}, context = {}) {
    const directory = scopedPath(input.path ?? ".", true);
    const pattern = validPattern(input.pattern);
    const mode = input.output_mode ?? "files_with_matches";
    if (!["content", "files_with_matches", "count"].includes(mode)) throw invalid("Grep output_mode is invalid.");
    const flags = `g${input["-i"] ? "i" : ""}${input.multiline ? "s" : ""}`;
    try { new RegExp(pattern, flags); } catch (error) { throw invalid(`Grep pattern is invalid: ${error.message}`); }
    const filter = input.glob ? picomatch(validPattern(input.glob), { dot: false, basename: true }) : null;
    const extensions = input.type ? typeExtensions(input.type) : null;
    const before = input["-C"] ?? input["-B"] ?? 0;
    const after = input["-C"] ?? input["-A"] ?? 0;
    for (const value of [before, after, input.offset ?? 0, input.head_limit ?? MAX_OUTPUT]) if (!Number.isInteger(value) || value < 0) throw invalid("Grep context or pagination is invalid.");
    if (before > 100 || after > 100 || (input.head_limit ?? MAX_OUTPUT) > MAX_OUTPUT) throw invalid("Grep result limit is exceeded.");
    const results = [];
    for (const path of await visibleFiles(directory)) {
      if (!within(path, directory) || !inScope(path, context) || (filter && !filter(path)) || (extensions && !extensions.some((ext) => path.endsWith(ext)))) continue;
      let file;
      try { file = codeCache ? await codeCache.read({ path }) : await fileService.readForIndex({ path, maxBytes: 1_000_000 }); }
      catch (error) { if (["FILE_ROLE_FORBIDDEN", "ENOENT", "FILE_TOO_LARGE"].includes(error.code) || /Refusing to index binary file/.test(error.message)) continue; throw error; }
      const lines = file.content.split("\n");
      const matches = matchLines(file.content, pattern, flags, input.multiline === true);
      if (!matches.length) continue;
      if (mode === "files_with_matches") results.push(path);
      else if (mode === "count") results.push({ path, count: matches.length });
      else for (const index of matches) {
        const start = Math.max(0, index - before);
        const end = Math.min(lines.length, index + after + 1);
        results.push({ path, line: index + 1, content: lines.slice(start, end).map((text, at) => ({ line: start + at + 1, text })) });
      }
      if (results.length > (input.offset ?? 0) + (input.head_limit ?? MAX_OUTPUT)) break;
    }
    const offset = input.offset ?? 0;
    const limit = input.head_limit ?? MAX_OUTPUT;
    return { output_mode: mode, matches: results.slice(offset, offset + limit), total: results.length, truncated: results.length > offset + limit };
  }

  // Lists only paths approved by the role-scoped File Service.
  async function visibleFiles(directory) {
    const files = await fileService.listFiles({ glob: directory === "." ? "**/*" : `${directory}/**/*` });
    if (files.length > MAX_FILES) throw invalid(`Project contains more than ${MAX_FILES} visible files; narrow the search path.`);
    return files.sort();
  }

  // Keeps absolute Claude paths within the current project and converts them for File Service.
  function scopedPath(value, allowRoot) {
    if (allowRoot && (value === "." || value === undefined)) return ".";
    if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")) throw invalid("File path is invalid.");
    const path = isAbsolute(value) ? relative(resolve(projectRoot), resolve(value)).split(sep).join("/") : value.replace(/^\.\//, "");
    if (!path || path === "." || path.startsWith("../") || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))) throw invalid("File path is outside the permitted project scope.");
    return path;
  }
}

// Limits Claude coder discovery to the ticket's approved files and directory prefixes.
function inScope(path, context) {
  return isAgentPathAllowed(path, context);
}

// Refuses direct reads beyond the ticket scope even when the path is inside the project.
function assertScope(path, context) {
  if (!inScope(path, context)) throw Object.assign(new ConfigurationError(`File is outside the approved ticket scope: ${path}.`), { code: "TOOL_RESOURCE_FORBIDDEN" });
}

// Rejects unsafe or unbounded pattern arguments before any project files are listed.
function validPattern(value) {
  if (typeof value !== "string" || !value || value.length > 500 || value.includes("\0") || value.includes("\\") || value.startsWith("/") || value.split("/").some((part) => part === "..")) throw invalid("Search pattern is invalid.");
  return value;
}

// Tests whether a project-relative file belongs to the selected directory.
function within(path, directory) { return directory === "." || path.startsWith(`${directory}/`); }

// Converts a project-relative file path to the selected directory's relative form.
function relativePath(path, directory) { return directory === "." ? path : path.slice(directory.length + 1); }

// Maps Claude's common type filters to file extensions without exposing ignored files.
function typeExtensions(type) {
  const types = { js: [".js", ".jsx", ".mjs", ".cjs"], ts: [".ts", ".tsx", ".mts", ".cts"], py: [".py"], json: [".json"], md: [".md"], css: [".css"], html: [".html", ".htm"] };
  if (!types[type]) throw invalid(`Grep type is unsupported: ${type}`);
  return types[type];
}

// Bounds regex execution so an agent search pattern cannot stall the Control API process.
function matchLines(content, pattern, flags, multiline) {
  try {
    return runInNewContext(`const expression = new RegExp(pattern, flags); const hits = []; if (multiline) { for (const match of content.matchAll(expression)) hits.push(content.slice(0, match.index).split("\\n").length - 1); } else { const lines = content.split("\\n"); for (let index = 0; index < lines.length; index++) { expression.lastIndex = 0; if (expression.test(lines[index])) hits.push(index); } } hits`, { content, pattern, flags, multiline }, { timeout: 100 });
  } catch (error) {
    if (error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") throw Object.assign(new ConfigurationError("Grep pattern exceeded its execution time limit."), { code: "GREP_TIMEOUT" });
    throw error;
  }
}

// Gives rejected Claude-shaped file requests a stable error code for logs and agent results.
function invalid(message) { return Object.assign(new ConfigurationError(message), { code: "CLAUDE_FILE_INPUT_INVALID" }); }
