import { readFile, writeFile } from "node:fs/promises";
import { backupFile as createBackup } from "./backup.js";
import { createExecutionResult } from "../execution-layer.js";

/** Apply the small apply_patch dialect emitted by some coding agents. */
export async function applyApplyPatch(filePath, patchText, options = {}) {
  const startedAt = Date.now();
  let original;
  try { original = await readFile(filePath, "utf8"); }
  catch (error) { return result({ success: false, errorCode: "IO_ERROR", errorMessage: error.message }); }
  try {
    const updated = applyPatch(original, patchText, filePath);
    if (options.dry_run === true) return result({ success: true, detail: { file_path: filePath, dry_run: true, content: updated } });
    const backup = await (options.backupFile ?? ((path) => createBackup(path, { fileService: options?.fileService })))(filePath);
    if (!backup?.success) return backup;
    if (options?.fileService?.atomicWrite) await options.fileService.atomicWrite({ path: filePath, content: updated, replace: true });
    else await writeFile(filePath, updated, "utf8");
    return result({ success: true, detail: { file_path: filePath, backup_ref: backup.detail?.backup_ref } });
  } catch (error) { return result({ success: false, errorCode: "PATCH_NOT_APPLICABLE", errorMessage: error.message, detail: { file_path: filePath } }); }

  function result(values) { return createExecutionResult({ stepName: "applyApplyPatch", durationMs: Date.now() - startedAt, ...values }); }
}

function applyPatch(original, text, expectedPath) {
  const lines = String(text ?? "").replaceAll("\r\n", "\n").split("\n");
  if (lines[0]?.trim() !== "*** Begin Patch" || lines.at(-1)?.trim() !== "*** End Patch") throw new Error("apply_patch must be wrapped by *** Begin Patch and *** End Patch.");
  const update = lines.findIndex((line) => line.startsWith("*** Update File: "));
  if (update < 0) throw new Error("apply_patch requires *** Update File:.");
  const path = lines[update].slice("*** Update File: ".length).trim();
  if (path !== expectedPath && path.replace(/^a\//, "") !== expectedPath) throw new Error(`Patch file ${path} does not match ${expectedPath}.`);
  const rows = lines.slice(update + 1, lines.findIndex((line, index) => index > update && line.startsWith("*** End Patch")));
  const hunks = [];
  let current = null;
  for (const line of rows) {
    if (line.startsWith("@@")) { current = []; hunks.push(current); continue; }
    if (!current) continue;
    if (!line || ![" ", "+", "-"].includes(line[0])) throw new Error("Invalid apply_patch hunk line; include context, +, or - rows.");
    current.push({ type: line[0], text: line.slice(1) });
  }
  if (!hunks.length) throw new Error("apply_patch contains no hunks.");
  const source = original.split("\n");
  if (source.at(-1) === "") source.pop();
  for (const hunk of hunks) {
    const context = hunk.filter((row) => row.type !== "+").map((row) => row.text);
    if (!context.length) throw new Error("apply_patch hunk has additions only; include at least one context line to locate insertion.");
    let position = -1;
    for (let i = 0; i <= source.length - context.length; i += 1) if (context.every((line, index) => source[i + index] === line)) { position = i; break; }
    if (position < 0) throw new Error("apply_patch context does not match the current file.");
    let cursor = position;
    const replacement = [];
    for (const row of hunk) { if (row.type === "+") replacement.push(row.text); else { if (source[cursor] !== row.text) throw new Error("apply_patch context mismatch."); if (row.type === " ") replacement.push(source[cursor]); cursor += 1; } }
    source.splice(position, context.length, ...replacement);
  }
  return source.join("\n") + (original.endsWith("\n") ? "\n" : "");
}
