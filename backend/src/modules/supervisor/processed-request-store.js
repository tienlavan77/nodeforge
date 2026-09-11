import { ConfigurationError } from "../../shared/errors.js";
export function createProcessedRequestStore({ fileService, root = ".forge/runtime/supervisor-processed" } = {}) {
  if (typeof fileService?.readFile !== "function" || typeof fileService?.atomicWrite !== "function") throw new ConfigurationError("Processed request store requires File Service.");
  return Object.freeze({ get, save, claim });
  async function get(requestId) { try { return JSON.parse(await fileService.readFile({ path: `${root}/${safe(requestId)}.json` })); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
  async function save(requestId, event) { await fileService.atomicWrite({ path: `${root}/${safe(requestId)}.json`, content: `${JSON.stringify(event)}\n`, replace: true }); return event; }
  async function claim(requestId, operation = "default") {
    const key = `${safe(requestId)}-${safe(operation)}`; const path = `${root}/claims/${key}.json`; const lockPath = `${root}/claims/lock-${key}.lock`;
    for (;;) { try { const lock = await fileService.createLock({ path: lockPath }); try { try { await fileService.readFile({ path }); return false; } catch (error) { if (error?.code !== "ENOENT") throw error; } await fileService.atomicWrite({ path, content: `${JSON.stringify({ request_id: requestId, operation, claimed_at: new Date().toISOString() })}\n`, replace: false }); return true; } finally { await lock.release().catch(() => {}); } } catch (error) { if (error?.code !== "FILE_LOCK_EXISTS") throw error; await new Promise((resolve) => setTimeout(resolve, 10)); } }
  }
}
function safe(value) { if (typeof value !== "string" || !/^[A-Za-z0-9._:-]+$/.test(value)) throw new ConfigurationError("Request ID contains unsafe characters."); return value; }
