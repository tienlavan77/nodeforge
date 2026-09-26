// Grants owner conversation tools by role and limits architecture writes to project design artifacts.
import { lstat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { ConfigurationError } from "../shared/errors.js";
import { authorizeTool } from "./tool-authorization.js";

const READ_TOOLS = Object.freeze(["rg_files", "search_tree", "read_file", "sed_lines"]);
const ROLE_TOOLS = Object.freeze({
  architecture_manager: Object.freeze([...READ_TOOLS, "write_diff", "edit_diff"]),
  sprint_leader: READ_TOOLS,
  coder: READ_TOOLS,
  reviewer: READ_TOOLS,
  linguist: Object.freeze(["read_file", "sed_lines"]),
  runtime: Object.freeze([])
});
const WRITE_PREFIXES = Object.freeze(["docs/", "Skills/"]);
const WRITE_FILES = Object.freeze(["ARCHITECTURE.md"]);
const WRITE_TOOLS = new Set(["write_diff", "edit_diff"]);
const PRIVATE_PATH = /(^|\/)(?:\.[^/]+|node_modules|vendor|dist|build|coverage|cache|\.next|(?:secret|secrets|credential|credentials|private|id_rsa|id_ed25519)(?:[._-]|$)|[^/]+\.(?:pem|key|p12|pfx|crt|keystore)$)/i;

// Returns the Forge capabilities advertised to one owner conversation role.
export function ownerRoleTools(role) { return ROLE_TOOLS[role] ?? []; }

// Keeps only task patch paths within the architecture document policy.
export function ownerWritePaths(candidateFiles = []) {
  return candidateFiles.filter((item) => item?.role === "PATCH" && isArchitectureWritePath(item.path)).map((item) => item.path);
}

// Rechecks role capability and approved project paths at the Node execution boundary.
export async function authorizeOwnerTool(name, input, context, projectRoot) {
  authorizeTool(name, context);
  if (!ownerRoleTools(context.agent_identity?.role).includes(name)) throw forbidden("Tool is not permitted for this role.");
  if (!["read_file", "sed_lines", "write_diff", "edit_diff"].includes(name)) return;
  const path = input?.path;
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\\") || path.includes("\0")
    || path.split("/").some((part) => !part || part === "." || part === "..")) throw forbidden("Tool path must be a relative project file.");
  if (PRIVATE_PATH.test(path)) throw forbidden("Tool path is ignored or private.");
  if (WRITE_TOOLS.has(name) && !isArchitectureWritePath(path)) {
    throw forbidden("Architecture writes are limited to approved project documentation and skills.");
  }
  if (WRITE_TOOLS.has(name) && !context.allowed_write_paths?.includes(path)) {
    throw forbidden("Architecture write path was not approved for this task.");
  }
  let current = projectRoot;
  const parts = path.split("/");
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) throw forbidden("Tool path cannot traverse a symlink or non-directory.");
    } catch (error) {
      if (error?.code !== "ENOENT" || !WRITE_TOOLS.has(name)) throw error;
    }
  }
  if (await isGitIgnored(projectRoot, path)) throw forbidden("Tool path is ignored by project rules.");
}

// Checks the fixed document area before a task's exact path grant is applied.
function isArchitectureWritePath(path) {
  return typeof path === "string" && !isAbsolute(path) && !path.includes("\\") && !path.includes("\0")
    && !path.split("/").some((part) => !part || part === "." || part === "..") && !PRIVATE_PATH.test(path)
    && (WRITE_FILES.includes(path) || WRITE_PREFIXES.some((prefix) => path.startsWith(prefix)));
}

// Returns a stable denial code for role and path violations.
function forbidden(message) { return Object.assign(new ConfigurationError(message), { code: "TOOL_FORBIDDEN" }); }

// Applies project Git ignore rules to both existing files and approved new documents.
function isGitIgnored(projectRoot, path) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["check-ignore", "--no-index", "--quiet", "--", path], { cwd: projectRoot, stdio: ["ignore", "ignore", "pipe"] });
    const errors = [];
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(true);
      else if (code === 1) resolve(false);
      else reject(Object.assign(new ConfigurationError(`Could not check project ignore rules: ${Buffer.concat(errors).toString("utf8").trim()}`), { code: "TOOL_SCOPE_INVALID" }));
    });
  });
}
