// Durable snapshot store for project lifecycle operations (O3 foundation).
// Business purpose: a Create/Add lifecycle request must be recoverable after lost responses,
// throttling or process restarts, so every state change is persisted as one atomic snapshot and
// retries are reconciled through the request key without ever creating a second operation for the
// same intent. Every published result must name the authority that publishes it, because a stale
// worker must never overwrite state a newer attempt already owns. Technical description: snapshots
// live at <root>/<sha256(requestKey)>.json written temp+rename; the complete read-validate-replace
// of every mutation is additionally serialized through the shared compare-and-swap directory lock
// (project-operation-lock.js), so two handles sharing one storage directory can never both replace
// the same revision and silently lose one accepted update. Attempt leases are separate wx-created
// .lock files whose presence fences attempts that still hold unreleased resources. Public
// transition requires an authority token: { attempt: N } is the execution token (N must equal the
// persisted attempt AND still hold its open lease) or { recovery: true } is the coordinator token
// for restart reconciliation and pre-claim bookkeeping. Attempt advancement stays exclusively in
// claimAttempt, so a patch can never change attempt directly. Terminal statuses may only be stored
// together with a result in the same snapshot write, so settlement is never half-applied.
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  OPERATION_ID_PREFIX, assertStageTransition, computeRequestFingerprint, validateOperationSnapshot
} from "./project-operation-contract.js";
import { withCasLock } from "./project-operation-lock.js";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

