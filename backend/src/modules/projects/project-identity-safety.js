// Binds persisted project identity to its canonical directory before storage or membership writes.
// Business purpose: copied metadata and replaced roots must require explicit reconciliation rather
// than silently admitting another directory as an existing project. Technical description: reject
// linked managed paths, compare metadata roots, and retain an exclusive device/inode checkpoint.
import { lstat, open, realpath, writeFile } from "node:fs/promises";
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
