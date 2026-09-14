import { ConfigurationError } from "../../shared/errors.js";

const MAX_RECENT_FILES = 4;

/** Read-only projection of the Code Index for stream snapshots. */
export function createWatcherSnapshotService({ indexDb, maxFiles = MAX_RECENT_FILES } = {}) {
  if (typeof indexDb?.all !== "function") throw new ConfigurationError("Watcher Snapshot requires the Code Index database.");
  if (!Number.isInteger(maxFiles) || maxFiles < 2 || maxFiles > MAX_RECENT_FILES) throw new ConfigurationError("Watcher Snapshot maxFiles must be between 2 and 4.");

  return Object.freeze({ recentFiles, recentEvents, snapshot });

  function recentFiles() {
    return indexDb.all(
      `SELECT path, language, size_bytes, sha256, indexed_at
       FROM files
       WHERE indexed_at IS NOT NULL
       ORDER BY indexed_at DESC
       LIMIT ${maxFiles}`
    ).slice(0, maxFiles).map(normalizeFile);
  }

  function snapshot() {
    return Object.freeze({ watcher: Object.freeze({ recent_events: recentEvents() }) });
  }

  function recentEvents() {
    return recentFiles().map((file) => ({
      event_id: `SNAPSHOT-${file.path}-${file.indexed_at}`,
      event_type: "watcher.file_indexed",
      timestamp: file.indexed_at,
      payload: {
        ...file,
        operation: "indexer.updated",
        activity: activityFor("watcher.file_indexed", file.path)
      }
    }));
  }
}

function activityFor(eventType, path) {
  return [
    `Filesystem change: ${path}`,
    `Watcher event: ${eventType} ${path}`,
    `Indexer updated: ${path}`
  ];
}

function normalizeFile(file = {}) {
  return Object.freeze({
    path: file.path,
    language: file.language ?? null,
    size_bytes: file.size_bytes ?? null,
    sha256: file.sha256 ?? null,
    indexed_at: file.indexed_at
  });
}
