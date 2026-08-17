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
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("ignores Forge runtime state while keeping rules, workflows, and roadmap trackable", async () => {
  const parent = await mkdtemp(join(os.tmpdir(), "nodeforge-forge-gitignore-"));
  const projectRoot = join(parent, "project");

  try {
    await execFile("git", ["init", "--quiet", projectRoot]);
    await writeFile(join(projectRoot, ".gitignore"), await readFile(join(repositoryRoot, ".gitignore"), "utf8"));
    const { forgeDir, runtimeDir } = await ensureForgeLayout(projectRoot);
    const runtimeState = join(runtimeDir, "index.db");
    const rule = join(forgeDir, "rules", "forge-sprint-delivery.rules.json");
    const workflow = join(forgeDir, "workflows", "forge-sprint-delivery.workflow.json");
    const roadmap = join(forgeDir, "roadmap", "plan.json");
    await Promise.all([
      writeFile(runtimeState, "runtime state\n"),
      writeFile(roadmap, "{}\n")
    ]);

    assert.equal(await isIgnored(projectRoot, ".forge/runtime/index.db"), true);
    for (const path of [".forge/rules/forge-sprint-delivery.rules.json", ".forge/workflows/forge-sprint-delivery.workflow.json", ".forge/roadmap/plan.json"]) {
      assert.equal(await isIgnored(projectRoot, path), false, `${path} must remain trackable`);
    }

    await execFile("git", ["add", "--", rule, workflow, roadmap], { cwd: projectRoot });
    const { stdout } = await execFile("git", ["diff", "--cached", "--name-only"], { cwd: projectRoot });
    assert.deepEqual(stdout.trim().split("\n").sort(), [
      ".forge/roadmap/plan.json",
      ".forge/rules/forge-sprint-delivery.rules.json",
      ".forge/workflows/forge-sprint-delivery.workflow.json"
    ]);
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
