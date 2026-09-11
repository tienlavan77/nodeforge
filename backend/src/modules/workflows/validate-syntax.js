import { parse } from "@babel/parser";

/** Validate submitted source before any File Service write. */
export function validateSyntax(language, content) {
  if (typeof content !== "string" || content.trim().length === 0) return { valid: false, error: "content is empty" };
  const normalized = String(language ?? "").toLowerCase();
  try {
    if (["javascript", "js", "jsx", "typescript", "ts", "tsx", "mjs", "cjs"].includes(normalized)) {
      parse(content, { sourceType: "unambiguous", errorRecovery: false, plugins: ["jsx", "typescript", "importAttributes", "topLevelAwait"] });
    } else if (["json", "jsonc"].includes(normalized)) {
      JSON.parse(content);
    } else if (["css", "scss", "less"].includes(normalized)) {
      assertBalanced(content, "{}", "braces");
    } else if (["python", "py"].includes(normalized)) {
      assertBalanced(content, "()[]{}", "delimiters");
    }
    return { valid: true, error: null };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

function assertBalanced(content, pairs, label) {
  const opens = new Set(["{", "(", "["]);
  const closes = new Map([["}", "{"], [")", "("], ["]", "["]]);
  const stack = [];
  for (const char of content) {
    if (opens.has(char)) stack.push(char);
    else if (closes.has(char)) {
      if (stack.pop() !== closes.get(char)) throw new Error(`unbalanced ${label}`);
    }
  }
  if (stack.length) throw new Error(`unbalanced ${label}`);
}
