// Orchestrates Agent Coder English comment normalization and rollback safety during project intake.
// Business purpose: scans imported source files for missing or non-English header and symbol comments, coordinates Agent Coder to add English descriptions (`comment_language: "en"`) prior to AST/summary/embedding indexing, and rolls back any attempt to split files or alter executable code.
// Technical description: walks non-ignored supported project files, synthesizes or delegates English purpose comments, enforces `validateCommentOnlyMutation` and file-tree invariants, and emits real-time progress onto the project event bus.
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { createProjectIgnoreMatcher } from "../../infrastructure/filesystem/watcher.js";
import { extractorRegistry } from "../index/parser/index.js";
import { purposeComments, purposeCommentBefore } from "../index/parser/purpose-comments.js";
import { readContentHash } from "../watcher/debounced-watcher.js";
import {
  assertCommentOnlyMutation,
  commentModeForPath,
  inspectFileCommentNeeds,
  isEnglishComment,
  stripCommentsToExecutableCode,
  validateCommentOnlyMutation
} from "./project-comment-integrity.js";

export {
  assertCommentOnlyMutation,
  commentModeForPath,
  inspectFileCommentNeeds,
  isEnglishComment,
  stripCommentsToExecutableCode,
  validateCommentOnlyMutation
};

const DOCUMENTED_SYMBOL_KINDS = new Set(["function", "method", "hook", "component", "class", "interface", "trait"]);

// Formats a single-line or block English comment using the target language's comment delimiters.
// Business purpose: ensures generated English comments match the lexical syntax expected by the Code Index parser for JavaScript, TypeScript, PHP, and CSS.
// Technical description: emits `/* ... */` for CSS or existing block comments and `// ...` for JavaScript, TypeScript, and PHP line comments.
function formatCommentText(summary, mode, preferBlock = false, indent = "") {
  return mode === "css" || preferBlock ? `${indent}/* ${summary} */` : `${indent}// ${summary}`;
}

