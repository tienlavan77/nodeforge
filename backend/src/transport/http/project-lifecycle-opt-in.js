// Defines the additive lifecycle transport independently of strict legacy root-only requests.
// Explicit version negotiation is required on every new route. Bounded JSON and strict fields
// prevent accidental opt-in, and status reads never retry admission. Workspace routes are unchanged.
import { isAbsolute, resolve } from "node:path";

// Enumerates only the method/path pairs that HTTP dispatch and preflight may expose for this contract.
export function lifecycleOptInRoute(method, pathname) {
  return method === "POST" && ["/lifecycle/operations/create", "/lifecycle/operations/add", "/lifecycle/operations/retry"].includes(pathname) ||
    method === "GET" && ["/lifecycle/directory", "/lifecycle/operations/status"].includes(pathname);
}

// Validates negotiation, request shape and configured capability before delegating backend operations.
export async function routeLifecycleOptIn(method, url, request, lifecycle) {
  if (!lifecycleOptInRoute(method, url.pathname)) return null;
  if (request.headers?.["x-nodeforge-lifecycle"] !== "1") throw failure(406, "lifecycle_version_required", "Use x-nodeforge-lifecycle: 1.");
  if (!lifecycle || url.pathname !== "/lifecycle/directory" && !lifecycle.operations) throw failure(503, "lifecycle_unavailable", "Project lifecycle management is not configured.");
  if (method === "GET") {
    await readBody(request, []);
    if (url.pathname === "/lifecycle/directory") {
      if ([...url.searchParams].length) throw failure(400, "invalid_lifecycle_request", "Directory does not accept query parameters.");
      return { status: 200, body: { version: "1", projects: lifecycle.directory().map(({ projectId, ...entry }) => ({ ...entry, project_id: projectId })) } };
    }
    if ([...url.searchParams].length !== 1 || !url.searchParams.has("request_key")) throw failure(400, "invalid_lifecycle_request", "Status requires only request_key.");
    return { status: 200, body: { version: "1", operation: await lifecycle.operations.status(key(url.searchParams.get("request_key"))) } };
  }
  if ([...url.searchParams].length) throw failure(400, "invalid_lifecycle_request", "Mutation does not accept query parameters.");
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers?.["content-type"] ?? "")) throw failure(415, "lifecycle_json_required", "Use application/json.");
  const retry = url.pathname.endsWith("/retry");
  const body = await readBody(request, retry ? ["request_key", "expected_attempt"] : ["root", "request_key"]);
  key(body.request_key);
  if (retry) {
    if (!Number.isSafeInteger(body.expected_attempt) || body.expected_attempt < 1) throw failure(400, "invalid_lifecycle_request", "Retry requires the observed attempt.");
    return { status: 202, body: { version: "1", operation: await lifecycle.operations.retry(body.request_key, body.expected_attempt) } };
  }
  if (typeof body.root !== "string" || body.root !== body.root.trim() || !isAbsolute(body.root)) throw failure(400, "invalid_lifecycle_request", "Root must be an absolute server path.");
  return { status: 202, body: { version: "1", operation: await lifecycle.operations.submit(url.pathname.endsWith("/create") ? "create" : "add", resolve(body.root), body.request_key) } };
}

// Limits request memory and rejects extra fields rather than relaxing any existing strict payload.
async function readBody(request, fields) {
  let raw = "";
  for await (const chunk of request) {
    raw += String(chunk);
    if (Buffer.byteLength(raw) > 8192) throw failure(413, "lifecycle_request_too_large", "Lifecycle request exceeds 8192 bytes.");
  }
  if (!fields.length) {
    if (raw.trim()) throw failure(400, "invalid_lifecycle_request", "Read requests do not accept a body.");
    return null;
  }
  let body;
  try { body = JSON.parse(raw); } catch (error) {
    throw failure(400, "invalid_lifecycle_request", "Lifecycle request must be valid JSON.", error);
  }
  if (!body || Array.isArray(body) || Object.keys(body).length !== fields.length || fields.some((field) => !Object.hasOwn(body, field))) {
    throw failure(400, "invalid_lifecycle_request", "Lifecycle request fields do not match the negotiated contract.");
  }
  return body;
}

// Bounds reconciliation keys while preserving their exact identity across submits and status reads.
function key(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 256) throw failure(400, "invalid_lifecycle_request", "Request key must contain 1–256 characters.");
  return value;
}

// Uses the existing canonical error envelope without exposing internal filesystem exception details.
function failure(statusCode, code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { statusCode, code, retryable: false, scope: "scoped" });
}
