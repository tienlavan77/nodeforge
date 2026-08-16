import parser from "php-parser";
import { dirname, resolve } from "node:path";

import { emptyExtraction } from "./contract.js";

const engine = new parser.Engine({ parser: { php7: true }, ast: { withPositions: true } });

export function extractPhp(source, filePath) {
  const extraction = emptyExtraction();
  const ast = engine.parseCode(source, filePath);

  walk(ast, extraction, filePath);
  return extraction;
}

function walk(node, extraction, filePath, callerSymbol = null) {
  if (!node || typeof node !== "object") return;

  const symbol = symbolFor(node);
  if (symbol) extraction.symbols.push(symbol);
  addUseImport(node, extraction.imports);
  addIncludeImport(node, extraction.imports, filePath);
  addCall(node, extraction.calls, callerSymbol);

  const nestedCaller = symbol?.kind === "function" || symbol?.kind === "method" ? symbol.name : callerSymbol;

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) walk(child, extraction, filePath, nestedCaller);
    } else if (value?.kind) {
      walk(value, extraction, filePath, nestedCaller);
    }
  }
}

function symbolFor(node) {
  const kinds = new Map([
    ["function", "function"],
    ["class", "class"],
    ["method", "method"],
    ["interface", "interface"],
    ["trait", "trait"]
  ]);
  const kind = kinds.get(node.kind);
  const name = node.name?.name ?? node.name;
  if (!kind || typeof name !== "string") return null;
  return { name, kind, start_line: node.loc.start.line, end_line: node.loc.end.line };
}

function addUseImport(node, imports) {
  if (node.kind !== "usegroup") return;

  for (const item of node.items) {
    const source = node.name ? `${node.name}\\${item.name}` : item.name;
    const imported = source.split("\\").at(-1);
    imports.push({ source, imported, local: item.alias ?? imported, kind: "use", external: true });
  }
}

function addIncludeImport(node, imports, filePath) {
  if (node.kind !== "include") return;

  const includePath = staticIncludePath(node.target);
  if (!includePath) return;

  imports.push({
    source: resolve(dirname(filePath), includePath),
    imported: null,
    local: null,
    kind: "require",
    external: false
  });
}

function addCall(node, calls, callerSymbol) {
  if (node.kind !== "call" || node.what?.kind !== "name") return;
  calls.push({ callee_name: node.what.name, line: node.loc.start.line, caller_symbol: callerSymbol });
}

function staticIncludePath(node) {
  if (node?.kind === "string") return node.value;
  if (node?.kind !== "bin" || node.type !== ".") return null;
  if (node.left?.kind !== "magic" || node.left.value !== "__DIR__" || node.right?.kind !== "string") return null;
  return node.right.value.replace(/^[\\/]+/, "");
}
