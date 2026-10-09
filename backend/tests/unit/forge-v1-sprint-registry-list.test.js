// Verifies the Sprint list blocks mixed legacy and Registry inventories before data can be hidden.
import assert from "node:assert/strict";
import test from "node:test";

import { createForgeV1Router } from "../../src/transport/http/forge-v1-router.js";

test("Sprint list rejects an unmigrated legacy Sprint beside Registry records", async () => {
  const router = createForgeV1Router({
    sprintRegistry: { listDetails: async () => [{ id: "SPRINT-REGISTRY" }] },
    sprintPlanUploadService: { list: () => [{ id: "SPRINT-LEGACY" }] }
  });
  await assert.rejects(router.route("GET", new URL("http://localhost/forge/v1/sprints?project=PROJECT-A"), { headers: {} }), {
    code: "SPRINT_REGISTRY_MIGRATION_REQUIRED",
    statusCode: 409,
    identifiers: ["SPRINT-LEGACY"]
  });
});
