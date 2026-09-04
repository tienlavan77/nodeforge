import { ConfigurationError } from "../../shared/errors.js";
export function createSupervisorStateStore({ fileService, root = ".forge/runtime/supervisors" } = {}) {
  if (typeof fileService?.readFile !== "function" || typeof fileService?.atomicWrite !== "function") throw new ConfigurationError("Supervisor state store requires File Service.");
  return Object.freeze({ save, get, list });
  async function save(state) { await fileService.atomicWrite({ path: `${root}/${safe(state.supervisor_id)}.json`, content: `${JSON.stringify(state)}\n`, replace: true }); return state; }
  async function get(id) { try { return JSON.parse(await fileService.readFile({ path: `${root}/${safe(id)}.json` })); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
  async function list() { if (typeof fileService.listFiles !== "function") return []; const paths = await fileService.listFiles({ glob: `${root}/*.json` }); const out=[]; for (const path of paths) { try { out.push(JSON.parse(await fileService.readFile({ path }))); } catch (error) { if (error?.code !== "ENOENT") throw error; } } return out; }
}
function safe(value) { if (typeof value !== "string" || !/^[A-Za-z0-9._:-]+$/.test(value)) throw new ConfigurationError("Supervisor ID contains unsafe characters."); return value; }
