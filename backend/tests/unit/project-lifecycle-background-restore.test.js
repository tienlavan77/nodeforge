// Ensures slow project restoration cannot prevent the API composition from becoming available,
// while lifecycle shutdown still drains restoration and releases the recovered runtime.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectLifecycle } from "../../src/modules/projects/project-lifecycle.js";

test("background restore returns before a slow runtime and shutdown waits for cleanup", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "forge-background-restore-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  await mkdir(join(projectRoot, ".forge/runtime"), { recursive: true });
  await writeFile(join(projectRoot, ".forge/runtime/project.json"), JSON.stringify({
    project_id: "PROJECT-RESTORE", name: "project", root: projectRoot,
    forge_dir: ".forge", schema_version: "1.2.0"
  }));
  const catalogPath = join(root, "projects.json");
  await writeFile(catalogPath, JSON.stringify([{ root: projectRoot, projectId: "PROJECT-RESTORE" }]));
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let cleaned = false;
  const lifecycle = await createProjectLifecycle({
    catalogPath, restoreInBackground: true,
    // Hold runtime initialization to model indexing without relying on timing or real workers.
    startRuntime: async () => {
      started.resolve();
      await release.promise;
      return { projectId: "PROJECT-RESTORE", close: async () => { cleaned = true; } };
    }
  });
  await started.promise;
  let closed = false;
  const shutdown = lifecycle.close().then(() => { closed = true; });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    assert.deepEqual(lifecycle.startupErrors, []);
  } finally {
    release.resolve();
    await shutdown;
  }
  assert.equal(cleaned, true);
});
