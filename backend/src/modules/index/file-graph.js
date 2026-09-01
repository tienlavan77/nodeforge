import { ConfigurationError } from "../../shared/errors.js";
import { createFileNode, createGraphEdge, createGraphQueryResult } from "./code-graph-contract.js";

/** Read-only file relationship queries over the Code Index tables. */
export function createFileGraph({ database } = {}) {
  if (!database || typeof database.all !== "function") throw new ConfigurationError("File Graph requires an index database.");

  return Object.freeze({ getImports, getImporters, getDependencies, getDependents });

  function getImports(path) {
    const file = requireFile(path);
    const rows = database.all(
      `SELECT target.file_id AS target_id, target.path AS target_path, target.language, target.sha256,
              rel.kind, rel.is_broken
       FROM imports_exports rel
       LEFT JOIN files target ON target.file_id = rel.related_file_id
       WHERE rel.file_id = ? ORDER BY target.path, rel.kind`, [file.file_id]
    );
    return resultFor(file, rows.map((row) => edgeAndNode(file, row, "out")));
  }

  function getImporters(path) {
    const file = requireFile(path);
    const rows = database.all(
      `SELECT source.file_id AS source_id, source.path AS source_path, source.language, source.sha256,
              rel.kind, rel.is_broken
       FROM imports_exports rel
       JOIN files source ON source.file_id = rel.file_id
       WHERE rel.related_file_id = ? ORDER BY source.path, rel.kind`, [file.file_id]
    );
    return resultFor(file, rows.map((row) => edgeAndNode(file, row, "in")));
  }

  function getDependencies(path, depth = 1) { return traverse(path, depth, false); }
  function getDependents(path, depth = 1) { return traverse(path, depth, true); }

  function traverse(path, depth, reverse) {
    const root = requireFile(path);
    assertDepth(depth);
    const nodes = [createFileNode(fileData(root))];
    const edges = [];
    const seen = new Set([root.file_id]);
    let frontier = [root];
    for (let level = 0; level < depth; level += 1) {
      const next = [];
      for (const source of frontier) {
        const rows = reverse ? importerRows(source.file_id) : dependencyRows(source.file_id);
        for (const row of rows) {
          const id = row.target_id ?? row.source_id;
          const targetPath = row.target_path ?? row.source_path;
          if (!targetPath) continue;
          edges.push(createGraphEdge({ from: reverse ? targetPath : source.path, to: reverse ? source.path : targetPath, kind: row.kind === "require" ? "require" : "dependency", broken: Boolean(row.is_broken) }));
          if (seen.has(id)) continue;
          seen.add(id);
          nodes.push(createFileNode({ fileId: id, path: targetPath, language: row.language, sha256: row.sha256 }));
          next.push({ file_id: id, path: targetPath });
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
    return createGraphQueryResult({ nodes, edges, indexVersion: indexVersion(), confidence: "static" });
  }

  function dependencyRows(fileId) {
    return database.all(`SELECT target.file_id AS target_id, target.path AS target_path, target.language, target.sha256, edge.kind, edge.is_broken FROM dependency_edges edge LEFT JOIN files target ON target.file_id = edge.target_file_id WHERE edge.source_file_id = ?`, [fileId]);
  }
  function importerRows(fileId) {
    return database.all(`SELECT source.file_id AS source_id, source.path AS source_path, source.language, source.sha256, edge.kind, edge.is_broken FROM dependency_edges edge JOIN files source ON source.file_id = edge.source_file_id WHERE edge.target_file_id = ?`, [fileId]);
  }
  function edgeAndNode(root, row, direction) {
    const targetPath = row.target_path ?? row.source_path;
    const targetId = row.target_id ?? row.source_id ?? null;
    const edge = targetPath ? createGraphEdge({ from: direction === "out" ? root.path : targetPath, to: direction === "out" ? targetPath : root.path, kind: row.kind === "require" ? "require" : row.kind === "export" ? "export" : "import", broken: Boolean(row.is_broken) }) : null;
    return { node: targetPath ? createFileNode({ fileId: targetId, path: targetPath, language: row.language, sha256: row.sha256 }) : null, edge };
  }
  function resultFor(root, pairs) { return createGraphQueryResult({ nodes: [createFileNode(fileData(root)), ...pairs.filter((pair) => pair.node).map((pair) => pair.node)], edges: pairs.filter((pair) => pair.edge).map((pair) => pair.edge), indexVersion: indexVersion(), confidence: "static" }); }
  function requireFile(path) { if (typeof path !== "string" || !path) throw new ConfigurationError("File Graph path is required."); const file = database.all("SELECT file_id, path, language, sha256, size_bytes FROM files WHERE path = ?", [path])[0]; if (!file) throw new ConfigurationError(`Indexed file not found: ${path}`); return file; }
  function fileData(file) { return { fileId: file.file_id, path: file.path, language: file.language, sha256: file.sha256, sizeBytes: file.size_bytes, indexVersion: indexVersion() }; }
  function indexVersion() { return `IDX-${database.all("SELECT version FROM index_metadata LIMIT 1")[0]?.version ?? 0}`; }
  function assertDepth(depth) { if (!Number.isInteger(depth) || depth < 0 || depth > 10) throw new ConfigurationError("File Graph depth must be an integer between 0 and 10."); }
}
