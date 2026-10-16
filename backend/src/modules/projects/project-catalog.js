// Persists the process-wide project catalog separately from per-project runtime state.
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

// Opens catalog metadata without opening project databases, watchers, or workers.
export async function createProjectCatalog({ catalogPath } = {}) {
  if (!catalogPath) throw new Error("An explicit global catalogPath is required.");
  const path = resolve(catalogPath);
  let entries = [];
  try {
    entries = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!Array.isArray(entries) || entries.some((entry) =>
    typeof entry.root !== "string" || resolve(entry.root) !== entry.root ||
    !/^PROJECT-[A-Za-z0-9-]+$/.test(entry.projectId)) ||
    new Set(entries.map((entry) => entry.root)).size !== entries.length ||
    new Set(entries.map((entry) => entry.projectId)).size !== entries.length) {
    throw new Error("Invalid global project catalog.");
  }
  return Object.freeze({ list, replace });

  // Returns detached catalog metadata so callers cannot mutate persisted membership.
  function list() {
    return entries.map(({ root, projectId }) => ({ root, projectId }));
  }

  // Atomically replaces catalog membership after the lifecycle transition succeeds.
  async function replace(next) {
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporaryPath, path);
      entries = next.map(({ root, projectId }) => ({ root, projectId }));
    } catch (error) {
      try { await unlink(temporaryPath); } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") throw new AggregateError([error, cleanupError], "Catalog write and cleanup failed.");
      }
      throw error;
    }
  }
}
