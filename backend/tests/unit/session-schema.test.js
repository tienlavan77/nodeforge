import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../schemas/core/common.schema.json");
const agentSchema = require("../../../schemas/core/agent.schema.json");
const sessionSchema = require("../../../schemas/project/session.schema.json");

test("accepts AI and Node session capability profiles while keeping the field optional", async () => {
  const validate = createSessionValidator();
  for (const fixture of ["session-ai-capability.json", "session-node-capability.json", "session.json"]) {
    assert.equal(validate(await readFixture(fixture)), true, fixture);
  }
});

test("rejects a session capability declaration that matches neither Agent profile", async () => {
  const validate = createSessionValidator();
  assert.equal(validate(await readFixture("session-invalid-capability.json")), false);
});

function createSessionValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(agentSchema).addSchema(sessionSchema);
  return ajv.getSchema(sessionSchema.$id);
}

async function readFixture(name) {
  return JSON.parse(await readFile(new URL(`../../../schemas/examples/${name}`, import.meta.url), "utf8"));
}
