// Reads installed dependency source and guidance without indexing packages or leaving the project.
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createFileService } from "./file-service.js";
import { isProtectedPath } from "./protected-path-policy.js";
import { ConfigurationError } from "../../shared/errors.js";

// Recognizes package installations in backend, UI, and the shared workspace store.
export function isDependencyPath(path) { return typeof path === "string" && /(^|\/)node_modules(?:\/|$)/.test(path); }

// Resolves pnpm package links only when both the requested and real paths remain project-local and non-secret.
export function dependencyReadPath(projectRoot, path) {
  const denied = /(^|\/)(?:secrets?|credentials?|private|id_rsa|id_ed25519)(?:[._/-]|$)/i;
  if (!isDependencyPath(path) || isAbsolute(path) || path.includes("\\") || path.includes("\0")
    || path.split("/").some((part) => !part || part === "." || part === "..") || denied.test(path) || isProtectedPath(path)) throw forbidden();
  const root = realpathSync(projectRoot);
  const canonical = realpathSync(resolve(root, path));
  const local = relative(root, canonical).split(sep).join("/");
  if (!local || local === ".." || local.startsWith("../") || isAbsolute(local) || !isDependencyPath(local)
    || denied.test(local) || isProtectedPath(local)) throw forbidden();
  return local;
}

// Returns File Service text and checksum using the resolved package path, bypassing the code index/cache.
export async function readDependencyFile({ projectRoot, path, maxBytes = 1_000_000 }) {
  const canonical = dependencyReadPath(projectRoot, path);
  const files = createFileService({ projectRoot: realpathSync(projectRoot), watcherIgnore: [] });
  const file = await files.readForIndex({ path: canonical, allowNodeModules: true, maxBytes });
  return { ...file, path, cache: { status: "bypass", cached_at: null, expires_at: null }, index_status: "unavailable" };
}

// Reports rejected dependency paths consistently through the existing Forge tool log handling.
function forbidden() { return Object.assign(new ConfigurationError("Dependency read must remain inside project node_modules and exclude protected files."), { code: "FILE_ROLE_FORBIDDEN" }); }
