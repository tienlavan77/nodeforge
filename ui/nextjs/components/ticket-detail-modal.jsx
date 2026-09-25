'use client';
// View and manage sprint tickets with regenerated English content.

import { useMemo, useRef, useState, useEffect } from "react";
import { createPortal } from "react-dom";

// Sorts tickets with incomplete items first.
export function sortSprintTickets(tickets = []) {
  return tickets
    .map((ticket, index) => ({ ticket, index }))
    .sort((left, right) => Number(String(left.ticket.status ?? "").toLowerCase() === "done") - Number(String(right.ticket.status ?? "").toLowerCase() === "done") || left.index - right.index)
    .map(({ ticket }) => ticket);
}

// Card displaying a single ticket with run and delete actions.
export function TicketCard({ ticket, client, projectId, onRefresh, onDeleted }) {
  const [message, setMessage] = useState("");
  const [viewOpen, setViewOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  async function view() {
    try { setDetail(await client.getTicket(projectId, ticket.id)); }
    catch (error) {
      console.error("Unable to load ticket details", error);
      setDetail(ticket);
    }
    setViewOpen(true);
  }
  async function run({ fresh = false } = {}) {
    try {
      const response = await client.runTicket(projectId, ticket.id, { fresh });
      const status = response?.status;
      if (status === "accepted" || status === "started") setMessage(response?.resumed ? `Đã resume ${ticket.id} từ turn ${response.resumed_from_turn ?? "?"}, đang xử lý…` : `Đã gửi ${ticket.id} cho Supervisor, đang xử lý…`);
      else if (status === "already_running") setMessage(`${ticket.id} đang chạy.`);
      else if (status === "failed") setMessage(`${ticket.id} retry thất bại.`);
      else setMessage(`${ticket.id}: ${status ?? "đã gửi yêu cầu chạy"}`);
    } catch (error) { setMessage(error.message); }
  }
  async function remove() {
    if (!window.confirm(`Delete ticket ${ticket.id}?`)) return;
    try { await client.deleteTicket(projectId, ticket.id); onDeleted?.(ticket.id); setMessage("Deleted"); }
    catch (error) { setMessage(error.message); }
  }
  const resumable = ticket.checkpoint?.resumable === true;
  const disabled = ticket.status === "done" || ticket.status === "running";
  return <><article className="dashboard-ticket"><div><strong>{ticket.id}</strong><span className="priority">{ticket.priority}</span></div><p>{ticket.title}</p><small><span className={`ticket-status ticket-status-${ticket.status ?? "planned"}`}>{ticket.status ?? "planned"}</span> · {ticket.progress}%</small>{resumable && <small className="ticket-checkpoint">Có checkpoint dở ở turn {ticket.checkpoint.last_completed_turn ?? "?"}{ticket.checkpoint.last_tool ? ` (tool cuối: ${ticket.checkpoint.last_tool})` : ""}.</small>}<div className="ticket-actions"><button className="sprint-view-button small" onClick={view}>View</button>{resumable ? <button className="sprint-run-button small is-resume" onClick={() => run()} disabled={disabled}>Resume</button> : null}{resumable ? <button className="sprint-run-button small" onClick={() => run({ fresh: true })} disabled={disabled}>Run fresh</button> : <button className="sprint-run-button small" onClick={() => run()} disabled={disabled}>Run</button>}<button className="sprint-delete-button small" onClick={remove} disabled={disabled}>Delete</button></div>{message && <small>{message}</small>}</article>{viewOpen && <TicketModal ticket={detail ?? ticket} client={client} projectId={projectId} onRefreshed={(updatedTicket) => { setDetail(updatedTicket); onRefresh?.(); }} onClose={() => { setViewOpen(false); setDetail(null); }} />}</>;
}

// Extracts Vietnamese context from a ticket.
function ticketVietnameseContext(ticket) {
  const context = ticket.context ?? ticket.vietnamese_context ?? ticket.original_vietnamese_context ?? ticket.content_vi;
  return context == null ? "" : typeof context === "string" ? context : JSON.stringify(context, null, 2);
}

// Builds English content text from ticket fields.
function ticketEnglishContent(ticket) {
  const explicit = ticket.english_content ?? ticket.regenerated_english_content ?? ticket.generated_content ?? ticket.content_en;
  if (explicit) return String(explicit);
  return [
    ticket.title ? `Title: ${ticket.title}` : "",
    ticket.objective ? `Objective: ${ticket.objective}` : "",
    (ticket.acceptance_criteria ?? []).length ? `Acceptance criteria:\n${ticket.acceptance_criteria.map((item) => `- ${item}`).join("\n")}` : ""
  ].filter(Boolean).join("\n\n");
}

// Normalizes Vietnamese text for diff comparison.
function normalizeVietnameseContextForDiff(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

// Modal for editing Vietnamese context and regenerating English.
function TicketModal({ ticket, client, projectId, onRefreshed, onClose }) {
  const initialVietnameseContext = useMemo(() => ticketVietnameseContext(ticket), [ticket]);
  const originalVietnameseContextRef = useRef(initialVietnameseContext);
  const [vietnameseContext, setVietnameseContext] = useState(initialVietnameseContext);
  const [englishContent, setEnglishContent] = useState(ticketEnglishContent(ticket));
  const [generatedFields, setGeneratedFields] = useState(() => ({
    title: ticket.title ?? "",
    objective: ticket.objective ?? "",
    acceptance_criteria: Array.isArray(ticket.acceptance_criteria) ? ticket.acceptance_criteria : [],
  }));
  const [submitState, setSubmitState] = useState("idle");
  const [error, setError] = useState("");
  const ticketIdRef = useRef(ticket.id);
  useEffect(() => {
    if (ticket.id !== ticketIdRef.current) {
      ticketIdRef.current = ticket.id;
      originalVietnameseContextRef.current = initialVietnameseContext;
      setVietnameseContext(initialVietnameseContext);
      setEnglishContent(ticketEnglishContent(ticket));
      setGeneratedFields({
        title: ticket.title ?? "",
        objective: ticket.objective ?? "",
        acceptance_criteria: Array.isArray(ticket.acceptance_criteria) ? ticket.acceptance_criteria : [],
      });
    }
  }, [ticket.id, initialVietnameseContext, ticket]);
  const hasVietnameseContextEdit = normalizeVietnameseContextForDiff(vietnameseContext) !== normalizeVietnameseContextForDiff(originalVietnameseContextRef.current);
  async function submitContentChange(event) {
    event.preventDefault();
    if (!hasVietnameseContextEdit) return;
    setSubmitState("submitting");
    setError("");
    const payload = { project_id: projectId, sprint_id: ticket.sprint_id ?? ticket.sprintId ?? null, context: vietnameseContext };
    try {
      const response = client?.regenerateTicketEnglish
        ? await client.regenerateTicketEnglish(projectId, ticket.id, payload)
        : await fetch(`/forge/v1/tickets/${encodeURIComponent(ticket.id)}?project=${encodeURIComponent(projectId)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).then(async (res) => { if (!res.ok) throw new Error(await res.text() || `Request failed (${res.status})`); return res.json(); });
      const updatedTicket = response?.ticket ?? response?.data?.ticket ?? (response?.id ? response : null);
      const generated = updatedTicket ?? response?.data ?? response;
      const nextFields = {
        title: generated?.title ?? "",
        objective: generated?.objective ?? "",
        acceptance_criteria: Array.isArray(generated?.acceptance_criteria) ? generated.acceptance_criteria : [],
      };
      const regenerated = response?.english_content ?? response?.regenerated_english_content ?? response?.content ?? response?.ticket?.english_content ?? response?.ticket?.regenerated_english_content ?? response?.ticket?.content_en ?? response?.ticket?.generated_content ?? updatedTicket?.english_content ?? updatedTicket?.content_en ?? response?.ticket?.objective;
      if (nextFields.title || nextFields.objective || nextFields.acceptance_criteria.length) setGeneratedFields(nextFields);
      if (!regenerated && !updatedTicket) throw new Error("Backend did not return regenerated English ticket content.");
      const sourceContext = String(vietnameseContext ?? "");
      let nextEnglish = regenerated != null ? String(regenerated) : updatedTicket ? ticketEnglishContent(updatedTicket) : "";
      if (sourceContext && nextEnglish && nextEnglish.trim() === sourceContext.trim()) nextEnglish = "";
      if (sourceContext && nextEnglish.includes(sourceContext) && sourceContext.length > 20) nextEnglish = nextEnglish.replace(sourceContext, "").trim();
      if (nextEnglish) setEnglishContent(nextEnglish);
      else if (updatedTicket) setEnglishContent(ticketEnglishContent(updatedTicket));
      else if (regenerated != null) setEnglishContent(String(regenerated));
      try {
        await onRefreshed?.(updatedTicket ?? response?.ticket ?? { ...ticket, english_content: String(regenerated) });
      } catch (refreshError) {
        throw new Error(`English ticket regenerated, but the dashboard refresh failed: ${refreshError?.message ?? String(refreshError)}`);
      }
      setSubmitState("done");
      setError("");
    } catch (err) {
      setError(`Regeneration failed: ${err?.message ?? String(err)}`);
      setSubmitState("error");
    }
  }
  return <EntityDetailsModal title={ticket.id} modalClassName="ticket-language-modal" onClose={onClose}><div className="ticket-language-summary"><p className="sprint-objective">{generatedFields.title || ticket.title}</p><p><strong>Status:</strong> {ticket.status} · {ticket.progress}%</p><dl className="ticket-generated-fields"><dt>Objective</dt><dd>{generatedFields.objective || "—"}</dd><dt>Acceptance criteria</dt><dd>{generatedFields.acceptance_criteria.length ? <ul>{generatedFields.acceptance_criteria.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul> : "—"}</dd></dl></div><form className="ticket-content-change-panel" onSubmit={submitContentChange}><label htmlFor={`ticket-vietnamese-context-${ticket.id}`}>Vietnamese context<textarea id={`ticket-vietnamese-context-${ticket.id}`} value={vietnameseContext} onChange={(event) => setVietnameseContext(event.target.value)} rows={8} placeholder="Enter Vietnamese context..." /></label><div className="ticket-regenerate-actions"><button className="ticket-regenerate-button" type="submit" disabled={!hasVietnameseContextEdit || submitState === "submitting"}>{submitState === "submitting" ? "Generating…" : "Generate English"}</button></div>{error && <p className="dashboard-state error" role="alert">{error}</p>}{submitState === "done" && !error && <p className="dashboard-state" role="status">English ticket generated.</p>}</form></EntityDetailsModal>;
}

// Generic modal for displaying entity details.
export function EntityDetailsModal({ title, state, modalClassName = "", onClose, children }) {
  const content = <div className="sprint-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className={`sprint-modal ${modalClassName}`.trim()} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button onClick={onClose} aria-label="Close details">&#215;</button></header><div className="sprint-modal-content">{state === "loading" && <p className="dashboard-state">Loading...</p>}{state && state !== "loading" && state !== "ready" && <p className="dashboard-state error">{state}</p>}{(!state || state === "ready") && children}</div></section></div>;
  return typeof document === "undefined" ? null : createPortal(content, document.body);
}
