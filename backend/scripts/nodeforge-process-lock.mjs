import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function acquireProcessLock(dataDir, role) {
  const path = join(dataDir, `.nodeforge-${role}.lock`);
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
