import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import Ajv2020 from "ajv/dist/2020.js";

const require = createRequire(import.meta.url);
const schema = require("../../schemas/agent/agent-tool.schema.json");
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(schema);

test("agent tool request_info and submit_code variants validate", () => {
  for (const value of [
    { kind: "request_info", tool: "read_context", query: "NF-SVC-T01", reason: "Need context", round: 1, max_rounds: 5, next_action: "need_more_info" },
    { kind: "submit_code", target_path: "src/example.js", target_dir: "src", file_operation: "create", code_kind: "main", content: "x", round: 3, max_rounds: 5, next_action: "submit_main", is_final: false },
    { kind: "submit_code", target_path: "tests/example.test.js", target_dir: "tests", file_operation: "create", code_kind: "test", content: "x", round: 4, max_rounds: 5, next_action: "submit_test", is_final: true }
  ]) assert.equal(validate(value), true, ajv.errorsText(validate.errors));
});

test("agent tool rejects traversal, unsupported tools, and rounds above five", () => {
  assert.equal(validate({ kind: "request_info", tool: "shell", query: "x", reason: "x", round: 1, max_rounds: 5, next_action: "need_more_info" }), false);
  assert.equal(validate({ kind: "submit_code", target_path: "../outside.js", target_dir: "..", file_operation: "create", code_kind: "main", content: "x", round: 6, max_rounds: 5, next_action: "done", is_final: true, extra_tool: "shell" }), false);
});
