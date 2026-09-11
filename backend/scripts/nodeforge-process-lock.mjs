import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function acquireProcessLock(dataDir, role, { fileService } = {}) {
  const path = join(dataDir, `.nodeforge-${role}.lock`);
  if (fileService?.createLockSync) {
    const relative = path.startsWith(`${process.cwd()}/`) ? path.slice(process.cwd().length + 1) : path;
    try {
      const lock = fileService.createLockSync({ path: relative });
      return Object.freeze({ path, release: lock.release });
    } catch (error) {
      if (error.code !== "FILE_LOCK_EXISTS") throw error;
      // A crashed startup can leave a lock behind. Reclaim it only when the
      // recorded owner is definitely gone; a live owner remains protected.
      let ownerPid = null;
      try { ownerPid = Number.parseInt(readFileSync(path, "utf8").trim(), 10); } catch {}
      if (Number.isInteger(ownerPid) && ownerPid > 0) {
        try { process.kill(ownerPid, 0); } catch (probe) {
          if (probe.code === "ESRCH") {
            try { unlinkSync(path); } catch (removeError) { if (removeError.code !== "ENOENT") throw removeError; }
            const retry = fileService.createLockSync({ path: relative });
            return Object.freeze({ path, release: retry.release });
          }
        }
      }
      throw new Error(`${role} process already running (lock: ${path}).`);
    }
  }
  let fd;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const pid = Number(readFileSync(path, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); } catch (probe) {
        if (probe.code === "ESRCH") { unlinkSync(path); fd = openSync(path, "wx"); }
      }
    }
    if (fd === undefined) throw new Error(`${role} process already running (lock: ${path}).`);
  }
  writeFileSync(fd, `${process.pid}\n`);
  closeSync(fd);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { unlinkSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
  };
  return Object.freeze({ path, release });
}
