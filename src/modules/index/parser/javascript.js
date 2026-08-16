import { parse } from "@babel/parser";

import { emptyExtraction } from "./contract.js";

export function extractJavaScript(source) {
  const extraction = emptyExtraction();
  const ast = parse(source, {
    sourceType: "unambiguous",
    plugins: ["jsx", "typescript"]
  });

  walk(ast.program, extraction);
  return extraction;
}

function walk(node, extraction, callerSymbol = null) {
  if (!node || typeof node !== "object") return;

  const symbol = symbolFor(node);
  if (symbol) extraction.symbols.push(symbol);
  addImport(node, extraction.imports);
  addExport(node, extraction.exports);
  addCall(node, extraction.calls, callerSymbol);

  const nestedCaller = symbol?.kind === "function" || symbol?.kind === "method" ? symbol.name : callerSymbol;

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) walk(child, extraction, nestedCaller);
    } else if (value?.type) {
      walk(value, extraction, nestedCaller);
    }
  }
}

function symbolFor(node) {
  if (node.type === "FunctionDeclaration" && node.id) return createSymbol(node.id.name, "function", node);
  if (node.type === "ClassDeclaration" && node.id) return createSymbol(node.id.name, "class", node);
  if (node.type === "ClassMethod" || node.type === "ObjectMethod" || node.type === "TSDeclareMethod") {
    const name = propertyName(node.key);
    return name ? createSymbol(name, "method", node) : null;
  }
  if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && isFunction(node.init)) {
    return createSymbol(node.id.name, "function", node);
  }
  return null;
}

function addImport(node, imports) {
  if (node.type !== "ImportDeclaration") return;

  if (node.specifiers.length === 0) {
    imports.push({ source: node.source.value, imported: null, local: null, kind: "side_effect", external: isExternalSource(node.source.value) });
    return;
  }
  for (const specifier of node.specifiers) {
    if (specifier.type === "ImportDefaultSpecifier") {
      imports.push({ source: node.source.value, imported: "default", local: specifier.local.name, kind: "default", external: isExternalSource(node.source.value) });
    } else if (specifier.type === "ImportNamespaceSpecifier") {
      imports.push({ source: node.source.value, imported: "*", local: specifier.local.name, kind: "namespace", external: isExternalSource(node.source.value) });
    } else {
      imports.push({ source: node.source.value, imported: propertyName(specifier.imported), local: specifier.local.name, kind: "named", external: isExternalSource(node.source.value) });
    }
  }
}

function addExport(node, exports) {
  if (node.type === "ExportDefaultDeclaration") {
    exports.push({ name: declarationName(node.declaration) ?? "default", kind: "default", source: null });
  } else if (node.type === "ExportAllDeclaration") {
    exports.push({ name: "*", kind: "all", source: node.source.value });
  } else if (node.type === "ExportNamedDeclaration") {
    for (const name of declarationNames(node.declaration)) {
      exports.push({ name, kind: "named", source: node.source?.value ?? null });
    }
    for (const specifier of node.specifiers) {
      exports.push({ name: propertyName(specifier.exported), kind: "named", source: node.source?.value ?? null });
    }
  }
}

function addCall(node, calls, callerSymbol) {
  if (node.type !== "CallExpression" || node.callee.type !== "Identifier") return;
  calls.push({ callee_name: node.callee.name, line: node.loc.start.line, caller_symbol: callerSymbol });
}

function createSymbol(name, kind, node) {
  return { name, kind, start_line: node.loc.start.line, end_line: node.loc.end.line };
}

function declarationNames(node) {
  if (!node) return [];
  if (node.type === "VariableDeclaration") return node.declarations.map((declaration) => declarationName(declaration)).filter(Boolean);
  const name = declarationName(node);
  return name ? [name] : [];
}

function declarationName(node) {
  if (node?.id?.type === "Identifier") return node.id.name;
  return null;
}

function propertyName(node) {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "StringLiteral" || node?.type === "NumericLiteral") return String(node.value);
  return null;
}

function isFunction(node) {
  return node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";
}

function isExternalSource(source) {
  return !source.startsWith(".") && !source.startsWith("/");
}
