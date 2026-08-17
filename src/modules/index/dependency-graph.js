import { isAbsolute, posix, relative } from "node:path";

export function createDependencyGraph({ database, files, projectRoot } = {}) {
  return Object.freeze({
    resolve: resolveImport,
    replaceForFile(fileId, sourcePath, imports) {
      database.run("DELETE FROM dependency_edges WHERE source_file_id = ?", [fileId]);
      for (const item of imports) {
        const targetFileId = resolveImport(sourcePath, item.source, item.external);
        if (!targetFileId) continue;
        database.run(
          "INSERT OR IGNORE INTO dependency_edges (source_file_id, target_file_id, kind, is_broken) VALUES (?, ?, ?, 0)",
          [fileId, targetFileId, item.kind]
        );
      }
    },
    markTargetBroken(fileId) {
      database.run("UPDATE dependency_edges SET is_broken = 1 WHERE target_file_id = ?", [fileId]);
    }
  });

  function resolveImport(sourcePath, source, external) {
    if (!source || external) return null;
    const targetPath = isAbsolute(source)
      ? relative(projectRoot, source).split(/\\/).join("/")
      : posix.normalize(posix.join(posix.dirname(sourcePath), source));
    return files.findByPath(targetPath)?.file_id ?? null;
  }
}
