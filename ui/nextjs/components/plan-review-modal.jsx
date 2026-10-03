"use client";
// Lets the project owner inspect and decide the exact immutable plan revision for a sprint.
import { useEffect, useState } from "react";
import { EntityDetailsModal } from "./ticket-detail-modal.jsx";

// Prepares an editable historical sprint draft without inventing approach or evidence.
function legacyDraft(sprint) {
  const tickets = sprint.tickets ?? [];
  return { objective: sprint.objective ?? "", outcome: "", in_scope: "", out_of_scope: "", approach: "", components: [], tickets: tickets.map((ticket) => ticket.id), ticket_specs: tickets, dependencies: sprint.dependencies ?? [], risks: [], assumptions: [], open_questions: [], evidence_refs: [], acceptance_criteria: sprint.exit_criteria ?? [] };
}

// Shows plan scope, evidence, and checksum before submitting an authenticated decision.
export function PlanReviewModal({ client, projectId, sprintId, planId, conversationId, agentId, onClose, onChanged }) {
  const [state, setState] = useState("loading");
  const [registry, setRegistry] = useState(null);
  const [plan, setPlan] = useState(null);
  const [token, setToken] = useState("");
  const [comments, setComments] = useState("");
  const [message, setMessage] = useState("");
  const [draftText, setDraftText] = useState("");
  const [legacyPlan, setLegacyPlan] = useState(null);
  const [legacyDependencies, setLegacyDependencies] = useState([]);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        if (planId) {
          const head = (await client.listPlans(projectId)).find((item) => item.plan_id === planId);
          if (!head) throw new Error("Markdown plan is not indexed.");
          const document = await client.getPlanRevision(projectId, head.plan_id, head.revision);
          if (active) { setPlan(document); setState("ready"); }
          return;
        }
        const schedule = await client.getSprintRegistry(projectId, sprintId);
        const heads = await client.listPlans(projectId);
        const head = heads.find((item) => item.sprint_id === sprintId || item.plan_id === schedule?.plan_id);
        if (!schedule) {
          const sprint = await client.getSprintPlan(projectId, sprintId);
          if (active) setLegacyDependencies(sprint.dependencies ?? []);
          if (head) {
            const document = await client.getPlanRevision(projectId, head.plan_id, head.revision);
            if (active) { setLegacyPlan(document); setPlan(document); setState("ready"); }
            return;
          }
          if (active) { setDraftText(JSON.stringify(legacyDraft(sprint), null, 2)); setState("legacy"); }
          return;
        }
        const document = await client.getPlanRevision(projectId, head?.plan_id ?? schedule.plan_id, head?.revision ?? schedule.plan_revision);
        if (active) { setRegistry(schedule); setLegacyPlan(schedule ? null : document); setPlan(document); setState("ready"); }
      } catch (error) { if (active) setState(error.message); }
    }
    void load();
    return () => { active = false; };
  }, [client, projectId, sprintId, planId]);

  // Registers a historical sprint only after an explicit, reviewable draft exists.
  async function createLegacy() {
    setState("submitting"); setMessage("");
    try {
      const content = JSON.parse(draftText);
      const draft = await client.createPlan(projectId, `PLAN-${sprintId}`, sprintId, content);
      const registered = await client.listSprintRegistry(projectId);
      const schedule = await client.registerSprint(projectId, sprintId, registered.length, legacyDependencies, draft);
      setRegistry(schedule); setPlan(draft); setState("ready");
      await onChanged?.();
    } catch (error) { setMessage(error.message); setState("legacy"); }
  }

  // Creates a new immutable revision when the owner changes scope or requests edits.
  async function revise() {
    setState("submitting"); setMessage("");
    try {
      const revised = await client.revisePlan(projectId, plan, JSON.parse(draftText));
      if (registry) await client.bindSprintPlan(projectId, sprintId, revised);
      setPlan(revised); setEditing(false); setState("ready");
      await onChanged?.();
    } catch (error) { setMessage(error.message); setState("ready"); }
  }

  // Records the owner's decision and activates the approved revision for scheduling.
  async function decide(decision) {
    if (!plan || !token) return;
    setState("submitting"); setMessage("");
    try {
      if (plan.format !== "markdown" && !registry) {
        const registered = await client.listSprintRegistry(projectId);
        setRegistry(await client.registerSprint(projectId, sprintId, registered.length, legacyDependencies, legacyPlan ?? plan));
      } else if (plan.format !== "markdown" && registry.plan_revision !== plan.revision) setRegistry(await client.bindSprintPlan(projectId, sprintId, plan));
      if (plan.format === "markdown" && decision === "approved") {
        if (!(plan.conversation_id ?? conversationId)) throw new Error("Open the Architecture conversation before approving this plan.");
        const result = await client.postOwnerMessage({ projectId, conversationId: plan.conversation_id ?? conversationId, agentId, messageId: `MSG-OWNER-APPROVE-${crypto.randomUUID()}`, correlationId: `CORR-APPROVE-${crypto.randomUUID()}`, text: `/approve ${plan.plan_id}`, ownerToken: token, approvalRevision: plan.revision, approvalSha256: plan.sha256, approvalComments: comments });
        if (result?.message_type === "owner.command.error" || result?.payload?.error) throw new Error(result.payload?.error?.message ?? "Plan handoff failed.");
      } else await client.decidePlan(projectId, plan, decision, token, comments);
      setToken(""); setPlan({ ...plan, status: decision, ...(plan.format === "markdown" && decision === "approved" ? { handoff_status: "completed" } : {}) });
      if (decision === "approved" && !plan.source_path) setRegistry(await client.setSprintStatus(projectId, sprintId, "ready"));
      setMessage(`Revision ${plan.revision}: ${decision}.`);
      setState("decided");
      await onChanged?.();
    } catch (error) { setMessage(error.message); setState("ready"); }
  }

  // Retries sprint readiness after approval when an operational dependency becomes satisfied.
  async function markReady() {
    setState("submitting"); setMessage("");
    try { setRegistry(await client.setSprintStatus(projectId, sprintId, "ready")); setMessage("Sprint is ready."); setState("ready"); await onChanged?.(); }
    catch (error) { setMessage(error.message); setState("ready"); }
  }

  return <EntityDetailsModal title={`Review plan · ${sprintId ?? planId}`} onClose={onClose}>
    {state === "loading" && <p>Loading plan revision…</p>}
    {state === "legacy" && <div className="plan-review-content"><p>This historical sprint has no plan revision. Complete the scope, approach, components and evidence fields, then create a draft for owner review.</p><label>Plan JSON<textarea rows={18} value={draftText} onChange={(event) => setDraftText(event.target.value)} /></label><button type="button" onClick={createLegacy}>Create draft</button>{message && <p role="alert">{message}</p>}</div>}
    {state !== "loading" && state !== "legacy" && state !== "ready" && state !== "submitting" && state !== "decided" && <p role="alert">{state}</p>}
    {plan && <div className="plan-review-content">
      <p><strong>Plan:</strong> {plan.plan_id} · revision {plan.revision} · {plan.status}</p>
      <p><strong>SHA-256:</strong> <code>{plan.sha256}</code></p>
      {plan.format === "markdown" ? <><p>Review this Markdown revision and its SHA-256 before approving. Approval authorizes Sprint Leader to draft a Sprint Plan; it does not start RUN.</p><pre className="plan-review-markdown">{plan.markdown}</pre></> : <>
      <p><strong>Objective:</strong> {plan.content.objective}</p>
      <p><strong>Outcome:</strong> {plan.content.outcome}</p>
      <p><strong>In scope:</strong> {plan.content.in_scope}</p>
      <p><strong>Out of scope:</strong> {plan.content.out_of_scope}</p>
      <p><strong>Approach:</strong> {plan.content.approach}</p>
      {[["Components", "components"], ["Tickets", "tickets"], ["Dependencies", "dependencies"], ["Risks", "risks"], ["Assumptions", "assumptions"], ["Open questions", "open_questions"], ["Evidence", "evidence_refs"], ["Acceptance criteria", "acceptance_criteria"]].map(([label, key]) => <section key={key}><h3>{label}</h3><ul>{(plan.content[key] ?? []).map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></section>)}
      {(plan.content.ticket_specs ?? []).map((ticket) => <section key={ticket.id}><h3>{ticket.id}: {ticket.title}</h3><p>{ticket.objective}</p><ul>{(ticket.acceptance_criteria ?? []).map((criterion, index) => <li key={`${index}-${criterion}`}>{criterion}</li>)}</ul></section>)}
      </>}
      {!editing && plan.format !== "markdown" && <button type="button" onClick={() => { setDraftText(JSON.stringify(plan.content, null, 2)); setEditing(true); }}>Create revised draft</button>}
      {editing && <><label>Revised plan JSON<textarea rows={18} value={draftText} onChange={(event) => setDraftText(event.target.value)} /></label><div className="settings-actions"><button type="button" disabled={state === "submitting"} onClick={revise}>Save revision</button><button type="button" onClick={() => setEditing(false)}>Cancel edit</button></div></>}
      {!editing && (plan.status === "awaiting_human_approval" || plan.format === "markdown" && plan.status === "approved" && plan.handoff_status !== "completed") && <div className="plan-review-decision-fields"><label>Owner token<input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Enter owner token" /></label>{plan.status === "awaiting_human_approval" && <label>Review comments<textarea value={comments} onChange={(event) => setComments(event.target.value)} rows={3} placeholder="Optional note for this decision" /></label>}<div className="settings-actions"><button type="button" disabled={!token || state === "submitting"} onClick={() => decide("approved")}>{plan.status === "approved" ? "Continue handoff" : "Approve"}</button>{plan.status === "awaiting_human_approval" && <><button type="button" disabled={!token || state === "submitting"} onClick={() => decide("changes_requested")}>Request changes</button><button type="button" disabled={!token || state === "submitting"} onClick={() => decide("rejected")}>Reject</button></>}</div></div>}
      {plan.status === "approved" && registry && !["ready", "running", "done"].includes(registry.status) && <button type="button" disabled={state === "submitting"} onClick={markReady}>Mark sprint ready</button>}
      {message && <p role="status">{message}</p>}
    </div>}
  </EntityDetailsModal>;
}
