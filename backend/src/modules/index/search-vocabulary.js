const TOKEN_PATTERN = /[\p{L}\p{M}\p{N}_$.-]+/gu;

export const SEARCH_STOP_WORDS = Object.freeze({
  en: Object.freeze(["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "was", "were", "with", "get", "set", "add", "put", "can", "its", "not", "update", "return", "existing", "sent", "fields", "complete", "requested", "response", "including", "both", "each", "when", "does", "all", "new", "use", "used", "make", "take", "give", "into", "out", "over", "under", "between", "through", "during", "before", "after", "above", "below", "them", "then", "than", "such", "only", "other", "some", "any", "every", "being", "been", "have", "has", "had", "will", "would", "should", "could", "must", "shall", "may", "might", "also", "just", "more", "most", "many", "much", "very", "well", "even", "still", "already", "yet", "ensure", "ensuring", "provide", "provides", "include", "includes", "contain", "contains", "without", "within", "along", "across"]),
  vi: Object.freeze(["bằng", "bị", "cho", "có", "của", "đã", "để", "được", "khi", "không", "là", "một", "những", "thay", "thì", "trên", "trong", "từ", "và", "với"])
});

export const SEARCH_PROTECTED_TERMS = Object.freeze(["api", "css", "db", "fts", "html", "http", "id", "js", "json", "jsx", "sql", "sse", "ui"]);
const STOP_WORD_SET = new Set(Object.values(SEARCH_STOP_WORDS).flat());
const PROTECTED_TERM_SET = new Set(SEARCH_PROTECTED_TERMS);

/** Tokenize natural language and code identifiers without breaking Unicode words. */
export function tokenizeSearchText(value, { minLength = 1 } = {}) {
  if (typeof value !== "string" || !value.trim()) return [];
  const normalized = value.normalize("NFC").toLocaleLowerCase("vi-VN");
  // Split snake_case and kebab-case so CONVERSATION_BLOCK and conversation-block
  // both become separate searchable tokens. Underscore and hyphen are word
  // boundaries for code identifiers, but keep camelCase intact for proper nouns.
  const expanded = normalized.replace(/[_-]+/g, " ");
  const tokens = expanded.match(TOKEN_PATTERN) ?? [];
  return [...new Set(tokens.filter((term) => PROTECTED_TERM_SET.has(term) || (term.length >= minLength && !STOP_WORD_SET.has(term))))];
}
