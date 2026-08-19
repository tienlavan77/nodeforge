import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const schemaDirectories = ["schemas"];
const fixtures = [
  ["https://forge.local/schemas/core/agent.schema.json", "schemas/examples/builder-agent.json"],
  ["https://forge.local/schemas/core/agent.schema.json", "schemas/examples/node-agent.json"],
  ["https://forge.local/schemas/core/command.schema.json", "schemas/examples/envelope-command.json", "/message"],
  ["https://forge.local/schemas/core/command.schema.json", "schemas/examples/command-context-request.json"],
  ["https://forge.local/schemas/core/command.schema.json", "schemas/examples/command-tasks-report-status.json"],
  ["https://forge.local/schemas/core/command.schema.json", "schemas/examples/command-agents-report-touch.json"],
  ["https://forge.local/schemas/core/command.schema.json", "schemas/examples/command-sprints-request-plan.json"],
  ["https://forge.local/schemas/core/command.schema.json", "schemas/examples/command-agents-report-touch-invalid.json", undefined, false],
  ["https://forge.local/schemas/core/envelope.schema.json", "schemas/examples/envelope-command.json"],
  ["https://forge.local/schemas/core/envelope.schema.json", "schemas/examples/envelope-event.json"],
  ["https://forge.local/schemas/core/error.schema.json", "schemas/examples/error.json"],
  ["https://forge.local/schemas/core/event.schema.json", "schemas/examples/event.json"],
  ["https://forge.local/schemas/core/event.schema.json", "schemas/examples/envelope-event.json", "/message"],
  ["https://forge.local/schemas/node/node-agent.schema.json", "schemas/examples/node-agent.json"],
  ["https://forge.local/schemas/node/node-capability.schema.json", "schemas/examples/node-agent.json"],
  ["https://forge.local/schemas/node/node-command.schema.json", "schemas/examples/node-command.json"],
  ["https://forge.local/schemas/node/node-event.schema.json", "schemas/examples/envelope-event.json", "/message"],
  ["https://forge.local/schemas/node/node-event.schema.json", "schemas/examples/event-review-requested.json"],
  ["https://forge.local/schemas/node/node-event.schema.json", "schemas/examples/event-verification-test-started.json"],
  ["https://forge.local/schemas/node/node-event.schema.json", "schemas/examples/event-concurrent-modification.json"],
  ["https://forge.local/schemas/core/event.schema.json", "schemas/examples/event-sprints-plan-proposed.json"],
  ["https://forge.local/schemas/node/node-query-result.schema.json", "schemas/examples/node-query-result.json"],
  ["https://forge.local/schemas/node/node-state.schema.json", "schemas/examples/node-state.json"],
  ["https://forge.local/schemas/context/context.schema.json", "schemas/examples/context-pack.json"],
  ["https://forge.local/schemas/project/permission.schema.json", "schemas/examples/permission.json", "/0"],
  ["https://forge.local/schemas/project/permission.schema.json", "schemas/examples/permission.json", "/1"],
  ["https://forge.local/schemas/project/builder-evidence.schema.json", "schemas/examples/builder-evidence.json"],
  ["https://forge.local/schemas/project/builder-evidence.schema.json", "schemas/examples/builder-evidence-invalid.json", undefined, false],
  ["https://forge.local/schemas/project/rule.schema.json", "schemas/examples/rule.json"],
  ["https://forge.local/schemas/project/rule.schema.json", "schemas/examples/rule-invalid-blocking-no-condition.json", undefined, false],
  ["https://forge.local/schemas/project/rule.schema.json", "schemas/examples/rule-invalid-orchestrator-no-condition.json", undefined, false],
  ["https://forge.local/schemas/project/rule.schema.json", "schemas/examples/rule-invalid-condition-no-language.json", undefined, false],
  ["https://forge.local/schemas/project/project.schema.json", "schemas/examples/project.json"],
  ["https://forge.local/schemas/project/session.schema.json", "schemas/examples/session.json"],
  ["https://forge.local/schemas/project/session.schema.json", "schemas/examples/session-ai-capability.json"],
  ["https://forge.local/schemas/project/session.schema.json", "schemas/examples/session-node-capability.json"],
  ["https://forge.local/schemas/project/session.schema.json", "schemas/examples/session-invalid-capability.json", undefined, false],
  ["https://forge.local/schemas/project/task.schema.json", "schemas/examples/task.json"],
  ["https://forge.local/schemas/project/task.schema.json", "schemas/examples/task-with-commit.json"],
  ["https://forge.local/schemas/project/workflow-ruleset.schema.json", "rules/forge-sprint-delivery.rules.json"],
  ["https://forge.local/schemas/results/check-result.schema.json", "schemas/examples/check-result.json"],
  ["https://forge.local/schemas/results/file-change.schema.json", "schemas/examples/file-change.json"],
  ["https://forge.local/schemas/results/review-result.schema.json", "schemas/examples/review-result.json"],
  ["https://forge.local/schemas/results/test-result.schema.json", "schemas/examples/test-result.json"],
  ["https://forge.dev/schemas/verification/verification-plan.schema.json", "schemas/examples/verification-plan.json"],
  ["https://forge.dev/schemas/verification/verification-run.schema.json", "schemas/examples/verification-run.json"],
  ["https://forge.dev/schemas/verification/verification-result.schema.json", "schemas/examples/verification-result.json"],
  ["https://forge.dev/schemas/verification/test-failure.schema.json", "schemas/examples/test-failure.json"],
  ["https://forge.dev/schemas/verification/verification-policy.schema.json", "schemas/examples/verification-policy.json"],
  ["https://forge.dev/schemas/roadmap/commit.schema.json", "schemas/examples/commit.json"],
  ["https://forge.dev/schemas/roadmap/sprint.schema.json", "schemas/examples/sprint.json"],
  ["https://forge.dev/schemas/roadmap/roadmap.schema.json", "schemas/examples/roadmap.json"]
];

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function loadSchemas(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const loaded = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return loadSchemas(path);
    if (entry.isFile() && entry.name.endsWith(".schema.json")) return [await readJson(path)];
    return [];
  }));
  return loaded.flat();
}

