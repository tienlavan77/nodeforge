import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createExecutionResult } from "../execution-layer.js";

export async function backupFile(filePath, options = {}) {
  const startedAt = Date.now();
  try {
    const content = await readFile(filePath, "utf8");
    const backupRef = join(process.cwd(), ".forge", "runtime", "backup", randomUUID(), basename(filePath));
    if (options?.fileService?.atomicCreate) {
      const relative = backupRef.slice(process.cwd().length + 1);
      await options.fileService.atomicCreate({ path: relative, content });
    } else {
      await mkdir(join(backupRef, ".."), { recursive: true });
      await writeFile(backupRef, content, "utf8");
    }
    return createExecutionResult({ stepName: "backupFile", success: true, detail: { backup_ref: backupRef }, durationMs: Date.now() - startedAt });
  } catch (error) {
    if (error?.code === "ENOENT") return createExecutionResult({ stepName: "backupFile", success: false, errorCode: "IO_ERROR", errorMessage: `Source file not found: ${filePath}`, detail: { file_path: filePath, file_missing: true }, durationMs: Date.now() - startedAt });
    return createExecutionResult({ stepName: "backupFile", success: false, errorCode: "IO_ERROR", errorMessage: error.message, durationMs: Date.now() - startedAt });
  }
}

export async function rollbackFile(filePath, backupRef) {
  const startedAt = Date.now();
  try {
    const content = await readFile(backupRef, "utf8");
    await writeFile(filePath, content, "utf8");
    return createExecutionResult({ stepName: "rollbackFile", success: true, detail: { file_path: filePath, backup_ref: backupRef }, durationMs: Date.now() - startedAt });
  } catch (error) {
    return createExecutionResult({ stepName: "rollbackFile", success: false, errorCode: "IO_ERROR", errorMessage: error.message, durationMs: Date.now() - startedAt });
  }
}