// Opens the operation store over one managed-storage directory; snapshots survive restart because
// all state lives in the files, not in process memory.
export async function createProjectOperationStore({ directory } = {}) {
  if (!directory) throw new Error("An explicit operation store directory is required.");
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  let tail = Promise.resolve();

  return Object.freeze({ register, load, loadByRequestKey, transition, claimAttempt, releaseAttempt, openAttempts, scan });

  // Serializes every mutation so concurrent retries of the same intent interleave safely while
  // each caller still observes its own rejection; the queue itself never swallows an error.
  function enqueue(work) {
    const result = tail.then(work);
    tail = result.catch((error) => { console.error("Project operation store queue rejection.", { error }); });
    return result;
  }

  // Creates or reconciles the operation for a request key. The wx create makes two concurrent
  // retries resolve to one operation: the losing writer re-reads and returns the winner's snapshot.
  function register({ requestKey, kind, root: projectRoot, projectId = null } = {}) {
    return enqueue(async () => {
      if (!requestKey || !kind || !projectRoot) throw failure("operation_invalid", "Request key, kind and root are required.");
      const fingerprint = computeRequestFingerprint({ kind, root: projectRoot, projectId });
      const existing = await readSnapshot(requestKey);
      if (existing) return reconcile(existing, fingerprint);
      const now = new Date().toISOString();
      const snapshot = {
        operation_id: `${OPERATION_ID_PREFIX}${randomUUID()}`,
        request_key: requestKey,
        request_fingerprint: fingerprint,
        kind,
        root: projectRoot,
        attempt: 0,
        revision: 0,
        stage: "intended",
        status: "pending",
        counters: { transitions: 0, attempts: 0 },
        timestamps: { created_at: now, updated_at: now }
      };
      if (projectId) snapshot.project_id = projectId;
      validateOperationSnapshot(snapshot);
      try {
        await writeNew(snapshotPath(requestKey), snapshot);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const winner = await readSnapshot(requestKey);
        if (!winner) throw error;
        return reconcile(winner, fingerprint);
      }
      return { operation: snapshot, reused: false };
    });
  }

  // Same key + same fingerprint returns the recorded operation even when the first response was
  // lost before the client observed the operation id; same key + different fingerprint conflicts.
  function reconcile(existing, fingerprint) {
    if (existing.request_fingerprint !== fingerprint) {
      throw failure("request_conflict", "The request key was already used with different content.");
    }
    return { operation: existing, reused: true };
  }

  // Loads a snapshot by operation id; linear scan is acceptable at managed-storage scale.
  function load(operationId) {
    return enqueue(async () => findByOperationId(operationId));
  }

  // Loads a snapshot by request key so a retry after a lost response can reconcile before
  // deciding whether the earlier intent is already recorded.
  function loadByRequestKey(requestKey) {
    return enqueue(async () => readSnapshot(requestKey));
  }

  // Applies a validated stage/status patch under optimistic revision control: a stale expected
  // revision or an invalid stage move is rejected without touching the persisted snapshot. The
  // read, revision/authority validation and replacement run as one compare-and-swap section under
  // the directory lock, so a second handle on the same storage that read the same revision is
  // rejected as stale after re-reading under the lock instead of silently replacing the winner.
  // Execution-owned publication (stage/status/result of the running attempt) must carry
  // { attempt: N } matching the persisted attempt with its lease still open; { recovery: true }
  // is the distinct coordinator authority permitted only for restart-settlement publication.
  function transition(operationId, expectedRevision, patch = {}, authority = null) {
    return mutate(async () => {
      if (patch.attempt !== undefined || authority?.internalClaim !== undefined) {
        throw failure("attempt_frozen", "Only claimAttempt may advance the attempt.");
      }
      const current = await findByOperationId(operationId);
      if (!current) throw failure("operation_not_found", `Unknown operation ${operationId}.`);
      return applyTransition(current, expectedRevision, patch, authority);
    });
  }

  // Fences execution: claiming an attempt runs under the directory lock and requires releasing
  // the previous attempt's resources first, because an open lease means runtime or filesystem
  // resources are still unreleased — so two concurrent retries across two handles can never both
  // open an attempt. The lease file is created before the snapshot moves to attempted, so a crash
  // between the two leaves an observable lease instead of an unfenced half-started attempt.
  function claimAttempt(operationId) {
    return mutate(async () => {
      const current = await findByOperationId(operationId);
      if (!current) throw failure("operation_not_found", `Unknown operation ${operationId}.`);
      const open = await leasesFor(operationId);
      if (open.length) throw failure("attempt_open", `Attempt ${open[0]} still holds unreleased resources.`);
      const attempt = current.attempt + 1;
      await writeFile(join(root, leaseName(operationId, attempt)),
        JSON.stringify({ operation_id: operationId, attempt, acquired_at: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
      const stagePatch = current.stage === "intended" ? { stage: "attempted" } : {};
      return applyTransition(current, current.revision, { ...stagePatch, status: "running", attempt, attempts: attempt },
        { internalClaim: attempt });
    });
  }

  // Releases a lease only for the attempt that holds it; the check and removal happen under the
  // directory lock so a stale or duplicate attempt token cannot release, settle or overwrite
  // state owned by a newer attempt.
  function releaseAttempt(operationId, attempt) {
    return mutate(async () => {
      const open = await leasesFor(operationId);
      if (!open.includes(attempt)) throw failure("attempt_stale", `Attempt ${attempt} does not hold resources for ${operationId}.`);
      await unlink(join(root, leaseName(operationId, attempt)));
      return true;
    });
  }

  // Runs one read-validate-replace section under the shared directory lock inside the in-memory
  // queue; nesting would deadlock by design, so mutations must call this exactly once.
  function mutate(work) {
    return enqueue(() => withCasLock(root, work));
  }

  // Lists operations with unreleased resources so restart recovery can re-run incomplete steps
  // but never start a second runtime while an old attempt still owns resources.
  function openAttempts() {
    return enqueue(async () => {
      const names = await listFiles();
      const grouped = new Map();
      for (const name of names.filter((entry) => entry.includes(".attempt-"))) {
        const parsed = /^(OPRO-[A-Za-z0-9_-]+)\.attempt-(\d+)\.lock$/.exec(name);
        if (!parsed) continue;
        if (!grouped.has(parsed[1])) grouped.set(parsed[1], []);
        grouped.get(parsed[1]).push(Number.parseInt(parsed[2], 10));
      }
      return [...grouped].map(([operationId, attempts]) => ({ operationId, attempts: attempts.sort((a, b) => a - b) }));
    });
  }

  // Reads every snapshot for restart reconciliation and reports corrupt files separately so a
  // damaged snapshot can never block catalog-based membership reconciliation.
  function scan() {
    return enqueue(async () => {
      const names = await listFiles();
      const operations = [];
      const corrupted = [];
      for (const name of names.filter((entry) => entry.endsWith(".json"))) {
        try {
          const snapshot = JSON.parse(await readFile(join(root, name), "utf8"));
          validateOperationSnapshot(snapshot);
          operations.push(snapshot);
        } catch (error) {
          if (error instanceof SyntaxError || error.code === "snapshot_invalid") { corrupted.push(name); continue; }
          throw error;
        }
      }
      return { operations, corrupted };
    });
  }

  // One validated snapshot write shared by transition and claimAttempt, enforcing the revision
  // precondition, the attempt-authority rule and the rule that terminal statuses and settled
  // stages persist their outcome. Runs inside the caller's compare-and-swap lock section.
  async function applyTransition(current, expectedRevision, patch, authority) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) {
      throw failure("revision_stale", `Expected revision ${expectedRevision}, found ${current.revision}.`);
    }
    if (patch.attempt !== undefined && authority?.internalClaim !== patch.attempt) {
      throw failure("attempt_frozen", "Only claimAttempt may advance the attempt; patches cannot change it directly.");
    }
    await assertTransitionAuthority(current, patch, authority);
    const next = structuredClone(current);
    const now = new Date().toISOString();
    if (patch.stage && patch.stage !== current.stage) {
      assertStageTransition(current.stage, patch.stage);
      next.stage = patch.stage;
      next.counters.transitions += 1;
    }
    if (patch.progress && current.progress?.attempt === patch.progress.attempt && patch.progress.revision <= current.progress.revision) throw failure("revision_stale", "Index progress revision must advance.");
    if (patch.progress) next.progress = structuredClone(patch.progress);
    if (patch.status) next.status = patch.status;
    if (patch.project_id) next.project_id = patch.project_id;
    if (patch.result) next.result = patch.result;
    if (patch.diagnostic) next.diagnostic = { ...patch.diagnostic, recorded_at: now };
    if (patch.attempt !== undefined) { next.attempt = patch.attempt; next.counters.attempts = patch.attempts; delete next.progress; }
    if (TERMINAL_STATUSES.has(next.status) && !next.result) {
      throw failure("terminal_requires_result", "A terminal status must persist its result in the same snapshot write.");
    }
    if (next.stage === "settled") next.timestamps.settled_at ??= now;
    next.revision = current.revision + 1;
    next.timestamps.updated_at = now;
    validateOperationSnapshot(next);
    return writeSnapshot(snapshotPath(next.request_key), next).then(() => next);
  }

  // Enforces the authority that publishes an outcome. Execution-owned publication — any patch that
  // moves stage, status or result — must present { attempt: N } where N equals the snapshot's
  // current attempt AND N still holds its open lease, so a stale worker whose lease ended or whose
  // attempt was superseded cannot publish committed or terminal results even while carrying the
  // latest revision. { recovery: true } is the distinct coordinator authority used by restart
  // reconciliation after its own catalog/identity/ownership evidence passes; an internal claim may
  // only pass the claim's own status/stage bookkeeping. A metadata-only patch (project_id,
  // diagnostic) may travel without an execution token because it publishes no outcome.
  async function assertTransitionAuthority(current, patch, authority) {
    const publishes = patch.progress !== undefined || patch.stage !== undefined || patch.status !== undefined || patch.result !== undefined;
    if (!publishes) return;
    if (authority?.recovery === true) return;
    if (authority?.internalClaim !== undefined) {
      if (patch.result !== undefined) {
        throw failure("authority_invalid", "A claim may not publish a final result; settlement belongs to transition.");
      }
      return;
    }
    const attempt = authority?.attempt;
    if (!Number.isSafeInteger(attempt)) {
      throw failure("attempt_required", "Publishing stage, status or result requires the current attempt token or recovery authority.");
    }
    if (attempt !== current.attempt) {
      throw failure("attempt_stale", `Attempt ${attempt} no longer owns ${current.operation_id}; current attempt is ${current.attempt}.`);
    }
    const open = await leasesFor(current.operation_id);
    if (!open.includes(attempt)) {
      throw failure("attempt_stale", `Attempt ${attempt} does not hold its lease for ${current.operation_id}.`);
    }
  }

  // Finds the snapshot whose persisted operation_id matches, reading every .json in the store.
  async function findByOperationId(operationId) {
    const names = await listFiles();
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const snapshot = await readSnapshotFile(join(root, name));
      if (snapshot?.operation_id === operationId) return snapshot;
    }
    return null;
  }

  // Returns the sorted attempt numbers with live lease files for one operation.
  async function leasesFor(operationId) {
    const names = await listFiles();
    return names
      .map((name) => Number.parseInt(new RegExp(`^${operationId}\\.attempt-(\\d+)\\.lock$`).exec(name)?.[1] ?? "", 10))
      .filter((attempt) => Number.isSafeInteger(attempt))
      .sort((a, b) => a - b);
  }

  // Lists store directory entries; absence of the directory reads as an empty store.
  async function listFiles() {
    return readdir(root).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  }

  // Maps a request key to its snapshot path so retries hash to the same file.
  function snapshotPath(requestKey) {
    return join(root, `${createHash("sha256").update(requestKey).digest("hex")}.json`);
  }

  // Reads the snapshot registered for a request key, or null when no intent was recorded.
  async function readSnapshot(requestKey) {
    return readSnapshotFile(snapshotPath(requestKey));
  }

  // Creates a brand-new snapshot atomically via hard link, which fails with EEXIST when a
  // concurrent retry already published one; rename would overwrite the winner's operation id.
  async function writeNew(path, snapshot) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await link(temporary, path);
    } finally {
      await unlink(temporary).catch((cleanupError) => {
        if (cleanupError.code !== "ENOENT") console.error("Snapshot temp cleanup failed.", { cleanupError });
      });
    }
  }

  // Replaces a snapshot atomically with cleanup that rethrows on double failure.
  async function writeSnapshot(path, snapshot) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch((cleanupError) => {
        if (cleanupError.code !== "ENOENT") throw new AggregateError([error, cleanupError], "Snapshot write and cleanup failed.");
      });
      throw error;
    }
  }
}

// Names the fenced-lease file for one attempt of one operation.
function leaseName(operationId, attempt) {
  return `${operationId}.attempt-${attempt}.lock`;
}

// Reads one snapshot file and refuses corrupt content; a missing file is simply absent state.
async function readSnapshotFile(path) {
  try {
    const snapshot = JSON.parse(await readFile(path, "utf8"));
    validateOperationSnapshot(snapshot);
    return snapshot;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Builds the deterministic store errors shared by validation and reconciliation failures.
function failure(code, message) {
  return Object.assign(new Error(message), { code, retryable: false });
}
