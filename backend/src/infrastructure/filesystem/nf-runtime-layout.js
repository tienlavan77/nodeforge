// Defines the control-runtime layout independently of the already migrated pipeline stores.
// Historical database and receipt references stay logical; physical paths switch per project only
// after an offline migration publishes a ready marker, preserving JSONL byte offsets and SDK homes.
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Functional groups for control state; databases, credentials, and daemon locks stay at the root. */
export const NF_RUNTIME_GROUPS = Object.freeze({
  planning: Object.freeze(["plans", "plan-clarifications", "plan-requests"]),
  execution: Object.freeze(["tickets", "sprint-plan", "code-requests"]),
  history: Object.freeze(["conversations", "conversation-migrations", "summary"]),
  sdk: Object.freeze(["codex-homes", "sdk-cache"]),
  maintenance: Object.freeze(["error-migrations", "sprint-migration", "sprint-migration-backups", "sprint-migration-receipts"]),
  logs: Object.freeze([])
});
/** The control-runtime root remains stable for SQLite, configuration, and ownership locks. */
export const NF_RUNTIME_ROOT = ".forge/runtime/nf";
/** Separate marker prevents nf migration from rewriting the thirty-store migration journal. */
export const NF_LAYOUT_FILE = NF_RUNTIME_ROOT + "/nf-runtime-layout.json";
/** Exclusive control-runtime fence is also honored by the existing daemon startup checks. */
export const NF_LAYOUT_LOCK = NF_RUNTIME_ROOT + "/.nf-runtime-layout.lock";
/** Maps each preserved leaf name to its functional group. */
const NF_STORES = new Map(Object.entries(NF_RUNTIME_GROUPS).flatMap(([group, stores]) => stores.map(store => [store, group])));

/** Converts a historical control-store reference, including every numbered project-log sibling. */
export function groupedNfRuntimePath(path) {
  return path.replace(/^\.forge\/runtime\/nf\/([^/]+)(?=\/|$)/, (prefix, store) => {
    const group = NF_STORES.get(store) ?? (/^project\.log(?:\.\d+)?$/.test(store) ? "logs" : null);
    return group ? NF_RUNTIME_ROOT + "/" + group + "/" + store : prefix;
  });
}

/** Restores logical names for old database references, permission checks, and discovery globs. */
export function legacyNfRuntimePath(path) {
  return path.replace(/^\.forge\/runtime\/nf\/([^/]+)\/([^/]+)(?=\/|$)/, (prefix, group, store) =>
    NF_STORES.get(store) === group || group === "logs" && /^project\.log(?:\.\d+)?$/.test(store) ? NF_RUNTIME_ROOT + "/" + store : prefix);
}

/** Reads a regular marker within a regular project nf tree; absent markers retain legacy storage. */
export function readNfRuntimeLayout(root) {
  for (const path of [".forge", ".forge/runtime", NF_RUNTIME_ROOT, NF_LAYOUT_FILE]) {
    try {
      const info = lstatSync(resolve(root, path));
      if (info.isSymbolicLink() || (path === NF_LAYOUT_FILE ? !info.isFile() : !info.isDirectory())) throw new Error("Unsafe nf layout path: " + path);
    } catch (error) { if (error.code === "ENOENT") return { version: 1, layout: "legacy", status: "ready" }; throw error; }
  }
  const marker = JSON.parse(readFileSync(resolve(root, NF_LAYOUT_FILE), "utf8"));
  if (marker.version !== 1 || !["legacy", "grouped"].includes(marker.layout) || !["ready", "migrating"].includes(marker.status)) throw new Error("Invalid nf runtime layout marker.");
  return marker;
}

/** Blocks state access and daemon startup until an interrupted nf migration is recovered. */
export function assertNfRuntimeAvailable(root) {
  const marker = readNfRuntimeLayout(root);
  try { lstatSync(resolve(root, NF_LAYOUT_LOCK)); throw new Error("NF runtime migration is fenced."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (marker.status !== "ready") throw new Error("NF runtime migration is incomplete; rollback is required.");
  return marker;
}

/** Selects one physical control-store layout without changing logical evidence references. */
export function nfRuntimeStoragePath(root, path) {
  if (!path.startsWith(NF_RUNTIME_ROOT + "/")) return path;
  return assertNfRuntimeAvailable(root).layout === "grouped" ? groupedNfRuntimePath(path) : legacyNfRuntimePath(path);
}

/** Keeps explicit grouped globs physical and broad or historical globs compatible with old callers. */
export function nfRuntimeListingPath(path, glob) {
  const explicit = Object.keys(NF_RUNTIME_GROUPS).some(group => glob === NF_RUNTIME_ROOT + "/" + group || glob.startsWith(NF_RUNTIME_ROOT + "/" + group + "/"));
  return explicit ? path : legacyNfRuntimePath(path);
}
