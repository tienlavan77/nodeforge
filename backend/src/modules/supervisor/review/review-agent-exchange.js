/** Connects independent review and finding repair to shared agent messages while
 * retaining the existing finding IDs, verdict validators and artifact authority. */
import { createFileService } from "../../../infrastructure/filesystem/file-service.js";
import { createAgentExchange, bindAgentExchangeResponse } from "../../governance/agent-exchange.js";
import { createAgentExchangeStorage } from "../../governance/agent-exchange-storage.js";
import { agentExchangePrompt } from "../../governance/agent-exchange-prompt.js";

/** Creates a source-bound Coder-to-Reviewer request; unbound legacy diagnostic
 * callers retain the old transport until their runtime identities are available. */
export async function prepareReviewExchange({ job, reviewer, sourceRef, coderReport, exchange, projectRoot, projectLogger }) {
  if (!job.project_id || !job.payload?.execution_id || !job.agent_id) return null;
  const storage = createAgentExchangeStorage({ fileService: createFileService({ projectRoot, role: "system_engineer" }), projectLogger });
  const request = createAgentExchange({ context: { project_id: job.project_id, ticket_id: job.task_id, execution_id: job.payload.execution_id },
    sender: { agent_id: job.agent_id, role: "coder" }, recipient: { agent_id: reviewer.agent_id, role: "reviewer" },
    kind: "review_request", subject: "Review the submitted ticket source and adjudicate current findings.",
    payload: { source_ref: sourceRef, criterion_ids: (job.payload.ticket?.acceptance_criteria ?? []).map((_, index) => `AC-${index + 1}`),
      report_ref: coderReport?.idempotency_key ?? coderReport?.artifact_id ?? null, finding_refs: (exchange?.findings ?? []).map((entry) => entry.finding_id) },
    continuation: { assignment_id: job.request_id || job.id, checkpoint_ref: `task/${job.task_id}/review-checkpoint` } });
  const requestRef = await storage.save(request);
  return { request, requestRef, storage, prompt: agentExchangePrompt(request, "review_result") };
}

/** Decodes explicit shared review results without deciding whether findings are
 * valid; the existing strict Reviewer contract checks their substance next. */
export function decodeReviewExchange(value, request) {
  const response = bindAgentExchangeResponse(value, request);
  return { verdict: response.payload.verdict, findings: response.payload.findings, adjudications: response.payload.finding_updates,
    ...(response.payload.verification_requests ? { verification_requests: response.payload.verification_requests } : {}), exchange_response: response };
}

/** Publishes a validated independent verdict as the response to its exact review
 * request; source and finding acceptance have already passed their own gates. */
export async function saveReviewExchange(communication, verdict) {
  if (!communication) return null;
  const response = bindAgentExchangeResponse(communication.response ?? { kind: "review_result", subject: `Independent review: ${verdict.verdict}.`, evidence: [],
    payload: { verdict: verdict.verdict, summary: `Independent review: ${verdict.verdict}.`, findings: verdict.findings, finding_updates: verdict.adjudications } }, communication.request);
  return { request_id: communication.request.message_id, response_id: response.message_id,
    request_ref: communication.requestRef, response_ref: await communication.storage.save(response) };
}

/** Constructs a Reviewer-to-Coder repair assignment from persisted finding IDs,
 * ensuring resume carries minimum required work rather than reopening discovery. */
export async function prepareRepairExchange({ request, selected, reviewerId, findings, projectRoot, reviewRef, projectLogger }) {
  if (!request.project_id || !request.payload?.execution_id || !reviewerId) return null;
  const storage = createAgentExchangeStorage({ fileService: createFileService({ projectRoot, role: "system_engineer" }), projectLogger });
  const message = createAgentExchange({ context: { project_id: request.project_id, ticket_id: request.task_id, execution_id: request.payload.execution_id },
    sender: { agent_id: reviewerId, role: "reviewer" }, recipient: { agent_id: selected.agent_id, role: "coder" },
    kind: "work_request", subject: "Repair or substantiate the current Reviewer findings from the retained checkpoint.",
    payload: { objective: "Address current findings without repeating completed implementation.", criterion_ids: [],
      decision_refs: reviewRef ? [reviewRef] : [], remaining_work: findings.map((finding) => typeof finding === "string" ? finding :
        `${finding.finding_id}: ${finding.minimum_change_scope || finding.finding?.minimum_change_scope || finding.message || "Retrieve this exact finding with query_review."}`),
      expected_outputs: ["Verified repair report or an evidence-based finding response through the existing Forge tools."] },
    continuation: { assignment_id: request.request_id, checkpoint_ref: `task/${request.task_id}/checkpoint` } });
  await storage.save(message);
  return message;
}
