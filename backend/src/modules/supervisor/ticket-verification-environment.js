// Captures project dependencies separately from ticket-owned files so verification never expands a ticket commit.
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, mkdir, writeFile, link, rm } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { createTicketRootGit } from "./ticket-root-git.js";

const ROOT = ".forge/runtime/ticket-verification/environment";
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
  for (const file of environment.files) await persistEvidence(join(projectRoot, ROOT, "blobs", file.sha256), file.bytes, file.sha256);
  const manifestPath = `${ROOT}/manifests/${environment.sha256}.json`;
  await persistEvidence(join(projectRoot, manifestPath), JSON.stringify(environment.manifest), environment.sha256);
  return { sha256: environment.sha256, manifest_path: manifestPath, scope: "project_environment_not_ticket_changes" };
}

// Reads only immutable environment evidence named by Node's verification artifact.
export async function loadVerificationEnvironment(projectRoot, binding) {
  if (!/^[a-f0-9]{64}$/.test(binding?.sha256 ?? "") || binding.manifest_path !== `${ROOT}/manifests/${binding.sha256}.json`) throw fail("Verification environment binding is invalid.");
  const bytes = await readFile(join(projectRoot, binding.manifest_path));
  if (hash(bytes) !== binding.sha256) throw fail("Verification environment manifest checksum changed.");
  return JSON.parse(bytes);
}

// Supplies the exact dependency bytes used by verification to independent review without reading live files.
export async function readVerificationEnvironmentFile(projectRoot, entry) {
  if (!/^[a-f0-9]{64}$/.test(entry?.sha256 ?? "")) throw fail("Dependency evidence checksum is invalid.");
  const bytes = await readFile(join(projectRoot, ROOT, "blobs", entry.sha256));
  if (hash(bytes) !== entry.sha256) throw fail("Dependency evidence content changed.");
  return bytes;
}
