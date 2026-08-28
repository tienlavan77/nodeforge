import { createFileId } from "../../shared/file-identity.js";

export function createFileRepository(database, { createId = createFileId, now = () => new Date().toISOString() } = {}) {
  return Object.freeze({
    insert(path, { language = null, sha256 = null, sizeBytes = null } = {}) {
      const fileId = createId();
      database.run(
        "INSERT INTO files (file_id, path, language, sha256, size_bytes, indexed_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET language = excluded.language, sha256 = excluded.sha256, size_bytes = excluded.size_bytes, indexed_at = excluded.indexed_at",
        [fileId, path, language, sha256, sizeBytes, now()]
      );
      return database.all("SELECT file_id FROM files WHERE path = ?", [path])[0]?.file_id ?? fileId;
    },
    rename(fileId, path) {
      const result = database.run("UPDATE files SET path = ?, indexed_at = ? WHERE file_id = ?", [path, now(), fileId]);
      return result.changes > 0;
    },
    updateHash(fileId, sha256) {
      const result = database.run("UPDATE files SET sha256 = ?, indexed_at = ? WHERE file_id = ?", [sha256, now(), fileId]);
      return result.changes > 0;
    },
    findById(fileId) {
      return database.all("SELECT file_id, path, language, sha256, size_bytes, indexed_at FROM files WHERE file_id = ?", [fileId])[0] ?? null;
    },
    findByPath(path) {
      return database.all("SELECT file_id, path, language, sha256, size_bytes, indexed_at FROM files WHERE path = ?", [path])[0] ?? null;
    },
    remove(fileId) {
      return database.run("DELETE FROM files WHERE file_id = ?", [fileId]).changes > 0;
    }
  });
}
