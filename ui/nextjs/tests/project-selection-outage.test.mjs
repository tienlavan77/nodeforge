// A failed refresh must preserve admission; only a genuinely removed project may revoke it.
import assert from "node:assert/strict";
import test from "node:test";
import { bindProjectClient, getProjectSelection, refreshProjects, selectProject } from "../lib/project-selection.js";

test("a transient API outage keeps the selected project, generation and streams intact", async (context) => {
  let offline = false;
  let projects = [{ project_id: "A", root: "/a" }];
  context.mock.method(globalThis, "fetch", async (input) => {
    const { pathname } = new URL(input);
    if (pathname.endsWith("/lifecycle/list")) {
      if (offline) throw new TypeError("Failed to fetch");
      return Response.json({ projects });
    }
    return Response.json({});
  });

  await refreshProjects({ selectInitial: false });
  selectProject("A");
  let closed = 0;
  bindProjectClient({ connectProjectStream: () => ({ close: () => { closed += 1; } }) }).connectProjectStream({});
  const before = getProjectSelection();
  assert.equal(before.projectId, "A");

  // API restart / outage: the list request fails but the workspace stays admitted and mounted.
  offline = true;
  await assert.rejects(refreshProjects({ selectInitial: false }), /unavailable|fetch/i);
  const during = getProjectSelection();
  assert.equal(during.projectId, "A", "a failed refresh must not revoke admission");
  assert.equal(during.generation, before.generation, "a failed refresh must not change the selection generation");
  assert.equal(during.loaded, true, "the directory stays loaded so the page keeps rendering");
  assert.deepEqual(during.projects, [{ project_id: "A", root: "/a" }], "the last known projects are retained");
  assert.match(String(during.error), /unavailable|fetch/i, "the connection error is surfaced without clearing state");
  assert.equal(closed, 0, "existing project streams must not be closed by a transient outage");

  // Recovery to the same project clears the error and still does not remount the workspace.
  offline = false;
  await refreshProjects({ selectInitial: false });
  const recovered = getProjectSelection();
  assert.equal(recovered.projectId, "A");
  assert.equal(recovered.error, null, "a successful refresh clears the outage error");
  assert.equal(recovered.generation, before.generation, "recovery to the same project must not change the generation");
  assert.equal(closed, 0, "streams stay open across outage and recovery");

  // Authoritative removal still invalidates the selection and closes streams.
  projects = [];
  await refreshProjects({ selectInitial: false });
  const removed = getProjectSelection();
  assert.equal(removed.projectId, null, "a genuinely missing project must revoke admission");
  assert.equal(removed.generation, before.generation + 1, "removal must bump the generation to fence old clients");
  assert.match(String(removed.error), /unavailable/i);
  assert.equal(closed, 1, "removal must close the previous project stream");
});
