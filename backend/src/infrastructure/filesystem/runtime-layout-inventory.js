// Inventories the fixed functional runtime mapping without moving data or following storage links.
// This shared planner lets the operator preview collisions and lets migration validate journal
// endpoints against the same thirty-store contract used by application path resolution.
import { lstat, readdir } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { RUNTIME_GROUPS as GROUPS, readRuntimeLayout } from "./runtime-layout.js";

// Preserve leaf names so receipts remain recognizable; no path defaults change yet.
export async function inventory(projectRoot) {
  const root = resolve(projectRoot);
  const runtime = join(root, ".forge/runtime");
  await assertDirectory(root);
  await assertDirectory(join(root, ".forge"));
  await assertDirectory(runtime);
  const moves = [];
  for (const [group, names] of Object.entries(GROUPS)) {
    const groupPath = join(runtime, group);
    const groupInfo = await info(groupPath);
    if (groupInfo && (groupInfo.isSymbolicLink() || !groupInfo.isDirectory())) throw new Error(`Invalid group: ${group}`);
    for (const name of names) {
      const source = join(runtime, name);
      const target = join(groupPath, name);
      const from = await info(source);
      const to = await info(target);
      if (from && (from.isSymbolicLink() || !from.isDirectory())) throw new Error(`Invalid source: ${name}`);
      if (to && (to.isSymbolicLink() || !to.isDirectory())) throw new Error(`Invalid target: ${group}/${name}`);
      moves.push({ from: relative(root, source), to: relative(root, target), status: from && to ? "conflict" : from ? "planned" : to ? "already_grouped" : "absent" });
    }
  }
  const mapped = new Set(Object.values(GROUPS).flat());
  const preserved = (await readdir(runtime)).filter((name) => !mapped.has(name)).sort();
  return { mode: "inventory-only", migrationReady: false, layout: readRuntimeLayout(root).layout,
    reason: "Use forge-runtime-migrate.mjs to verify offline ownership and migrate; this inventory never applies changes.", moves, preserved };
}
// Keeps missing endpoints distinct from filesystem errors during migration planning.
async function info(path) {
  try { return await lstat(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
// Prevents migration planning through linked or non-directory runtime ancestors.
async function assertDirectory(path) {
  const value = await info(path);
  if (!value || value.isSymbolicLink() || !value.isDirectory()) throw new Error(`Invalid runtime directory: ${path}`);
}
