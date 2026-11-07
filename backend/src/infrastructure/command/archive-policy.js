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
      if (token === "-d" || token.startsWith("-d=")) {
        const rawDir = token === "-d" ? args[i + 1] : token.slice(3);
        if (!rawDir) throw commandError("COMMAND_ARCHIVE_INVALID", "unzip -d requires a target directory inside projectRoot.");
        targetDirAbs = resolveProjectContainedPath(projectRoot, resolve(cwdAbsolute, rawDir), { forbidProtected: true, label: "unzip target_dir" }).absolutePath;
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
      const entries = listRes.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
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
      if (verboseRes.exitCode === 0 && /^l[rwx-]{9}/m.test(verboseRes.stdout)) {
        throw commandError("COMMAND_ZIP_SLIP_FORBIDDEN", "Archive contains symbolic link entries, which are forbidden during unzip extraction.");
      }
    }
  }
}
