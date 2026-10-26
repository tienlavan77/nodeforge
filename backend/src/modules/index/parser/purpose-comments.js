// Shared purpose-comment rules keep file documentation separate from symbol contracts.
// Lexical comment tokens exclude implementation strings; summaries preserve all words,
// tags and warnings while collapsing presentation whitespace without truncation.
import { parse } from "@babel/parser";

/** Produces complete canonical text while retaining punctuation and information order. */
export function normalizePurposeComment(raw = "") {
  // Match the outer wrapper so literal delimiters remain part of the business contract.
  const wrapper = raw.match(/^\s*(\/\*+|<!--)/);
  const content = wrapper ? raw.slice(wrapper[0].length)
    .replace(wrapper[1] === "<!--" ? /-->\s*$/ : /\*\/\s*$/, "") : raw;
  return content.replace(/\r\n?/g, "\n").split("\n")
    .map((line) => line.replace(/^\s*(?:\/\/|#(?!!)|\*(?!\/))\s?/, "").trim())
    .join(" ").replace(/\s+/g, " ").trim();
}

/** Collects standalone source comments so checkers and indexing share attachment boundaries. */
export function purposeComments(source, mode = "javascript") {
  let tokens;
  const decorators = [];
  if (mode === "javascript") {
    try {
      const ast = parse(source, { sourceType: "unambiguous", plugins: ["jsx", "typescript", "decorators-legacy"], errorRecovery: true });
      tokens = ast.comments;
      collectDecorators(ast.program, decorators);
    } catch (error) {
      // Invalid source cannot provide reliable lexical evidence for a purpose comment.
      return { header: null, comments: [], source, error };
    }
  } else {
    tokens = scanComments(source, mode);
  }
  const comments = [];
  for (const token of tokens) {
    const start = token.start;
    const end = token.end;
    const prefix = source.slice(source.lastIndexOf("\n", start - 1) + 1, start);
    const suffix = source.slice(end, source.indexOf("\n", end) < 0 ? source.length : source.indexOf("\n", end));
    if (prefix.trim() || suffix.trim()) continue;
    const raw = source.slice(start, end);
    if (!normalizePurposeComment(raw)) continue;
    const previous = comments.at(-1);
    if (previous && raw.startsWith("//") && previous.raw.startsWith("//") && /^[ \t\r]*\n[ \t]*$/.test(source.slice(previous.end, start))) {
      previous.end = end;
      previous.raw = source.slice(previous.start, end);
      previous.summary = normalizePurposeComment(previous.raw);
    } else if (previous && raw.startsWith("#") && previous.raw.startsWith("#") && /^[ \t\r]*\n[ \t]*$/.test(source.slice(previous.end, start))) {
      previous.end = end;
      previous.raw = source.slice(previous.start, end);
      previous.summary = normalizePurposeComment(previous.raw);
    } else {
      comments.push({ start, end, raw, summary: normalizePurposeComment(raw) });
    }
  }
  const first = comments[0];
  const preamble = first ? source.slice(0, first.start).replace(/^\uFEFF/, "").replace(/^#![^\r\n]*(?:\r?\n|$)/, "").replace(/^\s*<\?php\b/, "") : "";
  return { source, comments, decorators, header: first && !preamble.trim() ? first : null };
}

/** Resolves only an adjacent non-header comment, crossing declaration decorators but no implementation code. */
export function purposeCommentBefore(document, lineIndex) {
  const { source, comments, header } = document;
  let offset = source.split("\n").slice(0, lineIndex).join("\n").length + (lineIndex ? 1 : 0);
  for (const decorator of [...(document.decorators ?? [])].sort((a, b) => b.end - a.end)) {
    if (decorator.end <= offset && /^\s*$/.test(source.slice(decorator.end, offset))) offset = decorator.start;
  }
  const comment = comments.filter((item) => item.end <= offset).at(-1);
  return comment && comment !== header && /^\s*$/.test(source.slice(comment.end, offset)) ? comment : null;
}

/** Retains parser-confirmed decorator spans so multiline arguments cannot become code boundaries. */
function collectDecorators(node, decorators) {
  if (!node || typeof node !== "object") return;
  if (node.type === "Decorator") { decorators.push({ start: node.start, end: node.end }); return; }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) collectDecorators(child, decorators);
    } else if (value?.type) collectDecorators(value, decorators);
  }
}

/** Scans PHP and CSS strings before recognizing their language-specific comment delimiters. */
function scanComments(source, mode) {
  const tokens = [];
  for (let index = 0; index < source.length;) {
    const start = index;
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      index++;
      while (index < source.length) {
        if (source[index] === "\\") { index += 2; continue; }
        if (source[index++] === char) break;
      }
    } else if (mode === "php" && source.startsWith("<<<", index)) {
      const opening = /^<<<[ \t]*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?[ \t]*\r?\n/.exec(source.slice(index));
      if (!opening) { index++; continue; }
      const closing = new RegExp("^[ \\t]*" + opening[1] + "(?=[;,\\r\\n]|$)", "m").exec(source.slice(index + opening[0].length));
      index = closing ? index + opening[0].length + closing.index + closing[0].length : source.length;
    } else if (mode === "markup" && source.startsWith("<!--", index)) {
      const close = source.indexOf("-->", index + 4);
      if (close < 0) break;
      index = close + 3;
      tokens.push({ start, end: index });
    } else if (source.startsWith("/*", index)) {
      const close = source.indexOf("*/", index + 2);
      if (close < 0) break;
      index = close + 2;
      tokens.push({ start, end: index });
    } else if (mode !== "css" && (source.startsWith("//", index) || (char === "#" && source[index + 1] !== "!" && source[index + 1] !== "["))) {
      index = source.indexOf("\n", index);
      if (index < 0) index = source.length;
      tokens.push({ start, end: index });
    } else {
      index++;
    }
  }
  return tokens;
}
