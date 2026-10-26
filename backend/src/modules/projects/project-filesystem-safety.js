// Protects Create/Add admission from ambiguous paths and copied filesystem identities.
// Business purpose: membership must describe the exact root the operator selected; temporary
// permission probes must never alter source files or authorize a later write on their own.
// Technical description: directory fingerprints are rechecked at side-effect boundaries,
// managed storage rejects links, and failures carry actionable effective-principal diagnostics.
import { access, lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

// Produces a stable diagnostic for operators while retaining the original system error.
export function filesystemError(stage, code, path, cause, guidance = "Correct the path or permissions and retry.") {
  const principal = { uid: process.geteuid?.() ?? "unknown", gid: process.getegid?.() ?? "unknown" };
  return Object.assign(new Error(`${stage}: ${cause?.message ?? code} (${path}). ${guidance} Effective principal UID=${principal.uid}, GID=${principal.gid}; ownership=unknown.`, { cause }), {
    code, stage, path, retryable: false, guidance, principal, ownership: "unknown",
    statusCode: stage === "input" ? 400 : stage === "identity" ? 409 : 500, scope: "scoped"
  });
}

// Captures an absolute canonical directory without accepting a symlink as the selected root.
export async function captureRoot(root) {
  if (typeof root !== "string" || !isAbsolute(root)) {
    throw filesystemError("input", "absolute_root_required", String(root), null, "Use an absolute path on the Control API host.");
  }
  const path = resolve(root);
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) {
      throw new Error("The selected root must be a canonical directory without symlink aliases");
    }
    return { root: path, dev: info.dev, ino: info.ino, uid: info.uid, gid: info.gid };
  } catch (error) {
    if (error.stage) throw error;
    throw filesystemError("input", "invalid_project_root", path, error);
  }
}

// Resolves stable Add aliases to a canonical root while keeping relative host paths invalid.
export async function captureAddRoot(root) {
  if (typeof root !== "string" || !isAbsolute(root)) return captureRoot(root);
  try { return await captureRoot(await realpath(root)); } catch (error) {
    if (error.stage) throw error;
    throw filesystemError("input", "invalid_project_root", root, error);
  }
}

// Reconciles the captured directory before every admission write and startup boundary.
export async function assertRoot(binding) {
  let current;
  try { current = await captureRoot(binding.root); } catch (error) {
    throw filesystemError("identity", "root_replaced", binding.root, error, "Restore the original directory and reconcile the operation before retrying.");
  }
  if (current.dev !== binding.dev || current.ino !== binding.ino) {
    throw filesystemError("identity", "root_replaced", binding.root, null, "Restore the original directory and reconcile the operation before retrying.");
  }
}

// Verifies traversability and source readability without writing any source permission probe.
export async function preflightSource(binding, directory = binding.root) {
  try {
    await assertRoot(binding);
    await access(directory, constants.R_OK | constants.X_OK);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if ([".forge", ".nf", ".git", "node_modules"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await preflightSource(binding, path);
      else if (entry.isFile()) {
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        await file.close();
      }
    }
  } catch (error) {
    if (error.stage) throw error;
    throw filesystemError("source", "source_unreadable", directory, error);
  }
}

// Creates only immediate NodeForge storage directories, rejecting links before using each one.
export async function prepareStorage(binding) {
  for (const path of [join(binding.root, ".forge"), join(binding.root, ".forge", "runtime")]) {
    await assertRoot(binding);
    try { await mkdir(path); } catch (error) {
      if (error.code !== "EEXIST") throw filesystemError("runtime", "runtime_unwritable", path, error);
    }
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) {
      throw filesystemError("identity", "storage_replaced", path, null, "Restore NodeForge storage; do not replace it with a symlink.");
    }
  }
  const runtimeDir = join(binding.root, ".forge", "runtime");
  await probeStorage(runtimeDir, "runtime", () => assertRoot(binding));
  return runtimeDir;
}

// Tests storage with an exclusively created NodeForge artifact and reports cleanup independently.
export async function probeStorage(directory, stage, guard = async () => {}) {
  const path = join(directory, `.nodeforge-probe-${randomUUID()}`);
  let file;
  let owned = false;
  let fingerprint;
  try {
    await guard();
    file = await open(path, "wx", 0o600);
    owned = true;
    fingerprint = await file.stat();
    await file.writeFile("NodeForge storage preflight\n");
    await file.sync();
  } catch (error) {
    throw filesystemError(stage, `${stage}_unwritable`, directory, error);
  } finally {
    await file?.close();
    if (owned) {
      try {
        await guard();
        const current = await lstat(path);
        if (!fingerprint || current.dev !== fingerprint.dev || current.ino !== fingerprint.ino) throw new Error("Probe ownership changed");
        await unlink(path);
      } catch (error) {
        throw filesystemError("cleanup", "probe_cleanup_failed", path, error, "Remove only this NodeForge probe after verifying directory ownership.");
      }
    }
  }
}

// Verifies the existing parent and rejects every existing Create target, including dangling links.
export async function preflightCreate(root) {
  if (typeof root !== "string" || !isAbsolute(root)) {
    throw filesystemError("input", "absolute_root_required", String(root), null, "Use an absolute path on the Control API host.");
  }
  const path = resolve(root);
  const parent = await captureRoot(dirname(path)).catch((error) => {
    throw filesystemError("input", error.cause?.code === "ENOENT" ? "create_parent_missing" : "create_parent_unavailable", dirname(path), error, "Select an existing canonical parent with traverse and create permissions; NodeForge will not create ancestor directories.");
  });
  try {
    await lstat(path);
    throw filesystemError("input", "create_target_exists", path, null, "Choose a new path or explicitly use Add.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await probeStorage(parent.root, "parent", () => assertRoot(parent));
  return { root: path, parent };
}
