// Validates source integrity and comment-only mutations during project intake comment normalization.
// Business purpose: guarantees that Agent Coder only adds or updates English descriptive comments on imported source files without altering executable statements, logic structure, or splitting files.
// Technical description: parses before/after source code and token streams across supported languages (JavaScript, TypeScript, JSX, TSX, PHP, CSS), strips lexical comments, and verifies that all executable tokens, AST structure, code line counts, and English comment rules are satisfied.
import { parse } from "@babel/parser";
import { extname } from "node:path";
import { extractorRegistry } from "../index/parser/index.js";
import { purposeComments, purposeCommentBefore, normalizePurposeComment } from "../index/parser/purpose-comments.js";
import { countBudgetLines, validateCommentLanguage } from "../../tools/agent-code-conventions.js";

const VIETNAMESE_DIACRITICS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
const DOCUMENTED_SYMBOL_KINDS = new Set(["function", "method", "hook", "component", "class", "interface", "trait"]);

// Determines the comment parser mode corresponding to a supported file extension.
// Business purpose: aligns comment scanning and mutation verification with the language-specific comment syntax used by the Code Index.
// Technical description: maps `.php` to `php`, `.css` to `css`, and JavaScript/TypeScript family extensions to `javascript`.
export function commentModeForPath(filePath) {
  const ext = extname(String(filePath ?? "")).toLowerCase();
  if (ext === ".php") return "php";
  if (ext === ".css") return "css";
  return "javascript";
}

// Checks whether a normalized comment string is written in English rather than Vietnamese or mixed language.
// Business purpose: enforces the `comment_language: "en"` requirement during project intake before AST, Purpose Summary, and embedding extraction.
// Technical description: verifies that the comment contains ASCII letters, has no Vietnamese diacritics, and passes natural-language comment validation.
export function isEnglishComment(text) {
  if (typeof text !== "string") return false;
  const trimmed = normalizePurposeComment(text);
  if (!trimmed || !/[A-Za-z]/.test(trimmed)) return false;
  if (VIETNAMESE_DIACRITICS.test(trimmed.normalize("NFC"))) return false;
  return validateCommentLanguage(trimmed);
}

// Inspects a source file to identify missing or non-English file header comments and symbol purpose comments.
// Business purpose: detects eligible imported source files that require Agent Coder English comment normalization prior to indexing.
// Technical description: runs the language extractor and purpose comment scanner to locate missing or non-English header comments and symbol-level comments.
export function inspectFileCommentNeeds(filePath, source, { commentLanguage = "en", registry = extractorRegistry } = {}) {
  if (typeof source !== "string" || !registry.supports(filePath)) {
    return { supported: false, needsNormalization: false, missingHeader: false, missingSymbols: [], nonEnglishComments: [] };
  }
  const mode = commentModeForPath(filePath);
  const doc = purposeComments(source, mode);
  if (doc.error) {
    return { supported: true, parseError: doc.error, needsNormalization: false, missingHeader: false, missingSymbols: [], nonEnglishComments: [] };
  }
  let extraction;
  try {
    extraction = registry.extract(filePath, source);
  } catch (error) {
    return { supported: true, parseError: error, needsNormalization: false, missingHeader: false, missingSymbols: [], nonEnglishComments: [] };
  }
  const checkLang = commentLanguage === "en" ? isEnglishComment : (text) => Boolean(text && text.trim());
  const missingHeader = !doc.header || !checkLang(doc.header.summary);
  const missingSymbols = [];
  const nonEnglishComments = [];
  if (doc.header && !checkLang(doc.header.summary)) {
    nonEnglishComments.push({ kind: "header", line: 1, summary: doc.header.summary });
  }
  const seenLines = new Set();
  for (const symbol of extraction.symbols ?? []) {
    if (!DOCUMENTED_SYMBOL_KINDS.has(symbol.kind)) continue;
    const startLine = symbol.start_line ?? symbol.startLine ?? 1;
    if (seenLines.has(startLine)) continue;
    seenLines.add(startLine);
    const comment = purposeCommentBefore(doc, Math.max(0, startLine - 1));
    if (!comment) {
      missingSymbols.push({ name: symbol.name, kind: symbol.kind, start_line: startLine });
    } else if (!checkLang(comment.summary)) {
      missingSymbols.push({ name: symbol.name, kind: symbol.kind, start_line: startLine, nonEnglish: true });
      nonEnglishComments.push({ kind: "symbol", name: symbol.name, line: startLine, summary: comment.summary });
    }
  }
  return {
    supported: true,
    mode,
    needsNormalization: missingHeader || missingSymbols.length > 0,
    missingHeader,
    missingSymbols,
    nonEnglishComments,
    symbols: extraction.symbols ?? []
  };
}

