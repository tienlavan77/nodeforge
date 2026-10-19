// Releases inactive ticket file ownership, including orphan claims, without discarding source or resumable work.
import { createHash } from "node:crypto";
import { acquireTicketFileLock } from "./ticket-file-lock.js";

// Maps project, ticket and path identities to the same lock and storage keys used by the change ledger.
const key = (value) => createHash("sha256").update(value).digest("hex");

// Applies an authorized release under ledger-compatible locks after checking execution and incomplete mutations.
export async function releaseInactiveTicketClaims({ projectId, taskId, fileService, isExecutionActive, close = false, projectLogger = () => {} }) {
  if (!projectId || !/^[A-Za-z0-9._:-]+$/.test(taskId ?? "") || typeof isExecutionActive !== "function"
    || !fileService?.listFiles || !fileService?.createLock) throw new Error("Inactive claim release requires project identity, persistence and execution fencing.");
  const scope = `.forge/runtime/ticket-changes/${key(projectId)}`;
  const journalPath = `${scope}/tickets/${key(taskId)}.json`;
  const ticketLock = await acquireTicketFileLock(fileService, `${scope}/locks/${key(`ticket:${taskId}`)}.lock`);
  try {
    let manifest = null;
    try {
      manifest = JSON.parse(await fileService.readFile({ path: journalPath }));
      if (!manifest || manifest.project_id !== projectId || manifest.task_id !== taskId || !manifest.entries) throw new Error("Inactive claim journal has an invalid identity.");
    }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (await isExecutionActive(taskId)) return { status: "deferred", reason: "active_execution", task_id: taskId, paths: [] };
    if (manifest?.pending_commit || Object.values(manifest?.entries ?? {}).some((entry) => entry.pending)) {
      return { status: "deferred", reason: "pending_mutation", task_id: taskId, paths: [] };
    }
    const candidates = [];
    for (const path of await fileService.listFiles({ glob: `${scope}/claims/*.json` })) {
      let claim;
      try { claim = JSON.parse(await fileService.readFile({ path })); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (!claim || typeof claim.path !== "string" || !claim.path || !/^[A-Za-z0-9._:-]+$/.test(claim.task_id ?? "")
        || Object.hasOwn(claim, "claim_id") && (typeof claim.claim_id !== "string" || !claim.claim_id)
        || path !== `${scope}/claims/${key(claim.path)}.json`) throw new Error("Inactive file claim has an invalid identity.");
      if (claim.task_id === taskId) candidates.push({ path, claim });
    }
    if (await isExecutionActive(taskId)) return { status: "deferred", reason: "active_execution", task_id: taskId, paths: [] };
    const paths = [];
    for (const candidate of candidates) {
      const pathLock = await acquireTicketFileLock(fileService, `${scope}/locks/${key(`path:${candidate.claim.path}`)}.lock`);
      try {
        if (await isExecutionActive(taskId)) return { status: "deferred", reason: "active_execution", task_id: taskId, paths };
        let current;
        try { current = JSON.parse(await fileService.readFile({ path: candidate.path })); }
        catch (error) { if (error.code === "ENOENT") continue; throw error; }
        if (current?.task_id !== taskId || current.claim_id !== candidate.claim.claim_id) continue;
        if (current.path !== candidate.claim.path) throw new Error("Inactive file claim changed its path identity.");
        await fileService.deleteFile({ path: candidate.path });
        paths.push(current.path);
      } finally { await pathLock.release(); }
    }
    const closing = close && manifest && manifest.state !== "closed";
    if (closing) await fileService.atomicWrite({ path: journalPath, content: JSON.stringify({ ...manifest, state: "closed" }), replace: true });
    if (!paths.length && !closing) return { status: "unchanged", task_id: taskId, paths };
    projectLogger({ event_name: "ticket.file_claims_released", level: "info", status: "success", task_id: taskId,
      source: "ticket-inactive-claims", message: "Inactive ticket claims released; source and journal history preserved.",
      payload: { path_count: paths.length, resumable: !close } });
    return { status: "released", task_id: taskId, paths };
  } finally { await ticketLock.release(); }
}
