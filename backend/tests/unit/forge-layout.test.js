import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { ensureForgeLayout } from "../../src/infrastructure/filesystem/forge-layout.js";

test("creates the full Forge layout and snapshots default schemas, rules, and workflows", async () => {
  await withLayout(async ({ projectRoot, sourceRoot }) => {
    const { forgeDir, runtimeDir } = await ensureForgeLayout(projectRoot, { sourceRoot });

    assert.deepEqual((await readdir(forgeDir)).sort(), ["roadmap", "rules", "runtime", "schemas", "workflows"]);
    assert.equal(await readFile(join(forgeDir, "schemas", "core", "event.schema.json"), "utf8"), "{\"event\":true}\n");
    assert.equal(await readFile(join(forgeDir, "rules", "default.rules.json"), "utf8"), "{\"rule\":true}\n");
    assert.equal(await readFile(join(forgeDir, "workflows", "default.workflow.json"), "utf8"), "{\"workflow\":true}\n");
    assert.deepEqual(await readdir(join(forgeDir, "roadmap")), []);
    assert.equal(runtimeDir, join(forgeDir, "runtime"));
  });
});

test("does not overwrite existing rule or workflow snapshots when a project reopens", async () => {
  await withLayout(async ({ projectRoot, sourceRoot }) => {
    const { forgeDir } = await ensureForgeLayout(projectRoot, { sourceRoot });
    const rule = join(forgeDir, "rules", "default.rules.json");
    const workflow = join(forgeDir, "workflows", "default.workflow.json");
    await writeFile(rule, "{\"rule\":\"custom\"}\n");
    await writeFile(workflow, "{\"workflow\":\"custom\"}\n");

    await ensureForgeLayout(projectRoot, { sourceRoot });

    assert.equal(await readFile(rule, "utf8"), "{\"rule\":\"custom\"}\n");
    assert.equal(await readFile(workflow, "utf8"), "{\"workflow\":\"custom\"}\n");
  });
});

async function withLayout(callback) {
  const parent = await mkdtemp(join(os.tmpdir(), "nodeforge-forge-layout-"));
  const projectRoot = join(parent, "project");
  const sourceRoot = join(parent, "defaults");
  try {
    await Promise.all([
      writeFileAt(sourceRoot, "schemas/core/event.schema.json", "{\"event\":true}\n"),
      writeFileAt(sourceRoot, "rules/default.rules.json", "{\"rule\":true}\n"),
      writeFileAt(sourceRoot, "workflows/default.workflow.json", "{\"workflow\":true}\n")
    ]);
    await callback({ projectRoot, sourceRoot });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

async function writeFileAt(root, path, content) {
  const filePath = join(root, path);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}
