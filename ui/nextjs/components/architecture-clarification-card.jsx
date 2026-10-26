// Lets the owner answer Architecture questions, review the choices and generate a plan without approving it implicitly.
"use client";
import { useEffect, useId, useRef, useState } from "react";
import { architectureClarificationError } from "../lib/architecture-clarification-error.js";

// Shows a durable, source-bound question wizard with explicit choices and a separate confirmation step.
export function ArchitectureClarificationCard({ session, onSave, onConfirm, onReload, onReanalyze }) {
  const [step, setStep] = useState(session.status === "generation_failed" ? session.questions.length : 0);
  const [selections, setSelections] = useState(session.selections);
  const [notes, setNotes] = useState(session.notes);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const scope = useId();
  const basis = `${session.session_id}:${session.version}:${session.status}`;
  const draftBasis = useRef(basis);
  useEffect(() => {
    if (draftBasis.current === basis) return;
    draftBasis.current = basis;
    setSelections(session.selections); setNotes(session.notes);
    if (session.status === "generation_failed") setStep(session.questions.length);
  }, [basis, session.selections, session.notes, session.status, session.questions.length]);
  const questions = session.questions;
  const generating = session.status === "generating";
  const editable = ["awaiting_owner_decisions", "generation_failed"].includes(session.status);
  const complete = questions.every((question) => Object.hasOwn(selections, question.id));
  const question = questions[step];
  const unsaved = JSON.stringify(selections) !== JSON.stringify(session.selections) || JSON.stringify(notes) !== JSON.stringify(session.notes);

  // Serializes owner actions and leaves failed confirmations retryable without losing server-persisted answers.
  async function act(action) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try { await action(); }
    catch (reason) { setError(architectureClarificationError(reason)); }
    finally { inFlight.current = false; setBusy(false); }
  }

  // Selects an explicit owner policy locally and persists it when owner authentication is supplied.
  async function choose(optionId) {
    if (inFlight.current) return;
    const next = { ...selections, [question.id]: optionId };
    setSelections(next);
    if (token) await act(() => onSave(session, next, notes, token));
  }

  if (["completed", "cancelled"].includes(session.status)) return null;
  return <section className="architecture-clarification-card" aria-label="Architecture owner decisions">
    <h3>{generating ? "Đang tạo kế hoạch" : session.status === "generation_failed" ? "Chưa tạo được plan" : "Architecture cần owner chốt quyết định"}</h3>
    <p className="architecture-clarification-source">Nguồn: <code>{session.source_path}</code>{questions.length > 0 && <> · {Object.keys(selections).length}/{questions.length} lựa chọn · {Object.keys(session.selections).length} đã lưu</>}</p>
    {session.status === "source_changed" && <><p role="alert">File nguồn đã thay đổi. Không dùng các lựa chọn cũ để tạo plan.</p><button type="button" onClick={() => act(() => onReanalyze(session))} disabled={busy}>Phân tích lại nguồn</button></>}
    {session.status === "cancelled" && <p>Yêu cầu đã hủy. Không tạo plan hoặc chạy ticket.</p>}
    {generating && <p role="status">{questions.length ? "Đang tạo plan từ các quyết định đã chốt." : "Architecture đang tạo plan từ cuộc trao đổi. Không cần nhập Owner token hoặc gửi lại yêu cầu."}</p>}
    {editable && <>
      <p>{session.status === "generation_failed" ? "Không cần trả lời lại các lựa chọn đã lưu. Có thể thử tạo plan lại hoặc sửa lựa chọn; thao tác này không phải approval plan." : "Chờ owner quyết định. Khuyến nghị chưa được chọn sẵn. Xác nhận lựa chọn không phải approval plan."}</p>
      <label className="architecture-clarification-token">Owner token <input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Nhập để lưu và xác nhận lựa chọn" /></label>
      {unsaved && <p role="status">Lựa chọn hoặc ghi chú chưa được lưu. Nhập Owner token để lưu hoặc xác nhận; reload sẽ mất phần nháp chưa lưu.</p>}
      <nav aria-label="Tiến độ câu hỏi">{questions.map((item, index) => <button type="button" key={item.id} aria-current={step === index ? "step" : undefined} disabled={busy} onClick={() => act(async () => { if (token) await onSave(session, selections, notes, token); setStep(index); })}>{index + 1}. {item.title}{Object.hasOwn(selections, item.id) ? " ✓" : ""}</button>)}</nav>
      {question ? <fieldset disabled={busy}>
        <legend>Câu {step + 1}/{questions.length} — {question.title}</legend><p>{question.reason}</p>
        {question.options.map((option, index) => <label className="architecture-clarification-option" key={option.id}>
          <input type="radio" name={`${scope}-${question.id}`} checked={selections[question.id] === option.id} onChange={() => choose(option.id)} />
          <span><strong>{index + 1}. {option.label}</strong>{question.recommended_option_id === option.id && <span className="architecture-clarification-recommendation">Khuyến nghị</span>}<span className="architecture-clarification-description">{option.description}</span></span>
        </label>)}
        <label className="architecture-clarification-notes">Ghi chú của owner<textarea value={notes[question.id] ?? ""} maxLength={2000} onChange={(event) => setNotes({ ...notes, [question.id]: event.target.value })} /></label>
      </fieldset> : <div className="architecture-clarification-review"><h4>Xem lại quyết định</h4>{questions.map((item, index) => {
        const option = item.options.find((entry) => entry.id === selections[item.id]);
        return <p key={item.id}><strong>{item.title}</strong> → {option?.label ?? "Chưa chọn"}: {option?.description}{notes[item.id] && <span> · Ghi chú: {notes[item.id]}</span>} <button type="button" disabled={busy} onClick={() => setStep(index)}>Sửa</button></p>;
      })}</div>}
      {session.status === "generation_failed" && !error && <p role="alert">{architectureClarificationError(session).message}</p>}
      <div className="architecture-clarification-actions">
        <button type="button" disabled={busy || !token} onClick={() => act(() => onSave(session, selections, notes, token, true))}>Hủy yêu cầu</button>
        <button type="button" disabled={busy || !token || !unsaved} onClick={() => act(() => onSave(session, selections, notes, token))}>Lưu lựa chọn</button>
        {step > 0 && <button type="button" disabled={busy} onClick={() => act(async () => { if (token) await onSave(session, selections, notes, token); setStep(step - 1); })}>← Quay lại</button>}
        {question ? <button className="architecture-clarification-primary" type="button" disabled={busy || !Object.hasOwn(selections, question.id)} onClick={() => act(async () => { if (token) await onSave(session, selections, notes, token); setStep(step + 1); })}>{step + 1 === questions.length ? "Xem lại quyết định" : "Tiếp theo →"}</button> : <button className="architecture-clarification-primary" type="button" disabled={busy || !complete || !token} onClick={() => act(async () => { const current = unsaved ? await onSave(session, selections, notes, token) : session; await onConfirm(current, token); })}>{session.status === "generation_failed" ? "Thử tạo plan lại" : "Xác nhận & tạo plan"}</button>}
      </div>
    </>}
    {busy && <p role="status">Đang xử lý…</p>}
    {error && <p role="alert">{error.message} {error.reload && <button type="button" disabled={busy} onClick={() => act(onReload)}>Cập nhật lựa chọn</button>}</p>}
  </section>;
}
