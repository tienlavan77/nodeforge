import { ConfigurationError } from "../../shared/errors.js";
export function createFileQueueStore({ fileService, root = ".forge/runtime/supervisor-queues" } = {}) {
  if (typeof fileService?.readFile !== "function" || typeof fileService?.atomicWrite !== "function") throw new ConfigurationError("File queue store requires File Service.");
  return Object.freeze({ list, save });
  async function list(name) { try { return JSON.parse(await fileService.readFile({ path: `${root}/${safe(name)}.json` })); } catch (error) { if (error?.code === "ENOENT") return []; throw error; } }
  async function save(name, item) { const entries = await list(name); const index = entries.findIndex((entry) => entry.id === item.id); if (index < 0) entries.push(structuredClone(item)); else entries[index] = structuredClone(item); await fileService.atomicWrite({ path: `${root}/${safe(name)}.json`, content: `${JSON.stringify(entries)}\n`, replace: true }); return item; }
}
function safe(value) { if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/.test(value)) throw new ConfigurationError("Queue name contains unsafe characters."); return value; }
