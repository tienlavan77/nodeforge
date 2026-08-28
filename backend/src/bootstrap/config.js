import { resolve } from "node:path";

import { ConfigurationError } from "../shared/errors.js";
import { assertSeverity } from "../shared/logger.js";

export function loadConfig({ cwd = process.cwd(), env = process.env, overrides = {} } = {}) {
  const logLevel = overrides.logLevel ?? env.NODEFORGE_LOG_LEVEL ?? "info";
  const dataDir = overrides.dataDir ?? env.NODEFORGE_DATA_DIR ?? ".forge";
  const watcherIgnore = overrides.watcherIgnore ?? parseWatcherIgnore(env.NODEFORGE_WATCHER_IGNORE);
  const watcherDebounceMs = Number(overrides.watcherDebounceMs ?? env.NODEFORGE_WATCHER_DEBOUNCE_MS ?? 200);
  const watcherRenameWindowMs = Number(overrides.watcherRenameWindowMs ?? env.NODEFORGE_WATCHER_RENAME_WINDOW_MS ?? 500);

  assertSeverity(logLevel);
  if (typeof dataDir !== "string" || dataDir.length === 0) {
    throw new ConfigurationError("NODEFORGE_DATA_DIR must be a non-empty path.");
  }
  if (!Array.isArray(watcherIgnore) || watcherIgnore.some((pattern) => typeof pattern !== "string" || pattern.length === 0)) {
    throw new ConfigurationError("watcherIgnore must be an array of non-empty patterns.");
  }
  if (!Number.isInteger(watcherDebounceMs) || watcherDebounceMs < 100 || watcherDebounceMs > 300) {
    throw new ConfigurationError("watcherDebounceMs must be an integer from 100 to 300.");
  }
  if (!Number.isInteger(watcherRenameWindowMs) || watcherRenameWindowMs < 100) {
    throw new ConfigurationError("watcherRenameWindowMs must be an integer of at least 100.");
  }

  return Object.freeze({
    dataDir: resolve(cwd, dataDir),
    logLevel,
    watcherIgnore: Object.freeze([...watcherIgnore]),
    watcherDebounceMs,
    watcherRenameWindowMs
  });
}

function parseWatcherIgnore(value) {
  if (!value) return [];
  return value.split(",").map((pattern) => pattern.trim()).filter(Boolean);
}
