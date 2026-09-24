// Summary: ESLint rule blocking catch blocks that swallow errors without logging or rethrowing.
"use strict";

// Reports a catch block when it neither rethrows, logs through a logger/console
// call, nor references the caught error (e.g. embedding error.message in the
// fallback value). Best-effort probes opt out explicitly with a per-line
// suppression comment naming this rule plus a reason.
const LOG_METHOD = /^(log|logger|debug|info|warn|warning|error|trace)$/i;
const EVENT_METHOD = /^(publish|emit|send|record|capture|report|track)$/i;
const LOG_OBJECT = /^(console|logger|projectLogger|warnings|errors|lastErrors|failures)$/i;

function calleeIsLogging(callee) {
  if (!callee) return false;
  if (callee.type === "Identifier") return LOG_METHOD.test(callee.name) || EVENT_METHOD.test(callee.name) || /log/i.test(callee.name);
  if (callee.type !== "MemberExpression" && callee.type !== "OptionalMemberExpression") return false;
  const prop = callee.property;
  const name = prop.type === "Identifier" ? prop.name : prop.type === "Literal" && typeof prop.value === "string" ? prop.value : null;
  if (!name) return false;
  if (LOG_METHOD.test(name) || /log/i.test(name)) return true;
  if (EVENT_METHOD.test(name)) return true;
  if (name === "push" && callee.object.type === "Identifier" && /^(warnings|errors|lastErrors|failures)$/i.test(callee.object.name)) return true;
  if (name === "write" && callee.object.type === "MemberExpression") return true;
  if (callee.object.type === "Identifier" && LOG_OBJECT.test(callee.object.name)) return true;
  return false;
}

// Detects throw or logging calls directly inside the catch body, ignoring
// nested function boundaries whose throw/log does not handle this error.
function scanBody(body) {
  let throws = false;
  let logs = false;
  const visit = (node, nested) => {
    if (!node || typeof node.type !== "string") return;
    if (!nested) {
      if (node.type === "ThrowStatement") { throws = true; return; }
      if ((node.type === "CallExpression" || node.type === "OptionalCallExpression") && calleeIsLogging(node.callee)) { logs = true; }
    }
    const inner = node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression";
    for (const key in node) {
      if (key === "parent") continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach((child) => visit(child, nested || inner));
      else if (value && typeof value.type === "string") visit(value, nested || inner);
    }
  };
  visit(body, false);
  return { throws, logs };
}

// Reports true when the catch body reads the caught error outside nested
// function boundaries (e.g. embedding error.message in the fallback value).
// Reads nested inside a closure do not count: they may run later or never.
function referencesParam(body, name) {
  let found = false;
  const visit = (node, nested, parent) => {
    if (!node || typeof node.type !== "string" || found) return;
    const inner = node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression";
    const inNested = nested || inner;
    if (!inNested && node.type === "Identifier" && node.name === name) {
      const isMemberKey = parent && (parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") && parent.property === node && parent.computed === false;
      const isObjectKey = parent && parent.type === "Property" && parent.key === node && !parent.computed && parent.value !== node;
      if (!isMemberKey && !isObjectKey) { found = true; return; }
    }
    for (const key in node) {
      if (key === "parent") continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach((child) => { if (child && typeof child.type === "string") visit(child, inNested, node); });
      else if (value && typeof value.type === "string") visit(value, inNested, node);
    }
  };
  visit(body, false, null);
  return found;
}

module.exports = {
  meta: { type: "problem", docs: { description: "forbid catch blocks that swallow errors without logging" }, schema: [] },
  create(context) {
    return {
      CatchClause(node) {
        if (node.body.body.length === 0) {
          context.report({ node, message: "Empty catch block swallows the error. Log it or add eslint-disable-next-line no-silent-catch with a reason." });
          return;
        }
        const { throws, logs } = scanBody(node.body);
        if (throws || logs) return;
        if (node.param && node.param.type === "Identifier" && referencesParam(node.body, node.param.name)) return;
        context.report({ node, message: "Catch block returns a fallback without logging the error. Log via logger/console, reference the caught error, or add eslint-disable-next-line no-silent-catch with a reason." });
      }
    };
  }
};
