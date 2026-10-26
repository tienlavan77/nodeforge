// Defines the functional runtime groups and resolves historical receipt paths without rewriting
// their signed or hashed contents. Layout selection is project-local and changes only after an
// offline migration publishes its ready marker; an interrupted migration fails closed.
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { assertNfRuntimeAvailable, nfRuntimeStoragePath, nfRuntimeListingPath } from "./nf-runtime-layout.js";

/** The thirty state stores grouped by their current operational responsibility. */
export const RUNTIME_GROUPS = Object.freeze({
  tickets: Object.freeze(["ticket-changes", "ticket-workspaces", "ticket-execution-contexts", "ticket-verification", "ticket-integrations", "ticket-root-commits", "ticket-baselines", "ticket-root-workspaces", "ticket-run-dispositions", "ticket-pipeline-shadow", "ticket-pipeline-disposition", "ticket-pipeline-rollout"]),
  reviews: Object.freeze(["review-records", "review-dependency-reconciliation", "ticket-review-findings", "ticket-review-repairs", "ticket-finding-repairs", "automatic-review-locks"]),
  agents: Object.freeze(["agent-checkpoints", "reviewer-checkpoints", "agent-messages", "agent-checkpoint-decisions", "owner-executions", "architecture-executions", "supervisors"]),
  recovery: Object.freeze(["evidence-mapping-recovery", "blocker-contract-decisions", "blocker-context"]),
  backups: Object.freeze(["recovery-backups", "repair-backups"])
});
/** Stable marker and fencing paths live outside the stores that migration moves. */
export const RUNTIME_LAYOUT_FILE = ".forge/runtime/runtime-layout.json";
/** Exclusive migration fence checked by project readers and daemon startup. */
export const RUNTIME_LAYOUT_LOCK = ".forge/runtime/.runtime-layout.lock";
/** Canonical ownership lookup shared by inventory, path resolution, and cleanup. */
const STORE_GROUPS = new Map(Object.entries(RUNTIME_GROUPS).flatMap(([group, stores]) => stores.map((store) => [store, group])));

/** Maps a historical project-relative store path into the grouped layout without touching disk. */
export function groupedRuntimePath(path) {
  return path.replace(/^\.forge\/runtime\/([^/]+)(?=\/|$)/, (prefix, store) => STORE_GROUPS.has(store) ? `.forge/runtime/${STORE_GROUPS.get(store)}/${store}` : prefix);
}

/** Preserves historical FileService discovery results so old receipts and prefix checks still match. */
export function legacyRuntimePath(path) {
  return path.replace(/^\.forge\/runtime\/([^/]+)\/([^/]+)(?=\/|$)/, (prefix, group, store) => STORE_GROUPS.get(store) === group ? `.forge/runtime/${store}` : prefix);
}

/** Keeps grouped discovery explicit while returning historical names for legacy and broad globs. */
export function runtimeListingPath(path, glob) {
  const explicitGroup = Object.keys(RUNTIME_GROUPS).some((group) => glob === ".forge/runtime/" + group || glob.startsWith(".forge/runtime/" + group + "/"));
  return nfRuntimeListingPath(explicitGroup ? path : legacyRuntimePath(path), glob);
}

/** Reads only a regular project-local marker; missing markers retain the deployed flat layout. */
export function readRuntimeLayout(projectRoot) {
  for (const path of [".forge", ".forge/runtime", RUNTIME_LAYOUT_FILE]) {
    try {
      const info = lstatSync(resolve(projectRoot, path));
      if (info.isSymbolicLink() || (path === RUNTIME_LAYOUT_FILE ? !info.isFile() : !info.isDirectory())) throw new Error(`Unsafe runtime layout path: ${path}`);
    } catch (error) { if (error.code === "ENOENT") return { version: 1, layout: "legacy", status: "ready" }; throw error; }
  }
  const marker = JSON.parse(readFileSync(resolve(projectRoot, RUNTIME_LAYOUT_FILE), "utf8"));
  if (marker.version !== 1 || !["legacy", "grouped"].includes(marker.layout) || !["ready", "migrating"].includes(marker.status)) throw new Error("Invalid runtime layout marker.");
  return marker;
}

/** Refuses startup and state access while migration owns the fence or needs crash recovery. */
export function assertRuntimeAvailable(projectRoot) {
  assertNfRuntimeAvailable(projectRoot);
  const marker = readRuntimeLayout(projectRoot);
  try {
    lstatSync(resolve(projectRoot, RUNTIME_LAYOUT_LOCK));
    throw new Error("Runtime layout migration is fenced; finish or roll back migration before starting writers.");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (marker.status !== "ready") throw new Error("Runtime layout migration is incomplete; roll it back before starting writers.");
  return marker;
}

/** Resolves old and new relative store paths against the selected physical layout of one project. */
export function runtimeStoragePath(projectRoot, path) {
  if (!path.startsWith(".forge/runtime/") && path !== ".forge/runtime") return path;
  const marker = assertRuntimeAvailable(projectRoot);
  return nfRuntimeStoragePath(projectRoot, marker.layout === "grouped" ? groupedRuntimePath(path) : legacyRuntimePath(path));
}

/** Gives direct filesystem consumers the same compatibility mapping used by FileService. */
export function resolveRuntimePath(projectRoot, ...segments) {
  const root = resolve(projectRoot);
  const local = relative(root, resolve(root, ...segments));
  if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error("Runtime path escapes the project root.");
  return resolve(root, runtimeStoragePath(root, local.split(sep).join("/")));
}
