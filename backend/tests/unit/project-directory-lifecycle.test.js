// Verify the project chooser lists the actual single runtime without granting catalog mutation authority.
import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { createProjectDirectoryLifecycle } from "../../src/application/project-directory-lifecycle.js";
import { routeProjectLifecycle } from "../../src/modules/projects/project-lifecycle.js";

test("single-project directory uses the real running identity through the existing lifecycle route", async () => {
  const lifecycle = createProjectDirectoryLifecycle({ projectId: "PROJECT-A", projectRoot: process.cwd() });
  const response = await routeProjectLifecycle("GET", new URL("http://localhost/lifecycle/list"), Readable.from([]), lifecycle);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { projects: [{ project_id: "PROJECT-A", root: process.cwd(), readiness: "ready", operation: { attempt_id: 1, status: "succeeded", diagnostic: null }, diagnostic: null, retryable: false }], startup_errors: [] });
  for (const operation of ["add", "remove"]) assert.throws(() => lifecycle[operation](process.cwd()), { code: "lifecycle_unavailable", statusCode: 503 });
});

test("configured lifecycle remains the authority for all project admission and directory operations", () => {
  const configured = { list: () => [] };
  assert.equal(createProjectDirectoryLifecycle({ projectLifecycle: configured, projectId: "DEFAULT", projectRoot: "/default" }), configured);
  assert.equal(createProjectDirectoryLifecycle({}), undefined);
});
