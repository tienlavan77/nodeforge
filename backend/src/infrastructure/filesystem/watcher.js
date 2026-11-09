// Wraps chokidar to watch the project filesystem while filtering default, gitignore, project-configured, and custom ignored paths.
import chokidar from "chokidar";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import picomatch from "picomatch";

import { ConfigurationError } from "../../shared/errors.js";

export const DEFAULT_WATCHER_IGNORE = Object.freeze([
  ".forge/**",
  // Node Control keeps SQLite, logs, and conversation state outside the source tree.
  // Watching it creates a feedback loop: indexing the WAL writes verification events,
  // which grow the WAL and trigger another verification run.
  ".node-control/**",
  "node_modules/**",
  "vendor/**",
  "agent-tool/**",
  ".pnpm-store/**",
  ".git/**",
  "dist/**",
  "output/**",
  "outputs/**",
  ".next/**",
  // Ignore Next.js stale build directories created during interrupted dev runs.
  "**/.next.stale-*/**",
  "coverage/**",
  "**/.DS_Store",
  "**/*.tmp-*"
]);

const RAW_EVENTS = ["add", "change", "unlink"];

// Converts a single .gitignore rule into equivalent picomatch patterns relative to the project root.
// Business purpose: prevents code indexing, comment normalization, and file watching from scanning build artifacts, release bundles, or runtime directories excluded by a project's `.gitignore`.
// Technical description: strips comments and leading slashes, skips negation rules, and expands directory or path rules into both direct and `/**` subtree globs.
function gitignoreLineToGlobs(rawLine) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#") || line.startsWith("!")) return [];
  const anchored = line.startsWith("/");
  const directoryOnly = line.endsWith("/");
  const body = line.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!body) return [];
  if (directoryOnly) {
    return anchored || body.includes("/") ? [body, `${body}/**`] : [body, `${body}/**`, `**/${body}`, `**/${body}/**`];
  }
  if (anchored || body.includes("/")) {
    return [body, `${body}/**`];
  }
  return [body, `**/${body}`, `${body}/**`, `**/${body}/**`];
}

// Reads ignore globs from a project's `.gitignore` and `.forge/runtime/project.json` (`watch.ignore`).
// Business purpose: automatically honors repository ignore rules and per-project watch settings during indexing and watching without requiring global environment variables.
// Technical description: synchronously reads `.gitignore` and `.forge/runtime/project.json` when present on disk and returns normalized glob strings.
function loadProjectIgnoreGlobs(root) {
  if (typeof root !== "string" || !root) return [];
  const extra = [];
  try {
    const gitignoreText = readFileSync(join(root, ".gitignore"), "utf8");
    for (const line of gitignoreText.split(/\r?\n/)) {
      extra.push(...gitignoreLineToGlobs(line));
    }
    // eslint-disable-next-line no-silent-catch -- Missing or unreadable .gitignore is optional for non-Git project roots.
  } catch { /* Optional .gitignore */ }
  try {
    const projectMeta = JSON.parse(readFileSync(join(root, ".forge", "runtime", "project.json"), "utf8"));
    const configured = projectMeta?.watch?.ignore;
    if (Array.isArray(configured)) {
      for (const item of configured) {
        if (typeof item === "string" && item.trim()) extra.push(...gitignoreLineToGlobs(item));
      }
    }
    // eslint-disable-next-line no-silent-catch -- Missing or partial project.json before admission completes is expected.
  } catch { /* Optional project.json */ }
  return extra;
}

// Creates a chokidar-backed watcher that emits add/change/unlink events after applying ignored-path filtering.
export function createFilesystemWatcher({ root, ignore = [], chokidarOptions = {} } = {}) {
  if (typeof root !== "string" || root.length === 0) {
    throw new ConfigurationError("A project root is required for filesystem watching.");
  }
  if (!Array.isArray(ignore) || ignore.some((pattern) => typeof pattern !== "string" || pattern.length === 0)) {
    throw new ConfigurationError("watcher ignore must be an array of non-empty patterns.");
  }

  const events = new EventEmitter();
  const ignored = [...DEFAULT_WATCHER_IGNORE, ...ignore];
  const matchesIgnoredPath = createProjectIgnoreMatcher(root, ignore);
  const watcher = chokidar.watch(root, { ...chokidarOptions, followSymlinks: false, ignored: matchesIgnoredPath });

  for (const event of RAW_EVENTS) {
    watcher.on(event, (path) => events.emit(event, path));
  }
  watcher.on("ready", () => events.emit("ready"));
  watcher.on("error", (error) => {
    if (events.listenerCount("error")) events.emit("error", error);
    else console.error("Project filesystem watcher failed.", error);
  });

  return Object.freeze({
    ignored: Object.freeze(ignored),
    // Defines on method behavior for watcher.js.
    on(event, listener) {
      events.on(event, listener);
      return this;
    },
    // Defines once method behavior for watcher.js.
    once(event, listener) {
      events.once(event, listener);
      return this;
    },
    // Defines off method behavior for watcher.js.
    off(event, listener) {
      events.off(event, listener);
      return this;
    },
    // Defines close method behavior for watcher.js.
    close() {
      return watcher.close();
    }
  });
}

// Builds a predicate that returns true for paths matching default, gitignore, project-configured, or custom ignore globs relative to root.
export function createProjectIgnoreMatcher(root, ignore = []) {
  const discoveredPatterns = loadProjectIgnoreGlobs(root);
  const basePatterns = [...DEFAULT_WATCHER_IGNORE, ...ignore];
  // Match ignored directories at any depth (for example ui/nextjs/.next/**),
  // not only when they sit directly under the repository root.
  const expandedBase = basePatterns.flatMap((pattern) => {
    const normalized = pattern.replace(/^\.\//, "");
    return normalized.startsWith("**/") ? [normalized] : [normalized, `**/${normalized}`];
  });
  const isIgnored = picomatch([...new Set([...expandedBase, ...discoveredPatterns])], { dot: true });

  return (path) => {
    const relativePath = relative(root, path).split(sep).join("/");
    // Runtime/control data must never enter the project index, even when the watcher root is a parent directory.
    if (relativePath === ".forge" || relativePath.startsWith(".forge/") || relativePath === ".node-control" || relativePath.startsWith(".node-control/")) return true;
    return relativePath.length > 0 && isIgnored(relativePath);
  };
}
