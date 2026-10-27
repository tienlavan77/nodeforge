// Architecture Plan JSON schema, RFC 7396 merge and deterministic render contract.
// Business purpose: only Architecture Manager JSON becomes plan content, and Node must
// refuse to lock a revision from anything the schema cannot prove. Invalid, ambiguous,
// null-bearing or prose-only answers must leave no trace, while a valid canonical plan
// must render byte-identical Markdown whatever the JSON key insertion order was, so the
// owner always reviews the exact bytes Node later hashes, snapshots and hands off.
// Technical description: covers AC-2 fail-closed parsing, AC-7 canonical determinism and
// schema rejection, and AC-10 acceptance of the rendered document by the unchanged
// Markdown gates (validateMarkdown heading/discovery/assumption gates plus the
// section-5 outcome table reader in markdown-sprint-scope).
import assert from "node:assert/strict";
import test from "node:test";
import { architectureSessionFromRecord, canonicalArchitecturePlanSha256, canonicalizeArchitecturePlanJSON, mergeArchitecturePlanJSON, parseArchitecturePlanJSON, reconstructPlanFromCanonicalSource, renderArchitecturePlanMarkdown } from "../../src/modules/governance/architecture-plan-json.js";
import { appendArchitectureDecisions, readArchitectureDecisions } from "../../src/modules/governance/architecture-owner-decisions.js";
import { readMarkdownSprintScope } from "../../src/modules/governance/markdown-sprint-scope.js";
import { applyRfc7396MergePatch } from "../../src/shared/rfc7396-merge-patch.js";

const SHA = "a".repeat(64);

// Builds one schema-valid plan object whose key insertion order is caller-controlled.
function plan(reordered) {
  const base = {
    title: "Contract plan",
    objective: "Lock a schema-validated plan revision.",
    background: "Owner requested planning in the conversation.",
    scope: ["Backend planning and tests"],
    outcomes: [{ id: "O1", outcome: "Valid revision locked", acceptance_criteria: ["Schema-valid JSON only"], guardrails: ["No approval authority change"] }],
    evidence: [{ path: "backend/src/modules/governance/architecture-plan-json.js", location: "L1", fact: "Parsing is fail-closed." }],
    assumptions: ["Owner reviews before approval."],
    constraints: ["Preserve Markdown storage contracts"],
    risks: ["Provider drift"],
    verification: "Focused contract tests."
  };
  if (!reordered) return base;
  const entries = Object.entries(base);
  return Object.fromEntries([...entries.slice(1), entries[0]]);
}

// Builds a confirmed owner-decision session for the reconstruction gate.
function decisionSession(sourceSha256) {
  return { session_id: "CLARIFY-00000000-0000-4000-8000-000000000000", source_path: "backend/src/a.md", source_sha256: sourceSha256, owner_id: "OWNER", confirmed_at: "2026-10-25T00:00:00.000Z", questions: [{ id: "SCOPE", title: "Scope", reason: "Owner decides", options: [{ id: "NARROW", label: "Narrow", description: "Only planning" }] }], selections: { SCOPE: "NARROW" }, notes: {} };
}

test("schema-invalid, ambiguous, null-bearing and prose-only responses are rejected without partial state", () => {
  const rejected = ["", "   ", "I recommend we build this incrementally and review later.", "{", "[1,2]", '{"title":null}', JSON.stringify({ ...plan(), objective: null }), JSON.stringify({ ...plan(), scope: [] }), JSON.stringify({ ...plan(), assumptions: [""] }), JSON.stringify({ ...plan(), extra: 7 }), JSON.stringify({ ...plan(), outcomes: [{ id: "X1", outcome: "x", acceptance_criteria: ["y"], guardrails: ["z"] }] }), JSON.stringify({ ...plan(), evidence: [{ path: "/etc/passwd", fact: "x" }] }), JSON.stringify({ ...plan(), evidence: [{ path: "backend/src/a.js", location: "nope", fact: "x" }] })];
  for (const raw of rejected) assert.throws(() => parseArchitecturePlanJSON(raw), (error) => error.code === "ARCHITECTURE_PLAN_JSON_INVALID" && error.statusCode === 409, `must reject: ${String(raw).slice(0, 40)}`);
  assert.deepEqual(parseArchitecturePlanJSON(JSON.stringify(plan())), JSON.parse(JSON.stringify(plan())), "a valid plan round-trips");
});

