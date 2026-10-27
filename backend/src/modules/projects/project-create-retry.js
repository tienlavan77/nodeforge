// Resumes only a proven backend-owned Create directory after an explicit failed-operation retry.
// No directory is created, adopted, or deleted here. The original durable ownership checkpoint,
// current inode binding and released attempt lease must all agree before admission can resume.
import { resolve } from "node:path";
import { assertRoot, filesystemError } from "./project-filesystem-safety.js";

// Reuses the original Create authority instead of turning a failed Create into an unrestricted Add.
export async function retryProjectCreate({ store, admit, root, requestKey }) {
  let operation = await store.loadByRequestKey(requestKey);
  const ownership = operation?.diagnostic?.ownership;
  if (!operation || operation.kind !== "create" || operation.root !== resolve(root) || !ownership ||
      ownership.root !== operation.root || operation.status === "succeeded") {
    throw filesystemError("identity", "create_recovery_required", root, null,
      "Reconcile the original Create ownership evidence before retrying.");
  }
  await assertRoot(ownership);
  operation = await store.claimAttempt(operation.operation_id);
  const authority = { attempt: operation.attempt };
  try {
    await assertRoot(ownership);
    const entry = await admit(operation.root, ownership);
    if (operation.stage === "attempted") {
      operation = await store.transition(operation.operation_id, operation.revision,
        { stage: "committed", project_id: entry.projectId }, authority);
    }
    await store.transition(operation.operation_id, operation.revision,
      { stage: "settled", status: "succeeded", result: { outcome: "succeeded", project_id: entry.projectId } }, authority);
    return entry;
  } catch (error) {
    await store.transition(operation.operation_id, operation.revision,
      { status: "failed", result: { outcome: "failed" } }, authority);
    throw error;
  } finally {
    await store.releaseAttempt(operation.operation_id, operation.attempt);
  }
}
