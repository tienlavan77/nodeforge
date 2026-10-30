/** Keeps test-induced source mutations in the independent review conversation as
 * failed, durable evidence while preserving rejection of an invalid starting tree. */
import assert from "node:assert/strict";
import test from "node:test";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { reviewVerificationFixture } from "../fixtures/review-verification-fixture.js";
import { createReviewVerificationService } from "../../src/modules/supervisor/review/review-verification-service.js";
import { captureVerificationEnvironment, persistVerificationEnvironment } from "../../src/modules/supervisor/ticket/ticket-verification-environment.js";
import { materializeTicketVerification } from "../../src/modules/supervisor/ticket/ticket-verification-materialization.js";

// Runs real recorded tests that mutate their disposable working tree, including
// the legacy fixture mistake of recreating a ticket-deleted file through cwd.
for (const path of ["x", "backend/src/dependency.mjs"]) {
  test(`post-check mutation of ${path} returns failed evidence instead of aborting Reviewer`, async () => {
    const f = await reviewVerificationFixture();
    try {
      if (path === "x") f.artifact.file_checksums[path] = null;
      await writeFile(join(f.root, f.testPath), 'import test from "node:test";\nimport {writeFile} from "node:fs/promises";\n' +
        `test("test fixture mutates cwd", async () => { await writeFile(${JSON.stringify(path)}, ""); });\n`);
      f.artifact.environment = await persistVerificationEnvironment(f.root, await captureVerificationEnvironment({
        projectRoot: f.root, ticketPaths: Object.keys(f.artifact.file_checksums) }));
      const input = { requests: [{ ...f.request, scope: "regression" }], artifact: f.artifact, executionId: "EXECUTION-1" };
      const [receipt] = await f.service(input);
      assert.equal(receipt.status, "failed");
      assert.equal(receipt.commands[0].exit_code, 0);
      assert.equal(receipt.integrity_error.phase, "after_checks");
      assert.equal(receipt.integrity_error.code, path === "x" ? "VERIFY_SOURCE_MISMATCH" : "VERIFY_ENVIRONMENT_CHANGED");
      assert.match(receipt.integrity_error.message, new RegExp(path.replaceAll(".", "\\.")));
      if (path === "x") {
        assert.equal(receipt.integrity_error.path, path);
        assert.equal(receipt.integrity_error.expected_sha256, null);
        assert.equal(receipt.integrity_error.observed_sha256, `sha256:${createHash("sha256").update("").digest("hex")}`);
        await assert.rejects(access(join(f.root, path)), { code: "ENOENT" });
      } else assert.match(await readFile(join(f.root, path), "utf8"), /dependency = 13/);
      const again = await createReviewVerificationService(f.options)(input);
      assert.deepEqual(again[0], JSON.parse(JSON.stringify(receipt)));
      assert.equal(f.commands(), 1);
      assert.equal(f.artifact.status, "passed");
      assert.equal(f.logs.at(-1).event_name, "review.verification_failed");
    } finally { await f.close(); }
  });
}

test("a mismatched source before checks remains an explicit invalid-evidence error", async () => {
  const f = await reviewVerificationFixture();
  try {
    const service = createReviewVerificationService({ ...f.options, materialize: async (input) => {
      const archive = await materializeTicketVerification(input);
      await writeFile(join(archive.path, f.path), "wrong starting source\n");
      return archive;
    } });
    await assert.rejects(service({ requests: [f.request], artifact: f.artifact, executionId: "EXECUTION-1" }),
      { code: "VERIFY_SOURCE_MISMATCH", path: f.path });
    assert.equal(f.commands(), 0);
  } finally { await f.close(); }
});
