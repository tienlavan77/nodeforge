// Shared fetch helper that normalizes backend errors for the Node control client.
import { normalizeBackendError } from "./error-normalizer.js";
import { formatNotification } from "./notification-formatter.js";

export async function requestJson(url, { fallbackError, ...init } = {}) {
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    const n = normalizeBackendError({ body: null, status: null, fallbackError: fallbackError ?? "Node is unavailable. Check that the Node service is running.", requestId: null });
    const notification = formatNotification({ notification: { message: n.message, code: n.code }, status: null }, n.message);
    const err = new Error(notification.message || n.message);
    Object.assign(err, n, { status: null, notification, cause: error });
    throw err;
  }
  const text = response.status === 204 ? "" : await response.text();
  let body = null;
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      if (response.ok) {
        const n = normalizeBackendError({ body: null, status: response.status, fallbackError: "Node returned an invalid response.", requestId: null });
        const notification = formatNotification({ notification: { message: n.message, code: n.code }, status: response.status }, n.message);
        const err = new Error(notification.message || n.message);
        Object.assign(err, n, { status: response.status, notification, cause: text });
        throw err;
      }
      const n = normalizeBackendError({ body: { error: { message: text.slice(0, 280) } }, status: response.status, fallbackError: fallbackError ?? `Node request failed with HTTP ${response.status}.`, requestId: null });
      const notification = formatNotification({ notification: { message: n.message, code: n.code }, status: response.status }, n.message);
      const err = new Error(notification.message || n.message);
      Object.assign(err, n, { status: response.status, notification, cause: text });
      throw err;
    }
  }
  if (!response.ok) {
    const requestId = response.headers?.get?.("x-request-id") ?? response.headers?.get?.("x-correlation-id") ?? null;
    const normalized = normalizeBackendError({ body, status: response.status, fallbackError, requestId });
    const notification = formatNotification({ notification: { message: normalized.message, code: normalized.code }, error: { code: normalized.code, message: normalized.message }, status: response.status }, normalized.message);
    const err = new Error(notification.message || normalized.message);
    Object.assign(err, normalized, { status: response.status, notification, cause: body });
    throw err;
  }
  return body;
}
