/**
 * Verifies the integrated Ideas boundary over real HTTP in single and multiple
 * project configurations. Existing contract, authorization and resource-routing
 * witnesses remain executable here unchanged; additional cases exercise the full
 * CRUD sequence and prove explicit project selection survives a different default.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createIdeasVerificationFixture } from "./ideas-verification-fixture.js";

for (const projectIds of [["PROJECT-A"], ["PROJECT-A", "PROJECT-B"]]) {
  test(`all five Ideas endpoints traverse composition with ${projectIds.length} project(s)`, async context => {
    const f = await createIdeasVerificationFixture(context, { projectIds });
    assert.equal(f.defaultProject, projectIds.at(-1));
    const idea = await f.request("ideas", { method: "POST", status: 201, body: { project_id: "PROJECT-A", content: "Integrated notebook" } });
    assert.equal(idea.project_id, "PROJECT-A");
    assert.deepEqual(await f.request("ideas?project_id=PROJECT-A"), [idea]);
    assert.deepEqual(await f.request(`ideas/${idea.id}`), idea);
    const done = await f.request(`ideas/${idea.id}`, { method: "PATCH", body: { expected_version: 1, status: "done" } });
    assert.equal(done.version, 2);
    assert.equal(done.status, "done");
    const reopened = await f.request(`ideas/${idea.id}`, { method: "PATCH", body: { expected_version: 2, status: "open" } });
    assert.equal(reopened.version, 3);
    await f.request(`ideas/${idea.id}`, { method: "DELETE", body: { expected_version: 3 } });
    assert.deepEqual(await f.request("ideas?project_id=PROJECT-A&status=all"), []);
    if (projectIds.length > 1) assert.deepEqual(await f.request("ideas?project_id=PROJECT-B&status=all"), []);
  });
}

test("invalid credentials, contradictory references and attempted project moves leave notebook state intact", async context => {
  const f = await createIdeasVerificationFixture(context, { permitted: ["PROJECT-A"] });
  const idea = await f.request("ideas", { method: "POST", status: 201, body: { project_id: "PROJECT-A", content: "Keep identity" } });
  for (const token of [null, "wrong-owner"]) {
    for (const [path, method, body] of [
      ["ideas?project_id=PROJECT-A", "GET"],
      ["ideas", "POST", { project_id: "PROJECT-A", content: "Forbidden" }],
      [`ideas/${idea.id}`, "GET"],
      [`ideas/${idea.id}`, "PATCH", { expected_version: 1, content: "Forbidden" }],
      [`ideas/${idea.id}`, "DELETE", { expected_version: 1 }]
    ]) {
      const denied = await f.request(path, { method, body, status: 403, token });
      assert.equal(denied.error.code, "plan_owner_unauthorized");
    }
  }
  const deniedProject = await f.request("ideas?project_id=PROJECT-B", { status: 404 });
  assert.equal(deniedProject.error.code, "idea_not_found");
  await f.request("ideas?project_id=UNKNOWN", { status: 404 });
  await f.request("ideas/never-created", { status: 404 });
  await f.request(`ideas/${idea.id}?project_id=PROJECT-B`, { status: 409 });
  await f.request(`ideas/${idea.id}`, { method: "PATCH", status: 400, body: { expected_version: 1, project_id: "PROJECT-A", content: "Cannot set identity" } });
  await f.request(`ideas/${idea.id}`, { method: "PATCH", status: 409, body: { expected_version: 1, project_id: "PROJECT-B", content: "Cannot move" } });
  assert.deepEqual(await f.request(`ideas/${idea.id}`), idea);
  f.admitted.delete("PROJECT-A");
  await f.request("ideas?project_id=PROJECT-A", { status: 404 });
  await f.request(`ideas/${idea.id}`, { status: 404 });
  f.admitted.add("PROJECT-A");
  assert.deepEqual(await f.request(`ideas/${idea.id}`), idea);
});
