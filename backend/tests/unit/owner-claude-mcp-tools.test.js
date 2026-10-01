// Verifies Claude tool declarations remain gateway compatible without changing Forge path protection.
import assert from "node:assert/strict";
import test from "node:test";
import { claudeToolInputSchema } from "../../src/tools/owner-claude-mcp-tools.js";
import { readFileDefinition, writeDiffDefinition, editDiffDefinition } from "../../src/tools/index.js";

test("Claude tool declarations omit unsupported path lookaheads without mutating Forge schemas", () => {
  for (const definition of [readFileDefinition, writeDiffDefinition, editDiffDefinition]) {
    const adapted = claudeToolInputSchema(definition.input_schema);
    assert.equal(adapted.properties.path.pattern, undefined);
    assert.match(adapted.properties.path.description, /project-relative path/);
    assert.match(definition.input_schema.properties.path.pattern, /\(\?!/);
    assert.deepEqual(adapted.required, definition.input_schema.required);
    assert.equal(adapted.additionalProperties, false);
  }
  assert.equal(claudeToolInputSchema(writeDiffDefinition.input_schema).properties.before_checksum.pattern, writeDiffDefinition.input_schema.properties.before_checksum.pattern);
});
