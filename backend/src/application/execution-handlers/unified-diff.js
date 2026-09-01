import { readFile, writeFile } from "node:fs/promises";
import { backupFile as createBackup } from "./backup.js";
import { createExecutionResult } from "../execution-layer.js";

export async function applyUnifiedDiff(filePath, diffText, options = {}) {
  const startedAt = Date.now();
  const dryRun = options?.dry_run === true;
  let original;
  try {
    original = await readFile(filePath, "utf8");
  } catch (error) {
    return result({ success: false, errorCode: "IO_ERROR", errorMessage: error.message });
  }

  let updated;
  try {
    updated = applyPatch(original, diffText);
  } catch (error) {
    return result({ success: false, errorCode: "PATCH_NOT_APPLICABLE", errorMessage: error.message, detail: { file_path: filePath } });
  }
  if (dryRun) return result({ success: true, detail: { file_path: filePath, dry_run: true, content: updated } });

  const backup = await (options?.backupFile ?? ((path) => createBackup(path, { fileService: options?.fileService })))(filePath);
  if (!backup?.success) return backup;
  try {
    if (options?.fileService?.atomicWrite) await options.fileService.atomicWrite({ path: filePath, content: updated, replace: true });
    else await writeFile(filePath, updated, "utf8");
    return result({ success: true, detail: { file_path: filePath, backup_ref: backup.detail?.backup_ref } });
  } catch (error) {
    return result({ success: false, errorCode: "IO_ERROR", errorMessage: error.message, detail: { backup_ref: backup.detail?.backup_ref } });
  }

  function result(values) { return createExecutionResult({ stepName: "applyUnifiedDiff", durationMs: Date.now() - startedAt, ...values }); }
}

function applyPatch(original, diffText) {
  if (typeof diffText !== "string" || !diffText.trim()) throw new Error("Unified diff is empty.");
  const source = splitLines(original);
  const lines = diffText.replaceAll("\r\n", "\n").split("\n");
  const hunks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!header) continue;
    const hunk = { oldStart: Number(header[1]), oldCount: Number(header[2] ?? 1), newStart: Number(header[3]), newCount: Number(header[4] ?? 1), rows: [] };
    index += 1;
    while (index < lines.length && !lines[index].startsWith("@@ ")) {
      const line = lines[index];
      if (line === "" && index === lines.length - 1) { index += 1; continue; }
      if (line.startsWith("\\ No newline at end of file") || line === "---" || line === "+++") { index += 1; continue; }
      if (!line || ![" ", "+", "-"].includes(line[0])) throw new Error(`Invalid unified diff line ${index + 1}.`);
      hunk.rows.push({ type: line[0], text: line.slice(1) });
      index += 1;
    }
    hunks.push(hunk);
    index -= 1;
  }
  if (hunks.length === 0) throw new Error("Unified diff contains no hunks.");

  let offset = 0;
  for (const hunk of hunks) {
    const position = hunk.oldStart - 1 + offset;
    if (position < 0 || position > source.length) throw new Error(`Hunk location ${hunk.oldStart} is outside the file.`);
    let cursor = position;
    let consumed = 0;
    for (const row of hunk.rows) {
      if (row.type === "+") continue;
      if (source[cursor] !== row.text) throw new Error(`Hunk context mismatch at line ${cursor + 1}: expected ${JSON.stringify(row.text)}, found ${JSON.stringify(source[cursor])}.`);
      cursor += 1;
      consumed += 1;
    }
    let sourceCursor = position;
    const replacement = [];
    for (const row of hunk.rows) {
      if (row.type === "+") replacement.push(row.text);
      else if (row.type === " ") replacement.push(source[sourceCursor++]);
      else sourceCursor += 1;
    }
    source.splice(position, consumed, ...replacement);
    offset += hunk.newCount - hunk.oldCount;
  }
  return joinLines(source, original.endsWith("\n"));
}

function splitLines(content) { const lines = content.split("\n"); if (lines.at(-1) === "") lines.pop(); return lines; }
function joinLines(lines, trailingNewline) { return lines.join("\n") + (trailingNewline ? "\n" : ""); }
