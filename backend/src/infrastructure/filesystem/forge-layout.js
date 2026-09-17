// Ensures the .forge directory layout exists by copying bundled snapshot dirs and creating the runtime folder.
import { cp, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureRuntimeDir } from "../sqlite/index-database.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SNAPSHOT_DIRECTORIES = ["schemas", "rules", "workflows"];

// Initializes .forge structure by ensuring runtime dir, seeding schemas/rules/workflows snapshots and creating roadmap dir.
export async function ensureForgeLayout(projectRoot, { sourceRoot = repositoryRoot } = {}) {
  const runtimeDir = await ensureRuntimeDir(projectRoot);
  const forgeDir = dirname(runtimeDir);

  for (const directory of SNAPSHOT_DIRECTORIES) {
    const destination = join(forgeDir, directory);
    if (await exists(destination)) continue;
    const source = join(sourceRoot, directory);
    if (!(await exists(source))) continue;
    await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
  }

  await mkdir(join(forgeDir, "roadmap"), { recursive: true });
  return Object.freeze({ forgeDir, runtimeDir });
}

// Checks whether a filesystem path exists, returning false for ENOENT and rethrowing other errors.
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
