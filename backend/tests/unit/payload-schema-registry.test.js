import test from "node:test";
import assert from "node:assert/strict";

import { getPayloadSchema, hasPayloadSchema, payloadSchemaRegistry } from "../../src/modules/protocol/payload-schema-registry.js";

test("registry contains every Agent response payload type", () => {
  for (const type of ["code_needed", "submit_code_response", "usage_needed", "no_wiring_needed", "completed", "continue"]) {
    assert.equal(hasPayloadSchema("agent", type), true, `missing agent:${type}`);
    assert.equal(getPayloadSchema("agent", type).type, "object");
  }
});

test("code_response is an explicit compatibility alias", () => {
  assert.strictEqual(getPayloadSchema("agent", "code_response"), getPayloadSchema("agent", "submit_code_response"));
});

test("unknown role/type is rejected", () => {
  assert.equal(hasPayloadSchema("node", "completed"), false);
  assert.throws(() => getPayloadSchema("node", "completed"), /Unsupported payload schema/);
  assert.equal(Object.keys(payloadSchemaRegistry).length, 7);
});
