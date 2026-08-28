const SEVERITY_ALIASES = Object.freeze({
  fatal: "error",
  danger: "error",
  failure: "error",
  failed: "error",
  warn: "warning",
  pending: "info",
  accepted: "success",
  ok: "success"
});

const CODE_MESSAGES = Object.freeze({
  ticket_created: "Ticket đã được tạo.",
  ticket_creation_failed: "Không thể tạo ticket.",
  ticket_dispatched: "Ticket đã được nhận và đang chờ xử lý.",
  dispatch_accepted: "Yêu cầu chạy ticket đã được chấp nhận.",
  dispatch_pending: "Ticket đang chờ được xử lý.",
  dispatch_failed: "Không thể chạy ticket.",
  retry_accepted: "Yêu cầu chạy lại đã được chấp nhận.",
  retry_pending: "Ticket đang chờ chạy lại.",
  retry_failed: "Không thể chạy lại ticket.",
  context_missing: "Ticket thiếu ngữ cảnh cần thiết để tiếp tục.",
  verification_failed: "Ticket chưa vượt qua bước xác minh."
});

const STATUS_MESSAGES = Object.freeze({
  accepted: "Yêu cầu đã được chấp nhận.",
  pending: "Yêu cầu đang chờ xử lý.",
  queued: "Yêu cầu đang chờ xử lý.",
  running: "Ticket đang được xử lý.",
  retrying: "Ticket đang được chạy lại.",
  succeeded: "Yêu cầu đã hoàn tất.",
  success: "Yêu cầu đã hoàn tất.",
  completed: "Yêu cầu đã hoàn tất.",
  done: "Ticket đã hoàn tất.",
  failed: "Yêu cầu không thành công.",
  error: "Đã xảy ra lỗi khi xử lý yêu cầu."
});

function normalizeToken(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[.\s-]+/g, "_");
}

function plainText(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text) return "";

  // Backend messages may contain exception details. Keep only the useful lead
  // sentence and never expose serialized payloads or stack frames in the UI.
  if (/^[\[{]/.test(text) || /\n\s*at\s+\S+|traceback|stack trace/i.test(text)) return "";
  return text.split(/\r?\n/)[0].replace(/\s+/g, " ").slice(0, 280);
}

function inferSeverity(notification, status, code) {
  const explicit = normalizeToken(notification?.severity);
  if (["info", "success", "warning", "error"].includes(explicit)) return explicit;
  if (SEVERITY_ALIASES[explicit]) return SEVERITY_ALIASES[explicit];
  if (/fail|error|missing|reject|invalid/.test(code) || ["failed", "error", "rejected"].includes(status)) return "error";
  if (/warn/.test(code)) return "warning";
  if (["success", "succeeded", "completed", "done", "accepted"].includes(status)) return "success";
  return "info";
}

function notificationCandidate(response) {
  if (!response || typeof response !== "object") return {};
  return response.notification && typeof response.notification === "object"
    ? response.notification
    : response;
}

export function formatNotification(response, fallback = "Yêu cầu đã được cập nhật.") {
  const notification = notificationCandidate(response);
  const code = normalizeToken(notification.code ?? response?.error?.code ?? response?.error_code);
  const status = normalizeToken(notification.status ?? response?.status);
  const severity = inferSeverity(notification, status, code);
  const safeMessage = plainText(notification.message)
    || plainText(response?.message)
    || CODE_MESSAGES[code]
    || STATUS_MESSAGES[status]
    || fallback;
  const action = plainText(notification.suggested_action ?? response?.suggested_action);

  return {
    code: code || null,
    status: status || null,
    severity,
    message: safeMessage,
    suggestedAction: action || null,
    text: action ? `${safeMessage} ${action}` : safeMessage,
    role: severity === "error" || severity === "warning" ? "alert" : "status",
    ariaLive: severity === "error" ? "assertive" : "polite"
  };
}

export function notificationClassName(severity) {
  const safeSeverity = ["success", "warning", "error"].includes(severity) ? severity : "info";
  return `notification notification--${safeSeverity}`;
}
