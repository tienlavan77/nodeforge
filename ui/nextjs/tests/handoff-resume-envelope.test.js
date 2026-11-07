// Business purpose: verifies that the handoff Resume control calls the direct checkpoint route with exact plan identity.
// Technical description: exercises the Node client request adapter and confirms the backend route path and captured revision/SHA are sent without posting a conversation command.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createOwnerExecutionClient } from "../lib/owner-execution-client.js";
import { forgeV1 } from "../lib/node-client-url.js";

const projectId = "PROJECT-TEST";
const handoff = { handoff_id: "HANDOFF-PLAN-TEST-R1", plan_revision: 2, plan_sha256: "a".repeat(64), roles: { am: { conversation_id: "CONV-AM" } } };

// Business purpose: captures one direct client request and returns a controlled checkpoint result.
// Technical description: replaces network transport with a deterministic request adapter so the test asserts the client contract without depending on router internals.
function fixture(response = { status: "running", checkpoint: { execution_status: "pending", next_step: "se" } }) {
  const requests = [];
  const client = createOwnerExecutionClient({ forgeV1: (path, query) => `/forge/v1${path}?project=${query.project}`, requestJson: async (path, options) => { requests.push({ path, options }); return response; } });
  return { client, requests };
}

test("handoff Resume calls the direct implementation checkpoint with exact identity", async () => {
  const f = fixture();
  const response = await f.client.resumeHandoff(projectId, handoff, "owner-token");
  assert.equal(response.status, "running");
  assert.equal(f.requests[0].path, "/forge/v1/handoffs/HANDOFF-PLAN-TEST-R1/resume?project=PROJECT-TEST");
  assert.deepEqual(JSON.parse(f.requests[0].options.body), { project_id: projectId, approval_revision: handoff.plan_revision, approval_sha256: handoff.plan_sha256 });
});

test("workspace inspection and explicit adoption use project scope and exact plan identity", async () => {
  const { client, requests } = fixture();
  const handoff = { handoff_id: "HANDOFF-TEST", plan_revision: 2, plan_sha256: "approved-sha" };
  await client.getHandoffWorkspace("PROJECT-TEST", handoff);
  assert.match(requests[0].path, /\/handoffs\/HANDOFF-TEST\/workspace\?/);
  await client.adoptHandoffWorkspace("PROJECT-TEST", handoff, "owner-secret");
  assert.match(requests[1].path, /\/handoffs\/HANDOFF-TEST\/adopt-workspace\?/);
  assert.equal(requests[1].options.headers.authorization, "Bearer owner-secret");
  assert.deepEqual(JSON.parse(requests[1].options.body), { project_id: "PROJECT-TEST", approval_revision: 2, approval_sha256: "approved-sha" });
});

test("handoff Resume exposes a backend execution error", async () => {
  const f = fixture();
  f.requests.length = 0;
  f.client = createOwnerExecutionClient({ forgeV1: (path, query) => `/forge/v1${path}?project=${query.project}`, requestJson: async () => { throw new Error("HANDOFF_EXECUTION_UNKNOWN"); } });
  await assert.rejects(f.client.resumeHandoff(projectId, handoff, "owner-token"), /HANDOFF_EXECUTION_UNKNOWN/);
});
