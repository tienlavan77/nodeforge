// Persists the process-wide project catalog separately from per-project runtime state.
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { assertRoot, captureRoot, filesystemError, probeStorage } from "./project-filesystem-safety.js";

// Opens catalog metadata without opening project databases, watchers, or workers.
export async function createProjectCatalog({ catalogPath } = {}) {
  if (!catalogPath) throw new Error("An explicit global catalogPath is required.");
  const path = resolve(catalogPath);
  let entries = [];
  try {
    entries = JSON.parse(await readFile(path, { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW }));
  } catch (error) {
    if (error.code !== "ENOENT") throw filesystemError("catalog", "catalog_unreadable", path, error);
  }
  if (!Array.isArray(entries) || entries.some((entry) =>
    typeof entry.root !== "string" || resolve(entry.root) !== entry.root ||
    !/^PROJECT-[A-Za-z0-9-]+$/.test(entry.projectId)) ||
    new Set(entries.map((entry) => entry.root)).size !== entries.length ||
    new Set(entries.map((entry) => entry.projectId)).size !== entries.length) {
    throw new Error("Invalid global project catalog.");
  }
  return Object.freeze({ list, replace, preflight });

  // Proves managed catalog storage is writable before admission changes a root or starts services.
  async function preflight() {
    try {
      await mkdir(dirname(path), { recursive: true });
      const binding = await captureRoot(dirname(path));
      await probeStorage(binding.root, "catalog", () => assertRoot(binding));
      return binding;
    } catch (error) {
      if (error.stage === "cleanup") throw error;
      throw filesystemError("catalog", "catalog_unwritable", path, error);
    }
  }

  // Returns detached catalog metadata so callers cannot mutate persisted membership.
  function list() {
    return entries.map(({ root, projectId }) => ({ root, projectId }));
  }

  // Atomically replaces catalog membership after the lifecycle transition succeeds.
  async function replace(next, { guard = async () => {} } = {}) {
    const binding = await preflight();
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    let file;
    let fingerprint;
    try {
      await assertRoot(binding);
      file = await open(temporaryPath, "wx", 0o600);
      fingerprint = await file.stat();
      await file.writeFile(JSON.stringify(next, null, 2) + "\n");
      await file.sync();
      await file.close();
      file = null;
      await assertRoot(binding);
      const current = await lstat(temporaryPath);
      if (current.dev !== fingerprint.dev || current.ino !== fingerprint.ino) throw new Error("Catalog temporary ownership changed.");
      await guard();
      await rename(temporaryPath, path);
      entries = next.map(({ root, projectId }) => ({ root, projectId }));
    } catch (error) {
      try {
        await file?.close();
        if (fingerprint) {
          await assertRoot(binding);
          const current = await lstat(temporaryPath);
          if (current.dev !== fingerprint.dev || current.ino !== fingerprint.ino) throw new Error("Catalog temporary ownership changed.");
          await unlink(temporaryPath);
        }
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") throw filesystemError("cleanup", "catalog_cleanup_failed", temporaryPath, new AggregateError([error, cleanupError], "Catalog write and cleanup failed."));
      }
      throw filesystemError("catalog", "catalog_write_failed", path, error);
    }
  }
}
