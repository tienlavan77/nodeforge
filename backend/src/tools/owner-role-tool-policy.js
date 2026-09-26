// Defines owner conversation role tool permissions and path authorization.
import { ConfigurationError } from "../shared/errors.js";
import { authorizeTool } from "./tool-authorization.js";
import { assertRoleFileAccess, roleWritePrefixes } from "../infrastructure/filesystem/file-service-role-policy.js";

const READ_TOOLS = Object.freeze(["search_tree", "rg_files", "rg_search", "sed_lines", "read_file"]);
const ROLE_TOOLS = Object.freeze({ architecture_manager: Object.freeze([...READ_TOOLS, "write_diff", "edit_diff", "delete_file"]), sprint_leader: READ_TOOLS, coder: READ_TOOLS, reviewer: READ_TOOLS, linguist: Object.freeze(["read_file", "sed_lines"]), runtime: Object.freeze([]) });
const PRIVATE_PATH = /(^|\/)(?:\.[^/]+|node_modules|vendor|dist|build|coverage|cache|\.next|(?:secret|secrets|credential|credentials|private|id_rsa|id_ed25519)(?:[._-]|$)|[^/]+\.(?:pem|key|p12|pfx|crt|keystore)$)/i;
const WRITE_TOOLS = new Set(["write_diff", "edit_diff"]);

// Returns Forge capabilities allowed for an owner conversation role.
export function ownerRoleTools(role) { return ROLE_TOOLS[role] ?? []; }

// Returns approved architecture write paths from task candidates.
export function ownerWritePaths(candidateFiles = []) { return candidateFiles.filter((item) => item?.role === "PATCH" && isArchitectureWritePath(item.path)).map((item) => item.path); }

// Grants Architecture Manager the documented project writing areas during owner chat.
export function ownerWritePrefixes(role) { return roleWritePrefixes(role); }

// Enforces owner role, path, and authorization policy before tool execution.
export async function authorizeOwnerTool(name, input, context, projectRoot) {
  authorizeTool(name, context);
  if (!ownerRoleTools(context.agent_identity?.role).includes(name)) throw forbidden("Tool is not permitted for this role.");
  if (!WRITE_TOOLS.has(name) && name !== "delete_file") return;
  const path = input?.path;
  if (typeof path !== "string" || isPrivate(path)) throw forbidden("Architecture file path is private or unsafe.");
  try { assertRoleFileAccess(context.agent_identity?.role, name === "delete_file" ? "delete" : "write", path); }
  catch (error) { throw forbidden(error.message); }
  if (projectRoot && typeof projectRoot !== "string") throw forbidden("Project root is invalid.");
}

function isPrivate(path) { return !path || path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === "..") || PRIVATE_PATH.test(path); }
function isArchitectureWritePath(path) { return typeof path === "string" && !isPrivate(path) && (path === "ARCHITECTURE.md" || roleWritePrefixes("architecture_manager").some((prefix) => path.startsWith(prefix))); }
function forbidden(message) { return Object.assign(new ConfigurationError(message), { code: "TOOL_FORBIDDEN" }); }
