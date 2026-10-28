// Summary: File-backed idempotency store that persists processed request events and supports atomic claim per operation.
import { statePath } from "../../infrastructure/filesystem/forge-paths.js";
import { ConfigurationError } from "../../shared/errors.js";
// Defines createProcessedRequestStore function behavior for processed-request-store.js.
export function createProcessedRequestStore({ fileService, root = statePath("supervisor-processed") } = {}) {
  if (typeof fileService?.readFile !== "function" || typeof fileService?.atomicWrite !== "function") throw new ConfigurationError("Processed request store requires File Service.");
  return Object.freeze({ get, save, claim });
  // Defines get function behavior for processed-request-store.js.
  async function get(requestId) { try { return JSON.parse(await fileService.readFile({ path: `${root}/${safe(requestId)}.json` })); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
  // Defines save function behavior for processed-request-store.js.
  async function save(requestId, event) { await fileService.atomicWrite({ path: `${root}/${safe(requestId)}.json`, content: `${JSON.stringify(event)}\n`, replace: true }); return event; }
  // Defines claim function behavior for processed-request-store.js.
  async function claim(requestId, operation = "default") {
    const key = `${safe(requestId)}-${safe(operation)}`; const path = `${root}/claims/${key}.json`; const lockPath = `${root}/claims/lock-${key}.lock`;
    for (;;) { try { const lock = await fileService.createLock({ path: lockPath }); try { try { await fileService.readFile({ path }); return false; } catch (error) { if (error?.code !== "ENOENT") throw error; } await fileService.atomicWrite({ path, content: `${JSON.stringify({ request_id: requestId, operation, claimed_at: new Date().toISOString() })}\n`, replace: false }); return true; } finally { // eslint-disable-next-line no-silent-catch -- Lock release is best-effort; claim result already decided.
await lock.release().catch(() => {}); } } catch (error) { if (error?.code !== "FILE_LOCK_EXISTS") throw error; await new Promise((resolve) => setTimeout(resolve, 10)); } }
  }
}
// Defines safe function behavior for processed-request-store.js.
function safe(value) { if (typeof value !== "string" || !/^[A-Za-z0-9._:-]+$/.test(value)) throw new ConfigurationError("Request ID contains unsafe characters."); return value; }
