// Provides sandboxed file I/O with secret/protected path checks, atomic writes, and optional indexing/verification hooks.
import { FORGE_STATE_DIR, STATE_DIR_PREFIX, statePath } from "./forge-paths.js";
import { assertRuntimeAvailable, runtimeListingPath, runtimeStoragePath } from "./runtime-layout.js";
import { chmod, mkdir, readdir, unlink, writeFile as fsWriteFile, link, rename, rmdir, open as fsOpen } from "node:fs/promises";
import { appendFileSync as fsAppendFileSync, chmodSync, mkdirSync, statSync, readFileSync as fsReadFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, readSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import picomatch from "picomatch";
import { ConfigurationError } from "../../shared/errors.js";
import { SECRET_PATTERNS, isProtectedPath } from "./protected-path-policy.js";
import { projectIndexPath } from "./project-index-path.js";
import { readRegularFile, writeRegularFile, prepareSafeWriteTarget } from "./safe-object-open.js";
const DEFAULT_SECRETS = SECRET_PATTERNS; const DEFAULT_IGNORE = [".forge/**", ".node-control/**", "node_modules/**", ".git/**", "dist/**", "coverage/**", ".next/**", ".next.stale-*/**", "**/.DS_Store", "**/._*"];
const NODE_MODULES_PATH = /^node_modules(?:\/|$)/;
// Creates a sandboxed FileService scoped to projectRoot with queued writes, secret-path filtering, and atomic/lock operations.
export function createFileService({ projectRoot, secretPatterns = DEFAULT_SECRETS, watcherIgnore = DEFAULT_IGNORE, databaseService, internalBus, onWrite, logger = console, allowPlanStorage = false, role } = {}) {
  if (typeof projectRoot !== "string" || !projectRoot) throw new ConfigurationError("FileService requires a project root.");
  const root = resolve(projectRoot);
  assertRuntimeAvailable(root);
  const secretMatch = picomatch(secretPatterns, { dot: true });
  const ignoreMatch = picomatch(watcherIgnore, { dot: true });
  let queue = Promise.resolve();
  return Object.freeze({ writeFile, atomicCreate, atomicWrite, atomicWriteSync, appendFile, appendFileSync, createLock, createLockSync, readFile, readFileSync, readFileRangeSync, readForIndex, deleteFile, removeEmptyDirectory, renameFile, listFiles, listDirectories });
  function writeFile(input) {
    const job = queue.then(() => write(input));
    queue = job.catch((error) => { logCleanup("queued write", error); });
    return job;
  }
  function atomicCreate(input) {
    const job = queue.then(() => atomicWriteJob(input, { replace: false }));
    queue = job.catch((error) => { if (error?.code !== "FILE_ALREADY_EXISTS") logCleanup("queued atomic create", error); });
    return job;
  }
  function atomicWrite(input) {
    const job = queue.then(() => atomicWriteJob(input, { replace: input?.replace === true }));
    queue = job.catch((error) => { logCleanup("queued atomic write", error); });
    return job;
  }
  async function atomicWriteJob(input = {}, { replace }) {
    const { path, content } = input;
    const rel = safePath(path, { write: true });
    if (typeof content !== "string") throw new ConfigurationError("FileService content must be a string.");
    const destination = resolve(root, rel);
    const temporary = `${destination}.tmp-${randomUUID()}`;
    await mkdir(dirname(destination), { recursive: true });
    try {
      const targetMode = await prepareSafeWriteTarget(root, rel);
      let mode = 0o600; if (replace && targetMode !== null) mode = targetMode;
      await fsWriteFile(temporary, content, { encoding: "utf8", mode, flag: "wx" }); await chmod(temporary, mode);
      if (replace) await rename(temporary, destination);
      else await link(temporary, destination);
    } catch (error) {
      if (!replace && error?.code === "EEXIST") {
        const conflict = new ConfigurationError(`File already exists: ${rel}.`);
        conflict.code = "FILE_ALREADY_EXISTS";
        conflict.path = rel;
        throw conflict;
      }
      throw error;
    } finally {
      await unlink(temporary).catch((error) => logCleanup("atomic temporary file", error));
    }
    const result = Object.freeze({ path: rel, bytes: Buffer.byteLength(content), atomic: true, replaced: replace });
    internalBus?.emit?.("file.written", { path: rel, bytes: result.bytes, atomic: true });
    return result;
  }
  function atomicWriteSync(input = {}) {
    const { path, content } = input;
    const rel = safePath(path, { write: true });
    if (typeof content !== "string") throw new ConfigurationError("FileService content must be a string.");
    const destination = resolve(root, rel);
    const temporary = `${destination}.tmp-${randomUUID()}`;
    mkdirSync(dirname(destination), { recursive: true });
    try {
      let mode = input.mode ?? 0o600; try { mode = statSync(destination).mode & 0o7777; } catch (error) { if (error.code !== "ENOENT") throw error; }
      writeFileSync(temporary, content, { encoding: "utf8", mode, flag: "wx" }); chmodSync(temporary, mode);
      renameSync(temporary, destination);
    } finally {
      try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") process.stderr.write(`FileService temp cleanup failed: ${error.message}\n`); }
    }
    return Object.freeze({ path: rel, bytes: Buffer.byteLength(content), atomic: true, replaced: true });
  }
  function appendFile(input) {
    const job = queue.then(() => appendFileJob(input));
    queue = job.catch((error) => { logCleanup("queued append", error); });
    return job;
  }
  async function appendFileJob(input = {}) {
    const { path, content } = input;
    const rel = safePath(path, { write: true });
    if (typeof content !== "string") throw new ConfigurationError("FileService content must be a string.");
    const destination = resolve(root, rel);
    await mkdir(dirname(destination), { recursive: true });
    const handle = await fsOpen(destination, "a", 0o600);
    try {
      const before = (await handle.stat()).size;
      await handle.writeFile(content, "utf8");
      const bytes = Buffer.byteLength(content);
      internalBus?.emit?.("file.appended", { path: rel, byte_offset: before, byte_length: bytes });
      return Object.freeze({ path: rel, byte_offset: before, byte_length: bytes, bytes });
    } finally {
      await handle.close();
    }
  }
  function appendFileSync(input = {}) {
    const { path, content } = input;
    const rel = safePath(path, { write: true });
    if (typeof content !== "string") throw new ConfigurationError("FileService content must be a string.");
    const destination = resolve(root, rel);
    mkdirSync(dirname(destination), { recursive: true });
    let before = 0;
    try { before = statSync(destination).size; } catch (error) { if (error.code !== "ENOENT") throw error; }
    fsAppendFileSync(destination, content, { encoding: "utf8", flag: "a", mode: 0o600 });
    const bytes = Buffer.byteLength(content);
    internalBus?.emit?.("file.appended", { path: rel, byte_offset: before, byte_length: bytes });
    return Object.freeze({ path: rel, byte_offset: before, byte_length: bytes, bytes });
  }
  async function createLock({ path, content = `${process.pid}\n` } = {}) {
    const rel = safePath(path, { write: true });
    if (typeof content !== "string") throw new ConfigurationError("FileService lock content must be a string.");
    const destination = resolve(root, rel);
    await mkdir(dirname(destination), { recursive: true });
    let handle;
    try {
      handle = await fsOpen(destination, "wx", 0o600);
      await handle.writeFile(content, "utf8");
      return Object.freeze({ path: rel, release: async () => { await handle.close(); await unlink(destination); } });
    } catch (error) {
      await handle?.close().catch((closeError) => logCleanup("file lock handle", closeError));
      if (error?.code === "EEXIST") {
        const conflict = new ConfigurationError(`File lock already exists: ${rel}.`);
        conflict.code = "FILE_LOCK_EXISTS";
        conflict.path = rel;
        throw conflict;
      }
      throw error;
    }
  }
  function createLockSync({ path, content = `${process.pid}\n` } = {}) {
    const rel = safePath(path, { write: true });
    if (typeof content !== "string") throw new ConfigurationError("FileService lock content must be a string.");
    const destination = resolve(root, rel);
    mkdirSync(dirname(destination), { recursive: true });
    let descriptor;
    try {
      descriptor = openSync(destination, "wx", 0o600);
      writeFileSync(descriptor, content, "utf8");
      closeSync(descriptor);
      return Object.freeze({ path: rel, release: () => { try { unlinkSync(destination); } catch (error) { if (error.code !== "ENOENT") throw error; } } });
    } catch (error) {
      if (descriptor !== undefined) try { closeSync(descriptor); } catch (closeError) { process.stderr.write(`FileService lock cleanup failed: ${closeError.message}\n`); }
      if (error?.code === "EEXIST") { const conflict = new ConfigurationError(`File lock already exists: ${rel}.`); conflict.code = "FILE_LOCK_EXISTS"; conflict.path = rel; throw conflict; }
      throw error;
    }
  }
  async function write(input = {}) {
    const { path, content } = input;
    const rel = safePath(path, { write: true });
    if (input.commit) validateCommitTarget(input.commit, rel);
    if (typeof content !== "string") throw new ConfigurationError("FileService content must be a string.");
    await mkdir(dirname(resolve(root, rel)), { recursive: true });
    await writeRegularFile(root, rel, content, 0o600);
    if (databaseService?.transaction) databaseService.transaction(() => {});
    internalBus?.emit?.("file.written", { path: rel, bytes: Buffer.byteLength(content) });
    try {
      await onWrite?.({ path: rel, bytes: Buffer.byteLength(content) });
    } catch (error) {
      // Keep the aggregate status while exposing the concrete failing step.
      if (error?.verificationResult?.breakdown) {
        error.message = `${error.message} (${formatVerificationBreakdown(error.verificationResult.breakdown)})`;
      }
      throw error;
    }
    return Object.freeze({ path: rel, bytes: Buffer.byteLength(content) });
  }
  async function readFile({ path } = {}) { const rel = safePath(path); return readRegularFile(root, rel); }
  function readFileSync({ path } = {}) { const rel = safePath(path); return fsReadFileSync(resolve(root, rel), "utf8"); }
  function readFileRangeSync({ path, offset = 0, length } = {}) {
    const rel = safePath(path);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 0) throw new ConfigurationError("FileService read range is invalid.");
    const buffer = Buffer.alloc(length);
    const descriptor = openSync(resolve(root, rel), "r");
    try { readSync(descriptor, buffer, 0, length, offset); } finally { closeSync(descriptor); }
    return buffer.toString("utf8");
  }
  async function readForIndex({ path, maxBytes, allowNodeModules = false } = {}) {
    if (typeof path !== "string" || !path) throw new ConfigurationError("FileService indexing path is required.");
    const rel = relative(root, resolve(root, path)).split(sep).join("/");
    const forgeAccess = role === "system_engineer" && rel.startsWith(".forge/"); const dependencyRead = allowNodeModules === true && NODE_MODULES_PATH.test(rel);
    if (isAbsolute(path) || !rel || rel.startsWith("..") || (!forgeAccess && secretMatch(rel)) || (ignoreMatch(rel) && !dependencyRead && !forgeAccess)) throw new ConfigurationError("Refusing to index unsafe, ignored, or secret project path.");
    if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes < 1)) throw new ConfigurationError("FileService read limit is invalid.");
    let content;
    try { content = await readRegularFile(root, rel, { maxBytes }); } catch (error) { if (error?.code === "ENOENT" || error?.code === "FILE_TOO_LARGE" || error instanceof ConfigurationError) throw error; throw new ConfigurationError(`Unable to read file for indexing: ${rel}.`, { cause: error }); }
    if (content.includes("\u0000")) throw new ConfigurationError(`Refusing to index binary file: ${rel}.`);
    const sha256 = createHash("sha256").update(content).digest("hex");
    return Object.freeze({ path: rel, content, sha256: `sha256:${sha256}`, size_bytes: Buffer.byteLength(content, "utf8"), language: languageForPath(rel) });
  }
  async function deleteFile({ path } = {}) { const rel = safePath(path, { write: true }); await unlink(resolve(root, rel)); internalBus?.emit?.("file.deleted", { path: rel }); return { path: rel, deleted: true }; }
  async function removeEmptyDirectory({ path } = {}) {
    const rel = safePath(path, { write: true });
    await rmdir(resolve(root, rel));
    internalBus?.emit?.("directory.deleted", { path: rel });
    return { path: rel, deleted: true };
  }
  async function renameFile({ from, to } = {}) {
    const source = safePath(from, { write: true });
    const destination = safePath(to, { write: true });
    const job = queue.then(async () => {
      await mkdir(dirname(resolve(root, destination)), { recursive: true });
      await rename(resolve(root, source), resolve(root, destination));
      internalBus?.emit?.("file.renamed", { old_path: source, path: destination });
      return { from: source, to: destination, renamed: true };
    });
    queue = job.catch((error) => { logCleanup("queued rename", error); });
    return job;
  }
  async function listFiles({ glob = "**/*" } = {}) { assertRuntimeAvailable(root); const files = []; const runtimeListing = glob === FORGE_STATE_DIR || glob.startsWith(STATE_DIR_PREFIX) || role === "system_engineer" && glob.startsWith(".forge"); const wildcard = glob.search(/[!*?[]/); const base = wildcard < 0 ? glob : glob.slice(0, wildcard).replace(/\/+$/, ""); const start = base ? resolve(root, runtimeStoragePath(root, base)) : root; const startPrefix = base ? base : ""; try { await scan(start, startPrefix); } catch (error) { if (error?.code !== "ENOENT") throw error; } const match = picomatch(glob, { dot: true }); return [...new Set(files.map((path) => runtimeListingPath(path, glob)))].filter((path) => match(path));
    async function scan(directory, prefix) { for (const entry of await readdir(directory, { withFileTypes: true })) { const rel = prefix ? `${prefix}/${entry.name}` : entry.name; const runtimeAncestor = runtimeListing && (rel === ".forge" || rel === FORGE_STATE_DIR || rel.startsWith(STATE_DIR_PREFIX) || role === "system_engineer" && rel.startsWith(".forge/")); if (ignoreMatch(rel) && !runtimeAncestor) continue; if (entry.isDirectory()) await scan(resolve(directory, entry.name), rel); else files.push(rel); } }
  }
  async function listDirectories({ glob = "**/*" } = {}) { assertRuntimeAvailable(root); const directories = []; const runtimeListing = glob === FORGE_STATE_DIR || glob.startsWith(STATE_DIR_PREFIX) || role === "system_engineer" && glob.startsWith(".forge"); const start = glob.startsWith(FORGE_STATE_DIR) ? resolve(root, FORGE_STATE_DIR) : root; const startPrefix = glob.startsWith(FORGE_STATE_DIR) ? FORGE_STATE_DIR : ""; const match = picomatch(glob, { dot: true }); try { await scan(start, startPrefix); } catch (error) { if (error?.code !== "ENOENT") throw error; } return [...new Set(directories.map((path) => runtimeListingPath(path, glob)))].filter((path) => match(path));
    async function scan(directory, prefix) { for (const entry of await readdir(directory, { withFileTypes: true })) { if (!entry.isDirectory()) continue; const rel = prefix ? `${prefix}/${entry.name}` : entry.name; const runtimeAncestor = runtimeListing && (rel === ".forge" || rel === FORGE_STATE_DIR || rel.startsWith(STATE_DIR_PREFIX) || role === "system_engineer" && rel.startsWith(".forge/")); if (ignoreMatch(rel) && !runtimeAncestor) continue; await scan(resolve(directory, entry.name), rel); directories.push(rel); } }
  }
  function safePath(path, { write = false } = {}) {
    if (typeof path !== "string" || !path) throw new ConfigurationError("FileService path is required.");
    const absolute = resolve(root, path);
    const rel = relative(root, absolute).split(sep).join("/");
    const forgeAccess = role === "system_engineer" && (rel === ".forge" || rel.startsWith(".forge/")); const runtimePath = rel === FORGE_STATE_DIR || rel.startsWith(STATE_DIR_PREFIX);
    const planPath = allowPlanStorage && /^\.forge\/runtime\/nf\/(?:planning\/)?plans\/[A-Za-z0-9][A-Za-z0-9._-]*\/(?:[1-9][0-9]*\.(?:json|md)|ke-hoach-r[1-9][0-9]*\.md|(?:revision|decision|markdown|markdown-decision)\.lock)$/.test(rel);
    const summaryPath = allowPlanStorage && /^workflows\/\.nodeforge-summary-[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(rel);
    if (isAbsolute(path) || !rel || rel.startsWith("..") || (!planPath && !summaryPath && isProtectedPath(rel, { operation: write ? "write" : "read", role })) || (!forgeAccess && secretMatch(rel)) || (ignoreMatch(rel) && !forgeAccess && !runtimePath && !planPath && !summaryPath)) {
      throw new ConfigurationError("Refusing unsafe, ignored, or secret project path.");
    }
    // Runtime state is Node-owned but must be writable through this service; other
    // hidden project paths remain protected from agent file operations.
    if (write && basename(rel).startsWith(".") && !forgeAccess && !runtimePath && !planPath && !summaryPath) throw new ConfigurationError("Hidden project paths are not writable.");
    if (rel === statePath("nf/sessions") || rel.startsWith(statePath("nf/sessions/"))) projectIndexPath(root, rel, { allowMissing: true }); return runtimeStoragePath(root, rel);
  }
  // eslint-disable-next-line no-silent-catch -- Cleanup logging must not change file behavior.
  function logCleanup(operation, error) { if (error?.code === "ENOENT") return; try { logger.error?.("FileService cleanup failed.", { operation, error: error?.message, code: error?.code }); } catch { /* cleanup logging must not change file behavior */ } }
  function validateCommitTarget(commit, rel) {
    if (!commit || commit.target_path !== rel) throw new ConfigurationError("File write path does not match commit.target_path.");
    const expectedDir = dirname(rel).split(sep).join("/");
    const suppliedDir = typeof commit.target_dir === "string" ? commit.target_dir.replace(/\/+$/, "") || "." : commit.target_dir;
    if (suppliedDir !== expectedDir) throw new ConfigurationError("Commit target_dir does not match target_path.");
    if (Array.isArray(commit.allowed_change_areas) && !commit.allowed_change_areas.some((pattern) => picomatch.isMatch(rel, pattern, { dot: true }))) throw new ConfigurationError("File path is outside commit allowed_change_areas.");
  }
}
// Maps a file extension to its language identifier for indexing metadata.
function languageForPath(path) { return ({ ".js": "javascript", ".jsx": "javascript", ".ts": "typescript", ".tsx": "typescript", ".mjs": "javascript", ".cjs": "javascript", ".json": "json", ".css": "css", ".scss": "scss", ".md": "markdown", ".php": "php" })[extname(path).toLowerCase()] ?? null; }
// Formats a verification breakdown array into a concise comma-separated status string.
function formatVerificationBreakdown(breakdown) {
  return breakdown.map((step) => `${step.kind}:${step.status}${step.exit_code !== undefined ? ` (exit ${step.exit_code})` : ""}`).join(", ");
}