function atPointer(value, pointer) {
  if (!pointer) return value;
  return pointer.slice(1).split("/").reduce(
    (current, segment) => current?.[segment.replace(/~1/g, "/").replace(/~0/g, "~")],
    value
  );
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

try {
  const schemas = (await Promise.all(schemaDirectories.map(loadSchemas))).flat();
  for (const schema of schemas) ajv.addSchema(schema);
  const validators = new Map();
  const errors = [];

  for (const schema of schemas) {
    try {
      validators.set(schema.$id, ajv.getSchema(schema.$id));
    } catch (error) {
      errors.push(`${schema.$id}: ${error.message}`);
    }
  }

  for (const [schemaId, fixturePath, pointer, expectedValid = true] of fixtures) {
    const validate = validators.get(schemaId);
    if (!validate) continue;

    try {
      const fixture = atPointer(await readJson(fixturePath), pointer);
      if (fixture === undefined) throw new Error("value not found");
      const isValid = validate(fixture);
      if (isValid !== expectedValid) {
        const result = expectedValid ? ajv.errorsText(validate.errors, { separator: "; " }) : "expected schema to reject fixture";
        throw new Error(result);
      }
    } catch (error) {
      errors.push(`${fixturePath}${pointer ?? ""} against ${schemaId}: ${error.message}`);
    }
  }

  if (errors.length) throw new Error(`\n${errors.join("\n")}`);

  const schemaBreakdown = new Map();
  for (const schema of schemas) {
    const directory = schema.$id.split("/schemas/")[1].split("/")[0];
    schemaBreakdown.set(directory, (schemaBreakdown.get(directory) ?? 0) + 1);
  }
  const fixtureBreakdown = new Map();
  for (const [schemaId] of fixtures) {
    const directory = schemaId.split("/schemas/")[1].split("/")[0];
    fixtureBreakdown.set(directory, (fixtureBreakdown.get(directory) ?? 0) + 1);
  }

  console.log(`Validated ${schemas.length} schemas and ${fixtures.length} fixtures.`);
  console.log("Schema breakdown:");
  for (const [directory, count] of schemaBreakdown) console.log(`  ${directory}: ${count}`);
  console.log("Fixture validation breakdown:");
  for (const [directory, count] of fixtureBreakdown) console.log(`  ${directory}: ${count}`);
} catch (error) {
  console.error(`Schema validation failed: ${error.message}`);
  process.exitCode = 1;
}
