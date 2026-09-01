import { ConfigurationError } from "../../shared/errors.js";

/** Finds newly-created files that have no indexed importer yet. */
export function createUnwiredFileChecker({ fileGraph } = {}) {
  if (typeof fileGraph?.getImporters !== "function") throw new ConfigurationError("Unwired-file checker requires File Graph getImporters.");
  return Object.freeze({ checkUnwiredFiles });

  function checkUnwiredFiles(filesChanged = []) {
    if (!Array.isArray(filesChanged)) throw new ConfigurationError("filesChanged must be an array.");
    const candidates = filesChanged.filter((file) => file && file.action === "created" && typeof file.path === "string" && file.path);
    return Object.freeze(candidates.flatMap((file) => {
      const importedBy = readImporters(file.path);
      return importedBy.length ? [] : [{ path: file.path, status: "unwired", imported_by: [] }];
    }));
  }

  function readImporters(path) {
    try {
      const result = fileGraph.getImporters(path);
      const nodes = Array.isArray(result?.nodes) ? result.nodes : [];
      return nodes.filter((node) => node?.path && node.path !== path).map((node) => node.path);
    } catch (error) {
      if (/not found|indexed/i.test(error?.message ?? "")) return [];
      throw error;
    }
  }
}
