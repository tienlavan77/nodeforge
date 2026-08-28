import { writeFile } from "node:fs/promises";
import { backupFile as createBackup } from "./backup.js";
import { createExecutionResult } from "../execution-layer.js";

export async function applyFullFileReplace(filePath, newContent, options = {}) {
  const startedAt = Date.now();
  const dryRun = options?.dry_run === true;
  if (typeof newContent !== "string") {
    return result({ success: false, errorCode: "IO_ERROR", errorMessage: "newContent must be a string." });
  }
  if (dryRun) {
    return result({ success: true, detail: { file_path: filePath, dry_run: true, operation: "overwrite", new_bytes: Buffer.byteLength(newContent) } });
  }

  const backup = await (options?.backupFile ?? createBackup)(filePath);
  if (!backup?.success) return backup;
  try {
    await writeFile(filePath, newContent, "utf8");
    return result({ success: true, detail: { file_path: filePath, backup_ref: backup.detail?.backup_ref, new_bytes: Buffer.byteLength(newContent) } });
  } catch (error) {
    return result({ success: false, errorCode: "IO_ERROR", errorMessage: error.message, detail: { backup_ref: backup.detail?.backup_ref } });
  }

  function result(values) {
    return createExecutionResult({ stepName: "applyFullFileReplace", durationMs: Date.now() - startedAt, ...values });
  }
}
