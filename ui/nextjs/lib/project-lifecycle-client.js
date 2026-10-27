// Tracks backend-owned Create and Add operations without performing filesystem work in the browser.
// Request keys survive uncertain responses so recovery reads status rather than repeating a mutation.
// Attempt and revision ordering prevent delayed observations from replacing a newer retry result.
import { controlApiBase } from "./node-client-url.js";
import { requestJson } from "./node-client-request.js";

const headers = { "content-type": "application/json", "x-nodeforge-lifecycle": "1" };
let snapshot = { operations: {}, pending: {}, errors: {} };
const listeners = new Set();

// Expose a stable external-store snapshot for accessible operation tracking components.
export function getLifecycleSnapshot() { return snapshot; }

// Subscribe only to observation changes; unsubscribing never cancels backend lifecycle work.
export function subscribeLifecycle(listener) { listeners.add(listener); return () => listeners.delete(listener); }

// Publish immutable observation state so React can distinguish current diagnostics from stale responses.
function publish(update) {
  snapshot = { ...snapshot, ...update };
  for (const listener of listeners) listener();
}

// Send exactly one negotiated request per explicit action, retaining legacy transport payloads elsewhere.
export function lifecycleRequest(path, body) {
  return requestJson(`${controlApiBase()}/lifecycle/${path}`, {
    headers, cache: "no-store", ...(body ? { method: "POST", body: JSON.stringify(body) } : {})
  });
}

// Replace a whole operation only when its attempt and revision are at least as current as the displayed record.
export function acceptOperation(operation) {
  if (!operation || typeof operation.request_key !== "string" || !Number.isSafeInteger(operation.attempt) ||
      !Number.isSafeInteger(operation.revision)) throw new Error("Invalid backend operation response.");
  const previous = snapshot.operations[operation.request_key];
  if (previous && (operation.attempt < previous.attempt ||
      operation.attempt === previous.attempt && operation.revision < previous.revision)) return previous;
  const errors = { ...snapshot.errors };
  delete errors[operation.request_key];
  publish({ operations: { ...snapshot.operations, [operation.request_key]: operation }, errors });
  return operation;
}

// Reconcile an uncertain submission with its original request key; this action cannot create another operation.
export async function reloadOperation(requestKey) {
  try {
    const result = await lifecycleRequest(`operations/status?request_key=${encodeURIComponent(requestKey)}`);
    if (result.version !== "1") throw new Error("Unsupported backend lifecycle response.");
    return acceptOperation(result.operation);
  } catch (error) {
    publish({ errors: { ...snapshot.errors, [requestKey]: error.message } });
    throw error;
  }
}

// Submit the chosen backend lifecycle once and retain intent even when its response is lost.
export async function submitProjectOperation(kind, root, requestKey = globalThis.crypto.randomUUID()) {
  if (!["create", "add"].includes(kind) || !root.startsWith("/")) throw new Error("Enter an absolute server path.");
  const unresolved = Object.values(snapshot.pending).find((intent) => intent.root === root &&
    (!snapshot.operations[intent.request_key] || ["running", "pending"].includes(snapshot.operations[intent.request_key].status)));
  if (unresolved) throw Object.assign(new Error("Reload status for the existing request before submitting this path again."), { requestKey: unresolved.request_key });
  publish({ pending: { ...snapshot.pending, [requestKey]: { kind, root, request_key: requestKey } } });
  try {
    const result = await lifecycleRequest(`operations/${kind}`, { root, request_key: requestKey });
    if (result.version !== "1") throw new Error("Unsupported backend lifecycle response.");
    return acceptOperation(result.operation);
  } catch (error) {
    publish({ errors: { ...snapshot.errors, [requestKey]: error.message } });
    if (error.status >= 400 && error.status < 500 && ![408, 409, 429].includes(error.status)) {
      const pending = { ...snapshot.pending };
      delete pending[requestKey];
      publish({ pending });
      throw error;
    }
    throw Object.assign(error, { requestKey });
  }
}

// Retry only an observed failed attempt, preserving the original operation identity and request intent.
export async function retryProjectOperation(operation) {
  if (operation.status !== "failed") throw new Error("Only a failed operation can be retried.");
  try {
    const result = await lifecycleRequest("operations/retry", {
      request_key: operation.request_key, expected_attempt: operation.attempt
    });
    if (result.version !== "1") throw new Error("Unsupported backend lifecycle response.");
    return acceptOperation(result.operation);
  } catch (error) {
    publish({ errors: { ...snapshot.errors, [operation.request_key]: error.message } });
    throw error;
  }
}
