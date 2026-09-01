const TOKEN_PATTERN = /[\p{L}\p{M}\p{N}_$.-]+/gu;

export const SEARCH_STOP_WORDS = Object.freeze({
  en: Object.freeze(["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "was", "were", "with"]),
  vi: Object.freeze(["bằng", "bị", "cho", "có", "của", "đã", "để", "được", "khi", "không", "là", "một", "những", "thay", "thì", "trên", "trong", "từ", "và", "với"])
});

export const SEARCH_PROTECTED_TERMS = Object.freeze(["api", "css", "db", "fts", "html", "http", "id", "js", "json", "jsx", "sql", "sse", "ui"]);
const STOP_WORD_SET = new Set(Object.values(SEARCH_STOP_WORDS).flat());
const PROTECTED_TERM_SET = new Set(SEARCH_PROTECTED_TERMS);

/** Tokenize natural language and code identifiers without breaking Unicode words. */
export function tokenizeSearchText(value, { minLength = 1 } = {}) {
  if (typeof value !== "string" || !value.trim()) return [];
  const tokens = value.normalize("NFC").toLocaleLowerCase("vi-VN").match(TOKEN_PATTERN) ?? [];
  return [...new Set(tokens.filter((term) => PROTECTED_TERM_SET.has(term) || (term.length >= minLength && !STOP_WORD_SET.has(term))))];
}