test("canonical rendering is identical regardless of object-key insertion order", () => {
  const a = parseArchitecturePlanJSON(JSON.stringify(plan(false)));
  const b = parseArchitecturePlanJSON(JSON.stringify(plan(true)));
  assert.equal(canonicalizeArchitecturePlanJSON(a), canonicalizeArchitecturePlanJSON(b));
  assert.equal(canonicalArchitecturePlanSha256(a), canonicalArchitecturePlanSha256(b));
  const first = renderArchitecturePlanMarkdown({ plan: a, planId: "PLAN-A", revision: 1, sourceSha256: SHA });
  const second = renderArchitecturePlanMarkdown({ plan: b, planId: "PLAN-A", revision: 1, sourceSha256: SHA });
  assert.equal(first, second, "identical bytes for identical content");
  assert.equal(first.match(/^# Plan:/gm)?.length, 1, "exactly one Plan heading");
  assert.ok(first.includes("[Evidence: backend/src/modules/governance/architecture-plan-json.js#L1]"), "complete evidence rendered");
  assert.ok(first.includes("Assumption (unverified): Owner reviews before approval."), "complete assumptions rendered");
});

// Preserves exact AM citations for evidence that spans multiple source windows,
// including the typographic dashes emitted by the real conversation planning run.
test("evidence accepts single lines, typographic ranges and multiple source ranges", () => {
  for (const location of ["L1", "L17-75", "L17-L75", "L17–75", "L17—L75", "L98–106; L136–157; L160–238"]) {
    const candidate = { ...plan(), evidence: [{ ...plan().evidence[0], location }] };
    const parsed = parseArchitecturePlanJSON(JSON.stringify(candidate));
    assert.equal(parsed.evidence[0].location, location);
    const markdown = renderArchitecturePlanMarkdown({ plan: parsed, planId: "PLAN-A", revision: 1, sourceSha256: SHA });
    assert.ok(markdown.includes(`#${location}]`));
  }
});

// Separates malformed source coordinates from missing evidence so a retry can
// correct the precise field instead of asking the owner to supply unrelated facts.
test("invalid evidence reports its indexed field and rejects malformed source ranges", () => {
  for (const location of ["", "L0", "L75-17", "L1;", "L1; prose", "L1\nL2", "L1–", 17, "L9007199254740992"]) {
    const candidate = { ...plan(), evidence: [plan().evidence[0], { ...plan().evidence[0], location }] };
    assert.throws(() => parseArchitecturePlanJSON(JSON.stringify(candidate)), (error) => error.code === "ARCHITECTURE_PLAN_JSON_INVALID" && /evidence\[1\]\.location/.test(error.message));
  }
  for (const invalid of [{ path: "/etc/passwd", fact: "A fact" }, { path: "backend/src/a.js", fact: "" }]) {
    assert.throws(() => parseArchitecturePlanJSON(JSON.stringify({ ...plan(), evidence: [invalid] })), /evidence\[0\].*project source path and a concrete fact/);
  }
});

test("the rendered section-5 outcome table is accepted by the unchanged Markdown gates", () => {
  const markdown = renderArchitecturePlanMarkdown({ plan: plan(), planId: "PLAN-A", revision: 1, sourceSha256: SHA });
  assert.match(markdown, /^# Plan:\s*\S/);
  assert.ok(/^## 1\. /m.test(markdown) && /^## 7\. /m.test(markdown));
  assert.match(markdown, /discovery complete/i);
  assert.match(markdown, /assumption|unverified|unknown|uncertain/i);
  const scope = readMarkdownSprintScope(markdown);
  assert.equal(scope[0].kind, "outcome");
  assert.equal(scope[0].id, "O1");
  assert.deepEqual(scope[0].acceptance_criteria, ["Schema-valid JSON only"]);
  assert.equal(scope[0].guardrails.length, 1);
});

// Protects schema-valid alternatives in owner requirements from becoming table delimiters.
test("literal pipes, code alternatives and multiline JSON stay within outcome cells", () => {
  const candidate = plan();
  candidate.outcomes[0] = { id: "O1", outcome: "Ideas open|done", acceptance_criteria: ["status=open|done|all", "code `open|done` and ``x|y``", "first line\nsecond line"], guardrails: ["Keep GET|PATCH stable"] };
  const markdown = renderArchitecturePlanMarkdown({ plan: candidate, planId: "PLAN-A", revision: 1, sourceSha256: SHA });
  const [scope] = readMarkdownSprintScope(markdown);
  assert.equal(scope.outcome, "Ideas open|done");
  assert.deepEqual(scope.acceptance_criteria, ["status=open|done|all", "code open|done and x|y", "first line<br>second line"]);
  assert.deepEqual(scope.guardrails, ["Keep GET|PATCH stable"]);
  assert.match(markdown, /status=open\\\|done\\\|all/);
});

test("RFC 7396 merge updates fields, deletes nested keys with null and replaces arrays wholesale", () => {
  const merged = mergeArchitecturePlanJSON(JSON.stringify(plan()), JSON.stringify({ outcomes: [{ id: "O1", outcome: "Replaced list", acceptance_criteria: ["Replaced"], guardrails: ["Replaced"] }], evidence: [{ path: "backend/src/shared/rfc7396-merge-patch.js", fact: "Merge is shared." }], risks: [] }));
  assert.equal(merged.outcomes[0].outcome, "Replaced list");
  assert.equal(merged.outcomes.length, 1);
  assert.deepEqual(merged.risks, []);
  assert.equal(merged.title, "Contract plan", "omitted fields keep their retained base value");
  const patched = applyRfc7396MergePatch({ a: { b: 1, c: 2 } }, { a: { c: null, d: 3 } });
  assert.deepEqual(patched, { a: { b: 1, d: 3 } }, "a nested null deletes only that key");
  for (const patch of [JSON.stringify({ title: null }), "not json", JSON.stringify({ title: "  " }), JSON.stringify({ unknown: 1 })]) assert.throws(() => mergeArchitecturePlanJSON(JSON.stringify(plan()), patch), { code: "ARCHITECTURE_PLAN_JSON_INVALID" });
});

test("the retained canonical source reconstructs the revision base and detects altered bytes", () => {
  const parsed = parseArchitecturePlanJSON(JSON.stringify(plan()));
  const canonicalBytes = canonicalizeArchitecturePlanJSON(parsed);
  const sourceSha256 = canonicalArchitecturePlanSha256(parsed);
  const markdown = renderArchitecturePlanMarkdown({ plan: parsed, planId: "PLAN-A", revision: 1, sourceSha256 });
  const plain = `${markdown.trim()}\n`;
  assert.deepEqual(reconstructPlanFromCanonicalSource({ canonicalBytes, sourceSha256, markdown: plain, planId: "PLAN-A", revision: 1 }), parsed, "an empty decision record reproduces the locked bytes");
  const appended = appendArchitectureDecisions(markdown, decisionSession(sourceSha256));
  assert.deepEqual(reconstructPlanFromCanonicalSource({ canonicalBytes, sourceSha256, markdown: appended, planId: "PLAN-A", revision: 1 }), parsed, "Node's decision block is reproducible from the record alone");
  assert.deepEqual(architectureSessionFromRecord(readArchitectureDecisions(appended)).selections, { SCOPE: "NARROW" });
  assert.throws(() => reconstructPlanFromCanonicalSource({ canonicalBytes: `${canonicalBytes} `, sourceSha256, markdown: plain, planId: "PLAN-A", revision: 1 }), { code: "PLAN_SOURCE_MISMATCH" });
  assert.throws(() => reconstructPlanFromCanonicalSource({ canonicalBytes, sourceSha256, markdown: `${plain}extra\n`, planId: "PLAN-A", revision: 1 }), { code: "PLAN_HASH_MISMATCH" });
});