// Removes source position and comment attachment metadata from an AST node tree for structural comparison.
// Business purpose: ensures AST comparison detects any logic or statement modification while ignoring line number shifts caused by comment insertions.
// Technical description: recursively clones AST nodes while omitting location offsets, line coordinates, and comment arrays.
function stripAstMetadata(node) {
  if (Array.isArray(node)) return node.map(stripAstMetadata);
  if (!node || typeof node !== "object") return node;
  const cleaned = {};
  for (const [key, value] of Object.entries(node)) {
    if (["start", "end", "loc", "range", "leadingComments", "trailingComments", "innerComments", "comments", "tokens", "extra"].includes(key)) continue;
    cleaned[key] = stripAstMetadata(value);
  }
  return cleaned;
}

// Strips standalone comments and normalizes line endings to compare executable source lines across any supported language.
// Business purpose: provides a deterministic executable-code fingerprint for JavaScript, TypeScript, PHP, and CSS files so no executable line can be altered or removed.
// Technical description: removes parsed standalone comment ranges and collapses only the blank lines left by removed standalone comments.
export function stripCommentsToExecutableCode(source, mode = "javascript") {
  const doc = purposeComments(source, mode);
  if (doc.error) return { error: doc.error, executableLines: [] };
  let cursor = 0;
  let stripped = "";
  for (const comment of doc.comments) {
    stripped += source.slice(cursor, comment.start);
    cursor = comment.end;
  }
  stripped += source.slice(cursor);
  const executableLines = stripped
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return { error: null, executableLines };
}

// Compares JavaScript/TypeScript lexical tokens and AST structure between original and comment-normalized code.
// Business purpose: prevents subtle code modernization (such as `var` to `const`, arrow rewrites, or semicolon mutations) during Agent Coder comment normalization.
// Technical description: parses both sources with Babel token and AST extraction and verifies identical non-comment token sequences and metadata-stripped AST trees.
function verifyJavaScriptIntegrity(beforeSource, afterSource) {
  let beforeAst;
  let afterAst;
  try {
    beforeAst = parse(beforeSource, { sourceType: "unambiguous", plugins: ["jsx", "typescript", "decorators-legacy"], tokens: true });
    afterAst = parse(afterSource, { sourceType: "unambiguous", plugins: ["jsx", "typescript", "decorators-legacy"], tokens: true });
  } catch (error) {
    return { valid: false, code: "PARSE_ERROR", message: `Normalized source failed to parse: ${error.message}` };
  }
  const isCodeToken = (token) => token.type !== "CommentLine" && token.type !== "CommentBlock" && token.type?.label !== "eof";
  const beforeTokens = (beforeAst.tokens ?? []).filter(isCodeToken).map((t) => `${t.type?.label ?? t.type}:${beforeSource.slice(t.start, t.end)}`);
  const afterTokens = (afterAst.tokens ?? []).filter(isCodeToken).map((t) => `${t.type?.label ?? t.type}:${afterSource.slice(t.start, t.end)}`);
  if (beforeTokens.length !== afterTokens.length) {
    return { valid: false, code: "EXECUTABLE_CODE_CHANGED", message: "Executable token count changed during comment normalization." };
  }
  for (let i = 0; i < beforeTokens.length; i += 1) {
    if (beforeTokens[i] !== afterTokens[i]) {
      return { valid: false, code: "EXECUTABLE_CODE_CHANGED", message: `Executable token mismatch at index ${i}: expected ${beforeTokens[i]}, got ${afterTokens[i]}.` };
    }
  }
  if (JSON.stringify(stripAstMetadata(beforeAst.program)) !== JSON.stringify(stripAstMetadata(afterAst.program))) {
    return { valid: false, code: "EXECUTABLE_CODE_CHANGED", message: "Executable AST structure changed during comment normalization." };
  }
  return { valid: true };
}

