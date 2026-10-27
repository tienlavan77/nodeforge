/**
 * Proves the Ideas notebook remains independent of execution and governance.
 * Counters wrap real composed application service boundaries after fixture setup;
 * successful CRUD, stale writes and refused requests must leave every execution
 * counter untouched while SQLite notebook state demonstrably changes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createIdeasVerificationFixture } from "./ideas-verification-fixture.js";

test("Ideas CRUD never invokes approval, ticket, plan, sprint or agent services", async context => {
  const f = await createIdeasVerificationFixture(context);
  const before = { ...f.calls };
  const idea = await f.request("ideas", { method: "POST", status: 201, body: { project_id: "PROJECT-A", content: "Only a notebook" } });
  assert.deepEqual(await f.request("ideas?project_id=PROJECT-A"), [idea]);
  assert.deepEqual(await f.request(`ideas/${idea.id}`), idea);
  const edited = await f.request(`ideas/${idea.id}`, { method: "PATCH", body: { expected_version: 1, content: "Saved independently", status: "done" } });
  assert.equal(edited.version, 2);
  await f.request(`ideas/${idea.id}`, { method: "PATCH", status: 409, body: { expected_version: 1, content: "Stale" } });
  await f.request(`ideas/${idea.id}`, { method: "DELETE", status: 409, body: { expected_version: 1 } });
  await f.request(`ideas/${idea.id}`, { method: "DELETE", body: { expected_version: 2 } });
  await f.request("ideas", { method: "POST", status: 403, token: null, body: { project_id: "PROJECT-A", content: "Denied" } });
  assert.deepEqual(await f.request("ideas?project_id=PROJECT-A&status=all"), []);
  assert.deepEqual(f.calls, before);
  assert.deepEqual(f.calls, { approvals: 0, tickets: 0, plans: 0, sprints: 0, agents: 0 });
});
