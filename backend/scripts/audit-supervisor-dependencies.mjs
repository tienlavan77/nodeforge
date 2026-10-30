/**
 * Audits the accepted supervisor layout without changing production behavior.
 * Owner and AM retain 39 orchestration modules at the supervisor root. This
 * diagnostic validates their exact pre-audit bytes, reconstructs pre-B.3 source
 * from checksum-bound snapshots, and compares resolved dependency edges and
 * strongly connected components after canonicalizing approved moved paths.
 * It records existing cycles and unresolved dynamic imports instead of claiming
 * that an import scan proves production execution or computed-path safety.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile, writeFile, access } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { createHash } from "node:crypto";
import { Linter } from "eslint";

// Keeps the audit inside the project and separates evidence from production source.
const root = resolve(new URL("../../", import.meta.url).pathname);
const reports = ".forge/runtime/reports/";
const supervisor = "backend/src/modules/supervisor/";

// Identifies source bytes so snapshots and live files cannot silently diverge.
function checksum(source) {
  return "sha256:" + createHash("sha256").update(source).digest("hex");
}

// Collects executable backend source only, excluding hidden runtime directories.
async function sources(directory) {
  const result = new Map();
  for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = posix.join(directory, entry.name);
    if (entry.isDirectory()) for (const pair of await sources(path)) result.set(...pair);
    else if (/\.(?:js|mjs)$/.test(path)) result.set(path, await readFile(resolve(root, path), "utf8"));
  }
  return result;
}

// Reads dependency syntax through ESLint's existing parser, avoiding text matches
// in comments and prompt strings that would create false dependency cycles.
function references(source, path) {
  const linter = new Linter();
  const messages = linter.verify(source, { parserOptions: { ecmaVersion: 2022, sourceType: "module" }, rules: {} });
  assert.deepEqual(messages.filter((message) => message.fatal), [], path);
  const syntax = linter.getSourceCode();
  const links = []; const computed = [];
  // Walks parser-defined child nodes while avoiding parent links and token arrays.
  function visit(node) {
    let dependency; let kind;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type)) {
      dependency = node.source; kind = "module";
    } else if (node.type === "ImportExpression") { dependency = node.source; kind = "module"; }
    else if (node.type === "CallExpression" && node.callee.name === "require") {
      dependency = node.arguments[0]; kind = "require";
    } else if (node.type === "NewExpression" && node.callee.name === "URL") {
      dependency = node.arguments[0]; kind = "resource";
    }
    if (dependency) {
      const value = dependency.value ?? (dependency.type === "TemplateLiteral" && !dependency.expressions.length
        ? dependency.quasis[0].value.cooked : null);
      if (typeof value === "string" && value.startsWith(".")) links.push({ specifier: value, kind, line: node.loc.start.line });
      else if (value == null && kind !== "resource") computed.push({ path, kind, line: node.loc.start.line });
    }
    for (const key of syntax.visitorKeys[node.type] ?? []) {
      const child = node[key];
      if (Array.isArray(child)) for (const item of child) { if (item?.type) visit(item); }
      else if (child?.type) visit(child);
    }
  }
  visit(syntax.ast);
  return { links, computed };
}

// Resolves local module imports for cycle analysis and records worker/resource
// paths separately because spawning a process is not an in-process module cycle.
function dependencyGraph(files, canonical = (path) => path) {
  const graph = new Map(); const resources = []; const external = []; const computed = [];
  for (const [path, source] of files) {
    const parsed = references(source, path);
    const dependencies = new Set();
    computed.push(...parsed.computed.map((entry) => ({ ...entry, path: canonical(path) })));
    for (const link of parsed.links) {
      const target = posix.normalize(posix.join(posix.dirname(path), link.specifier));
      const edge = { source: canonical(path), target: canonical(target), kind: link.kind, line: link.line };
      if (link.kind === "resource") resources.push(edge);
      else if (files.has(target)) dependencies.add(canonical(target));
      else external.push(edge);
    }
    graph.set(canonical(path), dependencies);
  }
  return { graph, resources, external, computed };
}

// Finds strongly connected components, including self-imports, so the audit can
// distinguish preserved historical cycles from cycles introduced by relocation.
function cycles(graph) {
  const indices = new Map(); const low = new Map(); const stack = []; const active = new Set();
  const result = []; let index = 0;
  // Uses Tarjan's traversal to retain each complete cycle component exactly once.
  function visit(path) {
    indices.set(path, index); low.set(path, index++); stack.push(path); active.add(path);
    for (const target of graph.get(path) ?? []) {
      if (!graph.has(target)) continue;
      if (!indices.has(target)) { visit(target); low.set(path, Math.min(low.get(path), low.get(target))); }
      else if (active.has(target)) low.set(path, Math.min(low.get(path), indices.get(target)));
    }
    if (low.get(path) !== indices.get(path)) return;
    const component = []; let member;
    do { member = stack.pop(); active.delete(member); component.push(member); } while (member !== path);
    if (component.length > 1 || graph.get(path)?.has(path)) result.push(component.sort());
  }
  for (const path of graph.keys()) if (!indices.has(path)) visit(path);
  return result.sort((left, right) => left.join("|").localeCompare(right.join("|")));
}

// Canonicalizes only approved supervisor moves so a changed directory cannot
// masquerade as either a new dependency or a missing historical cycle.
function supervisorEdges(graph) {
  return [...graph].filter(([path]) => path.startsWith(supervisor))
    .flatMap(([path, targets]) => [...targets].map((target) => path + " -> " + target)).sort();
}

// Restores source from the exact snapshots preceding each group, in reverse
// migration order; unrelated live source remains identical in both graphs.
async function precedingSource(current) {
  const before = new Map(current); let validated = 0;
  for (const [stage, count] of [[5, 38], [4, 22], [3, 28], [2, 10], [1, 1]]) {
    for (let part = 1; part <= count; part++) {
      const name = stage === 1 ? "phase-b3-1-before.json" : stage === 2 && part === 10
        ? "phase-b3-2-before-010.json" : "phase-b3-" + stage + "-before-" + String(part).padStart(2, "0") + ".json";
      const snapshot = JSON.parse(await readFile(resolve(root, reports + name), "utf8"));
      for (const change of snapshot.changes) {
        if (!change.path.startsWith("backend/src/")) continue;
        assert.equal(checksum(change.before), change.before_checksum, change.path);
        if (change.path !== change.target) before.delete(change.target);
        before.set(change.path, change.before); validated++;
      }
    }
  }
  return { before, validated };
}

// Proves source identity and graph preservation for the final B.3 core boundary;
// raw runtime tests remain separate checks with their original assertions.
test("B.3.6 core identities, dependencies and cycles preserve the accepted source layout", async () => {
  const plan = JSON.parse(await readFile(resolve(root, reports + "phase-b3-6-plan.json"), "utf8"));
  const current = await sources("backend/src");
  assert.equal(plan.core.length, 39);
  assert.deepEqual([...current.keys()].filter((path) => path.startsWith(supervisor)
    && !path.slice(supervisor.length).includes("/")).sort(), plan.core.map((entry) => entry.path).sort());
  for (const path of plan.snapshots) {
    const snapshot = JSON.parse(await readFile(resolve(root, path), "utf8"));
    for (const change of snapshot.changes) {
      assert.equal(checksum(change.before), change.before_checksum, change.path);
      assert.equal(checksum(current.get(change.path)), change.before_checksum, change.path);
    }
  }
  assert.ok(plan.core.every((entry) => entry.code_lines <= 250));
  const inventory = JSON.parse(await readFile(resolve(root, reports + "phase-b3-source-inventory.json"), "utf8"));
  const moved = inventory.groups.flatMap((group) => group.changes).filter((entry) => entry.source_path !== entry.target_path);
  assert.equal(moved.length, 222);
  const reverse = new Map(moved.map((entry) => [entry.target_path, entry.source_path]));
  const previous = await precedingSource(current);
  const baseline = dependencyGraph(previous.before);
  const after = dependencyGraph(current, (path) => reverse.get(path) ?? path);
  const missing = [];
  for (const edge of [...after.external, ...after.resources.filter((entry) => /\.(js|mjs)$/.test(entry.target))]) {
    const physical = moved.find((entry) => entry.source_path === edge.target)?.target_path ?? edge.target;
    try { await access(resolve(root, physical)); }
    catch (error) { missing.push({ ...edge, code: error.code }); }
  }
  const oldEdges = supervisorEdges(baseline.graph), newEdges = supervisorEdges(after.graph);
  const oldCycles = cycles(baseline.graph), newCycles = cycles(after.graph);
  const evidence = { purpose: "Static dependency/cycle audit; runtime checks are separate.",
    core_unchanged: 39, moved_modules: moved.length, validated_pre_move_records: previous.validated,
    source_modules: current.size, baseline_edges: oldEdges, current_edges: newEdges,
    baseline_cycles: oldCycles, current_cycles: newCycles, missing_local_imports: missing,
    resources: after.resources, computed_imports: after.computed,
    scope: "Backend source ESM imports/exports, literal dynamic imports and literal require; external local paths validated, computed imports retained as limitations." };
  await writeFile(resolve(root, reports + "phase-b3-6-dependency-audit.json"), JSON.stringify(evidence) + "\n");
  assert.deepEqual(newEdges, oldEdges);
  assert.deepEqual(newCycles, oldCycles);
  assert.deepEqual(missing, []);
  assert.deepEqual(after.computed.filter((entry) => plan.core.some((core) => core.path === entry.path)), []);
  console.log(JSON.stringify({ core_unchanged: 39, source_modules: current.size, supervisor_edges: newEdges.length,
    baseline_cycles: oldCycles.length, current_cycles: newCycles.length, missing_local_imports: missing.length }));
});