// Validates that a file mutation only adds or updates English comments without changing executable code or splitting the file.
// Business purpose: enforces AC-2 security guarantees on every Agent Coder edit during project intake before any changes are committed to disk or indexed.
// Technical description: checks code line counts, non-comment executable lines, language-specific AST/tokens, and English-only comment compliance.
export function validateCommentOnlyMutation(beforeSource, afterSource, { filePath = "", commentLanguage = "en", registry = extractorRegistry } = {}) {
  if (typeof beforeSource !== "string" || typeof afterSource !== "string") {
    return { valid: false, code: "INVALID_SOURCE", message: "Both beforeSource and afterSource must be strings." };
  }
  const mode = commentModeForPath(filePath);
  const beforeCodeLines = countBudgetLines(beforeSource);
  const afterCodeLines = countBudgetLines(afterSource);
  if (beforeCodeLines !== afterCodeLines) {
    return {
      valid: false,
      code: "EXECUTABLE_CODE_CHANGED",
      message: `Executable code line count changed from ${beforeCodeLines} to ${afterCodeLines}. File splitting or code edits are forbidden.`
    };
  }
  const beforeExec = stripCommentsToExecutableCode(beforeSource, mode);
  const afterExec = stripCommentsToExecutableCode(afterSource, mode);
  if (beforeExec.error || afterExec.error) {
    return { valid: false, code: "PARSE_ERROR", message: "Source failed comment lexical analysis." };
  }
  if (beforeExec.executableLines.length !== afterExec.executableLines.length ||
      beforeExec.executableLines.some((line, index) => line !== afterExec.executableLines[index])) {
    return {
      valid: false,
      code: "EXECUTABLE_CODE_CHANGED",
      message: "Executable statements or logic lines were modified during comment normalization."
    };
  }
  if (mode === "javascript") {
    const jsCheck = verifyJavaScriptIntegrity(beforeSource, afterSource);
    if (!jsCheck.valid) return jsCheck;
  }
  if (registry.supports(filePath)) {
    try {
      const beforeExt = registry.extract(filePath, beforeSource);
      const afterExt = registry.extract(filePath, afterSource);
      const beforeSyms = (beforeExt.symbols ?? []).map((s) => `${s.kind}:${s.name}`);
      const afterSyms = (afterExt.symbols ?? []).map((s) => `${s.kind}:${s.name}`);
      if (JSON.stringify(beforeSyms) !== JSON.stringify(afterSyms)) {
        return { valid: false, code: "EXECUTABLE_CODE_CHANGED", message: "Extracted symbol inventory changed during comment normalization." };
      }
    } catch (error) {
      return { valid: false, code: "PARSE_ERROR", message: error.message };
    }
  }
  if (commentLanguage === "en") {
    const afterDoc = purposeComments(afterSource, mode);
    if (!afterDoc.header || !isEnglishComment(afterDoc.header.summary)) {
      return { valid: false, code: "COMMENT_LANGUAGE_INVALID", message: "File header comment is missing or not written in English." };
    }
    for (const comment of afterDoc.comments) {
      if (!isEnglishComment(comment.summary)) {
        return { valid: false, code: "COMMENT_LANGUAGE_INVALID", message: `Comment is not written in English: ${comment.summary}` };
      }
    }
  }
  return { valid: true, code: null, message: null };
}

// Throws a structured security error when a proposed comment normalization violates comment-only or English-language constraints.
// Business purpose: blocks unsafe Agent Coder mutations from persisting to the project workspace.
// Technical description: delegates to `validateCommentOnlyMutation` and throws an Error annotated with `code` and `statusCode`.
export function assertCommentOnlyMutation(beforeSource, afterSource, options = {}) {
  const result = validateCommentOnlyMutation(beforeSource, afterSource, options);
  if (!result.valid) {
    throw Object.assign(new Error(result.message), { code: result.code, statusCode: 400, validation: result });
  }
  return result;
}
