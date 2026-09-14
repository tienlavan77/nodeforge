// Summary: Extracts selector-level CSS symbols with bounded line ranges.

const RULE_PATTERN = /^[ \t]*([^@/\s{}][^{}]*)\{/;
const SELECTOR_CONTINUATION_PATTERN = /^[ \t]*([^@/\s{}][^{}]*),[ \t]*$/;
const CUSTOM_PROPERTY_PATTERN = /^[ \t]*(--[\w-]+)\s*:/;
const KEYFRAMES_PATTERN = /^[ \t]*@keyframes\s+([\w-]+)\s*\{/;
const AT_RULE_PATTERN = /^[ \t]*@(media|supports|container|layer)\b[^{]*\{/;
const BLOCK_COMMENT_PATTERN = /\/\*[\s\S]*?\*\//g;
const ELEMENT_ONLY_SELECTOR = /^(?:\*|html|body|div|span|p|a|ul|ol|li|table|thead|tbody|tr|td|th|form|input|button|select|textarea|label|img|h[1-6]|header|footer|main|nav|section|article|aside|video|canvas|svg|path)$/i;

const KIND = Object.freeze({ class: "css_class", id: "css_id", keyframes: "css_keyframes", at_rule: "css_at_rule", variable: "css_variable" });

export function extractCss(source) {
  const extraction = { symbols: [], imports: [], exports: [], calls: [] };
  if (typeof source !== "string" || !source.trim()) return extraction;

  const lines = stripBlockComments(source).split("\n");
  let pendingSelector = null;
  let pendingStartLine = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;

    const keyframes = KEYFRAMES_PATTERN.exec(line);
    if (keyframes) {
      extraction.symbols.push(symbol(keyframes[1], KIND.keyframes, lineNumber, findBlockEndLine(lines, index)));
      pendingSelector = null;
    }

    const atRule = AT_RULE_PATTERN.exec(line);
    if (atRule) {
      extraction.symbols.push(symbol(`@${atRule[1]}`, KIND.at_rule, lineNumber, findBlockEndLine(lines, index)));
      pendingSelector = null;
    }

    const rule = RULE_PATTERN.exec(line);
    if (rule) {
      const selectorText = pendingSelector ? `${pendingSelector} ${rule[1]}` : rule[1];
      const startLine = pendingSelector ? pendingStartLine : lineNumber;
      pendingSelector = null;
      pendingStartLine = 0;
      pushSelectorSymbols(extraction.symbols, selectorText, startLine, findBlockEndLine(lines, index));
    } else if (!keyframes && !atRule) {
      const continuation = SELECTOR_CONTINUATION_PATTERN.exec(line);
      if (continuation) {
        pendingSelector = pendingSelector ? `${pendingSelector} ${continuation[1]}` : continuation[1];
        if (!pendingStartLine) pendingStartLine = lineNumber;
      } else {
        pendingSelector = null;
        pendingStartLine = 0;
      }
    }

    const property = CUSTOM_PROPERTY_PATTERN.exec(line);
    if (property) extraction.symbols.push(symbol(property[1], KIND.variable, lineNumber, lineNumber));
  }
  return extraction;
}

function pushSelectorSymbols(symbols, selectorText, startLine, endLine) {
  const emitted = new Set();
  for (const rawPart of selectorText.split(",")) {
    const part = rawPart.trim();
    if (!part || ELEMENT_ONLY_SELECTOR.test(part)) continue;
    for (const match of part.matchAll(/([.#])([\w-]+)/g)) {
      const key = `${match[1]}${match[2]}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      symbols.push(symbol(match[2], match[1] === "." ? KIND.class : KIND.id, startLine, endLine));
    }
  }
}

function findBlockEndLine(lines, startIndex) {
  let depth = 0;
  for (let index = startIndex; index < lines.length; index += 1) {
    depth += count(lines[index], "{");
    depth -= count(lines[index], "}");
    if (depth <= 0 && index > startIndex) return index + 1;
    if (depth <= 0 && lines[index].includes("}")) return index + 1;
  }
  return startIndex + 1;
}

function count(text, token) {
  return text.split(token).length - 1;
}

function stripBlockComments(source) {
  return source.replace(BLOCK_COMMENT_PATTERN, (match) => match.replace(/[^\n]/g, " "));
}

function symbol(name, kind, startLine, endLine) {
  return { name, kind, start_line: startLine, end_line: endLine };
}
