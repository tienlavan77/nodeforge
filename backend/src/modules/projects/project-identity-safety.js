// Binds persisted project identity to its canonical directory before storage or membership writes.
// Business purpose: copied metadata and replaced roots must require explicit reconciliation rather
// than silently admitting another directory as an existing project. Technical description: reject
// linked managed paths, compare metadata roots, and retain an exclusive device/inode checkpoint.
import { randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { ensureForgeLayout } from "../../infrastructure/filesystem/forge-layout.js";
import { constants } from "node:fs";
import { join } from "node:path";
import { assertRoot, filesystemError } from "./project-filesystem-safety.js";

// Refuses linked storage before identity reads or layout creation can follow an outside path.
export async function inspectProjectStorage(binding) {
  await assertRoot(binding);
  for (const path of [".forge", ".forge/runtime", ".forge/schemas", ".forge/rules", ".forge/workflows", ".forge/roadmap", ".forge/scratch", ".nf"].map((name) => join(binding.root, name))) {
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) {
        throw filesystemError("identity", "storage_replaced", path, null, "Restore the original NodeForge storage directory.");
      }
    } catch (error) {
      if (error.code === "ENOENT") continue;
      if (["EACCES", "EPERM"].includes(error.code)) throw filesystemError("runtime", "runtime_unreadable", path, error);
      throw error;
    }
  }
  for (const name of ["project.json", "project-root-binding.json"]) {
    const path = join(binding.root, ".forge", "runtime", name);
    try {
      if (!(await lstat(path)).isFile()) throw filesystemError("identity", "identity_conflict", path, null);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

// Checks identity without rewriting metadata; the first verified admission checkpoints root identity.
export async function verifyProjectIdentity(binding, project) {
  await inspectProjectStorage(binding);
  if (project.root !== binding.root) {
    throw filesystemError("identity", "identity_conflict", binding.root, null, "Metadata belongs to another root. Restore the original root; do not rewrite its identity.");
  }
  const path = join(binding.root, ".forge", "runtime", "project-root-binding.json");
  const expected = { root: binding.root, dev: binding.dev, ino: binding.ino, projectId: project.project_id };
  let persisted;
  try { persisted = await readProjectIdentity(path); } catch (error) {
    if (error.code !== "ENOENT") throw filesystemError("identity", "identity_conflict", path, error);
    await assertRoot(binding);
    try { await writeFile(path, JSON.stringify(expected), { flag: "wx", mode: 0o600 }); } catch (writeError) {
      if (writeError.code !== "EEXIST") throw filesystemError("runtime", "runtime_unwritable", path, writeError);
    }
    persisted = await readProjectIdentity(path);
  }
  if (Object.keys(expected).some((key) => persisted[key] !== expected[key])) {
    throw filesystemError("identity", "identity_conflict", path, null, "Root ownership differs from its checkpoint. Restore the original directory and reconcile membership.");
  }
  await assertRoot(binding);
}

// Preserves established schema and workflow snapshot initialization after identity is verified.
export async function prepareProjectLayout(binding) {
  await inspectProjectStorage(binding);
  try { await ensureForgeLayout(binding.root); } catch (error) {
    throw filesystemError("runtime", "runtime_unwritable", binding.root, error);
  }
  await assertRoot(binding);
}

// Reads identity through a no-follow descriptor so metadata links never authorize admission.
export async function readProjectIdentity(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return JSON.parse(await file.readFile("utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw error;
    const stage = ["EACCES", "EPERM"].includes(error.code) ? "runtime" : "identity";
    throw filesystemError(stage, stage === "runtime" ? "runtime_unreadable" : "identity_conflict", path, error);
  } finally { await file?.close(); }
}

// Atomically replaces a persisted project configuration file through a guarded temporary file so write failures never truncate existing metadata.
// Business purpose: guarantees that updating extended project configuration preserves the existing `.forge/runtime/project.json` byte-for-byte if disk persistence fails (e.g., ENOSPC or I/O error).
// Technical description: opens an exclusive temporary file in the same runtime directory, writes and fsyncs the serialized payload, verifies root binding and inode ownership before atomic rename, and unlinks the temporary file on any failure.
export async function replaceProjectIdentityAtomically(binding, path, content, fileService = null) {
  await assertRoot(binding);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let file;
  let fingerprint;
  try {
    file = await open(temporaryPath, "wx", 0o600);
    fingerprint = await file.stat();
    if (typeof fileService?.writeTemporaryContent === "function") {
      await fileService.writeTemporaryContent({ file, temporaryPath, path, content });
    } else {
      await file.writeFile(content, "utf8");
    }
    await file.sync();
    await file.close();
    file = null;
    await assertRoot(binding);
    const current = await lstat(temporaryPath);
    if (current.dev !== fingerprint.dev || current.ino !== fingerprint.ino) {
      throw filesystemError("runtime", "runtime_unwritable", path, new Error("Project configuration temporary ownership changed."));
    }
    await rename(temporaryPath, path);
  } catch (error) {
    try {
      await file?.close();
      if (fingerprint) {
        const current = await lstat(temporaryPath);
        if (current.dev === fingerprint.dev && current.ino === fingerprint.ino) {
          await unlink(temporaryPath);
        }
      }
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") {
        throw filesystemError("cleanup", "runtime_cleanup_failed", temporaryPath, new AggregateError([error, cleanupError], "Project configuration write and cleanup failed."));
      }
    }
    throw error;
  }
}
