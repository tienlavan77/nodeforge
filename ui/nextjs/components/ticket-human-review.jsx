'use client';
// Lets the project owner inspect Reviewer findings and approve a ticket explicitly.
import { useEffect, useState } from "react";

// Shows the saved verdict before allowing a reasoned Human Review decision.
export function TicketHumanReview({ ticket, client, projectId, autoOpen = false, onApproved }) {
  const [open, setOpen] = useState(autoOpen);
  const [review, setReview] = useState(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  // Loads findings when the owner opens Human Approve from the ticket card.
  useEffect(() => {
    if (!autoOpen) return;
    let active = true;
    client.getTicketHumanReview(projectId, ticket.id)
      .then((result) => { if (active) setReview(result); })
      .catch((failure) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [autoOpen, client, projectId, ticket.id]);

  // Loads the latest checkpoint each time the owner opens the review panel.
  async function showReview() {
    if (open) { setOpen(false); return; }
    setBusy(true); setError("");
    try { setReview(await client.getTicketHumanReview(projectId, ticket.id)); setOpen(true); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  // Sends an explicit owner decision bound to the displayed Reviewer checkpoint.
  async function approve() {
    setBusy(true); setError("");
    try {
      await client.approveTicketHumanReview(projectId, ticket.id, { actor: "project_owner", reason, reviewerUpdatedAt: review.reviewer.updated_at });
      setReview(await client.getTicketHumanReview(projectId, ticket.id));
      setMessage("Human Review approved. Ticket marked done.");
      await onApproved?.(await client.getTicket(projectId, ticket.id));
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  return <section className="ticket-human-review ticket-content-change-panel" aria-label="Ticket Human Review">
    {!autoOpen && <button type="button" onClick={showReview} disabled={busy}>{busy ? "Loading…" : "Human Review"}</button>}
    {open && <div>
      <p><strong>Reviewer verdict:</strong> {review?.reviewer?.verdict ?? (error ? "Unavailable" : "Loading…")}</p>
      {review?.reviewer?.findings?.length > 0 && <ul>{review.reviewer.findings.map((finding, index) => <li key={`${index}-${finding}`}>{finding}</li>)}</ul>}
      {review?.eligible && <><p>Approval accepts these findings and marks the ticket done. Commits on a separate ticket branch still need integration into the main project.</p>
        <label htmlFor={`human-review-reason-${ticket.id}`}>Reason for approval</label>
        <textarea id={`human-review-reason-${ticket.id}`} value={reason} onChange={(event) => setReason(event.target.value)} rows={3} placeholder="Explain why you accept the Reviewer findings" />
        <button className="ticket-regenerate-button" type="button" onClick={approve} disabled={busy || !reason.trim()}>{busy ? "Approving…" : "Approve Human Review"}</button>
        {!reason.trim() && <p>Enter a reason to enable approval.</p>}
      </>}
      {review?.approved && <p>Approved by {review.decision?.actor}: {review.decision?.explanation}</p>}
      {!review?.eligible && !review?.approved && <p>Human Review is available after the Coder finishes and the Reviewer requests changes.</p>}
    </div>}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
