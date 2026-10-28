/** Exercises real service restart with a legacy supplemental failure to prove
 * ordinary verification resumes after durable PASS checks, while preserving
 * final source/environment validation and the immutable failed artifact. */
import assert from "node:assert/strict";
import test from "node:test";
import { baselineFixture, failedBaseline } from "./ticket-baseline-recovery-fixture.js";
import { createTicketVerificationService } from "../../src/modules/supervisor/ticket-verification-service.js";

test("a restarted verification service reuses validated PASS checks and reruns the failed suffix", async () => {
  const f = await baselineFixture();
  try {
    const first = await failedBaseline(f);
    assert.equal(first.job.status, "failed");
    const count = f.calls.length;
    const original = JSON.stringify(first.artifact);
    f.service = createTicketVerificationService(f.options);
    const second = await failedBaseline(f);
    assert.equal(second.job.status, "passed", JSON.stringify(second.job));
    const calls = f.calls.slice(count);
    assert.equal(calls.some(command => command.argv.includes(f.primary)), false);
    assert.equal(calls.some(command => ["lint", "typecheck", "schema_validation"].includes(command.kind)), false);
    assert.equal(calls.filter(command => command.argv.includes(f.regression)).length, 2);
    assert.equal(calls.filter(command => command.argv.includes(f.trailing)).length, 1);
    assert.equal(second.artifact.commands.find(command => command.argv.includes(f.primary)).reused_from.job_id, first.job.job_id);
    assert.equal((await f.service.assertPassedArtifact()).artifact_id, second.artifact.artifact_id);
    assert.equal(JSON.stringify(await f.service.loadArtifact(first.artifact.artifact_id)), original);
  } finally { await f.close(); }
});
