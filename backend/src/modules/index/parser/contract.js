// Provides module declarations and business logic for contract.js.

export const EXTRACTION_SHAPE = Object.freeze({
  symbols: Object.freeze(["name", "kind", "start_line", "end_line"]),
  imports: Object.freeze(["source", "imported", "local", "kind", "external"]),
  exports: Object.freeze(["name", "kind", "source"]),
  calls: Object.freeze(["callee_name", "line", "caller_symbol"])
});

// Defines emptyExtraction function behavior for contract.js.
export function emptyExtraction() {
  return { symbols: [], imports: [], exports: [], calls: [] };
}

// Defines normalizeExtraction function behavior for contract.js.
export function normalizeExtraction(extraction = {}) {
  return {
    symbols: Array.isArray(extraction.symbols) ? extraction.symbols : [],
    imports: Array.isArray(extraction.imports) ? extraction.imports : [],
    exports: Array.isArray(extraction.exports) ? extraction.exports : [],
    calls: Array.isArray(extraction.calls) ? extraction.calls : []
  };
}
