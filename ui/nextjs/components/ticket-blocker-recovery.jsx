// Shows automatic SL/Architecture progress and concrete owner proposals without granting approval authority.
'use client';
import { useState } from "react";

// Presents persisted investigation outcomes separately from Reviewer acceptance and Human Approve.
export function TicketBlockerRecovery({ recovery, onDecide }) {
  if (!recovery) return null;
  const decision = recovery.owner_decision ?? null;
  const message = recovery.status === "pending" ? "Đang tự động xác minh blocker; không cần reset hoặc RUN lại."
    : recovery.status === "owner_decided" ? "Đã ghi hướng xử lý; đang chờ AM hoàn thiện bàn giao. Coder chưa chạy tiếp."
    : recovery.status === "governance_required" ? "AM đã lưu bản nháp contract; cần duyệt đúng revision/SHA và bind qua governance trước khi Coder chạy tiếp."
    : recovery.status === "cancelled" ? "Đã dừng điều tra tự động; checkpoint được giữ nguyên."
      : recovery.status === "reconciliation_required" ? "Cần xử lý kỹ thuật/reconciliation; đây không phải yêu cầu owner quyết định policy. Checkpoint được giữ nguyên."
        : "AM xác định vấn đề vượt quyền kiến trúc; cần owner quyết định.";
  return <section aria-label="Automatic blocker recovery">
    <p><strong>SL / Architecture:</strong> {message}</p>
    <p>SL tự quyết trong Sprint Plan → AM tự quyết trong cấu trúc → vượt quyền AM mới hỏi owner.</p>
    {recovery.status === "owner_required" && recovery.escalation && <p><strong>Ranh giới cần quyết định:</strong> {recovery.escalation.boundary} — {recovery.escalation.rationale}</p>}
    {["owner_required", "reconciliation_required"].includes(recovery.status) && recovery.proposal && <><h4>{recovery.proposal.title}</h4>
      <ul>{recovery.proposal.options.map((option) => <li key={option.id}><strong>{option.id}{option.id === recovery.proposal.recommended_option_id ? " (khuyến nghị)" : ""}</strong>: {option.description}</li>)}</ul>
      <p>{recovery.status === "reconciliation_required" ? "Đây là yêu cầu xử lý vận hành, không phải owner approval. Không tự reset hoặc replay invocation chưa rõ kết quả."
        : "Đề xuất không phải approval. Contract/scope mới phải qua gate duyệt plan đúng revision; Human Approve không được dùng để bỏ qua blocker này."}</p></>}
    {recovery.status === "owner_required" && !decision && onDecide && <BlockerDecisionForm recovery={recovery} onDecide={onDecide} />}
    {decision && <p role="status"><strong>Owner đã quyết:</strong> {decision.option_id}{decision.decided_at ? ` · ${decision.decided_at}` : ""}{decision.reason ? ` — ${decision.reason}` : ""}. AM hoàn thiện bàn giao; quyết định này chưa phải approval cho contract mới.</p>}
    {recovery.governance_handoff && <div>
      <h4>Bản nháp contract đã lưu</h4>
      <p><code>{recovery.governance_handoff.plan_id}</code> · revision {recovery.governance_handoff.revision}</p>
      <p>SHA-256: <code>{recovery.governance_handoff.sha256}</code></p>
      <p>Markdown: <code>{recovery.governance_handoff.source_path}</code></p>
      <p>Chưa cấp approval, RUN hoặc nghiệm thu ticket.</p>
    </div>}
  </section>;
}

// Lets the owner choose a direction for AM fulfillment while keeping contract approval separate.
// eslint-disable-next-line no-unused-vars -- JSX uses this local component.
function BlockerDecisionForm({ recovery, onDecide }) {
  const [option, setOption] = useState(recovery.proposal.recommended_option_id ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  async function submit() {
    setBusy(true); setError("");
    try { await onDecide({ option_id: option, reason: reason.trim() }); setDone(true); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  if (done) return <p role="status">Đã ghi nhận quyết định của owner.</p>;
  return <form className="ticket-blocker-decision" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <h4>Owner quyết định blocker này</h4>
    <p>Chọn hướng xử lý để AM hoàn thiện bàn giao; Coder chờ contract hợp lệ.</p>
    {recovery.proposal.options.map((entry) => <label key={entry.id} style={{ display: "block", marginBottom: "0.75rem" }}>
      <input type="radio" name="blocker-decision-option" value={entry.id} checked={option === entry.id} onChange={() => setOption(entry.id)} />
      <strong>{entry.id}{entry.id === recovery.proposal.recommended_option_id ? " (khuyến nghị)" : ""}</strong>
      <p>{entry.description}</p>
    </label>)}
    <label htmlFor="blocker-decision-reason">Lý do (tuỳ chọn)</label>
    <textarea id="blocker-decision-reason" value={reason} onChange={(event) => setReason(event.target.value)} rows={3} placeholder="Giải thích lý do owner chọn phương án này" />
    <button className="ticket-regenerate-button" type="submit" disabled={busy || !option}>{busy ? "Đang ghi…" : "Ghi quyết định"}</button>
    {error && <p role="alert">{error}</p>}
  </form>;
}
