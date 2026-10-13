// Lets the owner answer Architecture questions, review the choices and generate a plan without approving it implicitly.
"use client";
import { useEffect, useId, useRef, useState } from "react";

// Shows a durable, source-bound question wizard with explicit choices and a separate confirmation step.
export function ArchitectureClarificationCard({ session, onSave, onConfirm, onReload, onReanalyze, onOpenPlan }) {
  const [step, setStep] = useState(0);
  const [selections, setSelections] = useState(session.selections);
  const [notes, setNotes] = useState(session.notes);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const scope = useId();
  useEffect(() => { setSelections(session.selections); setNotes(session.notes); }, [session.version, session.selections, session.notes]);
  const questions = session.questions;
  const editable = ["awaiting_owner_decisions", "generation_failed"].includes(session.status);
  const complete = questions.every((question) => Object.hasOwn(selections, question.id));
  const question = questions[step];

  // Serializes owner actions and leaves failed confirmations retryable without losing server-persisted answers.
  async function act(action) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try { await action(); }
    catch (reason) { setError(reason.message); }
    finally { inFlight.current = false; setBusy(false); }
  }

  // Saves a selected policy before advancing so reload never relies on an unsaved radio state.
  async function choose(optionId) {
    const next = { ...selections, [question.id]: optionId };
    await act(async () => { await onSave(session, next, notes, token); setSelections(next); });
  }

  return <section className="architecture-clarification-card" aria-label="Architecture owner decisions">
    <h3>{session.status === "completed" ? "Quyết định đã ghi vào plan" : "Architecture cần owner chốt quyết định"}</h3>
    <p>Nguồn: <code>{session.source_path}</code> · {Object.keys(session.selections).length}/{questions.length} quyết định</p>
    {session.status === "source_changed" && <><p role="alert">File nguồn đã thay đổi. Không dùng các lựa chọn cũ để tạo plan.</p><button type="button" onClick={() => act(() => onReanalyze(session))} disabled={busy}>Phân tích lại nguồn</button></>}
    {session.status === "cancelled" && <p>Yêu cầu đã hủy. Không tạo plan hoặc chạy ticket.</p>}
    {session.status === "generating" && <p role="status">Đang tạo plan từ các quyết định đã chốt.</p>}
    {editable && <>
      <p>Chờ owner quyết định. Khuyến nghị chưa được chọn sẵn. Xác nhận lựa chọn không phải approval plan.</p>
      <label>Owner token <input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Nhập để lưu và xác nhận lựa chọn" /></label>
      <nav aria-label="Tiến độ câu hỏi">{questions.map((item, index) => <button type="button" key={item.id} aria-current={step === index ? "step" : undefined} disabled={busy} onClick={() => act(async () => { if (token) await onSave(session, selections, notes, token); setStep(index); })}>{index + 1}. {item.title}{Object.hasOwn(selections, item.id) ? " ✓" : ""}</button>)}</nav>
      {question ? <fieldset disabled={busy || !token}>
        <legend>Câu {step + 1}/{questions.length} — {question.title}</legend><p>{question.reason}</p>
        {question.options.map((option, index) => <label className="architecture-clarification-option" key={option.id}>
          <input type="radio" name={`${scope}-${question.id}`} checked={selections[question.id] === option.id} onChange={() => choose(option.id)} />
          <span><strong>{index + 1}. {option.label}{question.recommended_option_id === option.id ? " — Khuyến nghị" : ""}</strong><span>{option.description}</span></span>
        </label>)}
        <label>Ghi chú của owner<textarea value={notes[question.id] ?? ""} maxLength={2000} onChange={(event) => setNotes({ ...notes, [question.id]: event.target.value })} /></label>
      </fieldset> : <div><h4>Xem lại quyết định</h4>{questions.map((item, index) => {
        const option = item.options.find((entry) => entry.id === selections[item.id]);
        return <p key={item.id}><strong>{item.title}</strong> → {option?.label ?? "Chưa chọn"}: {option?.description}{notes[item.id] && <span> · Ghi chú: {notes[item.id]}</span>} <button type="button" disabled={busy} onClick={() => setStep(index)}>Sửa</button></p>;
      })}</div>}
      {session.status === "generation_failed" && <p role="alert">Lựa chọn đã được giữ lại; tạo plan chưa hoàn tất ({session.error_code}). Có thể thử lại hoặc sửa lựa chọn.</p>}
      <div className="architecture-clarification-actions">
        <button type="button" disabled={busy || !token} onClick={() => act(() => onSave(session, selections, notes, token, true))}>Hủy yêu cầu</button>
        {step > 0 && <button type="button" disabled={busy} onClick={() => act(async () => { if (token) await onSave(session, selections, notes, token); setStep(step - 1); })}>← Quay lại</button>}
        {question ? <button type="button" disabled={busy || !Object.hasOwn(selections, question.id)} onClick={() => act(async () => { await onSave(session, selections, notes, token); setStep(step + 1); })}>{step + 1 === questions.length ? "Xem lại quyết định" : "Tiếp theo →"}</button> : <button type="button" disabled={busy || !complete || !token} onClick={() => act(() => onConfirm(session, token))}>Xác nhận &amp; tạo plan</button>}
      </div>
    </>}
    {session.status === "completed" && <><ul>{questions.map((item) => <li key={item.id}>{item.title}: {item.options.find((option) => option.id === session.selections[item.id])?.label}</li>)}</ul><p>Đã ghi vào plan. Xác nhận lựa chọn không tự approve plan hoặc RUN.</p><button type="button" disabled={busy} onClick={() => act(() => onOpenPlan(session.result))}>Xem và duyệt plan</button></>}
    {busy && <p role="status">Đang xử lý…</p>}
    {error && <p role="alert">{error} <button type="button" onClick={onReload}>Tải lại phiên</button></p>}
  </section>;
}
