// Shows Sprint-specific owner policy proposals and recommendations before immutable plan approval.
"use client";
import { useId } from "react";

// Presents explicit choices without silently accepting Sprint Leader recommendations.
export function PlanDecisionRequests({ requests = [], selections = {}, onChange, disabled = false }) {
  const scope = useId();
  if (!requests.length) return null;
  return <section aria-label="Owner decisions before Sprint Plan approval">
    <h3>Quyết định cần duyệt ({requests.length})</h3>
    <p>Chọn từng phương án trước khi duyệt Sprint Plan. Đề xuất của SL chưa phải quyết định của owner.</p>
    {requests.map((request) => <fieldset key={request.id} disabled={disabled}>
      <legend>{request.title}</legend><p>{request.reason}</p>
      <p>Ticket: {request.ticket_ids.join(", ")} · {request.criterion_ids.join(", ")}</p>
      {!request.options.length && <p role="alert">SL chưa đề xuất phương án. Tạo revision bổ sung phương án trước khi duyệt.</p>}
      {request.options.map((option) => <label key={option.id} style={{ display: "block", marginBottom: "0.75rem" }}>
        <input type="radio" name={`decision-${scope}-${request.id}`} value={option.id} checked={selections[request.id] === option.id} disabled={!onChange || disabled} onChange={() => onChange?.(request.id, option.id)} />
        <strong>{option.label}{request.recommended_option_id === option.id ? " — SL đề xuất" : ""}</strong>
        <p>{option.description}</p>
      </label>)}
    </fieldset>)}
  </section>;
}
