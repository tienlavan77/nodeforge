// Preserves summary-derived records across source edits by matching unique structural
// AST paths. Duplicate scopes and missing prior source fail closed rather than
// assigning another declaration's identity, vector or pending work.
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { parse } from "@babel/parser";
import phpParser from "php-parser";

// Reconciles one file inside the caller's indexing transaction. Source coordinates
// locate declarations within each snapshot; only unique AST paths bridge snapshots.
export function reconcileSymbols(database, fileId, path, symbols, content) {
  const prior = database.all("SELECT * FROM symbols WHERE file_id = ?", [fileId]);
  const source = database.all("SELECT content FROM file_content_fts WHERE file_id = ?", [fileId])[0]?.content;
  const before = structuralKeys(path, source, prior);
  const after = structuralKeys(path, content, symbols);
  const retained = new Set();
  for (const symbol of symbols) {
    const key = after.get(symbol);
    const old = key ? prior.filter((row) => before.get(row) === key) : [];
    const symbolId = old.length === 1 ? old[0].symbol_id : `SYM-${randomUUID()}`;
    retained.add(symbolId);
    if (old.length === 1) database.run("UPDATE symbols SET name = ?, kind = ?, start_line = ?, end_line = ? WHERE symbol_id = ?", [symbol.name, symbol.kind, symbol.start_line, symbol.end_line, symbolId]);
    else database.run("INSERT INTO symbols (symbol_id, file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?)", [symbolId, fileId, symbol.name, symbol.kind, symbol.start_line, symbol.end_line]);
  }
  for (const row of prior) if (!retained.has(row.symbol_id)) database.run("DELETE FROM symbols WHERE symbol_id = ?", [row.symbol_id]);
}

// Builds private structural keys without changing parser or database contracts.
// Array positions and line numbers never participate in cross-snapshot identity.
function structuralKeys(path, content, symbols) {
  const result = new Map();
  if (typeof content !== "string") return result;
  let ast;
  try {
    ast = extname(path) === ".php"
      ? new phpParser.Engine({ parser: { php7: true }, ast: { withPositions: true } }).parseCode(content, path)
      : parse(content, { sourceType: "unambiguous", plugins: ["jsx", "typescript", "decorators-legacy"] }).program;
  } catch (error) {
    // Unsupported or obsolete source must never cause speculative identity reuse.
    if (error) return result;
  }
  const nodes = [];
  visitStructure(ast, [], nodes);
  const counts = new Map();
  for (const node of nodes) counts.set(node.key, (counts.get(node.key) ?? 0) + 1);
  for (const symbol of symbols) {
    const candidates = nodes.filter((node) => node.start === symbol.start_line && node.end === symbol.end_line && node.name === symbol.name && node.declaration);
    if (candidates.length !== 1) continue;
    const node = candidates[0];
    if (node.prefixes.some((key) => counts.get(key) !== 1)) continue;
    const key = JSON.stringify([symbol.kind, node.key]);
    result.set(symbol, key);
  }
  const duplicates = new Map();
  for (const key of result.values()) duplicates.set(key, (duplicates.get(key) ?? 0) + 1);
  for (const [symbol, key] of result) if (duplicates.get(key) !== 1) result.delete(symbol);
  return result;
}

// Traverses declaration and lexical structure, retaining named ownership and
// branch roles while treating repeated anonymous scopes as ambiguous.
function visitStructure(node, parents, nodes, role = "") {
  if (!node || typeof node !== "object") return;
  const type = node.type ?? node.kind;
  if (typeof type !== "string" || !node.loc) return;
  if (/Comment/.test(type) || ["commentline", "commentblock"].includes(type)) return;
  const name = node.id?.name ?? node.key?.name ?? node.key?.value ?? node.name?.name ?? (typeof node.name === "string" ? node.name : "");
  const transparent = type.startsWith("Export") || type === "VariableDeclaration";
  const segment = JSON.stringify([role, type, name, node.static ?? node.isStatic ?? false, node.computed ?? false, typeof node.kind === "string" && node.type ? node.kind : ""]);
  const segments = transparent ? parents : [...parents, segment];
  const prefixes = segments.map((_, index) => JSON.stringify(segments.slice(0, index + 1)));
  const key = JSON.stringify(segments);
  const declaration = ["FunctionDeclaration", "ClassDeclaration", "VariableDeclarator", "ClassMethod", "ObjectMethod", "TSDeclareMethod", "function", "class", "method", "interface", "trait"].includes(type);
  if (!transparent) nodes.push({ key, prefixes, name, declaration, start: node.loc.start.line, end: node.loc.end.line });
  for (const [field, value] of Object.entries(node)) {
    if (["loc", "comments", "leadingComments", "trailingComments", "innerComments", "tokens"].includes(field)) continue;
    if (Array.isArray(value)) for (const child of value) visitStructure(child, segments, nodes, field);
    else if (value && typeof value === "object") visitStructure(value, segments, nodes, transparent ? role : field);
  }
}
