// Captures project dependencies separately from ticket-owned files so verification never expands a ticket commit.
import { statePath, resolveRuntimePath } from "../../infrastructure/filesystem/forge-paths.js";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, mkdir, writeFile, link, rm } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { createTicketRootGit } from "./ticket-root-git.js";

const ROOT = statePath("ticket-verification/environment");
// Identifies captured bytes independently of Git staging or authorship.
const hash = (value) => createHash("sha256").update(value).digest("hex");
// Reports corrupt environment evidence without converting it to ticket acceptance.
const fail = (message) => Object.assign(new Error(message), { code: "VERIFY_ENVIRONMENT_INVALID" });

// Rejects project escapes and mutable directory links before observing verification inputs.
async function regularFile(root, path) {
  if (!path || path.startsWith("/") || path.includes("\\") || posix.normalize(path) !== path || path.split("/").some((part) => ["..", ".git", ".forge", "node_modules"].includes(part))) return false;
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) return false; }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return false; throw error; }
  }
  return (await lstat(current)).isFile();
}

// Hashes tracked and unignored project files while excluding every ticket-owned path, including deletions.
export async function captureVerificationEnvironment({ projectRoot, ticketPaths }) {
  const git = createTicketRootGit({ projectRoot });
  const names = (await git.run(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  const owned = new Set(ticketPaths);
  const files = [];
  for (const path of [...new Set(names)].sort()) {
    if (owned.has(path) || !await regularFile(projectRoot, path)) continue;
    if (ticketPaths.some((ticketPath) => path.startsWith(`${ticketPath}/`) || ticketPath.startsWith(`${path}/`))) throw fail(`Project environment conflicts with ticket path: ${path}.`);
    const bytes = await readFile(join(projectRoot, path));
    const mode = (await lstat(join(projectRoot, path))).mode & 0o111 ? 0o755 : 0o644;
    files.push({ path, sha256: hash(bytes), mode, bytes });
  }
  const manifest = files.map(({ path, sha256, mode }) => ({ path, sha256, mode }));
  return { files, manifest, sha256: hash(JSON.stringify(manifest)) };
}

// Publishes complete evidence atomically so concurrent ticket snapshots never observe partially written blobs.
async function persistEvidence(path, bytes, checksum) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    try { await link(temporary, path); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (hash(await readFile(path)) !== checksum) throw fail("Verification environment evidence conflicts with its checksum.");
    }
  } finally { await rm(temporary, { force: true }); }
}

// Persists immutable dependency bytes and a source manifest independently of Git staging and ticket authorship.
export async function persistVerificationEnvironment(projectRoot, environment) {
  assertVerificationEnvironment(environment);
  for (const file of environment.files) await persistEvidence(resolveRuntimePath(projectRoot, ROOT, "blobs", file.sha256), file.bytes, file.sha256);
  const manifestPath = `${ROOT}/manifests/${environment.sha256}.json`;
  await persistEvidence(resolveRuntimePath(projectRoot, manifestPath), JSON.stringify(environment.manifest), environment.sha256);
  return { sha256: environment.sha256, manifest_path: manifestPath, scope: "project_environment_not_ticket_changes" };
}

// Reads only immutable environment evidence named by Node's verification artifact.
export async function loadVerificationEnvironment(projectRoot, binding) {
  if (!/^[a-f0-9]{64}$/.test(binding?.sha256 ?? "") || binding.manifest_path !== `${ROOT}/manifests/${binding.sha256}.json`) throw fail("Verification environment binding is invalid.");
  const bytes = await readFile(resolveRuntimePath(projectRoot, binding.manifest_path));
  if (hash(bytes) !== binding.sha256) throw fail("Verification environment manifest checksum changed.");
  let manifest;
  try { manifest = JSON.parse(bytes); }
  catch (error) { if (error instanceof SyntaxError) throw fail("Verification environment manifest is not valid JSON."); throw error; }
  assertVerificationEnvironmentManifest(manifest);
  return manifest;
}

/** Restores the immutable dependency bytes used by final verification so later
 * focused acceptance checks remain comparable after unrelated workspace edits.
 * Corrupt evidence and ticket ownership collisions fail instead of falling back
 * to a fresh snapshot of the live project. */
export async function restoreVerificationEnvironment(projectRoot, binding, ticketPaths = []) {
  const manifest = await loadVerificationEnvironment(projectRoot, binding);
  const files = [];
  for (const entry of manifest) files.push({ ...entry, bytes: await readVerificationEnvironmentFile(projectRoot, entry) });
  const environment = { files, manifest, sha256: binding.sha256 };
  assertVerificationEnvironment(environment, ticketPaths);
  return environment;
}

// Rejects malformed or overlapping evidence paths before discovery or archive overlays can use
// a manifest. A matching digest proves byte identity, not that those bytes form a safe file tree.
export function assertVerificationEnvironmentManifest(manifest) {
  if (!Array.isArray(manifest)) throw fail("Verification environment manifest must be an array.");
  const paths = new Set();
  for (const entry of manifest) {
    const path = entry?.path;
    if (typeof path !== "string" || !path || path.startsWith("/") || /^[A-Za-z]:/.test(path)
      || path.includes("\\") || /\p{Cc}/u.test(path) || posix.normalize(path) !== path
      || path.split("/").some((part) => !part || [".", "..", ".git", ".forge", ".forge-tmp", "node_modules"].includes(part))
      || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "") || ![0o644, 0o755].includes(entry.mode) || paths.has(path)) {
      throw fail("Verification environment manifest contains an invalid file entry.");
    }
    paths.add(path);
  }
  for (const path of paths) {
    const parts = path.split("/");
    for (let count = 1; count < parts.length; count++) {
      if (paths.has(parts.slice(0, count).join("/"))) throw fail("Verification environment file paths overlap.");
    }
  }
}

// Validates the complete in-memory snapshot before publishing blobs or modifying an archive.
// Ticket ownership remains separate: a valid environment must never replace a ticket-owned path.
export function assertVerificationEnvironment(environment, ticketPaths = []) {
  assertVerificationEnvironmentManifest(environment?.manifest);
  if (!Array.isArray(environment.files) || environment.files.length !== environment.manifest.length
    || hash(JSON.stringify(environment.manifest)) !== environment.sha256) throw fail("Verification environment identity is invalid.");
  for (let index = 0; index < environment.files.length; index++) {
    const file = environment.files[index];
    const entry = environment.manifest[index];
    if (!file || file.path !== entry.path || file.sha256 !== entry.sha256 || file.mode !== entry.mode
      || !Buffer.isBuffer(file.bytes) || hash(file.bytes) !== entry.sha256) throw fail("Verification environment bytes differ from the manifest.");
    if (ticketPaths.some((path) => entry.path === path || entry.path.startsWith(`${path}/`) || path.startsWith(`${entry.path}/`))) {
      throw fail("Verification environment conflicts with ticket ownership.");
    }
  }
}

// Supplies the exact dependency bytes used by verification to independent review without reading live files.
export async function readVerificationEnvironmentFile(projectRoot, entry) {
  if (!/^[a-f0-9]{64}$/.test(entry?.sha256 ?? "")) throw fail("Dependency evidence checksum is invalid.");
  const bytes = await readFile(resolveRuntimePath(projectRoot, ROOT, "blobs", entry.sha256));
  if (hash(bytes) !== entry.sha256) throw fail("Dependency evidence content changed.");
  return bytes;
}
