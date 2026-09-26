// Lists real project directories and files for agent discovery with Git ignore and secret filtering.
import { spawn } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRuntimeLogger } from "../core/runtime-logger.js";
import { logEvent } from "../core/project-log-service.js";
import { ConfigurationError } from "../shared/errors.js";
import { authorizeTool } from "./tool-authorization.js";

const PRIVATE_PATH = /(^|\/)(?:\.git(?:\/|$)|\.env(?:\.|\/|$)|(?:secret|secrets|credential|credentials|private|id_rsa|id_ed25519)(?:[._/-]|$)|[^/]+\.(?:pem|key|p12|pfx)$)/i;
const BLOCKED_PATH = /(^|\/)(?:\.forge|node_modules|vendor|dist|build|coverage|\.next|cache|\.cache|\.pnpm-store)(?:\/|$)/i;

// Creates a read-only, project-scoped directory walker with auditable execution.
export function createSearchTreeTool({ projectRoot, logger = createRuntimeLogger({ logEvent }) } = {}) {
  if (typeof projectRoot !== "string" || !isAbsolute(projectRoot)) throw invalidInput("search_tree requires an absolute project root.");
  return Object.freeze({ name: "search_tree", execute });

  // Returns a bounded breadth-first tree so top-level structure remains visible when truncated.
  async function execute(input = {}, context = {}) {
    const started = Date.now();
    let options;
    try {
      authorizeTool("search_tree", context);
      options = parseInput(input, projectRoot);
      await assertDirectoryPath(projectRoot, options.path);
    } catch (error) {
      emit("forge.search_tree_rejected", "failed", context, { error_code: error.code ?? "SEARCH_TREE_INPUT_INVALID", error: error.message, duration_ms: Date.now() - started });
      throw error;
    }
    emit("forge.search_tree_started", "started", context, { path: options.path, flags: options.flags });
    try {
      const result = await walk(projectRoot, options);
      emit("forge.search_tree_completed", "success", context, { path: options.path, count: result.entries.length, truncated: result.truncated, duration_ms: Date.now() - started });
      return result;
    } catch (error) {
      emit("forge.search_tree_failed", "failed", context, { path: options.path, error_code: error.code ?? "SEARCH_TREE_FAILED", error: error.message, duration_ms: Date.now() - started });
      throw error;
    }
  }

  // Sends tool lifecycle details through the project's structured runtime log.
  function emit(eventName, status, context, payload) {
    logger.emit({ event_name: eventName, level: status === "failed" ? "error" : "info", status,
      message: `search_tree ${status}.`, task_id: context?.task_id ?? context?.taskId ?? "SEARCH-TREE-UNSCOPED",
      correlation_id: context?.correlation_id, source: "search-tree-tool",
      ...(payload.error_code ? { error_code: payload.error_code } : {}),
      payload: { agent_id: context?.agent_identity?.agent_id, execution_id: context?.execution_id, ...payload } });
  }
}

// Accepts only a project directory and bounded flags; agent input cannot widen ignore behavior.
function parseInput(input, root) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["path", "flags"].includes(key))) throw invalidInput("search_tree accepts only path and flags.");
  const requestedPath = input.path ?? ".";
  if (typeof requestedPath !== "string" || requestedPath.includes("\0") || requestedPath.split(/[\\/]/).includes("..")) throw invalidInput("search_tree path must stay inside the project. Use '.' for the project root.");
  const path = requestedPath === "" || requestedPath === "/" ? "." : requestedPath;
  const normalized = relative(root, isAbsolute(path) ? resolve(path) : resolve(root, path));
  if (normalized.startsWith(`..${sep}`) || normalized === ".." || isAbsolute(normalized) || PRIVATE_PATH.test(normalized.replaceAll(sep, "/")) || BLOCKED_PATH.test(normalized.replaceAll(sep, "/"))) throw invalidInput("search_tree path is private or outside the project.");
  const flags = input.flags ?? [];
  if (!Array.isArray(flags) || flags.some((flag) => typeof flag !== "string")) throw invalidInput("search_tree flags must be an array of strings.");
  let maxDepth = 2, maxEntries = 200, dirsOnly = false;
  const seen = new Set();
  for (const flag of flags) {
    const name = flag.split("=")[0];
    if (seen.has(name)) throw invalidInput("search_tree flags must not repeat.");
    seen.add(name);
    if (flag === "--dirs-only") dirsOnly = true;
    else if (/^--max-depth=[1-6]$/.test(flag)) maxDepth = Number(flag.split("=")[1]);
    else if (/^--max-entries=[1-9]\d*$/.test(flag) && Number(flag.split("=")[1]) <= 500) maxEntries = Number(flag.split("=")[1]);
    else throw invalidInput("search_tree received an unsupported flag.");
  }
  return { path: normalized || ".", flags, maxDepth, maxEntries, dirsOnly };
}

