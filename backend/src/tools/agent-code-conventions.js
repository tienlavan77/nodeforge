// Detects file and function comments required for governed agent edits.
import { purposeComments, purposeCommentBefore } from "../modules/index/parser/purpose-comments.js";

// Checks whether a new source file starts with a purpose comment.
export function hasFileHeaderComment(content) {
  return Boolean(extractFileHeaderComment(content));
}

// Extracts only the new file's purpose summary without validating unrelated legacy comments.
export function extractFileHeaderComment(content) {
  return purposeComments(content, /^\s*<!--/.test(content) ? "markup" : "php").header?.raw ?? "";
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
  return purposeCommentBefore(purposeComments(content, commentMode(content)), lineIndex)?.raw ?? "";
}

/** Preserves existing header-check formats without registering additional indexer languages. */
function commentMode(content) {
  if (/^\s*<\?php\b/.test(content)) return "php";
  if (/^\s*<!--/.test(content)) return "markup";
  if (/^\s*#(?!!)/.test(content)) return "php";
  return "javascript";
}

// Counts executable or document lines without charging blank lines and standalone comments to the edit budget.
export function countBudgetLines(content) {
  let block = null;
  let quote = null;
  let escaped = false;
  let regexClass = false;
  const parentheses = [];
  const braces = [];
  const pendingClasses = [];
  const pendingCases = [];
  const switchBodies = [];
  let switchBody = false;
  let brackets = 0;
  let pendingFunction = null;
  let functionBody = null;
  let asyncExpression = false;
  let lastToken = "";
  let statementStart = true;
  let labelCandidate = false;
  let pendingTransfer = false;
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
        else if (character === quote && !regexClass) { quote = null; lastToken = "literal"; afterControl = false; }
        continue;
      }
      if (rest.startsWith("//")) break;
      if (character === "#" && !line.slice(0, index).trim() && /^(?:#!|#\s)/.test(rest)) break;
      if (rest.startsWith("/*")) { block = "*/"; index++; continue; }
      if (rest.startsWith("<!--")) { block = "-->"; index += 3; continue; }
      if (!character.trim()) continue;
      const identifier = /^(?:[$_\p{ID_Start}]|\\u(?:[\da-fA-F]{4}|\{[\da-fA-F]+\}))(?:[$\u200c\u200d\p{ID_Continue}]|\\u(?:[\da-fA-F]{4}|\{[\da-fA-F]+\}))*/u.exec(rest);
      if (identifier) {
        if (switchBodies.at(-1) === braces.length && lastToken !== "." && lastToken !== "#"
          && /^(?:case|default)$/.test(identifier[0])) {
          pendingCases.push({ braces: braces.length, parentheses: parentheses.length, brackets, conditional: 0 });
        }
        const expression = /^(?:[=(:,[!&|?+*%/^~<>-]|return|yield|throw|case|delete|void|typeof|new|in|instanceof|await)$/.test(lastToken);
        if (identifier[0] === "function" && lastToken !== "." && lastToken !== "#") {
          pendingFunction = lastToken === "async" ? asyncExpression : expression;
        }
        if (identifier[0] === "class" && lastToken !== "." && lastToken !== "#") {
          pendingClasses.push({ expression, parentheses: parentheses.length, braces: braces.length });
        }
        if (identifier[0] === "async") asyncExpression = expression;
        functionBody = null;
        afterControl = lastToken !== "." && lastToken !== "#" && /^(?:else|do|return|yield|throw|case|delete|void|typeof|new|in|instanceof|await)$/.test(identifier[0]);
        labelCandidate = statementStart;
        pendingTransfer = lastToken !== "." && lastToken !== "#" && /^(?:break|continue)$/.test(identifier[0])
          || pendingTransfer && /^(?:break|continue)$/.test(lastToken);
        lastToken = lastToken === "." || lastToken === "#" ? "property"
          : lastToken === "for" && identifier[0] === "await" ? "for await" : identifier[0];
        statementStart = /^(?:else|do)$/.test(lastToken);
        index += identifier[0].length - 1;
        code = true;
        continue;
      }
      pendingTransfer = false;
      if (rest.startsWith("++") || rest.startsWith("--")) {
        lastToken = rest.slice(0, 2);
        statementStart = false;
        labelCandidate = false;
        index++;
        afterControl = false;
        code = true;
        continue;
      }
      if (character === "/" && (afterControl || /^(?:[=(:,!&|?;{}[+*%/^~<>-]|)$/.test(lastToken))) { quote = "/"; regexClass = false; }
      if (character === "\"" || character === "'" || character === "`") quote = character;
      if (character === "(") {
        parentheses.push({ control: /^(?:if|while|for(?: await)?|with|switch|catch)$/.test(lastToken), switch: lastToken === "switch", functionExpression: pendingFunction });
        pendingFunction = null;
      }
      if (/^[:=;]$/.test(character) && pendingClasses.at(-1)?.parentheses === parentheses.length
        && pendingClasses.at(-1)?.braces === braces.length) pendingClasses.pop();
      if (character === "{") {
        if (switchBody) switchBodies.push(braces.length + 1);
        const pendingClass = pendingClasses.at(-1);
        const classBody = pendingClass?.parentheses === parentheses.length && pendingClass?.braces === braces.length
          ? pendingClasses.pop().expression : null;
        braces.push(classBody ?? functionBody ?? (!afterControl && /^(?:[=(:,[!&|?+*%/^~<>-]|return|yield|throw)$/.test(lastToken)
          || afterControl && /^(?:return|yield|throw)$/.test(lastToken)));
      }
      const parenthesis = character === ")" ? parentheses.pop() : null;
      afterControl = Boolean(parenthesis?.control);
      switchBody = Boolean(parenthesis?.switch);
      if (character === "}" && switchBodies.at(-1) === braces.length) switchBodies.pop();
      functionBody = parenthesis?.functionExpression ?? null;
      if (character === "[") brackets++;
      if (character === "]") brackets--;
      const pendingCase = pendingCases.at(-1);
      const caseBoundary = pendingCase?.braces === braces.length
        && pendingCase?.parentheses === parentheses.length && pendingCase?.brackets === brackets;
      if (caseBoundary && character === "?" && !/^[?.]/.test(line[index + 1] ?? "") && line[index - 1] !== "?") pendingCase.conditional++;
      const caseColon = caseBoundary && character === ":" && pendingCase.conditional === 0;
      if (caseBoundary && character === ":" && !caseColon) pendingCase.conditional--;
      if (caseColon) pendingCases.pop();
      const labelColon = character === ":" && (labelCandidate || caseColon);
      lastToken = character === "}" && braces.pop() ? "literal" : labelColon ? ";" : character;
      statementStart = labelColon || character === ";" || afterControl
        || character === "{" && !braces.at(-1) || character === "}" && lastToken === "}";
      labelCandidate = false;
      code = true;
    }
    if (code) count++;
    if (!quote && (pendingTransfer || /^(?:return|break|continue|yield|debugger)$/.test(lastToken))) {
      pendingTransfer = false;
      lastToken = ";";
      afterControl = false;
      statementStart = true;
      labelCandidate = false;
    }
    if (quote !== "`" && !escaped) quote = null;
    escaped = false;
  }
  return count;
}

// Rejects mixed natural-language summaries while allowing technical identifiers in business documentation.
// Removes annotation-shaped tokens before classifying the natural-language portion of a summary.
function stripTechnicalTokens(comment) {
  return String(comment ?? "")
    .replace(/`[^`]*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, " ")
    .replace(/@[A-Za-z][\w-]*\b/g, " ")
    .replace(/https?:\/\/\S+|\b[\w.-]+\([^)]*\)|\b\w+(?:[._/-]\w+)+\b/g, " ")
    .replace(/\b(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][A-Z0-9_]+|\w*\d\w*)\b/g, " ");
}

// Rejects mixed natural-language summaries while allowing technical identifiers in business documentation.
export function validateCommentLanguage(comment) {
  const prose = stripTechnicalTokens(comment);
  const vietnamese = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(prose.normalize("NFC"));
  const english = /\b(?:the|this|that|these|those|is|are|was|were|be|been|being|will|would|should|must|could|does|has|have|with|for|from|into|returns|checks|creates|updates|validates|ensures|handles|allows|rejects|reads|writes)\b/i.test(prose);
  return !vietnamese || !english;
}
