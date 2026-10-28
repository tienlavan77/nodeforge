// Summary: Persists and queries file identity rows (path, hash, language, size) in the Code Index database.
import { createFileId } from "../../shared/file-identity.js";

// Defines createFileRepository function behavior for file-repository.js.
export function createFileRepository(database, { createId = createFileId, now = () => new Date().toISOString() } = {}) {
  return Object.freeze({
    // Defines insert method behavior for file-repository.js.
    insert(path, { language = null, sha256 = null, sizeBytes = null } = {}) {
      const fileId = createId();
      database.run(
        "INSERT INTO files (file_id, path, language, sha256, size_bytes, indexed_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET language = excluded.language, sha256 = excluded.sha256, size_bytes = excluded.size_bytes, indexed_at = excluded.indexed_at",
        [fileId, path, language, sha256, sizeBytes, now()]
      );
      return database.all("SELECT file_id FROM files WHERE path = ?", [path])[0]?.file_id ?? fileId;
    },
    // Defines rename method behavior for file-repository.js.
    rename(fileId, path) {
      const result = database.run("UPDATE files SET path = ?, indexed_at = ? WHERE file_id = ?", [path, now(), fileId]);
      return result.changes > 0;
    },
    // Defines updateHash method behavior for file-repository.js.
    updateHash(fileId, sha256, sizeBytes = undefined, language = undefined) {
      const result = sizeBytes === undefined
        ? database.run("UPDATE files SET sha256 = ?, indexed_at = ? WHERE file_id = ?", [sha256, now(), fileId])
        : language === undefined
          ? database.run("UPDATE files SET sha256 = ?, size_bytes = ?, indexed_at = ? WHERE file_id = ?", [sha256, sizeBytes, now(), fileId])
          : database.run("UPDATE files SET sha256 = ?, size_bytes = ?, language = ?, indexed_at = ? WHERE file_id = ?", [sha256, sizeBytes, language, now(), fileId]);
      return result.changes > 0;
    },
    // Defines findById method behavior for file-repository.js.
    findById(fileId) {
      return database.all("SELECT file_id, path, language, sha256, size_bytes, indexed_at FROM files WHERE file_id = ?", [fileId])[0] ?? null;
    },
    // Defines findByPath method behavior for file-repository.js.
    findByPath(path) {
      return database.all("SELECT file_id, path, language, sha256, size_bytes, indexed_at FROM files WHERE path = ?", [path])[0] ?? null;
    },
    // Defines remove method behavior for file-repository.js.
    remove(fileId) {
      return database.run("DELETE FROM files WHERE file_id = ?", [fileId]).changes > 0;
    }
  });
}
