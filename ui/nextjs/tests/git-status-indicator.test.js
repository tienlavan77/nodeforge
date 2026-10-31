// Verify the workspace Git indicator confirms and reports owner commit-push actions.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const component = await readFile("ui/nextjs/components/git-status-indicator.jsx", "utf8");

import { runInNewContext } from "node:vm";

// Keeps the commit action adjacent to status and confirms its complete changed-file scope.
test("Git status indicator confirms all changed files before commit and push", async () => {
  const headerProjectGit = await readFile("ui/nextjs/components/conversation-project-git.jsx", "utf8");
  assert.ok(component.includes("client.commitAndPush(projectId, \"Update project changes\")"));
  assert.ok(component.includes("Commit and push all ${changed} changed files?"));
  assert.ok(component.includes("view.changed > 0 && <button"));
  assert.ok(component.includes("result.status === \"pushed\""));
  assert.ok(component.includes("created, but push failed."));
  assert.ok(component.includes("message.includes(\"index.lock\")"));
  assert.ok(component.includes("Another Git operation is still running."));
  assert.ok(headerProjectGit.includes("<GitStatusIndicator client={client} projectId={projectId} />"));
  const fnMatch = headerProjectGit.match(/export function resolveConversationProjectName[\s\S]*?\n\}/)[0].replace("export ", "");
  const resolveConversationProjectName = runInNewContext(`${fnMatch}; resolveConversationProjectName`);
  assert.equal(resolveConversationProjectName("PROJECT-ALPHA", [{ project_id: "PROJECT-ALPHA", name: "Alpha Catalog" }], []), "Alpha Catalog");
  assert.equal(resolveConversationProjectName("PROJECT-BETA", [], [{ project_id: "PROJECT-BETA", name: "Beta Selection" }]), "Beta Selection");
  assert.equal(resolveConversationProjectName("PROJECT-FALLBACK", [], []), "PROJECT-FALLBACK");
});
