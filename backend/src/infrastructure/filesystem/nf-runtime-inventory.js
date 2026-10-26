// Plans control-runtime moves and recognizes the one deliberate SDK compatibility alias.
// The alias preserves absolute rollout paths held inside SDK databases without rewriting sessions.
import { lstat, readdir, readlink } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { NF_RUNTIME_ROOT, NF_RUNTIME_GROUPS, groupedNfRuntimePath, readNfRuntimeLayout } from "./nf-runtime-layout.js";

/** Reads endpoint metadata without hiding permission failures or following links. */
export async function nfInfo(path) {
  try { return await lstat(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

/** Recognizes only the fixed codex-homes alias pointing to its exact project-local destination. */
export async function isNfSdkAlias(root, from, to) {
  const info = await nfInfo(resolve(root, from));
  return from === NF_RUNTIME_ROOT + "/codex-homes" && info?.isSymbolicLink()
    && resolve(resolve(root, from), "..", await readlink(resolve(root, from))) === resolve(root, to);
}

/** Inventories directories and numbered project logs while preserving all unrelated nf entries. */
export async function inventoryNfRuntime(projectRoot) {
  const root = resolve(projectRoot), nf = resolve(root, NF_RUNTIME_ROOT);
  for (const local of [".", ".forge", ".forge/runtime", NF_RUNTIME_ROOT]) {
    const info = await nfInfo(resolve(root, local));
    if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe nf runtime directory: " + local);
  }
  const stores = Object.values(NF_RUNTIME_GROUPS).flat();
  const entries = await readdir(nf);
  const logNames = new Set(entries.filter(name => /^project\.log(?:\.\d+)?$/.test(name)));
  const logs = await nfInfo(resolve(nf, "logs"));
  if (logs && (!logs.isDirectory() || logs.isSymbolicLink())) throw new Error("Unsafe nf logs directory.");
  if (logs) for (const name of await readdir(resolve(nf, "logs"))) if (/^project\.log(?:\.\d+)?$/.test(name)) logNames.add(name);
  const moves = [];
  for (const name of [...stores, ...[...logNames].sort()]) {
    const from = NF_RUNTIME_ROOT + "/" + name, to = groupedNfRuntimePath(from);
    const group = to.slice(0, to.lastIndexOf("/"));
    const groupInfo = await nfInfo(resolve(root, group));
    if (groupInfo && (!groupInfo.isDirectory() || groupInfo.isSymbolicLink())) throw new Error("Unsafe nf group: " + group);
    const source = await nfInfo(resolve(root, from)), target = await nfInfo(resolve(root, to));
    const alias = await isNfSdkAlias(root, from, to);
    const directory = stores.includes(name);
    if (source && !alias && (source.isSymbolicLink() || (directory ? !source.isDirectory() : !source.isFile()))) throw new Error("Unsafe nf source: " + from);
    if (target && (target.isSymbolicLink() || (directory ? !target.isDirectory() : !target.isFile()))) throw new Error("Unsafe nf target: " + to);
    moves.push({ from, to, kind: directory ? "directory" : "file", alias,
      status: source && !alias && target ? "conflict" : target ? "already_grouped" : source && !alias ? "planned" : alias ? "conflict" : "absent" });
  }
  return { mode: "inventory-only", layout: readNfRuntimeLayout(root).layout, migrationReady: false, moves,
    sdkCompatibilityAlias: NF_RUNTIME_ROOT + "/codex-homes",
    preserved: entries.filter(name => !stores.includes(name) && !logNames.has(name)).map(name => relative(root, resolve(nf, name))) };
}
