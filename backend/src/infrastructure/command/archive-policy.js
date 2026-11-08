// Business purpose: Enforces path containment, symlink escape prevention, and Zip Slip inspection for Node Archive Service operations (zip and unzip).
// Technical description: Resolves archive and target paths inside projectRoot, checks symlinks along every path segment, and inspects zip entries using the caller's remaining deadline and AbortSignal before extraction.

import { isAbsolute, normalize, resolve } from "node:path";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  assertNoSymlinkEscape,
  commandError,
  isProtectedInternalSegment,
  resolveProjectContainedPath
} from "./command-policy.js";

// Business purpose: Validates zip and unzip archive paths and entries so archives cannot read/write outside projectRoot or perform Zip Slip attacks.
// Technical description: Resolves archive and target paths inside projectRoot, checks symlinks, and inspects zip entries using the caller's remaining deadline and AbortSignal.
export const MAX_UNZIP_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_UNZIP_ENTRY_COUNT = 2000;

export async function validateArchiveOperation(command, args, cwdAbsolute, projectRoot, runProcess, { remainingTimeoutMs, signal } = {}) {
  if (command === "zip") {
    const pathArgs = args.filter((arg) => !arg.startsWith("-"));
    if (pathArgs.length < 2) throw commandError("COMMAND_ARCHIVE_INVALID", "zip requires an output archive path and at least one input path inside projectRoot.");
    for (const rawTarget of pathArgs) {
      const resolved = resolveProjectContainedPath(projectRoot, resolve(cwdAbsolute, rawTarget), { forbidProtected: true, label: "zip path" });
      await assertNoSymlinkEscape(projectRoot, resolved.absolutePath);
    }
    return;
  }
  if (command === "unzip") {
    const isListOnly = args.includes("-l") || args.includes("-Z") || args.includes("-Z1");
    let archiveArg = null;
    let targetDirAbs = cwdAbsolute;
    for (let i = 0; i < args.length; i += 1) {
      const token = args[i];
      if (token === "-d" || token.startsWith("-d")) {
        const rawDir = token === "-d" ? args[i + 1] : (token.startsWith("-d=") ? token.slice(3) : token.slice(2));
        if (!rawDir) throw commandError("COMMAND_ARCHIVE_INVALID", "unzip -d requires a target directory inside projectRoot.");
        targetDirAbs = resolveProjectContainedPath(projectRoot, isAbsolute(rawDir) ? rawDir : resolve(cwdAbsolute, rawDir), { forbidProtected: true, label: "unzip target_dir" }).absolutePath;
        if (token === "-d") i += 1;
      } else if (!token.startsWith("-") && !archiveArg) {
        archiveArg = token;
      }
    }
    if (!archiveArg) throw commandError("COMMAND_ARCHIVE_INVALID", "unzip requires an archive file path inside projectRoot.");
    const resolvedArchive = resolveProjectContainedPath(projectRoot, resolve(cwdAbsolute, archiveArg), { forbidProtected: true, label: "unzip archive" });
    await assertNoSymlinkEscape(projectRoot, resolvedArchive.absolutePath);
    await assertNoSymlinkEscape(projectRoot, targetDirAbs);
    if (!isListOnly) {
      // Business purpose: Computes the remaining timeout budget for archive preflight listing commands.
      // Technical description: Caps preflight execution at 15 seconds or the remaining command deadline and throws COMMAND_TIMEOUT when expired.
      const preflightTimeout = () => {
        const left = typeof remainingTimeoutMs === "function" ? remainingTimeoutMs() : (remainingTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
        if (left <= 0) throw commandError("COMMAND_TIMEOUT", "Command exceeded timeout before archive inspection completed.");
        return Math.min(left, 15_000);
      };
      const listRes = await runProcess("unzip", ["-Z1", resolvedArchive.absolutePath], { cwd: cwdAbsolute, timeoutMs: preflightTimeout(), signal });
      if (listRes.exitCode !== 0) throw commandError("COMMAND_ARCHIVE_INVALID", `Failed to inspect archive entries before extraction: ${listRes.stderr || "invalid zip archive"}`);
      if (listRes.truncated) {
        throw commandError("COMMAND_ARCHIVE_TOO_LARGE", "Zip Bomb protection: archive entry listing exceeded stream limit and was truncated.");
      }
      const entries = listRes.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (entries.length > MAX_UNZIP_ENTRY_COUNT) {
        throw commandError("COMMAND_ARCHIVE_TOO_LARGE", `Zip Bomb protection: archive entry count (${entries.length}) exceeds limit (${MAX_UNZIP_ENTRY_COUNT}).`);
      }
      for (const entryName of entries) {
        if (isAbsolute(entryName) || entryName.startsWith("/") || entryName.startsWith("\\")) {
          throw commandError("COMMAND_ZIP_SLIP_FORBIDDEN", `Zip Slip detected: archive entry has absolute path '${entryName}'.`);
        }
        const normalizedEntry = normalize(entryName).replace(/\\/g, "/");
        if (normalizedEntry === ".." || normalizedEntry.startsWith("../") || normalizedEntry.includes("/../") || isProtectedInternalSegment(normalizedEntry)) {
          throw commandError("COMMAND_ZIP_SLIP_FORBIDDEN", `Zip Slip or protected path detected in archive entry '${entryName}'.`);
        }
        const destAbs = resolve(targetDirAbs, entryName);
        resolveProjectContainedPath(projectRoot, destAbs, { forbidProtected: true, label: "archive entry" });
        await assertNoSymlinkEscape(projectRoot, destAbs);
      }
      const verboseRes = await runProcess("unzip", ["-Z", "-l", resolvedArchive.absolutePath], { cwd: cwdAbsolute, timeoutMs: preflightTimeout(), signal });
      if (verboseRes.exitCode !== 0) {
        throw commandError("COMMAND_ARCHIVE_INVALID", `Failed to inspect archive metadata before extraction: ${verboseRes.stderr || "invalid zip metadata"}`);
      }
      if (verboseRes.truncated) {
        throw commandError("COMMAND_ARCHIVE_TOO_LARGE", "Zip Bomb protection: archive verbose metadata listing exceeded stream limit and was truncated.");
      }
      if (/^l[rwx-]{9}/m.test(verboseRes.stdout)) {
        throw commandError("COMMAND_ZIP_SLIP_FORBIDDEN", "Archive contains symbolic link entries, which are forbidden during unzip extraction.");
      }
      let totalUncompressedBytes = 0;
      for (const line of verboseRes.stdout.split(/\r?\n/)) {
        const entryMatch = line.match(/^\s*[-d][rwxstST-]{9}\s+\S+\s+\S+\s+(\d+)\s+/);
        if (entryMatch) totalUncompressedBytes += Number.parseInt(entryMatch[1], 10);
        const summaryMatch = line.match(/^\s*\d+\s+files?,\s+(\d+)\s+bytes\s+uncompressed/i);
        if (summaryMatch) totalUncompressedBytes = Math.max(totalUncompressedBytes, Number.parseInt(summaryMatch[1], 10));
      }
      if (totalUncompressedBytes > MAX_UNZIP_TOTAL_BYTES) {
        throw commandError("COMMAND_ARCHIVE_TOO_LARGE", `Zip Bomb protection: total uncompressed size (${totalUncompressedBytes} bytes) exceeds limit (${MAX_UNZIP_TOTAL_BYTES} bytes).`);
      }
    }
  }
}
