import { mkdir, readFile as fsReadFile, readdir, unlink, writeFile as fsWriteFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import picomatch from "picomatch";
import { ConfigurationError } from "../../shared/errors.js";

const DEFAULT_SECRETS = ["**/.env", "**/.env.*", "**/*.key", "**/*.pem", "**/*.crt", "**/*.pfx", "**/*.keystore"];
const DEFAULT_IGNORE = [".forge/**", "node_modules/**", ".git/**", "dist/**", "coverage/**"];

export function createFileService({ projectRoot, secretPatterns = DEFAULT_SECRETS, watcherIgnore = DEFAULT_IGNORE, databaseService, internalBus, onWrite } = {}) {
  if (typeof projectRoot !== "string" || !projectRoot) throw new ConfigurationError("FileService requires a project root.");
  const root = resolve(projectRoot);
  const secretMatch = picomatch(secretPatterns, { dot: true });
  const ignoreMatch = picomatch(watcherIgnore, { dot: true });
  let queue = Promise.resolve();
  return Object.freeze({ writeFile, readFile, deleteFile, listFiles });

  function writeFile(input) {
    const job = queue.then(() => write(input));
    queue = job.catch(() => {});
    return job;
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
    await onWrite?.({ path: rel, bytes: Buffer.byteLength(content) });
    return Object.freeze({ path: rel, bytes: Buffer.byteLength(content) });
  }
  async function readFile({ path } = {}) { const rel = safePath(path); return fsReadFile(resolve(root, rel), "utf8"); }
  async function deleteFile({ path } = {}) { const rel = safePath(path, { write: true }); await unlink(resolve(root, rel)); internalBus?.emit?.("file.deleted", { path: rel }); return { path: rel, deleted: true }; }
  async function listFiles({ glob = "**/*" } = {}) { const files = []; await scan(root, ""); const match = picomatch(glob, { dot: true }); return files.filter((path) => match(path));
    async function scan(directory, prefix) { for (const entry of await readdir(directory, { withFileTypes: true })) { const rel = prefix ? `${prefix}/${entry.name}` : entry.name; if (ignoreMatch(rel)) continue; if (entry.isDirectory()) await scan(resolve(directory, entry.name), rel); else files.push(rel); } }
  }
  function safePath(path, { write = false } = {}) { if (typeof path !== "string" || !path) throw new ConfigurationError("FileService path is required."); const absolute = resolve(root, path); const rel = relative(root, absolute).split(sep).join("/"); if (isAbsolute(path) || !rel || rel.startsWith("..") || secretMatch(rel) || ignoreMatch(rel)) throw new ConfigurationError("Refusing unsafe, ignored, or secret project path."); if (write && basename(rel).startsWith(".")) throw new ConfigurationError("Hidden project paths are not writable."); return rel; }
  function validateCommitTarget(commit, rel) { if (!commit || commit.target_path !== rel) throw new ConfigurationError("File write path does not match commit.target_path."); const expectedDir = dirname(rel).split(sep).join("/"); if (commit.target_dir !== expectedDir) throw new ConfigurationError("Commit target_dir does not match target_path."); if (Array.isArray(commit.allowed_change_areas) && !commit.allowed_change_areas.some((pattern) => picomatch.isMatch(rel, pattern, { dot: true }))) throw new ConfigurationError("File path is outside commit allowed_change_areas."); }
}
