#!/usr/bin/env node
// Read-only inventory for the staged runtime regrouping. Never follows storage symlinks.
import { lstat, readdir } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Orphans deliberately excluded: the owner requested they remain untouched.
export const GROUPS = Object.freeze({
  tickets: Object.freeze(["ticket-changes", "ticket-workspaces", "ticket-execution-contexts", "ticket-verification", "ticket-integrations", "ticket-root-commits", "ticket-baselines", "ticket-root-workspaces", "ticket-run-dispositions", "ticket-pipeline-shadow", "ticket-pipeline-disposition", "ticket-pipeline-rollout"]),
  reviews: Object.freeze(["review-records", "review-dependency-reconciliation", "ticket-review-findings", "ticket-review-repairs", "ticket-finding-repairs", "automatic-review-locks"]),
  agents: Object.freeze(["agent-checkpoints", "reviewer-checkpoints", "agent-messages", "agent-checkpoint-decisions", "owner-executions", "architecture-executions", "supervisors"]),
  recovery: Object.freeze(["evidence-mapping-recovery", "blocker-contract-decisions", "blocker-context"]),
  backups: Object.freeze(["recovery-backups", "repair-backups"])
});

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
  return { mode: "inventory-only", migrationReady: false, reason: "Readers, stored receipt paths and offline ownership fencing must be migrated before any apply.", moves, preserved };
}
async function info(path) {
  try { return await lstat(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function assertDirectory(path) {
  const value = await info(path);
  if (!value || value.isSymbolicLink() || !value.isDirectory()) throw new Error(`Invalid runtime directory: ${path}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    console.error("This command only inventories the repository runtime; no --apply is implemented.");
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await inventory(fileURLToPath(new URL("../../", import.meta.url))), null, 2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
