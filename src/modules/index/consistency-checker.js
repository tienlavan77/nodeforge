import { randomUUID } from "node:crypto";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";

import { rebuildIndex } from "./index-rebuild.js";

export function createIndexConsistencyChecker({ projectRoot, projectId, database, ignore = [], emit = () => {}, rebuild = rebuildIndex } = {}) {
  return Object.freeze({
    async check() {
      const missingPaths = [];
      for (const { path } of database.all("SELECT path FROM files")) {
        try {
          await access(join(projectRoot, path), constants.F_OK);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          missingPaths.push(path);
        }
      }
      if (missingPaths.length === 0) return { consistent: true, missingPaths };

      emit({
        event_id: `IDX-${randomUUID()}`,
        type: "index.inconsistent",
        project_id: projectId,
        timestamp: new Date().toISOString(),
        payload: { missing_paths: missingPaths }
      });
      const result = await rebuild({ projectRoot, database, ignore });
      return { consistent: false, missingPaths, rebuilt: result.indexedFiles };
    }
  });
}
