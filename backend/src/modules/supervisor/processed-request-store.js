import { ConfigurationError } from "../../shared/errors.js";
export function createProcessedRequestStore({ fileService, root = ".forge/runtime/supervisor-processed" } = {}) {
  if (typeof fileService?.readFile !== "function" || typeof fileService?.atomicWrite !== "function") throw new ConfigurationError("Processed request store requires File Service.");
  return Object.freeze({ get, save });
  async function get(requestId) { try { return JSON.parse(await fileService.readFile({ path: `${root}/${safe(requestId)}.json` })); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
  async function save(requestId, event) { await fileService.atomicWrite({ path: `${root}/${safe(requestId)}.json`, content: `${JSON.stringify(event)}\n`, replace: true }); return event; }
}
function safe(value) { if (typeof value !== "string" || !/^[A-Za-z0-9._:-]+$/.test(value)) throw new ConfigurationError("Request ID contains unsafe characters."); return value; }
