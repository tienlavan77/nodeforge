// Applies the thirty-store regrouping only under an exclusive offline fence. The durable marker
// doubles as a recovery journal: every endpoint and pre-move fingerprint is recorded before rename,
// and rollback verifies unchanged data instead of overwriting either endpoint after a collision.
import { open, rename, mkdir, unlink, rmdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { inventory } from "./runtime-layout-inventory.js";
import { RUNTIME_GROUPS, RUNTIME_LAYOUT_FILE, RUNTIME_LAYOUT_LOCK, readRuntimeLayout } from "./runtime-layout.js";
import { migrationInfo, assertMigrationDirectory, fingerprintStore, migrationPidAlive, assertMigrationOffline } from "./runtime-migration-files.js";
import { assertNfRuntimeAvailable } from "./nf-runtime-layout.js";

/** Publishes a fully synced marker atomically so crashes never expose a partial JSON journal. */
export async function publishMarker(root, marker, markerFile = RUNTIME_LAYOUT_FILE) {
  const path = resolve(root, markerFile);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(marker, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

/** Persists rename metadata before the journal advances or releases writer fencing. */
export async function syncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Takes the exclusive fence and requires operator reconciliation of any fence left by a dead owner. */
export async function acquireFence(root, lockFile = RUNTIME_LAYOUT_LOCK) {
  const path = resolve(root, lockFile);
  let handle;
  try { handle = await open(path, "wx", 0o600); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const info = await migrationInfo(path);
    if (!info?.isFile() || info.isSymbolicLink()) throw new Error("Unsafe migration fence.");
    const { readFile } = await import("node:fs/promises");
    if (migrationPidAlive(Number((await readFile(path, "utf8")).trim()))) throw new Error("Another migration owns the runtime fence.");
    // Stale fences require explicit operator removal; two contenders must never reclaim one fence.
    throw new Error("Stale migration fence: verify its owner has exited, remove only that fence, then run --rollback.");
  }
  try { await handle.writeFile(`${process.pid}\n`); await handle.sync(); }
  finally { await handle.close(); }
  return path;
}

/** Returns a dry-run inventory; mutation requires an explicit offline apply or rollback request. */
export async function migrateRuntime(projectRoot, { apply = false, rollback = false, offline = false } = {}) {
  const root = resolve(projectRoot);
  if (!apply && !rollback) return inventory(root);
  if (apply && rollback) throw new Error("Choose apply or rollback, not both.");
  if (!offline) throw new Error("Migration requires explicit offline mode after writers have stopped.");
  assertNfRuntimeAvailable(root);
  for (const path of [root, join(root, ".forge"), join(root, ".forge/runtime")]) await assertMigrationDirectory(path);
  const fence = await acquireFence(root);
  try {
    assertNfRuntimeAvailable(root);
    const marker = readRuntimeLayout(root);
    const report = await inventory(root);
    if (report.moves.some((move) => move.status === "conflict")) throw new Error("Migration endpoint conflict; no stores moved.");
    const runtime = join(root, ".forge/runtime");
    await assertMigrationOffline(runtime, report.moves.flatMap((move) => [resolve(root, move.from), resolve(root, move.to)]));
    if (rollback) return await rollbackMigration(root, marker, report);
    if (marker.status !== "ready") throw new Error("Incomplete migration must be rolled back first.");
    if (marker.layout === "grouped") {
      if (report.moves.some((move) => move.status === "planned")) throw new Error("Grouped runtime contains unexpected legacy stores.");
      return { status: "already_grouped", moves: 0 };
    }
    if (report.moves.some((move) => move.status === "already_grouped")) throw new Error("Unjournaled grouped stores require manual reconciliation.");
    const moves = [];
    for (const move of report.moves.filter((entry) => entry.status === "planned")) {
      moves.push({ from: move.from, to: move.to, fingerprint: await fingerprintStore(resolve(root, move.from)) });
    }
    const createdGroups = [];
    for (const group of Object.keys(RUNTIME_GROUPS)) {
      if (!await migrationInfo(join(runtime, group)) && moves.some((move) => move.to.startsWith(".forge/runtime/" + group + "/"))) createdGroups.push(group);
    }
    const journal = { version: 1, layout: "legacy", status: "migrating", started_at: new Date().toISOString(), createdGroups, moves };
    await publishMarker(root, journal);
    for (const move of moves) {
      await mkdir(dirname(resolve(root, move.to)), { recursive: true });
      await rename(resolve(root, move.from), resolve(root, move.to));
      await syncDirectory(runtime);
      await syncDirectory(dirname(resolve(root, move.to)));
      if ((await fingerprintStore(resolve(root, move.to))).sha256 !== move.fingerprint.sha256) throw new Error(`Store verification failed: ${move.to}`);
    }
    await publishMarker(root, { ...journal, layout: "grouped", status: "ready", completed_at: new Date().toISOString() });
    return { status: "grouped", moves: moves.length, files: moves.reduce((sum, move) => sum + move.fingerprint.files, 0) };
  } finally { await unlink(fence); }
}

/** Reconciles interrupted renames from trusted endpoints and refuses rollback after evidence changed. */
async function rollbackMigration(root, marker, report) {
  if (marker.layout === "legacy" && marker.status === "ready") {
    if (report.moves.some((move) => move.status === "already_grouped")) throw new Error("Unjournaled grouped stores require manual reconciliation.");
    return { status: "already_legacy", moves: 0 };
  }
  if (!Array.isArray(marker.moves)) throw new Error("Rollback journal is missing.");
  const allowed = new Map(report.moves.map((move) => [move.from, move.to]));
  if (marker.createdGroups !== undefined && (!Array.isArray(marker.createdGroups) || marker.createdGroups.some((group) => !Object.hasOwn(RUNTIME_GROUPS, group)))) throw new Error("Invalid rollback groups.");
  const seen = new Set();
  for (const move of marker.moves) {
    if (allowed.get(move.from) !== move.to || seen.has(move.from) || !/^[a-f0-9]{64}$/.test(move.fingerprint?.sha256)) throw new Error("Invalid rollback journal endpoints.");
    seen.add(move.from);
    const source = await migrationInfo(resolve(root, move.from));
    const target = await migrationInfo(resolve(root, move.to));
    if (Boolean(source) === Boolean(target)) throw new Error(`Ambiguous rollback endpoint: ${move.from}`);
    if ((await fingerprintStore(resolve(root, source ? move.from : move.to))).sha256 !== move.fingerprint.sha256) throw new Error(`Rollback evidence changed: ${move.from}`);
  }
  if (report.moves.some((move) => move.status === "already_grouped" && !seen.has(move.from))) throw new Error("Unjournaled grouped store blocks rollback.");
  await publishMarker(root, { ...marker, status: "migrating" });
  for (const move of [...marker.moves].reverse()) {
    if (await migrationInfo(resolve(root, move.to))) {
      await rename(resolve(root, move.to), resolve(root, move.from));
      await syncDirectory(dirname(resolve(root, move.to)));
      await syncDirectory(join(root, ".forge/runtime"));
    }
  }
  for (const group of marker.createdGroups ?? []) {
    try { await rmdir(join(root, ".forge/runtime", group)); }
    catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; }
  }
  await publishMarker(root, { ...marker, layout: "legacy", status: "ready", rolled_back_at: new Date().toISOString() });
  return { status: "legacy", moves: marker.moves.length };
}
