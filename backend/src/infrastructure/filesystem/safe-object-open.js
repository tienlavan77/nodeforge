// Binds project file reads, overwrites and creates to the real opened leaf object so a symlink or
// path swap between an earlier path check and the actual operation cannot retarget bytes outside
// the approved inode. Opening with O_NOFOLLOW makes the kernel refuse a symlinked leaf at the exact
// moment of open, and the handle's (dev, ino) is then compared against a freshly walked canonical
// path so an ancestor directory swap is also caught instead of trusting a prior lstat.
import { constants, open } from "node:fs/promises";
import { statSync } from "node:fs";
import { ConfigurationError } from "../../shared/errors.js";
import { projectIndexPath } from "./project-index-path.js";

const NOFOLLOW_READ = constants.O_RDONLY | constants.O_NOFOLLOW;
const NOFOLLOW_WRITE = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;

// Reads a regular project file through one no-follow handle. A missing file keeps its ENOENT so
// callers preserve not-found semantics; a swapped or symlink leaf fails closed; a non-regular leaf
// (directory, device, fifo) is refused; bytes larger than maxBytes are refused before delivery.
// The canonical ancestor walk runs once here (allowMissing keeps ENOENT for an absent leaf, which
// open() reproduces) and once again inside bindObject as the post-open TOCTOU recheck; merging the
// former separate pre-walk and canonical-path walk avoids lstat/realpath amplification per read.
export async function readRegularFile(root, rel, { maxBytes, encoding = "utf8" } = {}) {
  const handle = await openLeaf(projectIndexPath(root, rel, { allowMissing: true }), NOFOLLOW_READ, false);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw unsafe("Refusing to read a non-regular project file.");
    if (maxBytes !== undefined && info.size > maxBytes) throw Object.assign(new ConfigurationError(`File exceeds the read limit: ${rel}.`), { code: "FILE_TOO_LARGE" });
    bindObject(root, rel, info);
    return await handle.readFile({ encoding });
  } finally { await handle.close(); }
}

// Writes a regular project file through one no-follow handle, creating it when absent. A symlinked
// leaf is refused (ELOOP) so a swap cannot spill bytes onto an unapproved inode; a non-regular leaf
// is refused before any truncation. Returns the byte length actually written.
export async function writeRegularFile(root, rel, content, mode = 0o600) {
  const handle = await openLeaf(projectIndexPath(root, rel, { allowMissing: true }), NOFOLLOW_WRITE, false, mode);
  try {
    const info = await handle.stat();
    if (info.isFile() === false) throw unsafe("Refusing to overwrite a non-regular project file.");
    bindObject(root, rel, info);
    await handle.writeFile(content, "utf8");
    return Buffer.byteLength(content, "utf8");
  } finally { await handle.close(); }
}

// Confirms an existing project leaf is a regular file (or is absent for a new create) before an
// atomic overwrite replaces it. Returns the current mode when a file exists, otherwise null, so the
// caller can preserve permissions while a rename cannot silently retarget a symlinked inode.
export async function prepareSafeWriteTarget(root, rel) {
  const handle = await openLeaf(projectIndexPath(root, rel, { allowMissing: true }), NOFOLLOW_READ, true);
  if (!handle) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw unsafe("Refusing to overwrite a non-regular project file.");
    bindObject(root, rel, info);
    return info.mode & 0o7777;
  } finally { await handle.close(); }
}

// Opens the leaf, translating a symlink or non-directory traversal into a stable unsafe-path error.
// allowMissing lets the create/overwrite guard accept a new file; readers require the file to exist.
async function openLeaf(path, flags, allowMissing, mode) {
  try { return await open(path, flags, mode); }
  catch (error) {
    if (error?.code === "ENOENT") { if (allowMissing) return null; throw error; }
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR") throw unsafe("Refusing to follow an unsafe project path.");
    throw error;
  }
}

// Re-walks ancestors and compares the opened handle's (dev, ino) against the freshly resolved
// canonical path. A directory swapped for an external symlink between walk and open now mismatched,
// so the read/write is refused instead of returning bytes from outside the project boundary.
function bindObject(root, rel, info) {
  const canonical = projectIndexPath(root, rel);
  const current = statSync(canonical);
  if (current.dev !== info.dev || current.ino !== info.ino) throw unsafe("Refusing to use a project file whose object changed mid-operation.");
}

// Reports an object-boundary violation without echoing target contents or resolved paths.
function unsafe(message) { return Object.assign(new ConfigurationError(message), { code: "FILE_ACCESS_UNSAFE_PATH" }); }
