// Verify the workspace Git indicator confirms and reports owner commit-push actions.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const component = await readFile("ui/nextjs/components/git-status-indicator.jsx", "utf8");

// Keeps the commit action adjacent to status and confirms its complete changed-file scope.
test("Git status indicator confirms all changed files before commit and push", () => {
  assert.ok(component.includes("client.commitAndPush(projectId, \"Update project changes\")"));
  assert.ok(component.includes("Commit and push all ${changed} changed files?"));
  assert.ok(component.includes("view.changed > 0 && <button"));
  assert.ok(component.includes("result.status === \"pushed\""));
  assert.ok(component.includes("created, but push failed."));
});
