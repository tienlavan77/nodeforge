import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ensureForgeLayout } from "../../src/infrastructure/filesystem/forge-layout.js";

const execFile = promisify(execFileCallback);
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

test("ignores generated Forge runtime and roadmap state", async () => {
  const parent = await mkdtemp(join(os.tmpdir(), "nodeforge-forge-gitignore-"));
  const projectRoot = join(parent, "project");

  try {
    await execFile("git", ["init", "--quiet", projectRoot]);
    await writeFile(join(projectRoot, ".gitignore"), await readFile(join(repositoryRoot, ".gitignore"), "utf8"));
    const { forgeDir, runtimeDir } = await ensureForgeLayout(projectRoot);
    const runtimeState = join(runtimeDir, "index.db");
    const roadmap = join(forgeDir, "roadmap", "plan.json");
    await Promise.all([
      writeFile(runtimeState, "runtime state\n"),
      writeFile(roadmap, "{}\n")
    ]);

    for (const path of [".forge/runtime/index.db", ".forge/roadmap/plan.json"]) {
      assert.equal(await isIgnored(projectRoot, path), true, `${path} must be ignored`);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

async function isIgnored(projectRoot, path) {
  try {
    await execFile("git", ["check-ignore", "--quiet", "--", path], { cwd: projectRoot });
    return true;
  } catch (error) {
    if (error.code === 1) return false;
    throw error;
  }
}
