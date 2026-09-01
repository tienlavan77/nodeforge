import chokidar from "chokidar";
import { EventEmitter } from "node:events";
import { relative, sep } from "node:path";
import picomatch from "picomatch";

import { ConfigurationError } from "../../shared/errors.js";

export const DEFAULT_WATCHER_IGNORE = Object.freeze([
  ".forge/**",
  // Node Control keeps SQLite, logs, and conversation state outside the source tree.
  // Watching it creates a feedback loop: indexing the WAL writes verification events,
  // which grow the WAL and trigger another verification run.
  ".node-control/**",
  "node_modules/**",
  ".git/**",
  "dist/**",
  ".next/**",
  // Ignore Next.js stale build directories created during interrupted dev runs.
  "**/.next.stale-*/**",
  "coverage/**",
  "**/.DS_Store",
  "**/._*"
]);

const RAW_EVENTS = ["add", "change", "unlink"];

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
  const watcher = chokidar.watch(root, { ...chokidarOptions, ignored: matchesIgnoredPath });

  for (const event of RAW_EVENTS) {
    watcher.on(event, (path) => events.emit(event, path));
  }
  watcher.on("ready", () => events.emit("ready"));

  return Object.freeze({
    ignored: Object.freeze(ignored),
    on(event, listener) {
      events.on(event, listener);
      return this;
    },
    once(event, listener) {
      events.once(event, listener);
      return this;
    },
    off(event, listener) {
      events.off(event, listener);
      return this;
    },
    close() {
      return watcher.close();
    }
  });
}

export function createProjectIgnoreMatcher(root, ignore = []) {
  const patterns = [...DEFAULT_WATCHER_IGNORE, ...ignore];
  // Match ignored directories at any depth (for example ui/nextjs/.next/**),
  // not only when they sit directly under the repository root.
  const projectPatterns = patterns.flatMap((pattern) => {
    const normalized = pattern.replace(/^\.\//, "");
    return normalized.startsWith("**/") ? [normalized] : [normalized, `**/${normalized}`];
  });
  const isIgnored = picomatch(projectPatterns, { dot: true });

  return (path) => {
    const relativePath = relative(root, path).split(sep).join("/");
    return relativePath.length > 0 && isIgnored(relativePath);
  };
}
