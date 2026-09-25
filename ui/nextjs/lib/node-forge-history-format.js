// Formats persisted conversation history and live Node events into chat-displayable text.

import { formatTicketResponse } from "./formatTicketResponse.js";

// Formats a timestamp into a human-readable date label.
export function formatDateLabel(timestamp) {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return timestamp;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return "Today";
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

// Converts a persisted history record into a displayable chat message.
export function historyRecordToMessage(record) {
  const isOwner = record.kind === "owner";
  const raw = record.content;
  const text = eventTextForUser(record.type, raw) ?? raw?.text ?? raw?.content ?? formatTicketResponse({ message_type: record.type, payload: raw }) ?? (typeof raw === "string" ? raw : JSON.stringify(raw ?? ""));
  const from = isOwner ? "owner" : record.kind === "failure" ? "system" : record.kind === "agent" || record.kind === "completion" ? "agent" : isOwner ? "owner" : "agent";
  const ts = record.timestamp;
  const d = ts ? new Date(ts) : new Date();
  return { id: record.id, correlation_id: record.correlation_id, message_type: record.type, from, text: String(text ?? record.type), time: d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), timestamp: ts, dateKey: Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10), dateLabel: ts ? formatDateLabel(ts) : "" };
}

// Maps internal event types to user-friendly messages.
export function eventTextForUser(type, payload = {}) {
  const value = String(type ?? "");
  const step = payload?.result?.step_name ?? payload?.step_name;
  if (value.endsWith(".message.progress") || value.endsWith(".progress")) return payload?.message ?? payload?.text ?? "Node đang xử lý…";
  if (value.endsWith(".working")) return "Builder đang làm việc…";
  if (value === "node.status_change") {
    const status = payload?.to ?? payload?.status;
    return status === "running" ? "Builder bắt đầu chạy ticket." : status === "reviewing" ? "Builder đã hoàn tất, đang chờ review." : status === "done" ? "Ticket đã hoàn tất." : status === "failed" ? `Ticket thất bại${payload?.error ? `: ${payload.error}` : "."}` : `Trạng thái ticket: ${status ?? "đã cập nhật"}.`;
  }
  if (value === "node.execution_step") return step ? `Đang xử lý: ${humanizeStep(step)}.` : "Đang xử lý một bước thực thi…";
  if (value === "node.command_result") return payload?.success === false ? `Bước thực thi thất bại${payload?.result?.error_code ? ` (${payload.result.error_code})` : "."}` : step ? `Đã hoàn tất: ${humanizeStep(step)}.` : "Đã hoàn tất một bước thực thi.";
  if (value === "git.status") return "Đã kiểm tra thay đổi Git.";
  if (value === "git.add") return "Đã chuẩn bị các file thay đổi cho commit.";
  if (value === "git.commit") return payload?.commit ? `Đã commit thay đổi (${payload.commit}).` : "Đã commit thay đổi.";
  if (value === "ticket.input_rejected") return payload?.error ?? "Ticket đang chạy; yêu cầu mới chưa được nhận.";
  return null;
}

// Converts a step identifier into a readable label.
export function humanizeStep(step) {
  return String(step).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (char) => char.toUpperCase());
}
