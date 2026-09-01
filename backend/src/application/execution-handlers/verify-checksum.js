import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createExecutionResult } from "../execution-layer.js";

export async function verifyChecksum(filePath, expectedChecksum) {
  const startedAt = Date.now();
  let content;
  try {
    content = await readFile(filePath);
  } catch (error) {
    // A create operation uses the empty-file checksum before the file exists.
    // Treat that state as verified so the apply handler can create the file.
    const emptyChecksum = `sha256:${createHash("sha256").update("").digest("hex")}`;
    if (error?.code === "ENOENT" && expectedChecksum === emptyChecksum) {
      return createExecutionResult({ stepName: "verifyChecksum", success: true, detail: { file_path: filePath, file_missing: true }, durationMs: Date.now() - startedAt });
    }
    return createExecutionResult({ stepName: "verifyChecksum", success: false, errorCode: "IO_ERROR", errorMessage: error.message, durationMs: Date.now() - startedAt });
  }
  const actual = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  if (actual !== expectedChecksum) {
    return createExecutionResult({ stepName: "verifyChecksum", success: false, errorCode: "CHECKSUM_MISMATCH", errorMessage: "File checksum does not match.", detail: { expected: expectedChecksum, actual }, durationMs: Date.now() - startedAt });
  }
  return createExecutionResult({ stepName: "verifyChecksum", success: true, durationMs: Date.now() - startedAt });
}
