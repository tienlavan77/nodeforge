// Summary: Extracts JSX UI metadata (static class names, ids, roles, ARIA and
// data attributes) from a Babel AST so selectors and labels become searchable
// symbols with exact line positions.

const ATTRIBUTE_KINDS = Object.freeze({
  className: "jsx_class",
  id: "jsx_id",
  role: "jsx_role",
  "aria-label": "jsx_aria",
  "aria-labelledby": "jsx_aria",
  "data-testid": "jsx_data"
});

// Defines createJsxUiWalker function behavior for jsx-ui.js.
export function createJsxUiWalker() {
  return Object.freeze({ collectUiSymbols });

  // Defines collectUiSymbols function behavior for jsx-ui.js.
  function collectUiSymbols(ast) {
    const symbols = [];
    walkNode(ast.program, null, symbols);
    return symbols;
  }

  // Defines walkNode function behavior for jsx-ui.js.
  function walkNode(node, tagName, symbols) {
    if (!node || typeof node !== "object") return;

    if (node.type === "JSXElement" || node.type === "JSXFragment") {
      const elementTag = node.type === "JSXElement" ? elementTagName(node.openingElement) : tagName;
      collectAttributes(node.type === "JSXElement" ? node.openingElement.attributes : [], elementTag, symbols);
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) walkNode(child, node.type === "JSXElement" ? elementTagName(node.openingElement) : tagName, symbols);
      } else if (value?.type) {
        walkNode(value, node.type === "JSXElement" ? elementTagName(node.openingElement) : tagName, symbols);
      }
    }
  }

  // Defines collectAttributes function behavior for jsx-ui.js.
  function collectAttributes(attributes, tagName, symbols) {
    for (const attribute of attributes) {
      if (attribute.type !== "JSXAttribute" || typeof attribute.name?.name !== "string") continue;
      const kind = ATTRIBUTE_KINDS[attribute.name.name];
      if (!kind) continue;
      const value = staticAttributeValue(attribute.value);
      if (!value) continue;
      symbols.push({ name: value, kind, start_line: attribute.loc.start.line, end_line: attribute.loc.end.line });
    }
  }
}

// Defines elementTagName function behavior for jsx-ui.js.
function elementTagName(openingElement) {
  const name = openingElement?.name;
  if (name?.type === "JSXIdentifier") return name.name;
  return null;
}

// Defines staticAttributeValue function behavior for jsx-ui.js.
function staticAttributeValue(value) {
  if (value?.type === "StringLiteral") return value.value.trim() || null;
  // Template literals and expressions stay out: only provably static values
  // become symbols, avoiding invented names for runtime-computed classes.
  if (value?.type === "JSXExpressionContainer" && value.expression?.type === "StringLiteral") return value.expression.value.trim() || null;
  return null;
}
