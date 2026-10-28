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

// Generates a deduplication key for explicit project actions on both HTTPS and local HTTP.
// These keys identify requests, not credentials; older browsers retain a non-credential fallback.
function createProjectRequestKey() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    return `project-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  return `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// Submit the chosen backend lifecycle once and retain intent even when its response is lost.
export async function submitProjectOperation(kind, root, requestKey = createProjectRequestKey()) {
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

// Business purpose: converts a project record into a complete editable form state covering all approved Section 5 configuration fields.
// Technical description: populates scalar strings, nested `commands`, `default_agents`, `watch.include`/`watch.exclude` lists, `tags`, and serialized `metadata` JSON with safe defaults.
export function createProjectEditForm(project = {}) {
  project ??= {};
  const commands = project.commands ?? {};
  const agents = project.default_agents ?? {};
  const watch = project.watch ?? {};
  return {
    name: project.name ?? "", description: project.description ?? "", author: project.author ?? "",
    git_url: project.git_url ?? "", default_branch: project.default_branch ?? "", default_workflow_id: project.default_workflow_id ?? "",
    language: project.language ?? "", package_manager: project.package_manager ?? "", comment_language: project.comment_language ?? "en",
    commands_test: commands.test ?? "", commands_lint: commands.lint ?? "", commands_build: commands.build ?? "", commands_dev: commands.dev ?? "",
    agent_architecture_manager: agents.architecture_manager ?? "", agent_sprint_leader: agents.sprint_leader ?? "", agent_coder: agents.coder ?? "", agent_reviewer: agents.reviewer ?? "",
    watch_include: Array.isArray(watch.include) ? watch.include.join(", ") : "", watch_exclude: Array.isArray(watch.exclude) ? watch.exclude.join(", ") : "",
    tags: Array.isArray(project.tags) ? project.tags.join(", ") : "", homepage_url: project.homepage_url ?? "", docs_url: project.docs_url ?? "",
    metadata: project.metadata && typeof project.metadata === "object" ? JSON.stringify(project.metadata) : ""
  };
}

// Business purpose: serializes the Edit modal form state back into a schema-valid project configuration update payload for `PUT /forge/v1/projects/<projectId>`.
// Technical description: constructs nested `commands`, `default_agents`, `watch`, `tags`, and parsed `metadata` objects while validating JSON syntax when metadata is provided.
export function buildProjectConfigurationUpdate(form) {
  const splitList = (value) => String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  let metadata;
  if (String(form.metadata ?? "").trim()) {
    try { metadata = JSON.parse(form.metadata); }
    catch (error) { throw new Error(`Invalid metadata JSON: ${error.message}`); }
  }
  return {
    name: form.name.trim(), description: form.description.trim(), author: form.author.trim(),
    git_url: form.git_url.trim(), default_branch: form.default_branch.trim(),
    default_workflow_id: form.default_workflow_id.trim() || null, language: form.language.trim(),
    package_manager: form.package_manager.trim(), comment_language: form.comment_language.trim() || "en",
    commands: { test: form.commands_test.trim(), lint: form.commands_lint.trim(), build: form.commands_build.trim(), dev: form.commands_dev.trim() },
    default_agents: { architecture_manager: form.agent_architecture_manager.trim(), sprint_leader: form.agent_sprint_leader.trim(), coder: form.agent_coder.trim(), reviewer: form.agent_reviewer.trim() },
    watch: { include: splitList(form.watch_include), exclude: splitList(form.watch_exclude) },
    tags: splitList(form.tags), homepage_url: form.homepage_url.trim(), docs_url: form.docs_url.trim(),
    ...(metadata !== undefined ? { metadata } : {})
  };
}

// Business purpose: formats backend error objects and diagnostics into a clear user-facing string that preserves the exact backend error code, message, stage, and guidance for display in project modals and cards.
// Technical description: extracts `rawCode`/`code`, `message`, `stage`, and `guidance` from normalized or raw error payloads and joins them so neither error codes nor detailed messages are lost.
export function formatProjectBackendError(error, fallback = "Project request failed.") {
  if (!error) return fallback;
  if (typeof error === "string") return error;
  const raw = error.cause && typeof error.cause === "object" ? (error.cause.error ?? error.cause) : (error.error ?? error);
  const code = raw?.code ?? error.rawCode ?? error.code ?? "";
  const message = raw?.message ?? error.message ?? fallback;
  const stage = raw?.stage ?? error.stage ?? "";
  const guidance = raw?.guidance ?? error.guidance ?? "";
  const parts = [];
  if (code && !String(message).includes(String(code))) parts.push(`[${code}]`);
  if (message) parts.push(String(message));
  if (stage && !String(message).includes(String(stage))) parts.push(`(stage: ${stage})`);
  if (guidance && !String(message).includes(String(guidance))) parts.push(String(guidance));
  return parts.join(" ").trim() || fallback;
}

// Business purpose: checks a candidate project root path via `POST /forge/v1/projects/preflight` before submission so the Add modal can display existing/new/invalid path states and auto-fill metadata suggestions.
// Technical description: sends `{ root }` to `/forge/v1/projects/preflight`, returning the backend classification (`existing`, `new`, or `invalid` with `suggestions`, `code`, and `message`).
export async function preflightProjectPath(root) {
  const response = await requestJson(`${controlApiBase()}/forge/v1/projects/preflight`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ root })
  });
  return response;
}

// Business purpose: submits a new or imported project configuration through `POST /forge/v1/projects` without requiring a manual Create/Add choice from the operator.
// Technical description: posts the validated project configuration object (including `name`, `description`, `author`, `root`, and optional extended settings) to `/forge/v1/projects` and returns the created/admitted project record.
export async function intakeProject(payload) {
  const result = await requestJson(`${controlApiBase()}/forge/v1/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(payload)
  });
  return result?.project ?? result;
}

// Business purpose: updates an admitted project's full extended configuration through `PUT /forge/v1/projects/<projectId>` while preserving its immutable `project_id` and `root`.
// Technical description: sends a JSON `PUT` request to `/forge/v1/projects/<projectId>` with the edited configuration fields and returns the persisted project configuration object.
export async function updateProjectConfiguration(projectId, updates) {
  const result = await requestJson(`${controlApiBase()}/forge/v1/projects/${encodeURIComponent(projectId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(updates)
  });
  return result?.project ?? result;
}

// Business purpose: removes a project from NodeForge's managed catalog via `DELETE /forge/v1/projects/<projectId>` while preserving all source and `.forge` files on disk.
// Technical description: sends a `DELETE` request to `/forge/v1/projects/<projectId>` and returns the removal confirmation payload.
export async function deleteManagedProject(projectId) {
  return requestJson(`${controlApiBase()}/forge/v1/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
    cache: "no-store"
  });
}
