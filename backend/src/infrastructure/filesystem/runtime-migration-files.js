// Verifies offline migration inputs and fingerprints complete store trees without following links.
// Fingerprints retain file bytes, modes, empty directories, and absolute link targets so a failed
// move can be reconciled without rewriting audit records or silently accepting changed evidence.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { isAbsolute, join, resolve, relative, dirname } from "node:path";
import { legacyRuntimePath, groupedRuntimePath } from "./runtime-layout.js";
import { groupedNfRuntimePath, NF_RUNTIME_ROOT } from "./nf-runtime-layout.js";

/** Distinguishes an absent migration endpoint from permission and filesystem failures. */
export async function migrationInfo(path) {
  try { return await lstat(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

/** Refuses linked or non-directory ancestors before mutation inside the selected project. */
export async function assertMigrationDirectory(path) {
  const info = await migrationInfo(path);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe migration directory: ${path}`);
}

/** Captures content identity while refusing relative links and Git worktrees whose move needs repair. */
export async function fingerprintStore(root, { allowInternalLinks = false, metadataOnly = false, allowStandaloneGit = false } = {}) {
  const digest = createHash("sha256");
  let files = 0, bytes = 0;
  /** Traverses one store deterministically without dereferencing dependency or evidence links. */
  async function visit(path, local) {
    const info = await lstat(path);
    const mode = info.mode & 0o7777;
    if (info.isSymbolicLink()) {
      const target = await readlink(path);
      if (!isAbsolute(target)) {
        const localTarget = relative(root, resolve(dirname(path), target));
        if (!allowInternalLinks || localTarget === ".." || localTarget.startsWith("../") || isAbsolute(localTarget)) throw new Error(`Relative link needs relocation review: ${path}`);
      }
      const runtimeOffset = target.indexOf("/.forge/runtime/");
      if (runtimeOffset >= 0) {
        const local = target.slice(runtimeOffset + 1);
        if (groupedRuntimePath(local) !== local || legacyRuntimePath(local) !== local) throw new Error(`Link into moved state needs relocation review: ${path}`);
        if (groupedNfRuntimePath(local) !== local && local !== NF_RUNTIME_ROOT + "/codex-homes" && !local.startsWith(NF_RUNTIME_ROOT + "/codex-homes/")) throw new Error(`Link into moved nf state needs relocation review: ${path}`);
      }
      digest.update(JSON.stringify([local, "link", target]));
    } else if (info.isDirectory()) {
      digest.update(JSON.stringify([local, "directory", mode]));
      for (const name of (await readdir(path)).sort()) {
        if (name === ".git") {
          const git = join(path, name), gitInfo = await lstat(git);
          if (!allowStandaloneGit || !gitInfo.isDirectory() || gitInfo.isSymbolicLink()
            || await migrationInfo(join(git, "commondir")) || await migrationInfo(join(git, "worktrees"))) throw new Error(`Git workspace needs relocation review: ${path}`);
          const config = await migrationInfo(join(git, "config"));
          if (config && (!config.isFile() || config.isSymbolicLink())) throw new Error(`Unsafe Git configuration: ${path}`);
          if (config && /^(?:\s*)(?:worktree|gitdir)\s*=/mi.test(await readFile(join(git, "config"), "utf8"))) throw new Error(`Git relocation configuration needs review: ${path}`);
        }
        await visit(join(path, name), `${local}/${name}`);
      }
    } else if (info.isFile()) {
      digest.update(JSON.stringify([local, "file", mode, info.size]));
      if (!metadataOnly) for await (const chunk of createReadStream(path)) digest.update(chunk);
      files += 1; bytes += info.size;
    } else throw new Error(`Unsupported migration entry: ${path}`);
  }
  await visit(root, "");
  return { sha256: digest.digest("hex"), files, bytes };
}

/** Treats unknown ownership as unsafe; only a definite ESRCH proves an owner has exited. */
export function migrationPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Unknown migration lock owner.");
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; if (error.code === "EPERM") return true; throw error; }
}

/** Checks persistent daemon owners and store/queue locks before any store can be renamed. */
export async function assertMigrationOffline(runtime, stores) {
  for (const role of ["control", "watcher"]) {
    const path = join(runtime, "nf", `.nodeforge-${role}.lock`);
    const info = await migrationInfo(path);
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe daemon lock: ${path}`);
    if (migrationPidAlive(Number((await readFile(path, "utf8")).trim()))) throw new Error(`Live ${role} process owns runtime.`);
  }
  /** Inspects lock metadata in state stores without following linked dependency trees. */
  async function scan(path) {
    const info = await migrationInfo(path);
    if (!info || info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      for (const name of await readdir(path)) if (!["node_modules", ".git"].includes(name)) await scan(join(path, name));
    } else if (path.endsWith(".lock")) {
      const content = (await readFile(path, "utf8")).trim();
      let pid = Number(content);
      if (content.startsWith("{")) {
        const owner = JSON.parse(content);
        pid = owner.pid ?? owner.owner_pid;
      }
      if (migrationPidAlive(pid)) throw new Error(`Live state lock: ${path}`);
    }
  }
  for (const path of [join(runtime, "queues"), ...stores]) await scan(path);
}
