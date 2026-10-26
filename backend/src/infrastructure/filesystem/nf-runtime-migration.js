// Migrates the control runtime independently of pipeline state, preserving historical references
// and complete SDK homes. Mutation requires stopped daemons plus an explicit SDK-writer assertion;
// content fingerprints, a durable journal, and a fixed SDK alias make partial moves recoverable.
import { mkdir, rename, unlink, symlink, rmdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { NF_RUNTIME_ROOT, NF_RUNTIME_GROUPS, NF_LAYOUT_FILE, NF_LAYOUT_LOCK, readNfRuntimeLayout } from "./nf-runtime-layout.js";
import { readRuntimeLayout, RUNTIME_LAYOUT_LOCK } from "./runtime-layout.js";
import { inventoryNfRuntime, nfInfo, isNfSdkAlias } from "./nf-runtime-inventory.js";
import { fingerprintStore, assertMigrationOffline } from "./runtime-migration-files.js";
import { publishMarker, syncDirectory, acquireFence } from "./runtime-migration.js";

/** Hashes store contents with relocatable internal links while preserving complete SDK state. */
const fingerprint = path => fingerprintStore(path, { allowInternalLinks: true, allowStandaloneGit: true });

/** Requires independent pipeline migration to be idle before control stores can move. */
async function assertPipelineReady(root) {
  if (readRuntimeLayout(root).status !== "ready" || await nfInfo(resolve(root, RUNTIME_LAYOUT_LOCK))) throw new Error("Pipeline runtime migration is active or incomplete.");
}

/** Returns live-owner and structural blockers without acquiring a fence or hashing session contents. */
export async function previewNfMigration(projectRoot) {
  const root = resolve(projectRoot), report = await inventoryNfRuntime(root), blockers = [];
  try { await assertPipelineReady(root); } catch (error) { blockers.push(error.message); }
  if (await nfInfo(resolve(root, NF_LAYOUT_LOCK))) blockers.push("NF migration fence exists.");
  if (readNfRuntimeLayout(root).status !== "ready") blockers.push("NF migration is incomplete; rollback is required.");
  if (report.moves.some(move => move.status === "conflict")) blockers.push("Conflicting migration endpoints.");
  try { await assertOffline(root, report); } catch (error) { blockers.push(error.message); }
  const stores = [];
  for (const move of report.moves.filter(move => ["planned", "already_grouped"].includes(move.status))) {
    try {
      const result = await fingerprintStore(resolve(root, move.status === "planned" ? move.from : move.to), { allowInternalLinks: true, allowStandaloneGit: true, metadataOnly: true });
      stores.push({ from: move.from, files: result.files, bytes: result.bytes });
    } catch (error) { blockers.push(error.message); }
  }
  return { ...report, blockers, stores, requiresOffline: true, requiresSdkStopped: true, migrationReady: false };
}

/** Checks project ownership locks, leaving opaque SDK locks to the mandatory stopped-SDK assertion. */
async function assertOffline(root, report) {
  const paths = report.moves.filter(move => !move.from.startsWith(NF_RUNTIME_ROOT + "/codex-homes") && !move.from.startsWith(NF_RUNTIME_ROOT + "/sdk-cache"))
    .flatMap(move => [resolve(root, move.from), resolve(root, move.to)]);
  await assertMigrationOffline(resolve(root, ".forge/runtime"), paths);
}

/** Executes a journaled control-store cutover, or verifies a rollback before reversing any move. */
export async function migrateNfRuntime(projectRoot, { apply = false, rollback = false, offline = false, sdkStopped = false } = {}) {
  const root = resolve(projectRoot);
  if (!apply && !rollback) return previewNfMigration(root);
  if (apply && rollback) throw new Error("Choose apply or rollback.");
  if (!offline || !sdkStopped) throw new Error("NF migration requires --offline and --sdk-stopped after stopping every writer.");
  await inventoryNfRuntime(root);
  await assertPipelineReady(root);
  const fence = await acquireFence(root, NF_LAYOUT_LOCK);
  try {
    await assertPipelineReady(root);
    const marker = readNfRuntimeLayout(root), report = await inventoryNfRuntime(root);
    if (report.moves.some(move => move.status === "conflict")) throw new Error("NF migration endpoint conflict.");
    await assertOffline(root, report);
    if (rollback) return await rollbackNf(root, marker, report);
    if (marker.status !== "ready") throw new Error("Incomplete NF migration must be rolled back.");
    if (marker.layout === "grouped") {
      if (report.moves.some(move => move.status === "planned")) throw new Error("Unexpected legacy NF stores.");
      return { status: "already_grouped", moves: 0 };
    }
    if (report.moves.some(move => move.status === "already_grouped")) throw new Error("Unjournaled grouped NF stores.");
    const moves = [];
    for (const move of report.moves.filter(move => move.status === "planned")) moves.push({ from: move.from, to: move.to, fingerprint: await fingerprint(resolve(root, move.from)) });
    const createdGroups = [];
    for (const group of Object.keys(NF_RUNTIME_GROUPS)) {
      if (!await nfInfo(resolve(root, NF_RUNTIME_ROOT, group)) && moves.some(move => move.to.startsWith(NF_RUNTIME_ROOT + "/" + group + "/"))) createdGroups.push(group);
    }
    const aliases = moves.filter(move => move.from === NF_RUNTIME_ROOT + "/codex-homes").map(({ from, to }) => ({ from, to }));
    const journal = { version: 1, layout: "legacy", status: "migrating", started_at: new Date().toISOString(), moves, createdGroups, aliases };
    await publishMarker(root, journal, NF_LAYOUT_FILE);
    for (const move of moves) {
      await mkdir(dirname(resolve(root, move.to)), { recursive: true });
      await rename(resolve(root, move.from), resolve(root, move.to));
      await syncDirectory(resolve(root, NF_RUNTIME_ROOT));
      await syncDirectory(dirname(resolve(root, move.to)));
      if ((await fingerprint(resolve(root, move.to))).sha256 !== move.fingerprint.sha256) throw new Error("NF content verification failed: " + move.to);
    }
    for (const alias of aliases) await symlink("sdk/codex-homes", resolve(root, alias.from), "dir");
    await syncDirectory(resolve(root, NF_RUNTIME_ROOT));
    await publishMarker(root, { ...journal, layout: "grouped", status: "ready", completed_at: new Date().toISOString() }, NF_LAYOUT_FILE);
    return { status: "grouped", moves: moves.length, sdkAliases: aliases.length };
  } finally { await unlink(fence); }
}

/** Restores only unchanged journaled endpoints; a compatibility alias is never treated as source data. */
async function rollbackNf(root, marker, report) {
  if (marker.layout === "legacy" && marker.status === "ready") {
    if (report.moves.some(move => move.status === "already_grouped")) throw new Error("Unjournaled grouped NF stores.");
    return { status: "already_legacy", moves: 0 };
  }
  if (!Array.isArray(marker.moves) || !Array.isArray(marker.createdGroups) || !Array.isArray(marker.aliases)) throw new Error("Invalid NF rollback journal.");
  if (marker.createdGroups.some(group => !Object.hasOwn(NF_RUNTIME_GROUPS, group))) throw new Error("Invalid NF rollback groups.");
  const allowed = new Map(report.moves.map(move => [move.from, move.to])), seen = new Set();
  for (const move of marker.moves) {
    if (allowed.get(move.from) !== move.to || seen.has(move.from) || !/^[a-f0-9]{64}$/.test(move.fingerprint?.sha256)) throw new Error("Invalid NF journal endpoints.");
    seen.add(move.from);
    const alias = await isNfSdkAlias(root, move.from, move.to);
    const source = await nfInfo(resolve(root, move.from)), target = await nfInfo(resolve(root, move.to));
    if (Boolean(source && !alias) === Boolean(target)) throw new Error("Ambiguous NF rollback endpoint: " + move.from);
    if ((await fingerprint(resolve(root, target ? move.to : move.from))).sha256 !== move.fingerprint.sha256) throw new Error("NF rollback evidence changed: " + move.from);
  }
  if (marker.aliases.some(alias => alias.from !== NF_RUNTIME_ROOT + "/codex-homes" || allowed.get(alias.from) !== alias.to || !seen.has(alias.from))) throw new Error("Invalid NF journal alias.");
  if (report.moves.some(move => move.status === "already_grouped" && !seen.has(move.from))) throw new Error("Unjournaled NF store blocks rollback.");
  await publishMarker(root, { ...marker, status: "migrating" }, NF_LAYOUT_FILE);
  for (const move of [...marker.moves].reverse()) {
    if (await nfInfo(resolve(root, move.to))) {
      if (await isNfSdkAlias(root, move.from, move.to)) await unlink(resolve(root, move.from));
      await rename(resolve(root, move.to), resolve(root, move.from));
      await syncDirectory(dirname(resolve(root, move.to)));
      await syncDirectory(resolve(root, NF_RUNTIME_ROOT));
    }
  }
  for (const group of marker.createdGroups) {
    try { await rmdir(resolve(root, NF_RUNTIME_ROOT, group)); } catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; }
  }
  await publishMarker(root, { ...marker, layout: "legacy", status: "ready", rolled_back_at: new Date().toISOString() }, NF_LAYOUT_FILE);
  return { status: "legacy", moves: marker.moves.length };
}
