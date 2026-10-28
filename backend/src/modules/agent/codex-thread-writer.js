// Prevents owner retries from resuming a Codex session while another runner still owns it.
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { ForgeError } from "../../shared/errors.js";

// Reports a live session owner without deleting SDK locks or replaying project mutations.
export function assertCodexThreadAvailable(codexHome, threadId, procRoot = "/proc", { requireIdle = false } = {}) {
  if (requireIdle && process.platform !== "linux") throw new ForgeError("Cannot confirm Codex process termination on this platform.", { code: "EXECUTION_SESSION_UNAVAILABLE" });
  if (!threadId && !requireIdle || process.platform !== "linux") return;
  const writerPath = join(resolve(codexHome), "thread-writer-locks", `${threadId}.lock`);
  for (const pid of readProc(() => readdirSync(procRoot), [], requireIdle)) {
    if (!/^\d+$/.test(pid)) continue;
    const processPath = join(procRoot, pid);
    const args = readProc(() => readFileSync(join(processPath, "cmdline"), "utf8"), "").split("\0");
    if (basename(args[0] || "") !== "codex" || !args.includes("exec")) continue;
    const environment = readProc(() => readFileSync(join(processPath, "environ"), "utf8"), "", requireIdle).split("\0");
    if (!environment.includes(`CODEX_HOME=${codexHome}`)) continue;
    const resumeIndex = args.indexOf("resume");
    const resuming = resumeIndex >= 0 && args.slice(resumeIndex + 1).includes(threadId);
    const holdsWriter = readProc(() => readdirSync(join(processPath, "fd")), [])
      .some((fd) => readProc(() => readlinkSync(join(processPath, "fd", fd)), "") === writerPath);
    if (requireIdle || resuming || holdsWriter) throw codexThreadBusyError(threadId);
  }
}

// Returns a recoverable conflict instead of suggesting a second writer or a fresh session.
export function codexThreadBusyError(threadId, cause) {
  const error = new ForgeError(`Codex session ${threadId ?? "requested"} is still owned by another runner. Wait for it to stop, then Continue the same execution.`, { code: "EXECUTION_SESSION_BUSY", cause });
  error.statusCode = 409;
  return error;
}

// Tolerates disappearing or inaccessible processes while keeping unexpected probe failures visible.
function readProc(read, fallback, strict = false) {
  try { return read(); }
  catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code) || !strict && ["EACCES", "EPERM"].includes(error.code)) return fallback;
    throw error;
  }
}
