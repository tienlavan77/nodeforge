// Keeps watcher and indexing activity inside one project by rejecting linked filesystem paths.
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ConfigurationError } from "../../shared/errors.js";

// Validates existing ancestors, including for deleted files, without following project-local links.
export function projectIndexPath(root, path, { allowMissing = false } = {}) {
  const projectRoot = resolve(root);
  const absolute = resolve(projectRoot, path);
  const local = relative(projectRoot, absolute);
  if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw new ConfigurationError("Index path is outside the selected project root.");
  }
  const canonicalRoot = realpathSync(projectRoot);
  let current = canonicalRoot;
  for (const segment of local.split(sep)) {
    current = resolve(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new ConfigurationError("Linked paths are outside the project indexing boundary.");
    } catch (error) {
      if (allowMissing && error.code === "ENOENT") return resolve(canonicalRoot, local);
      throw error;
    }
  }
  return current;
}
