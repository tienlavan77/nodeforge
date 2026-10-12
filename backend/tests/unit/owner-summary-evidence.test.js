// Verifies planning summaries accept readable documentation sources without weakening approval or execution gates.
import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerChatCommandService } from "../../src/application/owner-chat-command-service.js";

// Builds a discussion-only summary with the required uncertainty labels and an explicit source.
function summary(reference) {
  return `# Discussion Summary\n\n## Goals\nReview scope. ${reference}\n\n## In Scope\nPlanning.\n\n## Out of Scope\nRUN.\n\n## Decisions\nAwait review.\n\n## Assumptions\nAssumption: scope is stable.\n\n## Risks\nUnknown dependencies.\n\n## Open Questions\nWhich smoke test?`;
}

// Models readable project documents and records persistence independently of provider output.
function fixture() {
  const files = new Map([
    ["docs/scope.md", "# Scope\nReview the API."],
    ["workflows/agents/architecture/README.md", "# Frame\n## 1. Mục tiêu\n## 7. Nghiệm thu"],
    ["ui/nextjs/components/coding-architecture-plans.jsx", "export const plan = {};"],
    ["docs/empty.md", "   "],
  ]);
  const reads = []; const writes = []; const drafts = [];
  const service = createOwnerChatCommandService({
    projectId: "PROJECT-A",
    fileService: {
      readFile: async ({ path }) => { reads.push(path); if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return files.get(path); },
      atomicCreate: async ({ path, content }) => { files.set(path, content); writes.push(path); },
    },
    planStore: { createRevision: async () => {}, assertExecutable: async () => {} },
    markdownPlanStore: { createRevision: async (draft) => { drafts.push(draft); return { status: "awaiting_human_approval", revision: 1, sha256: "a".repeat(64), file_path: "workflows/plan.md" }; } },
  });
  return { service, files, reads, writes, drafts };
}

// Accepts documentation, workflow and code-path backticks only after reading the newly supported source.
test("summary accepts verified planning sources and paired backticks", async () => {
  for (const reference of ["[Source: docs/scope.md]", "[Evidence: workflows/agents/architecture/README.md#L1-L3]", "[Source: `docs/scope.md#L1`]", "[Source: `ui/nextjs/components/coding-architecture-plans.jsx`]"]) {
    const { service, reads, writes } = fixture();
    const result = await service.execute({ text: "/summary", requestArchitecture: async (prompt) => { assert.match(prompt, /Do not invent sources/); return summary(reference); } });
    assert.equal(result.status, "created");
    assert.equal(result.execution_authorized, false);
    assert.equal(result.plan_created, false);
    assert.equal(writes.length, 1);
    assert.equal(reads.length, 1);
  }
});

// Prevents fake, empty, external and traversal sources from making an invalid summary durable.
test("invalid planning references do not persist summaries", async () => {
  for (const reference of ["", "[Source: docs/missing.md]", "[Source: docs/empty.md]", "[Source: docs/../secret.md]", "[Source: /docs/scope.md]", "[Source: https://example.com/docs/scope.md]", "[Source: `docs/scope.md]", "[Source: docs/scope.md#L0]"]) {
    const { service, reads, writes } = fixture();
    await assert.rejects(service.execute({ text: "/summary", requestArchitecture: async () => summary(reference) }), { code: "SUMMARY_EVIDENCE_MISSING" });
    assert.equal(writes.length, 0);
    if (!/missing|empty/.test(reference)) assert.equal(reads.length, 0);
  }
});

// Ensures a valid documentation summary remains accepted by plan intake and plan discovery.
test("summary and plan intake share verified evidence rules", async () => {
  const { service, files, drafts } = fixture();
  const result = await service.execute({ text: "/summary", requestArchitecture: async () => summary("[Source: `docs/scope.md`]") });
  const markdown = "# Plan: Review scope\n\n## 1. Mục tiêu\nRepository discovery complete. [Evidence: docs/scope.md]\n\n## 5. Outcomes\n| Mã | Outcome | Acceptance criteria | Guardrail |\n| --- | --- | --- | --- |\n| O1 | API works | HTTP returns canonical errors | — |\n\n## 6. Rủi ro\nAssumption: scope is stable.\n\n## 7. Nghiệm thu\n- [ ] Reviewed";
  const plan = await service.execute({ text: `/plan ${result.summary_id}`, requestArchitecture: async () => markdown });
  assert.equal(plan.status, "awaiting_human_approval");
  assert.equal(plan.run_started, false);
  assert.equal(drafts.length, 1);
  files.delete("docs/scope.md");
  await assert.rejects(service.execute({ text: `/plan ${result.summary_id}`, requestArchitecture: async () => assert.fail("missing summary source must block provider") }), { code: "SUMMARY_SOURCE_INVALID" });
  assert.equal(drafts.length, 1);
});

// Preserves legacy code-source compatibility while checking extended references in generated plans.
test("legacy summary stays compatible but missing plan source blocks persistence", async () => {
  const { service, drafts } = fixture();
  const result = await service.execute({ text: "/summary", requestArchitecture: async () => summary("[Evidence: backend/src/application/owner-chat-command-service.js]") });
  await assert.rejects(service.execute({ text: `/plan ${result.summary_id}`, requestArchitecture: async () => "# Plan: Scope\n## 1. Goal\nRepository discovery complete. [Source: docs/missing.md]\nAssumption: scope.\n## 7. Acceptance\nReview." }), { code: "DISCOVERY_INCOMPLETE" });
  assert.equal(drafts.length, 0);
});
