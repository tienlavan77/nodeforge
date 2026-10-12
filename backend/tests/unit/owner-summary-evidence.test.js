// Verifies planning summaries accept readable documentation sources without weakening approval or execution gates.
import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerChatCommandService } from "../../src/application/owner-chat-command-service.js";

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

// Keeps evidence verification on generated plans without imposing the retired summary template on source files.
test("plan accepts an AM-written Markdown source and verified discovery references", async () => {
  for (const reference of ["[Source: docs/scope.md]", "[Evidence: workflows/agents/architecture/README.md#L1-L3]", "[Source: `docs/scope.md#L1`]", "[Source: `ui/nextjs/components/coding-architecture-plans.jsx`]"]) {
    const { service, drafts, writes } = fixture();
    const markdown = `# Plan: Scope\n## 1. Goal\nRepository discovery complete. ${reference}\n## 5. Outcomes\n| Mã | Outcome | Acceptance | Guardrail |\n| --- | --- | --- | --- |\n| O1 | API works | HTTP responds | — |\n## 6. Risks\nAssumption: scope.\n## 7. Acceptance\nReview.`;
    const result = await service.execute({ text: "/plan docs/scope.md", requestArchitecture: async () => markdown });
    assert.equal(result.status, "awaiting_human_approval");
    assert.equal(result.run_started, false);
    assert.equal(result.source_summary_path, "docs/scope.md");
    assert.equal(drafts.length, 1);
    assert.equal(writes.length, 0);
  }
});

// Rejects fabricated discovery evidence before saving a generated plan.
test("invalid generated plan references block persistence", async () => {
  for (const reference of ["", "[Source: docs/missing.md]", "[Source: docs/empty.md]", "[Source: docs/../secret.md]", "[Source: /docs/scope.md]", "[Source: https://example.com/docs/scope.md]", "[Source: `docs/scope.md]", "[Source: docs/scope.md#L0]"]) {
    const { service, drafts } = fixture();
    await assert.rejects(service.execute({ text: "/plan docs/scope.md", requestArchitecture: async () => `# Plan: Scope\n## 1. Goal\nRepository discovery complete. ${reference}\nAssumption: scope.\n## 7. Acceptance\nReview.` }), { code: "DISCOVERY_INCOMPLETE" });
    assert.equal(drafts.length, 0);
  }
});

// Fails missing or empty source files before invoking Architecture.
test("missing and empty source Markdown cannot start generation", async () => {
  for (const [path, code] of [["docs/missing.md", "SUMMARY_NOT_FOUND"], ["docs/empty.md", "SUMMARY_SOURCE_INVALID"]]) {
    const { service, drafts } = fixture();
    await assert.rejects(service.execute({ text: `/plan ${path}`, requestArchitecture: async () => assert.fail("invalid source must block provider") }), { code });
    assert.equal(drafts.length, 0);
  }
});

// Rejects unsafe paths and retires the old summary command without writing artifacts.
test("plan path validation and retired summary command fail before file access", async () => {
  for (const path of ["SUMMARY-A", "/docs/scope.md", "docs/../scope.md", "docs//scope.md", "./docs/scope.md", "https://example.com/scope.md", "C:\\scope.md", "docs/scope.txt"]) {
    const { service, reads } = fixture();
    await assert.rejects(service.execute({ text: `/plan ${path}` }), { code: "PLAN_SOURCE_PATH_INVALID" });
    assert.equal(reads.length, 0);
  }
  const { service, writes } = fixture();
  assert.equal(service.isCommand("/summary"), false);
  await assert.rejects(service.execute({ text: "/summary" }), { code: "COMMAND_INVALID" });
  assert.equal(writes.length, 0);
});
