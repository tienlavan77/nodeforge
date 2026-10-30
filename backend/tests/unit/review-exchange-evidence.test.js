// Covers complete review-history delivery through existing tools without granting general runtime access.
import test from "node:test";
import assert from "node:assert/strict";
import { createReviewExchangeEvidence, attachReviewExchangeTools } from "../../src/modules/supervisor/review/review-exchange-evidence.js";
import { createReviewerForgeTools } from "../../src/modules/supervisor/review/reviewer-forge-tools.js";

// Creates genuine Reviewer tools with a source service that must never serve virtual history.
function fixture(exchange) {
  const events = [];
  const job = { task_id: "TICKET-1", request_id: "REVIEW-1" };
  const evidence = createReviewExchangeEvidence(job.task_id, exchange);
  const base = createReviewerForgeTools({ projectRoot: "/project", job, reviewer: { agent_id: "REVIEWER" },
    fileService: { readForIndex: async () => { throw new Error("Unexpected source read"); } } });
  return { evidence, tools: attachReviewExchangeTools(base, evidence, { job, projectLogger: (event) => events.push(event) }), events };
}

test("large REV-1 history cannot hide later finding definitions, responses or adjudications", async () => {
  const exchange = { task_id: "TICKET-1", version: 12, findings: [
    { finding_id: "REV-1", status: "fixed", finding: { failure: "old issue" }, history: Array.from({ length: 25 }, () => ({ failure: "historic details ".repeat(200) })) },
    { finding_id: "REV-2", status: "open", finding: { failure: "Authoritative second finding" } },
    { finding_id: "REV-3", status: "open", finding: { failure: "Deliver complete evidence" } }
  ], coder_responses: [{ idempotency_key: "RESPONSE-1", responses: [{ finding_id: "REV-2", rationale: "Already repaired" }] }],
  adjudications: [{ finding_id: "REV-2", decision: "retain", reason: "Needs original evidence" }] };
  const original = structuredClone(exchange);
  const { evidence, tools, events } = fixture(exchange);
  assert.ok(JSON.stringify(exchange).length > 32_000);
  assert.match(evidence.prompt, /REV-2/);
  assert.match(evidence.prompt, /REV-3/);
  assert.doesNotMatch(evidence.prompt, /TRUNCATED/);
  for (const [path, file] of evidence.files) {
    const chunks = [];
    for (let start = 1; start <= file.total_lines; start += 40) {
      const result = await tools.registry.read_lines.execute({ path, start_line: start, end_line: start + 39 });
      chunks.push(result.stdout);
      assert.equal(result.sha256, file.sha256);
      assert.equal(result.evidence_scope, "ticket_review_history");
    }
    assert.equal(chunks.join("\n"), file.content);
  }
  const path = [...evidence.files.keys()].find((entry) => entry.includes("findings/1/current"));
  const result = await tools.registry.read_file.execute({ path });
  assert.equal(JSON.parse(result.content).finding.failure, "Authoritative second finding");
  assert.deepEqual(exchange, original);
  assert.ok(events.every((event) => event.event_name === "review.tool_call"));
  assert.ok(events.every((event) => event.payload.evidence_scope === "ticket_review_history"));
});

test("history snapshot reads keep exact-ticket boundaries, input limits and runtime secrets private", async () => {
  const { tools, evidence, events } = fixture({ findings: [{ finding_id: "REV-1", failure: "Bearer abc.def.ghi" }] });
  const path = [...evidence.files.keys()][0];
  assert.doesNotMatch((await tools.registry.read_file.execute({ path })).content, /abc.def.ghi/);
  await assert.rejects(tools.registry.read_lines.execute({ path, start_line: 1, end_line: 81 }), { code: "REVIEW_EVIDENCE_READ_INVALID" });
  await assert.rejects(tools.registry.read_file.execute({ path, offset: 0 }), { code: "REVIEW_EVIDENCE_READ_INVALID" });
  for (const other of [path.replace("TICKET-1", "TICKET-2"), ".forge/runtime/secrets.json", ".forge/runtime/review-evidence/TICKET-1/../secret.json"])
    await assert.rejects(tools.registry.read_file.execute({ path: other }), { code: "FILE_ROLE_FORBIDDEN" });
  assert.ok(events.some((event) => event.status === "failed"));
});

test("oversized individual records remain readable by smaller windows with a stable snapshot hash", async () => {
  const { tools, evidence } = fixture({ findings: [{ finding_id: "REV-1", evidence: Array.from({ length: 150 }, (_, index) => `Evidence ${index}: ${"x".repeat(300)}`) }] });
  const path = [...evidence.files.keys()][0];
  await assert.rejects(tools.registry.read_lines.execute({ path, start_line: 1, end_line: 80 }), { code: "REVIEW_EVIDENCE_READ_INVALID" });
  const chunks = [];
  for (let start = 1; start <= evidence.files.get(path).total_lines; start += 20) {
    const result = await tools.registry.read_lines.execute({ path, start_line: start, end_line: start + 19 });
    chunks.push(result.stdout);
    assert.equal(result.sha256, evidence.files.get(path).sha256);
  }
  assert.equal(chunks.join("\n"), evidence.files.get(path).content);
});