// Rejects symlinks or ignored/private ancestors before reading a requested subtree.
async function assertDirectoryPath(root, path) {
  let current = root;
  const pieces = path === "." ? [] : path.split(sep);
  for (const piece of pieces) {
    current = join(current, piece);
    const relativePath = relative(root, current).split(sep).join("/");
    if (PRIVATE_PATH.test(relativePath) || BLOCKED_PATH.test(relativePath) || (await ignoredPaths(root, [relativePath])).has(relativePath)) throw invalidInput("search_tree path is ignored or private.");
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalidInput("search_tree path must be a real project directory.");
  }
}

// Enumerates visible entries directly, preserving empty directories and sorting each level.
async function walk(root, options) {
  const entries = [];
  const queue = [{ path: options.path, depth: 0 }];
  while (queue.length) {
    const parent = queue.shift();
    if (parent.depth >= options.maxDepth) continue;
    const parentPath = resolve(root, parent.path);
    const parentStat = await lstat(parentPath);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw invalidInput("search_tree directory changed during traversal.");
    const children = await readdir(parentPath, { withFileTypes: true });
    const candidates = children.filter((child) => !child.isSymbolicLink() && (child.isDirectory() || child.isFile()))
      .map((child) => ({ child, path: join(parent.path, child.name).split(sep).join("/") }))
      .filter((entry) => !PRIVATE_PATH.test(entry.path) && !BLOCKED_PATH.test(entry.path));
    const ignored = await ignoredPaths(root, candidates.map((entry) => entry.path));
    candidates.sort((left, right) => Number(right.child.isDirectory()) - Number(left.child.isDirectory()) || left.child.name.localeCompare(right.child.name));
    for (const candidate of candidates) {
      if (ignored.has(candidate.path)) continue;
      const directory = candidate.child.isDirectory();
      if (directory && parent.depth + 1 < options.maxDepth) queue.push({ path: candidate.path, depth: parent.depth + 1 });
      if (directory || !options.dirsOnly) {
        if (entries.length >= options.maxEntries) return treeResult(options.path, entries, true);
        entries.push({ path: candidate.path, type: directory ? "directory" : "file", depth: parent.depth + 1 });
      }
    }
  }
  return treeResult(options.path, entries, false);
}

// Renders a ready-to-use directory tree alongside structured entries for agent replies.
function treeResult(root, entries, truncated) {
  const children = new Map();
  for (const entry of entries) {
    const parent = dirname(entry.path);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(entry);
  }
  const lines = [root === "." ? "." : `${root}/`];
  // Places each listed child under its real parent with tree connectors.
  function render(parent, prefix) {
    const siblings = children.get(parent) ?? [];
    siblings.forEach((entry, index) => {
      const last = index === siblings.length - 1;
      lines.push(`${prefix}${last ? "└── " : "├── "}${entry.path.split("/").at(-1)}${entry.type === "directory" ? "/" : ""}`);
      if (entry.type === "directory") render(entry.path, `${prefix}${last ? "    " : "│   "}`);
    });
  }
  render(root, "");
  return { root, entries, tree: lines.join("\n"), truncated };
}

// Uses Git's ignore engine, including nested .gitignore files and tracked ignored paths.
function ignoredPaths(root, paths) {
  if (!paths.length) return Promise.resolve(new Set());
  return new Promise((resolveResult, reject) => {
    const child = spawn("git", ["check-ignore", "--no-index", "-z", "--stdin"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    const output = [], errors = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => code === 0 || code === 1
      ? resolveResult(new Set(Buffer.concat(output).toString("utf8").split("\0").filter(Boolean)))
      : reject(new ConfigurationError(`search_tree ignore check failed: ${Buffer.concat(errors).toString("utf8").slice(0, 300)}`)));
    child.stdin.end(`${paths.join("\0")}\0`);
  });
}

// Gives invalid paths and flags a stable, loggable tool error code.
function invalidInput(message) {
  const error = new ConfigurationError(message);
  error.code = "SEARCH_TREE_INPUT_INVALID";
  return error;
}
