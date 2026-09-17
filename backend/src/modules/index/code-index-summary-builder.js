// Summary: Assembles checksum-verified file summaries from File Service content and Code Index symbols/dependencies for LLM context.
import { createHash } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";

/** Builds deterministic, token-efficient file context from File Service and Code Index data. */
export function createCodeIndexSummaryBuilder({ fileService, indexDb } = {}) {
  if (!fileService || typeof fileService.readFile !== "function") throw new ConfigurationError("Summary builder requires File Service.");
  if (!indexDb || typeof indexDb.all !== "function") throw new ConfigurationError("Summary builder requires Code Index database.");
  return Object.freeze({ build });
  async function build(paths = [], { summary = true } = {}) {
    if (!Array.isArray(paths)) throw new ConfigurationError("Summary builder paths must be an array.");
    return Promise.all([...new Set(paths.filter((path) => typeof path === "string" && path))].map((path) => buildFile(path, summary)));
  }
  async function buildFile(path, summary) {
    let content;
    try {
      content = await fileService.readFile({ path });
    } catch (error) {
      // Directories (EISDIR), missing files (ENOENT) and unreadable paths must
      // not abort the round: report them as non-existent placeholders, same
      // shape buildFileContext uses for NEW/READ_ONLY plan entries. The R3
      // full-content assertion still blocks MODIFY paths that fail to load.
      return { path, exists: false, before_checksum: null, language: inferLanguage(path), size_bytes: 0, content: null };
    }
    const indexed = indexDb.all("SELECT file_id, path, language, size_bytes, sha256 FROM files WHERE path = ? LIMIT 1", [path])[0] ?? {};
    const symbols = indexed.file_id ? indexDb.all("SELECT name, kind FROM symbols WHERE file_id = ? ORDER BY start_line, name", [indexed.file_id]) : [];
    const relations = indexed.file_id ? indexDb.all("SELECT name, kind FROM imports_exports WHERE file_id = ? ORDER BY kind, name", [indexed.file_id]) : [];
    const dependencyRows = indexed.file_id ? indexDb.all("SELECT target.path AS path, edge.kind FROM dependency_edges edge JOIN files target ON target.file_id = edge.target_file_id WHERE edge.source_file_id = ? ORDER BY target.path", [indexed.file_id]) : [];
    const language = indexed.language ?? inferLanguage(path);
    return { path, exists: true, before_checksum: indexed.sha256 ? `sha256:${indexed.sha256.replace(/^sha256:/, "")}` : `sha256:${createHash("sha256").update(content).digest("hex")}`, language, size_bytes: Number(indexed.size_bytes ?? Buffer.byteLength(content)), content: summary ? summarizeFile({ path, language, content, symbols, relations, dependencyRows }) : content };
  }
}

/** Derives the canonical structural summary for one readable file. */
export function summarizeFile({ path, language = inferLanguage(path), content = "", symbols = [], relations = [], dependencyRows = [] } = {}) {
  const imports = unique(relations.filter((item) => item.kind === "import").map((item) => item.name));
  const exports = unique(relations.filter((item) => item.kind === "export").map((item) => item.name));
  const functions = unique(symbols.filter((item) => ["function", "hook", "method"].includes(item.kind)).map((item) => item.name));
  const components = unique(symbols.filter((item) => ["component", "function"].includes(item.kind) && /^[A-Z]/.test(item.name)).map((item) => item.name));
  const jsxElements = unique([...content.matchAll(/<([A-Z][A-Za-z0-9._-]*|(?:header|nav|main|body|html|button|a|div|section|form))\b/g)].map((match) => match[1]));
  const cssVariables = unique([...content.matchAll(/--[A-Za-z0-9_-]+/g)].map((match) => match[0]));
  const routes = path.includes("/app/") ? [path.replace(/^.*\/app\//, "/").replace(/\/(?:page|layout)\.(?:jsx?|tsx?)$/, "") || "/"] : [];
  const dependencies = unique(dependencyRows.map((item) => item.path).filter(Boolean));
  const relationships = unique([...relations.map((item) => `${item.kind}:${item.name}`), ...dependencyRows.map((item) => `${item.kind ?? "dependency"}:${item.path}`).filter((item) => !item.endsWith(":undefined"))]);
  const modificationPoints = unique([...symbols.filter((item) => ["function", "hook", "method", "component", "class", "export"].includes(item.kind)).map((item) => item.name), ...cssVariables]);
  return { type: fileType(language, path), role: fileRole(path), exports, imports, components, functions, routes, jsx_elements: jsxElements, css_variables: cssVariables, dependencies, relationships, modification_points: modificationPoints };
}

function unique(values) { return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))]; }
export function inferLanguage(path) { const extension = path.split(".").pop()?.toLowerCase(); return extension === "js" || extension === "jsx" ? "javascript" : extension ?? "text"; }
function fileType(language, path) { if (/css|scss|less/i.test(language) || /\.(?:css|scss|less)$/.test(path)) return "Stylesheet"; if (/json/i.test(language) || path.endsWith("package.json")) return "JSON manifest"; if (/javascript|typescript|jsx|tsx/i.test(language)) return "JavaScript/React source"; return "Source file"; }
function fileRole(path) { if (path.endsWith("package.json")) return "Package manifest"; if (/\/(?:page|layout)\./.test(path)) return "Application route/layout"; if (path.includes("/components/")) return "Reusable component"; if (/\.(?:css|scss|less)$/.test(path)) return "Global stylesheet"; return "Repository source"; }
