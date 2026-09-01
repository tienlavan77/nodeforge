import { mkdir, readFile as fsReadFile, readdir, unlink, writeFile as fsWriteFile, link, rename, open as fsOpen } from "node:fs/promises";
import { appendFileSync as fsAppendFileSync, mkdirSync, statSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import picomatch from "picomatch";
import { ConfigurationError } from "../../shared/errors.js";

const DEFAULT_SECRETS = ["**/.env", "**/.env.*", "**/*.key", "**/*.pem", "**/*.crt", "**/*.pfx", "**/*.keystore"];
const DEFAULT_IGNORE = [".forge/**", ".node-control/**", "node_modules/**", ".git/**", "dist/**", "coverage/**", ".next/**", ".next.stale-*/**", "**/.DS_Store", "**/._*"];

export function createFileService({ projectRoot, secretPatterns = DEFAULT_SECRETS, watcherIgnore = DEFAULT_IGNORE, databaseService, internalBus, onWrite } = {}) {
  if (typeof projectRoot !== "string" || !projectRoot) throw new ConfigurationError("FileService requires a project root.");
  const root = resolve(projectRoot);
  const secretMatch = picomatch(secretPatterns, { dot: true });
  const ignoreMatch = picomatch(watcherIgnore, { dot: true });
  let queue = Promise.resolve();
  return Object.freeze({ writeFile, atomicCreate, atomicWrite, atomicWriteSync, appendFile, appendFileSync, createLock, createLockSync, readFile, readForIndex, deleteFile, listFiles });

  function writeFile(input) {
    const job = queue.then(() => write(input));
    queue = job.catch(() => {});
    return job;
  }
  function atomicCreate(input) {
    const job = queue.then(() => atomicWriteJob(input, { replace: false }));
    queue = job.catch(() => {});
    return job;
  }
  function atomicWrite(input) {
    const job = queue.then(() => atomicWriteJob(input, { replace: input?.replace === true }));
    queue = job.catch(() => {});
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
      await fsWriteFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
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
      await unlink(temporary).catch(() => {});
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
      writeFileSync(temporary, content, { encoding: "utf8", mode: input.mode ?? 0o600, flag: "wx" });
      renameSync(temporary, destination);
    } finally {
      try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") process.stderr.write(`FileService temp cleanup failed: ${error.message}\n`); }
    }
    return Object.freeze({ path: rel, bytes: Buffer.byteLength(content), atomic: true, replaced: true });
  }
  function appendFile(input) {
    const job = queue.then(() => appendFileJob(input));
    queue = job.catch(() => {});
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
      await handle?.close().catch(() => {});
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
    await fsWriteFile(resolve(root, rel), content, { encoding: "utf8", mode: 0o600 });
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
  async function readFile({ path } = {}) { const rel = safePath(path); return fsReadFile(resolve(root, rel), "utf8"); }
  async function readForIndex({ path } = {}) {
    if (typeof path !== "string" || !path) throw new ConfigurationError("FileService indexing path is required.");
    const rel = relative(root, resolve(root, path)).split(sep).join("/");
    if (isAbsolute(path) || !rel || rel.startsWith("..") || secretMatch(rel) || ignoreMatch(rel)) throw new ConfigurationError("Refusing to index unsafe, ignored, or secret project path.");
    const absolute = resolve(root, rel);
    let content;
    try { content = await fsReadFile(absolute, "utf8"); } catch (error) { if (error?.code === "ENOENT") throw error; throw new ConfigurationError(`Unable to read file for indexing: ${rel}.`, { cause: error }); }
    if (content.includes("\u0000")) throw new ConfigurationError(`Refusing to index binary file: ${rel}.`);
    const sha256 = createHash("sha256").update(content).digest("hex");
    return Object.freeze({ path: rel, content, sha256: `sha256:${sha256}`, size_bytes: Buffer.byteLength(content, "utf8"), language: languageForPath(rel) });
  }
  async function deleteFile({ path } = {}) { const rel = safePath(path, { write: true }); await unlink(resolve(root, rel)); internalBus?.emit?.("file.deleted", { path: rel }); return { path: rel, deleted: true }; }
  async function listFiles({ glob = "**/*" } = {}) { const files = []; const runtimeListing = glob === ".forge/runtime" || glob.startsWith(".forge/runtime/"); await scan(root, ""); const match = picomatch(glob, { dot: true }); return files.filter((path) => match(path));
    async function scan(directory, prefix) { for (const entry of await readdir(directory, { withFileTypes: true })) { const rel = prefix ? `${prefix}/${entry.name}` : entry.name; const runtimeAncestor = runtimeListing && (rel === ".forge" || rel === ".forge/runtime" || rel.startsWith(".forge/runtime/")); if (ignoreMatch(rel) && !runtimeAncestor) continue; if (entry.isDirectory()) await scan(resolve(directory, entry.name), rel); else files.push(rel); } }
  }
  function safePath(path, { write = false } = {}) {
    if (typeof path !== "string" || !path) throw new ConfigurationError("FileService path is required.");
    const absolute = resolve(root, path);
    const rel = relative(root, absolute).split(sep).join("/");
    const runtimePath = rel === ".forge/runtime" || rel.startsWith(".forge/runtime/");
    if (isAbsolute(path) || !rel || rel.startsWith("..") || secretMatch(rel) || (ignoreMatch(rel) && !runtimePath)) {
      throw new ConfigurationError("Refusing unsafe, ignored, or secret project path.");
    }
    // Runtime state is Node-owned but must be writable through this service; other
    // hidden project paths remain protected from agent file operations.
    if (write && basename(rel).startsWith(".") && !runtimePath) throw new ConfigurationError("Hidden project paths are not writable.");
    return rel;
  }
  function validateCommitTarget(commit, rel) {
    if (!commit || commit.target_path !== rel) throw new ConfigurationError("File write path does not match commit.target_path.");
    const expectedDir = dirname(rel).split(sep).join("/");
    const suppliedDir = typeof commit.target_dir === "string" ? commit.target_dir.replace(/\/+$/, "") || "." : commit.target_dir;
    if (suppliedDir !== expectedDir) throw new ConfigurationError("Commit target_dir does not match target_path.");
    if (Array.isArray(commit.allowed_change_areas) && !commit.allowed_change_areas.some((pattern) => picomatch.isMatch(rel, pattern, { dot: true }))) throw new ConfigurationError("File path is outside commit allowed_change_areas.");
  }
}

function languageForPath(path) {
  return ({ ".js": "javascript", ".jsx": "javascript", ".ts": "typescript", ".tsx": "typescript", ".mjs": "javascript", ".cjs": "javascript", ".json": "json", ".css": "css", ".scss": "scss", ".md": "markdown", ".php": "php" })[extname(path).toLowerCase()] ?? null;
}

function formatVerificationBreakdown(breakdown) {
  return breakdown.map((step) => `${step.kind}:${step.status}${step.exit_code !== undefined ? ` (exit ${step.exit_code})` : ""}`).join(", ");
}
