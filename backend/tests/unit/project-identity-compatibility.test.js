// Unit tests verifying backward compatibility of project_id validation across schemas, catalog, and operation contracts.
// Business purpose: ensures both new URL-safe slug identities and legacy PROJECT-... identities are accepted by
// project-lifecycle-transport.schema.json, project-operation.schema.json, and project-catalog.js without breaking existing projects.
// Technical description: validates slug and PROJECT-... identities against JSON schemas with Ajv2020, tests createProjectCatalog
// with mixed legacy and slug entries, and verifies validateOperationSnapshot acceptance and rejection rules.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { createProjectCatalog } from "../../src/modules/projects/project-catalog.js";
import { validateOperationSnapshot } from "../../src/modules/projects/project-operation-contract.js";
import { isValidProjectId } from "../../src/modules/projects/project-registry.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../schemas/core/common.schema.json");
const projectSchema = require("../../../schemas/project/project.schema.json");
const operationSchema = require("../../../schemas/project/project-operation.schema.json");
const transportSchema = require("../../../schemas/project/project-lifecycle-transport.schema.json");

// Builds an Ajv2020 instance preloaded with common and project-related JSON schemas.
// Business purpose: enables consistent schema validation of project operations and lifecycle transport payloads in unit tests.
// Technical description: initializes Ajv2020 with strict mode and format validators, registering common, project, operation, and transport schemas.
function createValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, useDefaults: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema);
  ajv.addSchema(projectSchema);
  ajv.addSchema(operationSchema);
  ajv.addSchema(transportSchema);
  return ajv;
}

test("project-lifecycle-transport.schema.json and project-operation.schema.json accept both slug and legacy PROJECT-... IDs", () => {
  const ajv = createValidator();
  const validateOperation = ajv.getSchema(operationSchema.$id);
  const validateTransport = ajv.getSchema(transportSchema.$id);

  for (const validId of ["du-an-ban-hang", "project-123", "PROJECT-114A", "PROJECT-550e8400-e29b-41d4-a716-446655440000"]) {
    assert.equal(isValidProjectId(validId), true, `Expected ${validId} to be valid`);

    const opRecord = {
      operation_id: "OPRO-test-1",
      request_key: "req-1",
      request_fingerprint: "a".repeat(64),
      kind: "create",
      root: "/workspace/project",
      project_id: validId,
      attempt: 1,
      revision: 2,
      stage: "settled",
      status: "succeeded",
      counters: { transitions: 2, attempts: 1 },
      timestamps: {
        created_at: "2026-10-27T00:00:00.000Z",
        updated_at: "2026-10-27T00:00:01.000Z",
        settled_at: "2026-10-27T00:00:01.000Z"
      },
      result: {
        outcome: "succeeded",
        project_id: validId,
        root: "/workspace/project"
      }
    };
    assert.equal(validateOperation(opRecord), true, ajv.errorsText(validateOperation.errors));
    assert.doesNotThrow(() => validateOperationSnapshot(opRecord));

    const directoryResponse = {
      version: "1",
      projects: [
        {
          root: "/workspace/project",
          project_id: validId,
          readiness: "ready",
          operation: {
            attempt_id: 1,
            status: "succeeded",
            diagnostic: null
          },
          diagnostic: null,
          retryable: false
        }
      ]
    };
    assert.equal(validateTransport(directoryResponse), true, ajv.errorsText(validateTransport.errors));
  }

  for (const invalidId of ["INVALID_UPPERCASE", "-leading-hyphen", "trailing-hyphen-", "double--hyphen", "PROJECT-"]) {
    const badDirectory = {
      version: "1",
      projects: [
        {
          root: "/workspace/project",
          project_id: invalidId,
          readiness: "ready",
          operation: { attempt_id: 1, status: "succeeded", diagnostic: null },
          diagnostic: null,
          retryable: false
        }
      ]
    };
    assert.equal(validateTransport(badDirectory), false, `Expected transport schema to reject ${invalidId}`);
  }
});

test("project-catalog.js accepts mixed slug and legacy PROJECT-... entries and rejects malformed projectId", async () => {
  const tempDir = await mkdtemp(join(os.tmpdir(), "nodeforge-catalog-compat-"));
  try {
    const catalogPath = join(tempDir, "projects.json");
    const validEntries = [
      { root: join(tempDir, "legacy-proj"), projectId: "PROJECT-legacy-001" },
      { root: join(tempDir, "slug-proj"), projectId: "du-an-ban-hang" }
    ];
    await writeFile(catalogPath, JSON.stringify(validEntries, null, 2), "utf8");

    const catalog = await createProjectCatalog({ catalogPath });
    assert.deepEqual(catalog.list(), validEntries);

    const invalidCatalogPath = join(tempDir, "invalid-projects.json");
    await writeFile(
      invalidCatalogPath,
      JSON.stringify([{ root: join(tempDir, "bad"), projectId: "Not_A_Valid_Slug" }]),
      "utf8"
    );
    await assert.rejects(
      () => createProjectCatalog({ catalogPath: invalidCatalogPath }),
      /Invalid global project catalog/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
