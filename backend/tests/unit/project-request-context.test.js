// Protects legacy conversation-list selection without broadening project identifiers to other operations.
import assert from "node:assert/strict";
import test from "node:test";
import { resolveProjectRequest } from "../../src/transport/http/project-request-context.js";
import { createForgeV1Router } from "../../src/transport/http/forge-v1-router.js";

test("existing GET conversation-list alias selects its project and rejects contradictory identifiers", () => {
  const request = { method: "GET", parts: ["conversations"], url: new URL("http://localhost/?project_id=A") };
  assert.equal(resolveProjectRequest(request), "A");
  assert.throws(() => resolveProjectRequest({ ...request, url: new URL("http://localhost/?project_id=A&project=B") }), { code: "PROJECT_CONTEXT_CONFLICT" });
  assert.throws(() => resolveProjectRequest({ ...request, body: { project_id: "B" } }), { code: "PROJECT_CONTEXT_CONFLICT" });
  assert.equal(resolveProjectRequest({ ...request, body: { project_id: "A" } }), "A");
});

test("alias is not introduced for POST, other methods, individual conversations or other routes", () => {
  const url = new URL("http://localhost/?project_id=A");
  for (const method of ["POST", "PUT", "DELETE", "PATCH", undefined]) assert.equal(resolveProjectRequest({ method, url, parts: ["conversations"] }), undefined);
  for (const parts of [["conversations", "id"], ["plans"], ["git"], []]) assert.equal(resolveProjectRequest({ method: "GET", url, parts }), undefined);
});

test("outer router resolves the existing GET alias before selecting project-bound services", async () => {
  const calls = [];
  const router = createForgeV1Router({ resolveProjectRouter: async (projectId) => {
    calls.push(projectId);
    return projectId === "A" ? { route: async () => ({ status: 200, body: { project_id: projectId } }) } : null;
  } });
  const result = await router.route("GET", new URL("http://localhost/forge/v1/conversations?project_id=A"), { headers: {} });
  assert.equal(result.body.project_id, "A");
  assert.deepEqual(calls, ["A"]);
  await assert.rejects(router.route("GET", new URL("http://localhost/forge/v1/conversations?project_id=A&project=B"), { headers: {} }), { code: "PROJECT_CONTEXT_CONFLICT" });
  await assert.rejects(router.route("GET", new URL("http://localhost/forge/v1/conversations?project_id=unknown"), { headers: {} }), { code: "PROJECT_NOT_FOUND" });
  await assert.rejects(router.route("POST", new URL("http://localhost/forge/v1/conversations?project_id=A"), { headers: {} }, undefined, {}), { code: "PROJECT_REQUIRED" });
});
