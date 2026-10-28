// Coordinates atomic dual-endpoint file moves and crash recovery for the ticket change ledger.
// Ensures that source deletion and destination creation are journaled, claimed, and recovered together
// under deterministic path-lock ordering so crashes or injected write failures never leave orphan state.
import { randomUUID } from "node:crypto";

// Creates the recoverable move transaction and move-aware recovery helpers for TicketChangeLedger.
// Enforces BOTH_PATHS_COUNTED by recording distinct source and destination ledger entries while
// restoring or completing interrupted dual-endpoint moves deterministically on recovery.
export function createTicketLedgerMove({ locked, load, save, claim, claimPath, readOptional, fileService, reconcile, sha, key, failure, projectLogger, recoverSingle }) {
  return Object.freeze({ recover, move });

  // Orders two project-relative paths deterministically to prevent lock-acquisition deadlocks during moves.
  async function withOrderedPathLocks(firstPath, secondPath, action) {
    const [first, second] = [firstPath, secondPath].sort();
    return locked(`path:${first}`, () => locked(`path:${second}`, action));
  }

  // Recovers a pending single-path write or a coordinated dual-endpoint move transaction on a manifest entry.
  async function recover(taskId, path, manifest) {
    const pending = manifest.entries[path]?.pending;
    if (!pending) return manifest;
    if (!pending.move_partner) return recoverSingle(taskId, path, manifest);
    const partnerPath = pending.move_partner;
    return locked(`path:${partnerPath}`, () => recoverMoveLocked(taskId, path, manifest));
  }

  // Recovers a pending operation while the caller already holds locks on both move endpoints.
  async function recoverInMove(taskId, path, lockedFrom, lockedTo, manifest) {
    const pending = manifest.entries[path]?.pending;
    if (!pending) return manifest;
    if (!pending.move_partner) return recoverSingle(taskId, path, manifest);
    const partner = pending.move_partner;
    if (partner === lockedFrom || partner === lockedTo) return recoverMoveLocked(taskId, path, manifest);
    return locked(`path:${partner}`, () => recoverMoveLocked(taskId, path, manifest));
  }

  // Reconciles both endpoints of an interrupted move while holding locks on both paths.
  async function recoverMoveLocked(taskId, path, manifest) {
    const pending = manifest.entries[path]?.pending;
    if (!pending) return manifest;
    if (!pending.move_partner) return recoverSingle(taskId, path, manifest);
    const fromPath = pending.move_role === "source" ? path : pending.move_partner;
    const toPath = pending.move_role === "destination" ? path : pending.move_partner;
    const fromEntry = manifest.entries[fromPath];
    const toEntry = manifest.entries[toPath];
    const fromPending = fromEntry?.pending;
    const toPending = toEntry?.pending;
    if (!fromPending || !toPending) return recoverSingle(taskId, path, manifest);
    const liveFrom = await readOptional(fromPath);
    const liveTo = await readOptional(toPath);
    const fromSha = sha(liveFrom);
    const toSha = sha(liveTo);
    const expectedFromBefore = fromPending.recovery_before_sha ?? fromPending.before_sha;
    const expectedToBefore = toPending.recovery_before_sha ?? toPending.before_sha;
    if (fromSha === null && toSha === toPending.after_sha) {
      completeMoveEntries(manifest, fromEntry, toEntry, fromPending, toPending);
      await save(taskId, manifest);
      return manifest;
    }
    if (fromSha === expectedFromBefore && toSha === toPending.after_sha) {
      await fileService.deleteFile({ path: fromPath });
      completeMoveEntries(manifest, fromEntry, toEntry, fromPending, toPending);
      await save(taskId, manifest);
      return manifest;
    }
    if (fromSha === expectedFromBefore && toSha === expectedToBefore) {
      await revertAbortedMove(taskId, manifest, fromPath, toPath);
      await save(taskId, manifest);
      return manifest;
    }
    throw failure("TICKET_WRITE_RECOVERY_CONFLICT", `Root source changed while recovering move ${fromPath} -> ${toPath}.`);
  }

  // Finalizes both source and destination ledger operations when a move completes or recovers forward.
  function completeMoveEntries(manifest, fromEntry, toEntry, fromPending, toPending) {
    const { move_partner: _fp, move_role: _fr, ...cleanFrom } = fromPending;
    const { move_partner: _tp, move_role: _tr, ...cleanTo } = toPending;
    fromEntry.operations.push({ ...cleanFrom, revision: manifest.revision + 1, status: "completed" });
    fromEntry.latest_sha = cleanFrom.after_sha;
    fromEntry.pending = null;
    toEntry.operations.push({ ...cleanTo, revision: manifest.revision + 2, status: "completed" });
    toEntry.latest_sha = cleanTo.after_sha;
    toEntry.pending = null;
    manifest.revision += 2;
  }

  // Cleans up newly created ledger entries and claims when a prepared move is aborted before touching disk.
  async function revertAbortedMove(taskId, manifest, fromPath, toPath) {
    for (const target of [fromPath, toPath]) {
      const entry = manifest.entries[target];
      if (!entry) continue;
      entry.pending = null;
      if (!entry.operations.length) {
        delete manifest.entries[target];
        if ((await claim(target))?.task_id === taskId) {
          try { await fileService.deleteFile({ path: claimPath(target) }); }
          catch (error) { if (error.code !== "ENOENT") throw error; }
        }
      }
    }
  }

  // Executes an atomic dual-endpoint file move through the ticket change ledger with full rollback on failure.
  async function move({ taskId, fromPath, toPath, before, operationId } = {}) {
    if (!taskId || typeof fromPath !== "string" || !fromPath || typeof toPath !== "string" || !toPath || fromPath === toPath || typeof before !== "string") {
      throw failure("TICKET_WRITE_INVALID", "Ticket move requires task, distinct fromPath and toPath, and source content.");
    }
    const baseId = operationId ?? key(`move\0${taskId}\0${fromPath}\0${toPath}\0${sha(before)}`);
    return locked(`ticket:${taskId}`, () => withOrderedPathLocks(fromPath, toPath, async () => {
      let manifest = await load(taskId);
      if (manifest.state === "closed") throw failure("TICKET_CHANGE_CLOSED", `Ticket ${taskId} has already integrated its changes.`);
      if (manifest.entries[fromPath]?.pending) manifest = await recoverInMove(taskId, fromPath, fromPath, toPath, manifest);
      if (manifest.entries[toPath]?.pending) manifest = await recoverInMove(taskId, toPath, fromPath, toPath, manifest);
      const fromOwned = await claim(fromPath);
      if (fromOwned?.task_id !== undefined && fromOwned.task_id !== taskId) throw failure("FILE_CLAIM_CONFLICT", `${fromPath} is owned by ticket ${fromOwned.task_id}.`);
      const toOwned = await claim(toPath);
      if (toOwned?.task_id !== undefined && toOwned.task_id !== taskId) throw failure("FILE_CLAIM_CONFLICT", `${toPath} is owned by ticket ${toOwned.task_id}.`);
      const existingFrom = manifest.entries[fromPath];
      const existingTo = manifest.entries[toPath];
      const fromOpId = key(`${baseId}\0from`);
      const toOpId = key(`${baseId}\0to`);
      const repeatedFrom = existingFrom?.operations.find((item) => item.id === fromOpId);
      const repeatedTo = existingTo?.operations.find((item) => item.id === toOpId);
      if (repeatedFrom && repeatedTo) {
        const liveFrom = await readOptional(fromPath);
        const liveTo = await readOptional(toPath);
        if (existingFrom.latest_sha === null && sha(liveFrom) === null && existingTo.latest_sha === sha(before) && sha(liveTo) === sha(before)) {
          if (!fromOwned) await fileService.atomicWrite({ path: claimPath(fromPath), content: JSON.stringify({ task_id: taskId, path: fromPath, claim_id: existingFrom.claim_id ?? randomUUID() }), replace: false });
          if (!toOwned) await fileService.atomicWrite({ path: claimPath(toPath), content: JSON.stringify({ task_id: taskId, path: toPath, claim_id: existingTo.claim_id ?? randomUUID() }), replace: false });
          return { from_path: fromPath, to_path: toPath, sha256: sha(before), repeated: true };
        }
        if (operationId) throw failure("TICKET_OPERATION_CONFLICT", `Ticket move ID was reused after source changed: ${fromPath} -> ${toPath}.`);
      }
      const liveFrom = await readOptional(fromPath);
      if (sha(liveFrom) !== sha(before)) throw failure("CHECKSUM_MISMATCH", `Root source changed before moving ${fromPath}.`);
      const liveTo = await readOptional(toPath);
      if (liveTo !== null) throw failure("FILE_ALREADY_EXISTS", `Destination file already exists: ${toPath}.`);
      if (existingFrom && existingFrom.latest_sha !== sha(liveFrom)) await reconcile.resolve({ taskId, path: fromPath, manifest, live: liveFrom });
      if (existingTo && existingTo.latest_sha !== sha(liveTo)) await reconcile.resolve({ taskId, path: toPath, manifest, live: liveTo });
      const fromOwner = fromOwned ?? { task_id: taskId, path: fromPath, claim_id: existingFrom?.claim_id ?? randomUUID() };
      const toOwner = toOwned ?? { task_id: taskId, path: toPath, claim_id: existingTo?.claim_id ?? randomUUID() };
      const acquiredClaims = [];
      try {
        if (!fromOwned) { await fileService.atomicWrite({ path: claimPath(fromPath), content: JSON.stringify(fromOwner), replace: false }); acquiredClaims.push(fromPath); }
        if (!toOwned) { await fileService.atomicWrite({ path: claimPath(toPath), content: JSON.stringify(toOwner), replace: false }); acquiredClaims.push(toPath); }
      } catch (error) {
        for (const claimed of acquiredClaims) {
          // eslint-disable-next-line no-silent-catch -- Best-effort claim rollback when move claim acquisition fails.
          try { await fileService.deleteFile({ path: claimPath(claimed) }); } catch { /* best-effort claim rollback */ }
        }
        throw error;
      }
      const nextFromId = repeatedFrom ? key(`${fromOpId}\0${manifest.revision + 1}`) : fromOpId;
      const nextToId = repeatedTo ? key(`${toOpId}\0${manifest.revision + 2}`) : toOpId;
      const fromEntry = existingFrom ?? { path: fromPath, claim_id: fromOwner.claim_id ?? null, initial_sha: sha(before), initial_content: before, latest_sha: sha(before), operations: [], pending: null };
      const toEntry = existingTo ?? { path: toPath, claim_id: toOwner.claim_id ?? null, initial_sha: null, initial_content: null, latest_sha: null, operations: [], pending: null };
      const fromOp = { id: nextFromId, before_sha: sha(before), after_sha: null, before, after: null, move_partner: toPath, move_role: "source" };
      const toOp = { id: nextToId, before_sha: null, after_sha: sha(before), before: null, after: before, move_partner: fromPath, move_role: "destination" };
      fromEntry.pending = fromOp;
      toEntry.pending = toOp;
      manifest.entries[fromPath] = fromEntry;
      manifest.entries[toPath] = toEntry;
      await save(taskId, manifest);
      let wroteDestination = false;
      try {
        await fileService.atomicWrite({ path: toPath, content: before, replace: false });
        wroteDestination = true;
        await fileService.deleteFile({ path: fromPath });
      } catch (error) {
        if (wroteDestination) {
          try { await fileService.deleteFile({ path: toPath }); }
          catch (cleanupError) { if (cleanupError.code !== "ENOENT") projectLogger({ event_name: "ticket.change_move_rollback_failed", level: "error", status: "failed", message: "Ticket move destination rollback failed.", task_id: taskId, source: "ticket-change-ledger", error_code: cleanupError.code ?? "FILE_DELETE_FAILED", payload: { from_path: fromPath, to_path: toPath } }); }
        }
        await revertAbortedMove(taskId, manifest, fromPath, toPath);
        await save(taskId, manifest);
        projectLogger({ event_name: "ticket.change_write_failed", level: "error", status: "failed", message: "Ticket root move failed.", task_id: taskId, source: "ticket-change-ledger", error_code: error.code ?? "FILE_MOVE_FAILED", payload: { from_path: fromPath, to_path: toPath } });
        throw error;
      }
      completeMoveEntries(manifest, fromEntry, toEntry, fromOp, toOp);
      await save(taskId, manifest);
      projectLogger({ event_name: "ticket.change_written", level: "info", status: "success", message: "Ticket moved project source.", task_id: taskId, source: "ticket-change-ledger", payload: { from_path: fromPath, to_path: toPath, revision: manifest.revision, sha256: toEntry.latest_sha } });
      return { from_path: fromPath, to_path: toPath, sha256: toEntry.latest_sha, revision: manifest.revision, moved: true };
    }));
  }
}
