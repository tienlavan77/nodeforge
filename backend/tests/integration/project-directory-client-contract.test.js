// Verifies the backend directory contract gives clients separate membership, project readiness,
// and connection failure channels. Client presentation and browser accessibility remain owned by
// the dependent client ticket; these checks exercise only the shared backend contribution.
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { routeProjectLifecycle } from "../../src/modules/projects/project-lifecycle.js";
import { createProjectDirectoryLifecycle } from "../../src/application/project-directory-lifecycle.js";
import { fixture } from "./multi-project-lifecycle-support.js";

test("directory reports current safe errors and clears old warnings after retry", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  let fail = true;
  const lifecycle = await f.open({ startRuntime: async ({ projectId, projectRoot }) => {
    if (fail) throw new Error("secret internal diagnostic");
    return { projectId, projectRoot, close() {} };
  } });
  await assert.rejects(lifecycle.add(f.roots[0]));
  const failed = await routeProjectLifecycle("GET", new URL("http://localhost/lifecycle/directory"), Object.assign(Readable.from([]), { headers: { "x-nodeforge-lifecycle": "1" } }), lifecycle);
  assert.equal(failed.status, 200);
  assert.equal(failed.body.projects.length, 1);
  assert.equal(failed.body.projects[0].readiness, "unavailable");
  assert.equal(failed.body.projects.filter((entry) => entry.diagnostic).length, 1);
  assert.doesNotMatch(JSON.stringify(failed.body), /secret internal diagnostic/);
  fail = false;
  await lifecycle.add(f.roots[0]);
  const ready = await routeProjectLifecycle("GET", new URL("http://localhost/lifecycle/directory"), Object.assign(Readable.from([]), { headers: { "x-nodeforge-lifecycle": "1" } }), lifecycle);
  assert.equal(ready.body.projects[0].project_id, failed.body.projects[0].project_id);
  assert.deepEqual(ready.body.projects.filter((entry) => entry.diagnostic), []);
  assert.equal(ready.body.projects[0].diagnostic, null);
});

test("preflight failure produces no member and directory failure does not replay mutation", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const lifecycle = await f.open();
  await assert.rejects(lifecycle.add(f.roots[0] + "/missing"));
  assert.deepEqual(lifecycle.directory(), []);
  let mutations = 0;
  const stub = {
    async add() { mutations += 1; return { root: f.roots[0], projectId: "PROJECT-A" }; },
    directory() { throw new Error("directory unavailable"); }
  };
  const result = await routeProjectLifecycle("POST", new URL("http://localhost/lifecycle/add"),
    Readable.from([JSON.stringify({ root: f.roots[0] })]), stub);
  assert.equal(result.status, 200);
  assert.equal(result.body.project.project_id, "PROJECT-A");
  await assert.rejects(routeProjectLifecycle("GET", new URL("http://localhost/lifecycle/directory"), Object.assign(Readable.from([]), { headers: { "x-nodeforge-lifecycle": "1" } }), stub), /directory unavailable/);
  assert.equal(mutations, 1);
});

test("single-project directory reports the active runtime contract", () => {
  const lifecycle = createProjectDirectoryLifecycle({ projectId: "PROJECT-A", projectRoot: "/root" });
  assert.equal(lifecycle.directory()[0].readiness, "ready");
  assert.equal(lifecycle.directory()[0].retryable, false);
});
