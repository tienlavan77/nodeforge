// Detects file and function comments required for governed agent edits.

// Checks whether a new source file starts with a purpose comment.
export function hasFileHeaderComment(content) {
  const head = content.trimStart().split("\n").slice(0, 3).join("\n").trim();
  return /^(?:\/\/|\/\*|#|<!--)/.test(head);
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
  const idx = lines.findIndex((line) => new RegExp(`\\bfunction\\s+${fnName}\\b`).test(line));
  if (idx <= 0) return false;
  const prev = lines[idx - 1]?.trim() ?? "";
  return /^(?:\/\/|\/\*|#|<!--)/.test(prev);
}
