/** Presents the exact technical question to the Owner and submits an authenticated
 * answer bound to its request, job and execution, separately from plan approval. */
'use client';
import { useState } from "react";

/** Keeps the question visible while collecting a direct response. The server
 * records the answer for SL; it never treats this form as a tool approval receipt. */
export function TicketBlockerOwnerInput({ request, response, onRespond }) {
  const [answer, setAnswer] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  /** Sends the displayed request identity so a changed question or execution
   * cannot accidentally consume an answer intended for the earlier checkpoint. */
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await onRespond({ request_id: request.request_id, job_id: request.job_id, execution_id: request.execution_id, answer: answer.trim(), token });
      setToken(""); setSaved(true);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  return <section aria-label="Owner response required">
    <h4>{request.kind === "tool_authorization" ? "Cần Owner xác nhận thao tác bị từ chối" : "Cần phản hồi / bằng chứng từ bên ngoài"}</h4>
    <p style={{ whiteSpace: "pre-wrap" }}><strong>Câu hỏi:</strong> {request.question}</p>
    <p style={{ whiteSpace: "pre-wrap" }}><strong>Bối cảnh:</strong> {request.context}</p>
    <p>Phản hồi được gửi về SL tại checkpoint hiện tại. Quyền công cụ vẫn được kiểm tra khi thực thi; đây không phải duyệt plan hay nghiệm thu ticket.</p>
    {response || saved ? <p role="status">Đã ghi phản hồi Owner. Node chuyển về SL để tiếp tục từ checkpoint.{response ? ` ${response.answer}` : ""}</p>
      : onRespond && <form onSubmit={submit}>
        <label>Phản hồi của Owner<textarea value={answer} onChange={(event) => setAnswer(event.target.value)} maxLength={8000} rows={4} required /></label>
        <label>Owner token<input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} required /></label>
        <button type="submit" disabled={busy || !answer.trim() || !token}>{busy ? "Đang gửi…" : "Gửi phản hồi cho SL"}</button>
        {error && <p role="alert">{error}</p>}
      </form>}
  </section>;
}
