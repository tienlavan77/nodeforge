// Recovers abandoned ticket locks so a Control API restart can resume file ownership work.
import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";

// Acquires a File Service lock, removing only locks whose recorded process is gone.
export async function acquireTicketFileLock(fileService, path, { attempts = 100 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await fileService.createLock({ path, content: `${process.pid}:${randomUUID()}\n` }); }
    catch (error) {
      if (error.code !== "FILE_LOCK_EXISTS") throw error;
      if (await isAbandoned(fileService, path)) {
        const recovery = await acquireTicketFileLock(fileService, `${path}.recovery`, { attempts });
        try {
          if (await isAbandoned(fileService, path)) {
            try { await fileService.deleteFile({ path }); }
            catch (cleanupError) { if (cleanupError.code !== "ENOENT") throw cleanupError; }
          }
        } finally { await recovery.release(); }
        continue;
      }
      if (attempt === attempts - 1) throw Object.assign(new ConfigurationError(`Ticket operation lock is busy: ${path}.`), { code: "FILE_CLAIM_BUSY" });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw Object.assign(new ConfigurationError(`Ticket operation lock could not be acquired: ${path}.`), { code: "FILE_CLAIM_BUSY" });
}

// Treats a lock as abandoned only when its owner PID no longer exists.
async function isAbandoned(fileService, path) {
  let content;
  try { content = await fileService.readFile({ path }); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  const pid = Number(content.split(":", 1)[0]);
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === "ESRCH") return true; if (error.code === "EPERM") return false; throw error; }
}
