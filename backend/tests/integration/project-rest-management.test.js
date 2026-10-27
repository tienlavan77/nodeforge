// Exercises automatic REST admission and O1 configuration persistence through the HTTP server.
// Real watchers and databases establish that settings, readiness and progress survive admission
// and that updating metadata preserves identity across lifecycle restoration.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, startLifecycleHttpServer } from "./multi-project-lifecycle-support.js";

test("REST automatically creates or imports projects and persists complete configuration", async () => {
  const f = await fixture();
  const lifecycle = await f.open();
  const server = await startLifecycleHttpServer(lifecycle);
  try {
    // Sends real collection and item requests while retaining the status for rejection assertions.
    async function request(method, suffix = "", body) {
      const response = await fetch(server.baseUrl + "/forge/v1/projects" + suffix, {
        method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {})
      });
      return { status: response.status, body: await response.json() };
    }
    const empty = join(f.directory, "empty");
    await mkdir(empty);
    const roots = [f.roots[0], join(f.directory, "created"), empty];
    for (const [index, root] of roots.entries()) {
      const input = { name: "REST Project " + index, root, description: "Details", author: "Owner",
        commands: { test: "node --test" }, tags: ["rest"], metadata: { source: "test" }, comment_language: "en" };
      const created = await request("POST", "", input);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.project.name, input.name);
      assert.equal(created.body.project.author, input.author);
      assert.equal(created.body.project.root, root);
      const id = created.body.project.project_id;
      const updated = await request("PUT", "/" + id, { name: "Updated", description: "Changed", comment_language: "vi", commands: { test: "npm test" } });
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
      assert.equal(updated.body.project.project_id, id);
      const disk = JSON.parse(await readFile(join(root, ".forge", "runtime", "project.json"), "utf8"));
      assert.equal(disk.name, "Updated");
      assert.equal(disk.description, "Changed");
      assert.equal(disk.comment_language, "vi");
      assert.deepEqual(disk.commands, { test: "npm test" });
      assert.deepEqual(disk.tags, ["rest"]);
      const listed = await request("GET");
      assert.equal(listed.status, 200);
      const project = listed.body.projects.find((entry) => entry.project_id === id);
      assert.equal(project.readiness, "ready");
      assert.ok(project.progress);
      assert.deepEqual(project.metadata, input.metadata);
      assert.equal(project.author, input.author);
      const denied = await request("PUT", "/" + id, { project_id: "different-id" });
      assert.equal(denied.status, 400);
      assert.equal(JSON.parse(await readFile(join(root, ".forge", "runtime", "project.json"), "utf8")).project_id, id);
    }
    assert.equal((await request("PUT", "/missing", { name: "Missing" })).status, 404);
    const invalidRoot = join(f.directory, "invalid-config");
    const invalid = await request("POST", "", { root: invalidRoot, name: "Invalid", commands: { test: 42 } });
    assert.equal(invalid.status, 400);
    await assert.rejects(readFile(join(invalidRoot, ".forge", "runtime", "project.json")), { code: "ENOENT" });
  } finally {
    await server.close();
    await f.cleanup();
  }
});
