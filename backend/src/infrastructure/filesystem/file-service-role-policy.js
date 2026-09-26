// Gives agents role-scoped File Service access so project workflows stay under Node governance.
import { ConfigurationError } from "../../shared/errors.js";
import { isProtectedPath } from "./protected-path-policy.js";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

const ARCHITECTURE_WRITE_PREFIXES = Object.freeze(["docs/", "Skills/", "workflows/"]);

// Lists project areas where a role may create or edit files.
export function roleWritePrefixes(role) { return role === "architecture_manager" ? [...ARCHITECTURE_WRITE_PREFIXES] : []; }

// Checks role permissions before File Service reads, writes, or deletes a path.
export function assertRoleFileAccess(role, operation, path) {
  const safe = typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0")
    && path.split("/").every((part) => part && part !== "." && part !== ".." && !part.startsWith("."))
    && !isProtectedPath(path, { operation: operation === "read" ? "read" : "write" })
    && !/(^|\/)(?:node_modules|vendor|dist|build|coverage|cache|\.next)(\/|$)|(^|\/)(?:secret|secrets|credential|credentials|private)(?:[._/-]|$)/i.test(path);
  const writeArea = role === "architecture_manager" && (path === "ARCHITECTURE.md" || ARCHITECTURE_WRITE_PREFIXES.some((prefix) => path?.startsWith(prefix)));
  const allowed = safe && (operation === "read" || (operation === "write" && writeArea) || (operation === "delete" && role === "architecture_manager" && path.startsWith("workflows/")));
  if (!allowed) throw Object.assign(new ConfigurationError(`File access is not permitted for role ${role}: ${operation} ${path ?? "<missing>"}.`), { code: "FILE_ROLE_FORBIDDEN" });
}

// Wraps Node File Service with checks for agent-initiated file operations.
export function createRoleFileService({ fileService, role, projectRoot }) {
  if (!fileService?.readFile || !fileService?.readForIndex || !fileService?.atomicWrite || !fileService?.deleteFile) throw new ConfigurationError("Role File Service requires read, write, and delete operations.");
  if (typeof projectRoot !== "string" || !projectRoot) throw new ConfigurationError("Role File Service requires a project root.");
  // Reject symlink components so an agent cannot reach outside the project through an approved relative path.
  async function checkPath(operation, path) {
    assertRoleFileAccess(role, operation, path);
    let current = resolve(projectRoot);
    for (const part of path.split("/")) {
      current = resolve(current, part);
      let info;
      try { info = await lstat(current); }
      catch (error) { if (error.code === "ENOENT") break; throw error; }
      if (info.isSymbolicLink()) throw Object.assign(new ConfigurationError("Agent file path contains a symbolic link."), { code: "FILE_ROLE_FORBIDDEN" });
    }
  }
  return Object.freeze({
    readFile: async (input) => { await checkPath("read", input?.path); return fileService.readFile(input); },
    readForIndex: async (input) => { await checkPath("read", input?.path); return fileService.readForIndex(input); },
    atomicWrite: async (input) => { await checkPath("write", input?.path); return fileService.atomicWrite(input); },
    deleteFile: async (input) => { await checkPath("delete", input?.path); return fileService.deleteFile(input); },
    listFiles: async (input) => filterListed("read", await fileService.listFiles(input)),
    listDirectories: async (input) => filterListed("read", await fileService.listDirectories(input))
  });

  // Hides private and symlinked entries from agent directory discovery.
  async function filterListed(operation, paths) {
    const visible = [];
    for (const path of paths) {
      try { await checkPath(operation, path); visible.push(path); }
      catch (error) { if (error.code !== "FILE_ROLE_FORBIDDEN") throw error; }
    }
    return visible;
  }
}
