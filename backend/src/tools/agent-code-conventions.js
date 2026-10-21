// Detects file and function comments required for governed agent edits.

// Checks whether a new source file starts with a purpose comment.
export function hasFileHeaderComment(content) {
  return Boolean(extractFileHeaderComment(content));
}

// Extracts only the new file's purpose summary without validating unrelated legacy comments.
export function extractFileHeaderComment(content) {
  const lines = content.trimStart().split("\n");
  if (/^(?:\/\/|#(?:\s|!))/.test(lines[0])) {
    let end = 0;
    while (end < lines.length && /^(?:\/\/|#(?:\s|!))/.test(lines[end].trim())) end++;
    return lines.slice(0, end).join("\n");
  }
  const closer = lines[0].startsWith("/*") ? "*/" : lines[0].startsWith("<!--") ? "-->" : null;
  if (!closer) return "";
  const end = content.trimStart().indexOf(closer);
  return end < 0 ? "" : content.trimStart().slice(0, end + closer.length);
}

// Finds declared function names before and after an agent edit.
export function extractFunctionSignatures(content) {
  const out = new Set();
  if (!content || typeof content !== "string") return out;
  const re = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g;
  let match;
  while ((match = re.exec(content))) out.add(match[1]);
  return out;
}

// Checks that a new function has a purpose comment immediately above it.
export function hasPrecedingComment(content, fnName) {
  const lines = content.split("\n");
  const idx = lines.findIndex((line) => extractFunctionSignatures(line).has(fnName));
  if (idx <= 0) return false;
  return Boolean(extractPrecedingCommentBlock(content, idx));
}

// Retrieves the complete adjacent summary so new business behavior can be documented and checked.
export function extractPrecedingCommentBlock(content, lineIndex) {
  const lines = content.split("\n");
  const end = lineIndex - 1;
  if (end < 0) return "";
  const last = lines[end].trim();
  if (/^(?:\/\/|#(?:\s|!))/.test(last)) {
    let start = end;
    while (start > 0 && /^(?:\/\/|#(?:\s|!))/.test(lines[start - 1].trim())) start--;
    return lines.slice(start, end + 1).join("\n");
  }
  const opener = last.endsWith("*/") ? "/*" : last.endsWith("-->") ? "<!--" : null;
  if (!opener) return "";
  for (let start = end; start >= 0; start--) {
    const line = lines[start].trim();
    if (line.startsWith(opener)) return lines.slice(start, end + 1).join("\n");
    if (start < end && (line.includes("*/") || line.includes("-->"))) break;
  }
  return "";
}

// Counts executable or document lines without charging blank lines and standalone comments to the edit budget.
export function countBudgetLines(content) {
  let block = null;
  let quote = null;
  let escaped = false;
  let regexClass = false;
  const parentheses = [];
  let lastToken = "";
  let afterControl = false;
  let count = 0;
  for (const line of String(content ?? "").split("\n")) {
    let code = false;
    for (let index = 0; index < line.length; index++) {
      const character = line[index];
      const rest = line.slice(index);
      if (block) {
        if (rest.startsWith(block)) { index += block.length - 1; block = null; }
        continue;
      }
      if (quote) {
        if (character.trim()) code = true;
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (quote === "/" && character === "[") regexClass = true;
        else if (quote === "/" && character === "]") regexClass = false;
        else if (character === quote && !regexClass) quote = null;
        continue;
      }
      if (rest.startsWith("//")) break;
      if (character === "#" && !line.slice(0, index).trim() && /^(?:#!|#\s)/.test(rest)) break;
      if (rest.startsWith("/*")) { block = "*/"; index++; continue; }
      if (rest.startsWith("<!--")) { block = "-->"; index += 3; continue; }
      if (!character.trim()) continue;
      const identifier = /^[A-Za-z_$][\w$]*/.exec(rest);
      if (identifier) {
        lastToken = identifier[0];
        index += lastToken.length - 1;
        afterControl = /^(?:else|do|return|yield|throw|case|delete|void|typeof|new|in|instanceof|await)$/.test(lastToken);
        code = true;
        continue;
      }
      if (character === "/" && (afterControl || /^(?:[=(:,!&|?;{}\[]|)$/.test(lastToken))) { quote = "/"; regexClass = false; }
      if (character === "\"" || character === "'" || character === "`") quote = character;
      if (character === "(") parentheses.push(/^(?:if|while|for|with|switch|catch)$/.test(lastToken));
      afterControl = character === ")" ? Boolean(parentheses.pop()) : false;
      lastToken = character;
      code = true;
    }
    if (code) count++;
    if (quote !== "`" && !escaped) quote = null;
    escaped = false;
  }
  return count;
}

// Rejects mixed natural-language summaries while allowing technical identifiers in business documentation.
export function validateCommentLanguage(comment) {
  const prose = String(comment ?? "")
    .replace(/`[^`]*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|@[A-Za-z][\w-]*\b/g, " ")
    .replace(/https?:\/\/\S+|\b[\w.-]+\([^)]*\)|\b\w+(?:[._/-]\w+)+\b/g, " ")
    .replace(/\b(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][A-Z0-9_]+|\w*\d\w*)\b/g, " ");
  const vietnamese = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(prose.normalize("NFC"));
  const english = /\b(?:the|this|that|these|those|is|are|was|were|be|been|being|will|would|should|must|could|does|has|have|with|for|from|into|returns|checks|creates|updates|validates|ensures|handles|allows|rejects|reads|writes)\b/i.test(prose);
  return !vietnamese || !english;
}
