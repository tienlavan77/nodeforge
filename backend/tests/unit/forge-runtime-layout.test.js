// Guards the read-only runtime-layout inventory: it must classify the planned regrouping, preserve
// orphans/queues/large subsystems, and never claim an apply is possible before readers migrate.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GROUPS, inventory } from "../../bin/forge-runtime-layout.mjs";

async function sandbox() {
  await mkdir(join(process.cwd(), ".forge/scratch"), { recursive: true });
  const root = await mkdtemp(join(process.cwd(), ".forge/scratch/layout-"));
  const runtime = join(root, ".forge/runtime");
  await mkdir(runtime, { recursive: true });
  for (const name of [...Object.values(GROUPS).flat(), "nf", "queues", "review-reopen"]) await mkdir(join(runtime, name), { recursive: true });
  await writeFile(join(runtime, "project.json"), "{}");
  return { root, runtime };
}

test("inventory reports each mapped directory as planned and flags no apply", async (context) => {
  const { root } = await sandbox();
  context.after(() => rm(root, { recursive: true, force: true }));
  const result = await inventory(root);
  assert.equal(result.mode, "inventory-only");
  assert.equal(result.migrationReady, false);
  assert.equal(result.moves.length, Object.values(GROUPS).flat().length);
  assert.equal(result.moves.every((move) => move.status === "planned"), true);
  const destinations = new Set(["tickets", "reviews", "agents", "recovery", "backups"]);
  assert.equal(result.moves.every((move) => destinations.has(move.to.split("/")[2])), true);
});

test("orphans and untouched subsystems are preserved, never scheduled for a move", async (context) => {
  const { root } = await sandbox();
  context.after(() => rm(root, { recursive: true, force: true }));
  const result = await inventory(root);
  const moving = new Set(result.moves.flatMap((move) => [move.from.split("/").pop(), move.to.split("/").pop()]));
  for (const protectedEntry of ["nf", "queues", "review-reopen", "project.json"]) {
    assert.equal(moving.has(protectedEntry), false, `${protectedEntry} must not be in the move set`);
    assert.equal(result.preserved.includes(protectedEntry), true, `${protectedEntry} must be preserved`);
  }
});

test("a refused apply does not mutate the runtime tree", async (context) => {
  const { root, runtime } = await sandbox();
  context.after(() => rm(root, { recursive: true, force: true }));
  const before = await (await import("node:fs/promises")).readdir(runtime);
  await inventory(root);
  const after = await (await import("node:fs/promises")).readdir(runtime);
  assert.deepEqual(after.sort(), before.sort());
});
