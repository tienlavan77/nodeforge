// Business purpose: ensures Reviewer discovery works through the production worker boundary.
// Technical description: exercises selector injection, receipt registration and symbolic reads through SDK options.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createReviewWorker } from "../../src/modules/supervisor/review/review-worker.js";

for (const provider of ["openai", "codex"]) {
  test(`${provider} Reviewer worker forwards candidate dependencies and retains verified checksums`, async () => {
    const path = "backend/src/example.js";
    const content = "export function example() { return true; }\n";
    const sha256 = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    let calls = 0;
    const gateway = { execute: async ({ options }) => {
      const tools = options.forgeTools;
      const result = await tools.registry.select_code_graph_candidates.execute({ query: "example behavior" });
      assert.equal(result.selected[0].receipt.status, "verified");
      assert.equal(result.selected[0].sha256, sha256);
      assert.equal(tools.context.active_file_checksums[path].sha256, sha256);
      const read = await tools.registry.Read.execute({ file_path: path, symbol: "example" });
      assert.match(read.content, /function example/);
      return { text: '{"verdict":"approved","findings":[]}' };
    } };
    const worker = createReviewWorker({
      agentResolver: { resolveAvailable: () => ({ agent_id: `reviewer-${provider}`, role: "reviewer", provider }) },
      openaiSdkGateway: gateway, codexSdkGateway: gateway,
      relevantTreeSelector: { select: () => { calls++; return { tree: [{ path }] }; } },
      fileService: { readForIndex: async ({ path: requested }) => ({ path: requested, sha256,
        size_bytes: Buffer.byteLength(content), content: requested.endsWith("README.md") ? "Reviewer rules" : content }) },
      gitService: { diffPatchFrom: async () => "" }, projectRoot: process.cwd()
    });
    const result = await worker.review({ task_id: `candidate-worker-${provider}`, request_id: `request-${provider}`,
      agent_id: "coder", payload: { changed_paths: [path], ticket: { title: "example" } } });
    assert.equal(result.verdict, "approved");
    assert.equal(calls, 1);
  });
}
