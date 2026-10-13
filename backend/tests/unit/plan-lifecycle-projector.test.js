// Verifies plan progress reaches the project stream with exact correlation and without approval authority or secrets.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
const streamSchema = createRequire(import.meta.url)("../../../schemas/stream/project-stream-event.schema.json");
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
ajv.addSchema(createRequire(import.meta.url)("../../../schemas/stream/architecture-clarification-waiting.schema.json"));
const validate = ajv.compile(streamSchema);
import { createProjectStreamPublisher } from "../../src/transport/sse/project-stream-publisher.js";
import { createProjectStream } from "../../src/transport/sse/project-stream.js";

const projectId = "PROJECT-A";
const requestId = "PLAN-REQUEST-1";
const identity = { plan_id: "PLAN-A", revision: 1, sha256: "a".repeat(64) };
const publisher = createProjectStreamPublisher({ projectId, indexDb: { all: () => [] } });

// Builds a native lifecycle envelope for projection and isolation tests.
function event(status, payload = {}, project = projectId) {
  return { project_id: project, event_type: `plan.request.${status}`, payload: { request_id: requestId, ...payload } };
}

test("projects only correlated lifecycle fields, not credentials, content or approval", () => {
  const secret = { token: "secret", markdown: "private content", approved: true, actor: "OWNER", conversation_id: "CONV-A", error_message: "secret failure" };
  for (const [status, fields] of [["generating", {}], ["awaiting_owner_decisions", { session_id: "CLARIFY-00000000-0000-0000-0000-000000000000" }], ["persisted", identity], ["failed", { error_code: "PLAN_GENERATION_FAILED" }]]) {
    const projected = publisher.project(event(status, { ...fields, ...secret }));
    assert.deepEqual(projected, { event_type: `plan.request.${status}`, payload: { request_id: requestId, ...fields } });
    assert.equal(publisher.project(event(status, fields, "PROJECT-B")), null);
    assert.equal(publisher.project({ ...event(status, fields), project_id: undefined }), null);
  }
});

test("rejects missing or malformed request, artifact identity and error codes", () => {
  for (const request_id of [undefined, null, 1, "", "bad/request", "request secret"]) {
    assert.equal(publisher.project(event("generating", { request_id })), null);
  }
  for (const override of [{ plan_id: undefined }, { plan_id: "../plan" }, { revision: 0 }, { revision: 1.5 }, { revision: "1" }, { sha256: "bad" }, { sha256: "A".repeat(64) }]) {
    assert.equal(publisher.project(event("persisted", { ...identity, ...override })), null);
  }
  for (const error_code of [undefined, "", "secret message", "ERROR\nTOKEN", "A".repeat(81)]) {
    assert.equal(publisher.project(event("failed", { error_code })), null);
  }
  assert.equal(publisher.project(event("approved", identity)), null);
  for (const session_id of [undefined, "", "OTHER", "../session"]) assert.equal(publisher.project(event("awaiting_owner_decisions", { session_id })), null);
});

test("native stream ingestion delivers all three lifecycle transitions without conversation binding", () => {
  let listener;
  const chunks = [];
  const subscriptions = {
    subscribe: (_pattern, callback) => { listener = callback; return "SUB-A"; },
    unsubscribe: () => { listener = null; },
    publish: (input) => { listener?.(input); return 1; }
  };
  const response = { writableEnded: false, write: (chunk) => chunks.push(chunk), end: () => { response.writableEnded = true; } };
  const stream = createProjectStream({ projectId, indexDb: { all: () => [] }, subscriptions });
  const connection = stream.connect({ requestedProjectId: projectId, response });
  try {
    for (const input of [event("generating"), event("persisted", identity), event("failed", { error_code: "PLAN_GENERATION_FAILED" })]) stream.ingest(input);
    const delivered = chunks.filter((chunk) => chunk.includes("data: ")).map((chunk) => JSON.parse(chunk.split("data: ")[1])).filter((input) => input.event_type.startsWith("plan."));
    assert.deepEqual(delivered.map((input) => input.event_type), ["plan.request.generating", "plan.request.persisted", "plan.request.failed"]);
    assert.ok(delivered.every((input) => input.project_id === projectId && input.payload.request_id === requestId));
    for (const input of delivered) {
      assert.equal(validate(input), true, JSON.stringify(validate.errors));
      assert.equal(validate({ ...input, payload: { ...input.payload, token: "secret" } }), false);
      assert.equal(validate({ ...input, payload: { ...input.payload, request_id: "bad/request" } }), false);
    }
    const persisted = delivered[1];
    assert.equal(validate({ ...persisted, payload: { ...persisted.payload, revision: 0 } }), false);
    assert.equal(validate({ ...persisted, payload: { ...persisted.payload, sha256: "bad" } }), false);
    assert.equal(validate({ ...delivered[2], payload: { request_id: requestId, error_code: "raw secret" } }), false);
    assert.throws(() => stream.ingest(event("generating", {}, "PROJECT-B")), { code: "PROJECT_CONTEXT_CONFLICT" });
    stream.ingest(event("persisted", { ...identity, revision: 0 }));
    assert.equal(chunks.filter((chunk) => chunk.includes("event: plan.")).length, 3);
  } finally { connection.close(); }
});
