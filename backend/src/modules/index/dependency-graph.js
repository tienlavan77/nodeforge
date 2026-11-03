// Summary: Maintains dependency_edges for the Code Index by resolving imports to file IDs and marking broken targets.
import { isAbsolute, posix, relative } from "node:path";

// Defines createDependencyGraph function behavior for dependency-graph.js.
export function createDependencyGraph({ database, files, projectRoot } = {}) {
  return Object.freeze({
    resolve: resolveImport,
    // Defines replaceForFile method behavior for dependency-graph.js.
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
    // Defines markTargetBroken method behavior for dependency-graph.js.
    markTargetBroken(fileId) {
      database.run("UPDATE dependency_edges SET is_broken = 1 WHERE target_file_id = ?", [fileId]);
    }
  });

  // Resolves relative or project-root imports, falling back from a pinned review snapshot path to its canonical project path when needed.
  function resolveImport(sourcePath, source, external) {
    if (!source || external) return null;
    const targetPath = isAbsolute(source)
      ? relative(projectRoot, source).split(/\\/).join("/")
      : posix.normalize(posix.join(posix.dirname(sourcePath), source));
    const directId = files.findByPath(targetPath)?.file_id ?? null;
    if (directId) return directId;
    const canonicalPath = targetPath.replace(/^\.forge\/runtime\/(?:tickets\/ticket-verification\/[^/]+\/snapshot|reports\/[^/]+-snapshot)\/[a-f0-9]{40,64}\//, "");
    return canonicalPath !== targetPath ? (files.findByPath(canonicalPath)?.file_id ?? null) : null;
  }
}
