// Verifies Supervisor cannot publish a ticket verification pass from path-only checks.
import assert from "node:assert/strict";
import test from "node:test";
import { verifyTicketChangeset } from "../../src/modules/supervisor/ticket-verification-gate.js";

const legacyWorker = { verifyChangeset: async () => ({ status: "passed" }) };
const fileChecksums = { "backend/src/a.js": "sha256:a" };

// Requires the collected checksum and paths to match the persisted artifact.
test("ticket verification pass requires an exact artifact match", async () => {
  const workspace = { testService: { assertPassedArtifact: async () => ({ artifact_id: "ARTIFACT-1", commit_sha: "commit-1", file_checksums: fileChecksums }) } };
  const job = { payload: { changed_paths: ["backend/src/a.js"], checksums: fileChecksums } };
  const passed = await verifyTicketChangeset({ workspace, job, legacyWorker });
  assert.equal(passed.status, "passed");
  assert.equal(passed.verification_artifact_id, "ARTIFACT-1");
  const mismatch = await verifyTicketChangeset({ workspace, job: { payload: { changed_paths: ["backend/src/a.js"], checksums: { "backend/src/a.js": "sha256:b" } } }, legacyWorker });
  assert.equal(mismatch.status, "failed");
  assert.equal(mismatch.error.code, "VERIFY_COLLECTOR_MISMATCH");
});

// Fails closed when the receipt is absent or stale.
test("ticket verification does not fall back to path-only pass", async () => {
  const workspace = { testService: { assertPassedArtifact: async () => { throw Object.assign(new Error("missing artifact"), { code: "VERIFY_ARTIFACT_MISMATCH" }); } } };
  const result = await verifyTicketChangeset({ workspace, job: { payload: { changed_paths: ["backend/src/a.js"] } }, legacyWorker });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "VERIFY_ARTIFACT_MISMATCH");
});
