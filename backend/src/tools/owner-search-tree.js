// Lists a bounded, secret-filtered project tree for owner conversations.
import { ConfigurationError } from "../shared/errors.js";
import { isProtectedPath } from "../infrastructure/filesystem/protected-path-policy.js";

export const ownerSearchTreeDefinition = Object.freeze({ name: "search_tree", description: "List directories and files below one project path, including empty directories. Depth and result count are bounded. For installed package guidance, specify its node_modules directory and use returned filenames with read_file/read_lines instead of guessing extensions.", input_schema: { type: "object", properties: { path: { type: "string", description: "Project-relative directory, or . for project root" }, max_depth: { type: "integer", minimum: 1, maximum: 8 }, limit: { type: "integer", minimum: 1, maximum: 500 } }, additionalProperties: false } });

// Creates a project-scoped tree reader using the existing File Service ignore rules.
export function createOwnerSearchTreeTool({ fileService, role }) {
  if (typeof fileService?.listFiles !== "function" || typeof fileService?.listDirectories !== "function") throw new ConfigurationError("search_tree requires File Service listing.");
  return { execute };

  // Lists only safe project entries, bounded by depth and count.
  async function execute(input = {}, context = {}) {
    const path = input.path ?? ".";
    const maxDepth = input.max_depth ?? 3;
    const limit = input.limit ?? 200;
    const forgeAccess = role === "system_engineer" && typeof path === "string" && (path === ".forge" || path.startsWith(".forge/"));
    if (typeof path !== "string" || (path !== "." && (path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === ".." || (!forgeAccess && part.startsWith(".")))))) throw new ConfigurationError("search_tree path must stay inside the project.");
    if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 8 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new ConfigurationError("search_tree limits are invalid.");
    if (typeof fileService.listTree === "function") return fileService.listTree({ path, maxDepth, limit, signal: context.abortSignal });
    const prefix = path === "." ? "" : `${path}/`;
    const safe = (entry) => role === "system_engineer" && (entry === ".forge" || entry.startsWith(".forge/")) || !entry.split("/").some((part) => part.startsWith(".") || /^(?:node_modules|vendor|dist|build|coverage|cache|secrets?|credentials?|private)$/i.test(part)) && !isProtectedPath(entry, { forIndex: true }) && !/\.(?:key|pem|crt|pfx|keystore)$/i.test(entry);
    const include = (entry) => entry.startsWith(prefix) && safe(entry) && entry.slice(prefix.length).split("/").length <= maxDepth;
    const [directories, files] = await Promise.all([fileService.listDirectories(), fileService.listFiles()]);
    const entries = [...directories.filter(include).map((entry) => ({ path: entry, type: "directory" })), ...files.filter(include).map((entry) => ({ path: entry, type: "file" }))].sort((a, b) => a.path.localeCompare(b.path));
    return { root: path, entries: entries.slice(0, limit), total: entries.length, truncated: entries.length > limit };
  }
}
