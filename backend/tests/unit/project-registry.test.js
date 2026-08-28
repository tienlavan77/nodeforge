import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProjectRegistry } from "../../src/modules/projects/project-registry.js";

test("creates and persists an opaque project_id for a new project", async () => {
  await withProject(async (projectRoot) => {
    const registry = new ProjectRegistry({ createId: () => "PROJECT-stable-test" });
    const projectId = await registry.getOrCreate(projectRoot);
    const persisted = JSON.parse(await readFile(join(projectRoot, ".forge", "runtime", "project.json"), "utf8"));

    assert.equal(projectId, "PROJECT-stable-test");
    assert.equal(persisted.project_id, projectId);
    assert.equal("id" in persisted, false);
  });
});

test("returns the same project_id after a registry instance is recreated", async () => {
  await withProject(async (projectRoot) => {
    const first = await new ProjectRegistry({ createId: () => "PROJECT-first" }).getOrCreate(projectRoot);
    const second = await new ProjectRegistry({ createId: () => "PROJECT-second" }).getOrCreate(projectRoot);
    assert.equal(first, "PROJECT-first");
    assert.equal(second, first);
  });
});

test("keeps project identity when the project directory moves with its .forge state", async () => {
  const parent = await mkdtemp(join(os.tmpdir(), "nodeforge-project-registry-move-"));
  const original = join(parent, "original");
  const moved = join(parent, "moved");
  try {
    await mkdir(original, { recursive: true });
    const first = await new ProjectRegistry().getOrCreate(original);
    await rename(original, moved);
    const second = await new ProjectRegistry().getOrCreate(moved);
    assert.equal(second, first);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("assigns different identities to different project paths", async () => {
  const parent = await mkdtemp(join(os.tmpdir(), "nodeforge-project-registry-two-"));
  try {
    const firstRoot = join(parent, "one");
    const secondRoot = join(parent, "two");
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    const registry = new ProjectRegistry();
    const first = await registry.getOrCreate(firstRoot);
    const second = await registry.getOrCreate(secondRoot);
    assert.notEqual(first, second);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

async function withProject(callback) {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-project-registry-"));
  try {
    await callback(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}
