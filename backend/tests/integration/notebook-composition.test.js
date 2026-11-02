/**
 * Verifies the integrated Notebook boundary over real HTTP in single and multiple
 * project configurations. Existing contract, authorization and resource-routing
 * witnesses remain executable here unchanged; additional cases exercise the full
 * CRUD sequence and prove explicit project selection survives a different default.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createNotebookVerificationFixture } from "./notebook-verification-fixture.js";

for (const projectIds of [["PROJECT-A"], ["PROJECT-A", "PROJECT-B"]]) {
  test(`all five Notebook endpoints traverse composition with ${projectIds.length} project(s)`, async context => {
    const f = await createNotebookVerificationFixture(context, { projectIds });
    assert.equal(f.defaultProject, projectIds.at(-1));
    const entry = await f.request("notebook", { method: "POST", status: 201, body: { project_id: "PROJECT-A", content: "Integrated notebook" } });
    assert.equal(entry.project_id, "PROJECT-A");
    assert.deepEqual(await f.request("notebook?project_id=PROJECT-A"), [entry]);
    assert.deepEqual(await f.request(`notebook/${entry.id}`), entry);
    const done = await f.request(`notebook/${entry.id}`, { method: "PATCH", body: { expected_version: 1, status: "done" } });
    assert.equal(done.version, 2);
    assert.equal(done.status, "done");
    const reopened = await f.request(`notebook/${entry.id}`, { method: "PATCH", body: { expected_version: 2, status: "open" } });
    assert.equal(reopened.version, 3);
    await f.request(`notebook/${entry.id}`, { method: "DELETE", body: { expected_version: 3 } });
    assert.deepEqual(await f.request("notebook?project_id=PROJECT-A&status=all"), []);
    if (projectIds.length > 1) assert.deepEqual(await f.request("notebook?project_id=PROJECT-B&status=all"), []);
  });
}

test("invalid credentials, contradictory references and attempted project moves leave notebook state intact", async context => {
  const f = await createNotebookVerificationFixture(context, { permitted: ["PROJECT-A"] });
  const entry = await f.request("notebook", { method: "POST", status: 201, body: { project_id: "PROJECT-A", content: "Keep identity" } });
  for (const token of [null, "wrong-owner"]) {
    for (const [path, method, body] of [
      ["notebook?project_id=PROJECT-A", "GET"],
      ["notebook", "POST", { project_id: "PROJECT-A", content: "Forbidden" }],
      [`notebook/${entry.id}`, "GET"],
      [`notebook/${entry.id}`, "PATCH", { expected_version: 1, content: "Forbidden" }],
      [`notebook/${entry.id}`, "DELETE", { expected_version: 1 }]
    ]) {
      const denied = await f.request(path, { method, body, status: 403, token });
      assert.equal(denied.error.code, "plan_owner_unauthorized");
    }
  }
  const deniedProject = await f.request("notebook?project_id=PROJECT-B", { status: 404 });
  assert.equal(deniedProject.error.code, "notebook_not_found");
  await f.request("notebook?project_id=UNKNOWN", { status: 404 });
  await f.request("notebook/never-created", { status: 404 });
  await f.request(`notebook/${entry.id}?project_id=PROJECT-B`, { status: 409 });
  await f.request(`notebook/${entry.id}`, { method: "PATCH", status: 400, body: { expected_version: 1, project_id: "PROJECT-A", content: "Cannot set identity" } });
  await f.request(`notebook/${entry.id}`, { method: "PATCH", status: 409, body: { expected_version: 1, project_id: "PROJECT-B", content: "Cannot move" } });
  assert.deepEqual(await f.request(`notebook/${entry.id}`), entry);
  f.admitted.delete("PROJECT-A");
  await f.request("notebook?project_id=PROJECT-A", { status: 404 });
  await f.request(`notebook/${entry.id}`, { status: 404 });
  f.admitted.add("PROJECT-A");
  assert.deepEqual(await f.request(`notebook/${entry.id}`), entry);
});
