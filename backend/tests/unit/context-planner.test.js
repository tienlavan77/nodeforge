import assert from "node:assert/strict";
import test from "node:test";
import { createContextPlanner } from "../../src/modules/index/context-planner.js";

function setup({ stale = false } = {}) {
  const content = "export function publish() { return true; }\n";
  const hash = "sha256:" + "a".repeat(64);
  const database = { all(sql, params = []) { if (sql.includes("FROM files")) return params[0] === "src/a.js" ? [{ file_id: "a", path: "src/a.js", language: "javascript", sha256: stale ? "sha256:" + "b".repeat(64) : hash, size_bytes: content.length }] : []; if (sql.includes("index_metadata")) return [{ version: 3 }]; return []; } };
  const fileService = { readForIndex: async () => ({ path: "src/a.js", content, language: "javascript", sha256: hash, size_bytes: content.length }) };
  return { database, fileService };
}

test("materializes relevant files through File Service with fresh checksum", async () => {
  const { database, fileService } = setup();
  const result = await createContextPlanner({ database, fileService }).plan({ relevantTree: [{ path: "src/a.js", score: 0.9, reason: ["symbol:publish"] }] });
  assert.equal(result.files[0].content.includes("publish"), true);
  assert.equal(result.files[0].score, 0.9);
  assert.equal(result.source, "file-service");
});

test("rejects stale indexed content and invalid budgets", async () => {
  const stale = setup({ stale: true });
  await assert.rejects(() => createContextPlanner(stale).plan({ relevantTree: ["src/a.js"] }), (error) => error.code === "CONTEXT_STALE");
  const fresh = setup();
  await assert.rejects(() => createContextPlanner(fresh).plan({ relevantTree: ["src/a.js"], tokenBudget: 1 }), /token budget/);
});
