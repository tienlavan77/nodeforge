/** Maps live response contracts to role-specific tasks. Public IDs describe the
 * business task; source references reuse existing validators instead of creating
 * a second protocol or accepting caller-selected schema files. */
export const AGENT_SCHEMA_CATALOG = Object.freeze([
  { schema_id: "coder.completion_report.v1", role: "coder", task: "completion_report", delivery: "tool:report_done", source: "agent/tools/report-done.schema.json", purpose: "Submit completion evidence or a blocked report to Node.", keywords: "report done bao cao hoan tat blocker consultation tham van", example: { status: "completed", summary: "Implemented the assigned behavior; Node verifies the recorded commit." } },
  { schema_id: "coder.review_response.v1", role: "coder", task: "review_response", delivery: "tool:respond_to_review", source: "agent/tools/respond-to-review.schema.json", purpose: "Respond to persisted Reviewer findings or request focused verification.", keywords: "finding review repair phan hoi sua loi", example: null },
  { schema_id: "coder.work_progress.v1", role: "coder", task: "work_progress", delivery: "exchange:work_progress", payload: "work_progress", envelope: true, purpose: "Yield completed discovery, implementation or verification without claiming ticket completion.", keywords: "progress discovery khao sat tien do", example: { kind: "work_progress", subject: "Discovery complete", evidence: [], payload: { status: "discovery_complete", next_action: "implement", summary: "Located the affected handler and focused regression.", remaining_work: ["Implement the accepted repair."] } } },
  { schema_id: "coder.candidate_result.v1", role: "coder", task: "candidate_result", delivery: "exchange:work_result", request: "work_request", purpose: "Return the read-only candidate requested by SL; this does not implement or commit it.", keywords: "candidate proposal de xuat dossier", example: null },
  { schema_id: "coder.consultation_request.v1", role: "coder", task: "consultation_request", delivery: "report_done.blocker.consultation", payload: "consultation_request", purpose: "Ask Sprint Leader one precise unresolved question; never consult AM directly.", keywords: "question decision tham van quyet dinh", example: null },
  { schema_id: "reviewer.review_result.v1", role: "reviewer", task: "review_result", delivery: "exchange:review_result", request: "review_request", purpose: "Return the ticket review verdict, findings and adjudications, or a typed verification request.", keywords: "verdict finding review ket qua danh gia", example: null },
  { schema_id: "reviewer.evidence_result.v1", role: "reviewer", task: "evidence_result", delivery: "exchange:review_result", request: "review_request", evidence: true, purpose: "Answer AM's independent evidence question on the assigned commit and artifact without a verdict.", keywords: "architecture evidence bang chung am", example: null },
  { schema_id: "sprint_leader.blocker_decision.v1", role: "sprint_leader", task: "blocker_decision", delivery: "exchange:consultation_response", request: "consultation_request", purpose: "Decide the next blocker step: resume Coder, request approved upstream dependency repair, consult AM or identify missing evidence.", keywords: "decision blocker quyet dinh giao coder", example: null },
  { schema_id: "sprint_leader.consultation_request.v1", role: "sprint_leader", task: "consultation_request", delivery: "consultation_response.payload.consultation", payload: "consultation_request", purpose: "Ask AM a focused technical question with known decisions and implementation impact.", keywords: "architecture question tham van am", example: null },
  { schema_id: "sprint_leader.sprint_plan.v1", role: "sprint_leader", task: "sprint_plan", delivery: "json_response", source: "governance/sprint-plan.schema.json", draft: "sprint", purpose: "Create the Sprint draft and tickets from approved Architecture scope.", keywords: "sprint plan ticket ke hoach", example: null },
  { schema_id: "sprint_leader.ticket_draft.v1", role: "sprint_leader", task: "ticket_draft", delivery: "json_response", source: "governance/ticket.schema.json", draft: "ticket", purpose: "Draft one ticket; Node assigns project, Sprint, status and provenance fields.", keywords: "ticket draft tao ticket", example: null },
  { schema_id: "architecture_manager.blocker_decision.v1", role: "architecture_manager", task: "blocker_decision", delivery: "exchange:consultation_response", request: "consultation_request", purpose: "Answer SL within approved Architecture authority; consult Owner only for an evidenced scope or structure boundary.", keywords: "decision technical architecture quyet dinh ky thuat", example: null },
  { schema_id: "architecture_manager.architecture_plan.v1", role: "architecture_manager", task: "architecture_plan", delivery: "json_response", contract: "architecture_plan", purpose: "Return the canonical Architecture Plan JSON (or an RFC 7396 JSON merge patch when updating a plan) used by Node to validate, lock and render the owner's reviewable plan.", keywords: "plan architecture ke hoach kien truc json merge patch outcome", example: {
    title: "<Outcome-oriented plan title>", objective: "<Problem solved, observable target result and business value>", background: "<Observed current system behavior and root cause>",
    scope: ["In scope: <Required capability or outcome>", "Out of scope: <Excluded behavior or refactor>"],
    outcomes: [{ id: "O1", outcome: "<Observable architecture deliverable>", acceptance_criteria: ["<Concrete observable acceptance criterion>"], guardrails: ["<Preserved contract or security boundary>"] }],
    evidence: [{ path: "backend/src/example.js", fact: "<Replace with an inspected source fact>", location: "L1-L10" }],
    assumptions: ["<Explicit unverified assumption or delegated Sprint Leader boundary>"],
    constraints: ["<Global contract, data, security or compatibility constraint>"],
    risks: ["[Major] <Risk description> — Impact: <effect> — Mitigation: <owner/action>"],
    verification: "<Plan-level verification strategy that Sprint Leader tickets must cover>" } },
  { schema_id: "architecture_manager.owner_consultation.v1", role: "architecture_manager", task: "owner_consultation", delivery: "consultation_response.payload.consultation", payload: "consultation_request", purpose: "Ask Owner about a specific evidenced approved-scope or project-structure boundary.", keywords: "owner human boundary chu du an", example: null },
  { schema_id: "system_engineer.handoff.v1", role: "system_engineer", task: "handoff", delivery: "text_response", purpose: "Report engineering results, executed checks, evidence paths and remaining work to the requester. SE is outside the ticket role pipeline.", keywords: "handoff report infrastructure ban giao bao cao", example: "Prepared the requested environment. Focused checks: 3 passed. Evidence: docs/environment-receipt.md. Remaining work: none." },
  { schema_id: "linguist.response.v1", role: "linguist", task: "response", delivery: "text_response", purpose: "Answer the owner's language request in the requested format.", keywords: "language translation ngon ngu dich", example: "Completed the requested wording review." }
]);

/** Returns only descriptors owned by the authenticated role, without exposing
 * model-supplied role overrides or obsolete protocol aliases. */
export function agentSchemaEntries(role) {
  return AGENT_SCHEMA_CATALOG.filter((entry) => entry.role === role);
}

/** Names the request-bound contract in prompts and validation feedback without
 * asking the model to supply or replace Node-owned routing metadata. */
export function agentResponseSchemaId(role, kind, purpose) {
  const task = { consultation_response: "blocker_decision", work_progress: "work_progress", work_result: "candidate_result",
    review_result: purpose === "blocker_evidence" ? "evidence_result" : "review_result" }[kind];
  return agentSchemaEntries(role).find((entry) => entry.task === task)?.schema_id ?? null;
}
