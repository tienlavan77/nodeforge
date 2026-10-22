// Verify existing catalog admission preserves project data and never starts duplicate indexing services.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlApiProjectRuntime } from "../../scripts/control-api-project-runtime.mjs";
import { createProjectLifecycle } from "../../src/modules/projects/project-lifecycle.js";

// Supply persisted project metadata and opaque existing database bytes without opening or migrating them.
async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-existing-admission-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "existing");
  await mkdir(join(projectRoot, ".forge/runtime/wc"), { recursive: true });
  const metadata = { project_id: "PROJECT-EXISTING", name: "existing", root: projectRoot, forge_dir: ".forge", schema_version: "1.2.0" };
  await writeFile(join(projectRoot, ".forge/runtime/project.json"), JSON.stringify(metadata));
  const indexPath = join(projectRoot, ".forge/runtime/wc/index.db");
  await writeFile(indexPath, "existing index must remain byte-for-byte unchanged");
  const catalogPath = join(root, "projects.json");
  await writeFile(catalogPath, JSON.stringify([{ root: projectRoot, projectId: metadata.project_id }]));
  return { projectRoot, projectId: metadata.project_id, catalogPath, indexPath };
}

test("catalog restore and repeated admission reuse the existing application without starting index services", async (context) => {
  const config = await fixture(context);
  const original = await readFile(config.indexPath);
  const startRuntime = () => assert.fail("must not start a watcher, database, or embedding worker");
  const lifecycle = await createProjectLifecycle({ catalogPath: config.catalogPath, startRuntime: createControlApiProjectRuntime({ ...config, startRuntime }) });
  context.after(() => lifecycle.close());
  assert.deepEqual(lifecycle.startupErrors, []);
  assert.deepEqual(lifecycle.list(), [{ root: config.projectRoot, projectId: config.projectId }]);
  const runtime = await lifecycle.get(config.projectRoot);
  assert.equal(runtime.status().closed, false);
  assert.deepEqual(await lifecycle.add(config.projectRoot), lifecycle.list()[0]);
  assert.deepEqual(await readFile(config.indexPath), original);
  await lifecycle.close();
  assert.equal(runtime.status().closed, true);
  assert.deepEqual(await readFile(config.indexPath), original);
});

test("other projects and a removed default project receive new owned runtimes", async (context) => {
  const config = await fixture(context);
  const calls = [];
  const start = createControlApiProjectRuntime({ ...config, startRuntime: async (input) => { calls.push(input); return { owned: true }; } });
  const other = { projectRoot: `${config.projectRoot}-other`, projectId: "PROJECT-OTHER" };
  assert.deepEqual(await start(other), { owned: true });
  const initial = await start(config);
  initial.close();
  assert.deepEqual(await start(config), { owned: true });
  assert.deepEqual(calls, [other, config]);
});

test("mismatched default identity cannot reuse the running application's resources", async (context) => {
  const config = await fixture(context);
  const start = createControlApiProjectRuntime({ ...config, startRuntime: () => assert.fail("unexpected independent startup") });
  await assert.rejects(start({ ...config, projectId: "PROJECT-WRONG" }), /identity differ/);
  assert.equal((await start(config)).projectId, config.projectId);
});
