// Defines owner conversation role tool permissions and path authorization.
import { ConfigurationError } from "../../shared/errors.js";
import { authorizeTool } from "../governance/tool-authorization.js";
import { assertRoleFileAccess, roleWritePrefixes } from "../../infrastructure/filesystem/file-service-role-policy.js";
import { isProjectGitkeepPath } from "../../infrastructure/filesystem/protected-path-policy.js";

const READ_TOOLS = Object.freeze(["search_tree", "list_files", "search_text", "read_file", "Read", "lookup_schema"]);
const DELEGATE_TOOL = "delegate_subagent";
const GIT_READ_TOOLS = Object.freeze(["git_status", "git_diff", "git_log", "git_show", "git_blame"]);
const ROLE_TOOLS = Object.freeze({
  architecture_manager: Object.freeze([...READ_TOOLS, DELEGATE_TOOL, ...GIT_READ_TOOLS, "git_branch", "write_diff", "edit_diff", "delete_file"]),
  system_engineer: Object.freeze([...READ_TOOLS, DELEGATE_TOOL, "write_diff", "edit_diff", "delete_file", "move_file", ...GIT_READ_TOOLS, "git_branch", "git_restore", "git_stash", "run_command", "run_check", "commit_changes", "push_commit"]),
  sprint_leader: Object.freeze([...READ_TOOLS, DELEGATE_TOOL, ...GIT_READ_TOOLS, "git_branch"]),
  coder: Object.freeze([...READ_TOOLS, DELEGATE_TOOL]),
  reviewer: Object.freeze([...READ_TOOLS, DELEGATE_TOOL, ...GIT_READ_TOOLS, "git_branch"]),
  linguist: Object.freeze(["read_file", "Read", "lookup_schema"]),
  runtime: Object.freeze([])
});
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
  if (context.planning_input_only === true) {
    if (![...READ_TOOLS, ...GIT_READ_TOOLS, "git_branch"].includes(name)) throw forbidden("Planning input permits discovery and Git reads only.");
    if (name === "git_branch" && !["list", "current"].includes(input?.action)) throw forbidden("Planning input permits read-only git_branch (list, current) only.");
  }
  const role = context.agent_identity?.role;
  if (!ownerRoleTools(role).includes(name)) throw forbidden("Tool is not permitted for this role.");
  if (name === "git_branch" && role !== "system_engineer" && !["list", "current"].includes(input?.action)) {
    throw forbidden("Only System Engineer may execute mutating git_branch actions in owner conversations.");
  }
  if (!WRITE_TOOLS.has(name) && name !== "delete_file" && name !== "move_file") return;
  const targets = name === "move_file"
    ? [["delete", input?.from_path], ["write", input?.to_path]]
    : [[name === "delete_file" ? "delete" : "write", input?.path]];
  for (const [operation, path] of targets) {
    if (typeof path !== "string" || (isPrivate(path) && !(role === "system_engineer" && (path.startsWith(".forge/") || operation === "delete" && isProjectGitkeepPath(path))))) throw forbidden("Architecture file path is private or unsafe.");
    try { assertRoleFileAccess(role, operation, path); }
    catch (error) { throw forbidden(error.message); }
  }
  if (name === "move_file") {
    try { assertRoleFileAccess(role, "move", input?.from_path); assertRoleFileAccess(role, "move", input?.to_path); }
    catch (error) { throw forbidden(error.message); }
  }
  if (projectRoot && typeof projectRoot !== "string") throw forbidden("Project root is invalid.");
}

function isPrivate(path) { return !path || path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === "..") || PRIVATE_PATH.test(path); }
function isArchitectureWritePath(path) { return typeof path === "string" && !isPrivate(path) && (path === "ARCHITECTURE.md" || roleWritePrefixes("architecture_manager").some((prefix) => path.startsWith(prefix))); }
function forbidden(message) { return Object.assign(new ConfigurationError(message), { code: "TOOL_FORBIDDEN" }); }