// Synthesizes a concise English file header comment and symbol purpose comments while preserving all executable lines.
// Business purpose: provides safe default Agent Coder English comment normalization (`comment_language: "en"`) for imported source files without altering any executable statements or splitting files > 250 lines.
// Technical description: replaces non-English purpose comments in-place and inserts missing symbol and file header comments from bottom to top so line indices and AST tokens remain intact.
export function generateEnglishCommentsForFile(filePath, source, { commentLanguage = "en", registry = extractorRegistry } = {}) {
  if (typeof source !== "string" || !registry.supports(filePath)) return source;
  const mode = commentModeForPath(filePath);
  const fileLabel = basename(filePath);
  let current = source.replace(/\r\n?/g, "\n");
  let doc = purposeComments(current, mode);
  if (doc.error) return source;

  if (commentLanguage === "en") {
    const replacements = doc.comments
      .filter((comment) => !isEnglishComment(comment.summary))
      .map((comment) => ({
        start: comment.start,
        end: comment.end,
        text: formatCommentText(
          doc.header === comment
            ? `Provides module implementation and exported declarations for ${fileLabel}.`
            : `Executes documented symbol logic in ${fileLabel}.`,
          mode,
          comment.raw.trimStart().startsWith("/*"),
          ""
        )
      }))
      .sort((a, b) => b.start - a.start);
    for (const item of replacements) {
      current = current.slice(0, item.start) + item.text + current.slice(item.end);
    }
    doc = purposeComments(current, mode);
  }

  if (!doc.header || (commentLanguage === "en" && !isEnglishComment(doc.header.summary))) {
    const headerComment = formatCommentText(`Provides module declarations and business logic for ${fileLabel}.`, mode, mode === "css", "");
    if (mode === "php" && /^\s*<\?php\b/.test(current)) {
      current = current.replace(/^(\s*<\?php[^\r\n]*\r?\n?)/, `$1${headerComment}\n\n`);
    } else if (/^#![^\r\n]*\r?\n/.test(current)) {
      current = current.replace(/^(#![^\r\n]*\r?\n)/, `$1${headerComment}\n\n`);
    } else {
      current = `${headerComment}\n\n${current}`;
    }
    doc = purposeComments(current, mode);
  }

  let extraction;
  // eslint-disable-next-line no-silent-catch -- Invalid syntax is left unchanged and reported by the indexer's parse_failed diagnostic.
  try { extraction = registry.extract(filePath, current); } catch { return current; }

  const lines = current.split("\n");
  const symbolsByLine = new Map();
  for (const symbol of extraction.symbols ?? []) {
    if (!DOCUMENTED_SYMBOL_KINDS.has(symbol.kind)) continue;
    const startLine = symbol.start_line ?? symbol.startLine ?? 1;
    if (!symbolsByLine.has(startLine)) symbolsByLine.set(startLine, []);
    symbolsByLine.get(startLine).push(symbol);
  }

  for (const startLine of [...symbolsByLine.keys()].sort((a, b) => b - a)) {
    let targetLineIndex = Math.max(0, startLine - 1);
    for (const decorator of [...(doc.decorators ?? [])].sort((a, b) => b.end - a.end)) {
      const decLineIndex = current.slice(0, decorator.start).split("\n").length - 1;
      const decEndLineIndex = current.slice(0, decorator.end).split("\n").length - 1;
      if (decEndLineIndex <= targetLineIndex && targetLineIndex - decEndLineIndex <= 1) targetLineIndex = decLineIndex;
    }
    const existing = purposeCommentBefore(doc, Math.max(0, startLine - 1));
    if (existing && (commentLanguage !== "en" || isEnglishComment(existing.summary))) continue;
    const lineSyms = symbolsByLine.get(startLine);
    const names = lineSyms.map((s) => s.name).join(", ");
    const kinds = [...new Set(lineSyms.map((s) => s.kind))].join("/");
    const indent = (lines[targetLineIndex] ?? "").match(/^[ \t]*/)?.[0] ?? "";
    const commentLine = formatCommentText(`Defines ${names} ${kinds} behavior for ${fileLabel}.`, mode, false, indent);
    const needsBlank = targetLineIndex === 1 && doc.header && lines[0]?.trim().startsWith("//");
    lines.splice(targetLineIndex, 0, ...(needsBlank ? ["", commentLine] : [commentLine]));
  }

  return lines.join("\n");
}

// Walks a project directory recursively and returns all non-ignored file paths relative to projectRoot.
// Business purpose: captures the exact project file structure before and after Agent Coder normalization so file splitting (> 250 lines) or unauthorized file creation can be detected and rolled back.
// Technical description: traverses directories using `readdir({ withFileTypes: true })`, skipping ignored paths and symlinks.
async function collectProjectFiles(projectRoot, isIgnored, directory = projectRoot, results = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (isIgnored(absolutePath)) continue;
    if (entry.isDirectory()) await collectProjectFiles(projectRoot, isIgnored, absolutePath, results);
    else if (entry.isFile()) results.push(relative(projectRoot, absolutePath).split("\\").join("/"));
  }
  return results.sort();
}

// Emits a structured Agent Coder activity event onto the project event bus for live SSE streaming.
// Business purpose: allows `GET /forge/v1/stream?project=<projectId>` subscribers to observe real-time comment normalization progress while the project is in `running` state.
// Technical description: publishes a schema-compliant `agent.activity` payload onto `internalBus` when present.
function emitCoderActivity(internalBus, projectId, activityType, status, summary) {
  if (!internalBus?.emit || !projectId) return;
  internalBus.emit("agent.activity", {
    event_type: "agent.activity",
    project_id: projectId,
    timestamp: new Date().toISOString(),
    payload: { agent_id: "coder", activity_type: activityType, status, summary: summary.slice(0, 500) }
  });
}

// Scans eligible project source files and orchestrates Agent Coder to normalize missing or non-English comments into English before indexing.
// Business purpose: fulfills AC-1, AC-2, and AC-5 by ensuring imported source files have English file and symbol comments before AST extraction, Purpose Summary persistence, and vector embedding, while strictly rejecting and rolling back any executable code edits or file splitting.
// Technical description: enters the `comment_normalization` progress stage, inspects each eligible file, invokes `coderNormalizer` or the built-in English comment generator, verifies mutations via `validateCommentOnlyMutation`, restores snapshots on violation, and returns detailed file outcomes.
export async function normalizeProjectComments({
  projectRoot, projectId, database = null, ignore = [], commentLanguage = "en", registry = extractorRegistry,
  coderNormalizer = null, rejectOnViolation = true, fallbackOnViolation = false, force = false, internalBus = null, progress = null
} = {}) {
  if (progress?.stage && progress.snapshot?.().stage !== "comment_normalization") progress.stage("comment_normalization");
  emitCoderActivity(internalBus, projectId, "started", "working", "Starting English comment normalization scan.");
  const isIgnored = createProjectIgnoreMatcher(projectRoot, ignore);
  const initialFiles = await collectProjectFiles(projectRoot, isIgnored);
  const initialFileSet = new Set(initialFiles);
  const snapshots = new Map();
  for (const relPath of initialFiles) {
    if (registry.supports(relPath)) snapshots.set(relPath, await readFile(join(projectRoot, relPath), "utf8"));
  }
  const results = [];
  const violations = [];

  for (const relPath of initialFiles) {
    if (!registry.supports(relPath)) continue;
    const absolutePath = join(projectRoot, relPath);
    if (!force && !coderNormalizer && database?.all) {
      const existing = database.all("SELECT file_id, sha256 FROM files WHERE path = ?", [relPath])[0];
      const currentHash = existing ? await readContentHash(absolutePath).catch(() => null) : null;
      if (existing && currentHash && existing.sha256 === currentHash) {
        results.push({ path: relPath, status: "unchanged", normalized: false });
        continue;
      }
    }
    const beforeSource = snapshots.get(relPath) ?? await readFile(absolutePath, "utf8");
    await writeFile(absolutePath, beforeSource, "utf8");
    const inspection = inspectFileCommentNeeds(relPath, beforeSource, { commentLanguage, registry });
    if (inspection.parseError || !inspection.needsNormalization) {
      results.push({ path: relPath, status: "unchanged", normalized: false });
      continue;
    }
    emitCoderActivity(internalBus, projectId, "step_started", "working", `Normalizing English comments for ${relPath}`);
    let proposedContent = beforeSource;
    let splitAttempted = false;
    try {
      if (typeof coderNormalizer === "function") {
        const outcome = await coderNormalizer({
          projectRoot, projectId, path: relPath, absolutePath, content: beforeSource, inspection, comment_language: "en", commentLanguage: "en"
        });
        if (typeof outcome === "string") proposedContent = outcome;
        else if (outcome && typeof outcome === "object") {
          if (Array.isArray(outcome.splitFiles) && outcome.splitFiles.length > 0) splitAttempted = true;
          proposedContent = typeof outcome.content === "string" ? outcome.content : await readFile(absolutePath, "utf8");
        } else proposedContent = await readFile(absolutePath, "utf8");
      } else {
        proposedContent = generateEnglishCommentsForFile(relPath, beforeSource, { commentLanguage: "en", registry });
      }
    } catch (error) {
      await writeFile(absolutePath, beforeSource, "utf8");
      emitCoderActivity(internalBus, projectId, "failed", "failed", `Comment normalization failed for ${relPath}`);
      throw error;
    }

    const afterFiles = await collectProjectFiles(projectRoot, isIgnored);
    const extraFiles = afterFiles.filter((candidate) => !initialFileSet.has(candidate));
    const missingFiles = initialFiles.filter((candidate) => !afterFiles.includes(candidate));
    if (extraFiles.length > 0 || missingFiles.length > 0) {
      splitAttempted = true;
      for (const extra of extraFiles) await rm(join(projectRoot, extra), { force: true });
    }
    const validation = splitAttempted
      ? { valid: false, code: "FILE_SPLIT_FORBIDDEN", message: `File splitting or structure modification is forbidden for ${relPath}.` }
      : validateCommentOnlyMutation(beforeSource, proposedContent, { filePath: relPath, commentLanguage: "en", registry });

    if (!validation.valid) {
      await writeFile(absolutePath, beforeSource, "utf8");
      const violation = { path: relPath, code: validation.code, message: validation.message, rolledBack: true };
      violations.push(violation);
      emitCoderActivity(internalBus, projectId, "failed", "failed", `Rolled back unsafe mutation on ${relPath}: ${validation.code}`);
      if (fallbackOnViolation) {
        const safeContent = generateEnglishCommentsForFile(relPath, beforeSource, { commentLanguage: "en", registry });
        if (validateCommentOnlyMutation(beforeSource, safeContent, { filePath: relPath, commentLanguage: "en", registry }).valid) {
          await writeFile(absolutePath, safeContent, "utf8");
          results.push({ path: relPath, status: "normalized", normalized: true, rolledBackUnsafeAttempt: true });
          continue;
        }
      }
      if (rejectOnViolation) {
        throw Object.assign(new Error(validation.message), { code: validation.code, reasonCode: validation.code, path: relPath, rolledBack: true, violations, statusCode: 400 });
      }
      results.push({ path: relPath, status: "rolled_back", normalized: false, violation });
      continue;
    }
    if (proposedContent !== beforeSource) await writeFile(absolutePath, proposedContent, "utf8");
    emitCoderActivity(internalBus, projectId, "step_completed", "success", `Normalized English comments for ${relPath}`);
    results.push({ path: relPath, status: "normalized", normalized: true });
  }
  emitCoderActivity(internalBus, projectId, "completed", "success", "Completed English comment normalization.");
  return { succeeded: violations.length === 0, commentLanguage: "en", normalizedFiles: results.filter((r) => r.normalized).length, results, violations };
}
