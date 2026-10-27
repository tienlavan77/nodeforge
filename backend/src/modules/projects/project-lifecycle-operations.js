// Provides durable, explicitly requested backend lifecycle operations for remote clients.
// Transport receipts are retained indefinitely in separate storage: they never establish catalog
// membership or grant Create ownership. Lost responses reconcile by request key without replay.
// Only explicit retry claims a new attempt; polling and disconnect never cancel backend work.
import { dirname, join } from "node:path";
import { createProjectOperationStore } from "./project-operation-store.js";

// Creates a bounded transport coordinator over the existing admission authority and durable store.
// The separate receipt directory prevents transport metadata from being mistaken for Create ownership.
export function createProjectLifecycleOperations({ catalogPath, create, add, logger = console }) {
  let storePromise;
  let tail = Promise.resolve();
  let closed = false;
  const jobs = new Map();
  return Object.freeze({ submit, status, retry, close });

  // Opens durable receipt storage lazily, so legacy startup does not acquire transport resources.
  function store() {
    return storePromise ??= createProjectOperationStore({ directory: join(dirname(catalogPath), "lifecycle-requests") });
  }

  // Serializes acceptance and retry decisions while execution proceeds independently of HTTP clients.
  function enqueue(work) {
    const result = tail.then(work);
    tail = result.catch((error) => logger.error?.("Lifecycle request rejected.", { error }));
    return result;
  }

  // Reconciles identical requests without restarting failed, running, or completed admission work.
  function submit(kind, root, requestKey) {
    return enqueue(async () => {
      if (closed) throw failure(503, "lifecycle_unavailable", "Lifecycle is closing.");
      const db = await store();
      let registration;
      try { registration = await db.register({ kind, root, requestKey }); } catch (error) {
        if (error.code === "request_conflict") throw failure(409, "request_conflict", "Request key already belongs to different intent.");
        throw error;
      }
      if (registration.reused) return registration.operation;
      return launch(db, registration.operation, false);
    });
  }

  // Loads by stable request key without mutating attempts, repairing evidence, or replaying work.
  async function status(requestKey) {
    const operation = await (await store()).loadByRequestKey(requestKey);
    if (!operation) throw failure(404, "operation_not_found", "No retained operation has this request key.");
    return operation;
  }

  // Requires a failed result and the observed attempt, preventing stale or duplicate retry submissions.
  function retry(requestKey, expectedAttempt) {
    return enqueue(async () => {
      if (closed) throw failure(503, "lifecycle_unavailable", "Lifecycle is closing.");
      const db = await store();
      const operation = await status(requestKey);
      if (operation.status !== "failed" || operation.attempt !== expectedAttempt || jobs.has(operation.operation_id)) {
        throw failure(409, "operation_retry_conflict", "Reload status before retrying a failed operation.");
      }
      return launch(db, operation, true);
    });
  }

  // Claims durable fencing before responding, then retains execution even if the requester disconnects.
  async function launch(db, previous, retrying) {
    const operation = await db.claimAttempt(previous.operation_id);
    const job = execute(db, operation, retrying).catch((error) => {
      logger.error?.("Lifecycle operation requires reconciliation.", { error, operation_id: operation.operation_id });
    }).finally(() => jobs.delete(operation.operation_id));
    jobs.set(operation.operation_id, job);
    return operation;
  }

  // Delegates all filesystem and identity work to backend admission and publishes safe terminal receipts.
  async function execute(db, initial, retrying) {
    let operation = initial;
    const authority = { attempt: operation.attempt };
    try {
      const entry = operation.kind === "create"
        ? await create(operation.root, { requestKey: operation.operation_id, retry: retrying })
        : await add(operation.root);
      if (operation.stage === "attempted") {
        operation = await db.transition(operation.operation_id, operation.revision,
          { stage: "committed", project_id: entry.projectId }, authority);
      }
      await db.transition(operation.operation_id, operation.revision,
        { stage: "settled", status: "succeeded", result: { outcome: "succeeded", project_id: entry.projectId } }, authority);
    } catch (error) {
      logger.error?.("Lifecycle admission failed.", { error, operation_id: operation.operation_id });
      await db.transition(operation.operation_id, operation.revision, {
        status: "failed", result: { outcome: "failed" },
        diagnostic: { code: "project_admission_failed", message: "Admission failed. Inspect backend diagnostics before explicit retry." }
      }, authority);
    } finally {
      await db.releaseAttempt(operation.operation_id, operation.attempt);
    }
  }

  // Drains accepted operations before lifecycle resources are released; retained snapshots survive shutdown.
  async function close() {
    closed = true;
    await tail;
    await Promise.all([...jobs.values()]);
  }
}

// Produces canonical HTTP errors while retaining stable codes for transport callers and negative fixtures.
function failure(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code, retryable: false, scope: "scoped" });
}
