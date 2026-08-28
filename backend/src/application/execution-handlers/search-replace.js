import { readFile, writeFile } from "node:fs/promises";
import { backupFile as createBackup } from "./backup.js";
import { createExecutionResult } from "../execution-layer.js";

export async function applySearchReplaceBlock(filePath, oldStr, newStr, options = {}) {
  const startedAt = Date.now();
  const dryRun = options?.dry_run === true;
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    return result({ success: false, errorCode: "IO_ERROR", errorMessage: error.message });
  }

  const matches = countMatches(content, oldStr);
  if (matches === 0) return result({ success: false, errorCode: "NO_MATCH", errorMessage: "The search string was not found." });
  if (matches >= 2) return result({ success: false, errorCode: "AMBIGUOUS_MATCH", errorMessage: `The search string matched ${matches} times.` });

  const updated = content.replace(oldStr, newStr);
  if (!dryRun) {
    const backup = await (options?.backupFile ?? createBackup)(filePath);
    if (!backup?.success) return backup;
    try {
      await writeFile(filePath, updated, "utf8");
      return result({
        success: true,
        detail: { file_path: filePath, dry_run: false, match_count: matches, old_length: oldStr.length, new_length: newStr.length, bytes_changed: Buffer.byteLength(updated) - Buffer.byteLength(content), backup_ref: backup.detail?.backup_ref }
      });
    } catch (error) {
      return result({ success: false, errorCode: "IO_ERROR", errorMessage: error.message, detail: { backup_ref: backup.detail?.backup_ref } });
    }
  }
  return result({
    success: true,
    detail: { file_path: filePath, dry_run: dryRun, match_count: matches, old_length: oldStr.length, new_length: newStr.length, bytes_changed: Buffer.byteLength(updated) - Buffer.byteLength(content) }
  });

  function result(values) {
    return createExecutionResult({ stepName: "applySearchReplaceBlock", durationMs: Date.now() - startedAt, ...values });
  }
}

function countMatches(content, search) {
  if (search.length === 0) return content.length + 1;
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(search, offset)) !== -1) {
    count += 1;
    offset += search.length;
  }
  return count;
}
