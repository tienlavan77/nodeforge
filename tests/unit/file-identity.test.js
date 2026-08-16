import assert from "node:assert/strict";
import test from "node:test";

import { FileIdentityRegistry } from "../../src/shared/file-identity.js";

test("a file keeps its file_id when renamed or moved", () => {
  const registry = new FileIdentityRegistry({ createId: () => "FILE-001" });
  const originalPath = "src/auth.js";
  const renamedPath = "src/security/auth.js";

  const fileId = registry.getOrCreate(originalPath);
  const movedFileId = registry.rename(originalPath, renamedPath);

  assert.equal(fileId, "FILE-001");
  assert.equal(movedFileId, fileId);
  assert.equal(registry.get(originalPath), undefined);
  assert.equal(registry.get(renamedPath), fileId);
  assert.doesNotMatch(fileId, /auth|security|src/);
});
