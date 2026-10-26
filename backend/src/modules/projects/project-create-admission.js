// Executes backend Create admission using the accepted durable operation foundation.
// Business purpose: a failed Create must never become Add or take over an existing directory.
// Technical description: register and fence the attempt before an exclusive mkdir, persist a
// directory ownership checkpoint, then admit membership before starting the runtime. Ambiguous
// retries require reconciliation and no failure path recursively deletes a project directory.
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { assertRoot, captureRoot, filesystemError, preflightCreate, probeStorage } from "./project-filesystem-safety.js";
import { createProjectOperationStore } from "./project-operation-store.js";

// Opens operation storage only inside the verified catalog parent, rejecting redirected directories.
export async function openProjectAdmissionStore(catalogPath) {
  const parent = await captureRoot(dirname(resolve(catalogPath)));
  const directory = join(parent.root, "project-operations");
  await assertRoot(parent);
  try { await mkdir(directory); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const binding = await captureRoot(directory);
  await probeStorage(directory, "operation_store", async () => { await assertRoot(parent); await assertRoot(binding); });
  await assertRoot(parent);
  await assertRoot(binding);
  return createProjectOperationStore({ directory });
}

// Prevents Add from bypassing a crashed Create whose root ownership has never been reconciled.
export async function assertProjectCreateOwnership({ store, catalogPath, binding }) {
  let evidence;
  try { evidence = await (store ?? await openProjectAdmissionStore(catalogPath)).scan(); } catch (error) {
    throw filesystemError("operation_store", "operation_store_unreadable", binding.root, error);
  }
  if (evidence.corrupted.length) {
    throw filesystemError("operation_store", "operation_evidence_corrupt", binding.root, null, "Repair corrupt operation evidence before admitting a project.");
  }
  for (const operation of evidence.operations.filter((entry) => entry.kind === "create" && entry.root === binding.root)) {
    const ownership = operation.diagnostic?.ownership;
    if (!ownership || ownership.root !== binding.root || ownership.dev !== binding.dev || ownership.ino !== binding.ino) {
      throw filesystemError("identity", "create_ownership_uncertain", binding.root, null,
        "Reconcile the Create operation and directory ownership before Add; missing checkpoints cannot authorize takeover.");
    }
  }
}

// Builds a Create action over the lifecycle's serialized membership admission boundary.
export function createProjectCreateAdmission({ store, admit }) {
  return async function create(root, { requestKey = randomUUID() } = {}) {
    const target = await preflightCreate(root);
    let operation;
    try {
      const registration = await store.register({ requestKey, kind: "create", root: target.root });
      if (registration.reused) {
        throw filesystemError("identity", "create_recovery_required", root, null,
          "Reconcile the existing operation and its ownership checkpoint before retrying. Create never takes over a target.");
      }
      operation = await store.claimAttempt(registration.operation.operation_id);
    } catch (error) {
      if (error.stage) throw error;
      throw filesystemError("operation_store", "operation_store_unwritable", root, error);
    }
    const authority = { attempt: operation.attempt };
    try {
      await assertRoot(target.parent);
      try { await mkdir(target.root, { mode: 0o700 }); } catch (error) {
        throw filesystemError("input", error.code === "EEXIST" ? "create_target_exists" : "create_failed", target.root, error,
          "Inspect the target and choose a new path; an existing target cannot be adopted by Create.");
      }
      const binding = await captureRoot(target.root);
      await assertRoot(target.parent);
      try {
        operation = await store.transition(operation.operation_id, operation.revision, {
          diagnostic: { code: "create_ownership_checkpoint", message: "Exclusive Create directory ownership recorded.", ownership: binding }
        }, authority);
      } catch (error) {
        throw filesystemError("operation_store", "create_ownership_uncertain", target.root, error,
          "Keep the directory. Reconcile exclusive creation and directory ownership before any retry.");
      }
      await assertRoot(binding);
      const entry = await admit(binding.root, binding);
      operation = await store.transition(operation.operation_id, operation.revision,
        { stage: "committed", project_id: entry.projectId }, authority);
      await store.transition(operation.operation_id, operation.revision,
        { stage: "settled", status: "succeeded", result: { outcome: "succeeded", project_id: entry.projectId } }, authority);
      return entry;
    } catch (error) {
      if (error.stage) throw error;
      throw filesystemError("operation_store", "create_operation_incomplete", target.root, error,
        "Keep the root and membership. Inspect the operation and retry startup after reconciliation.");
    } finally {
      try { await store.releaseAttempt(operation.operation_id, operation.attempt); } catch (error) {
        throw filesystemError("operation_store", "operation_release_failed", target.root, error,
          "Reconcile the open attempt lease before retrying.");
      }
    }
  };
}
