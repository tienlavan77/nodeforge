/** Defines explicit Owner input requests for technical recovery without turning
 * missing evidence into an Architecture policy decision or tool permission. */
import { createHash } from "node:crypto";
import { blockerValidationError } from "./blocker-validation.js";

/** Rejects ambiguous requests so the UI can show the exact question and context
 * that the Owner answers, independently of the agent's narrative summary. */
export function validateBlockerOwnerRequest(request, work, action) {
  if (request === undefined) return;
  if (action !== "reconciliation_required" || !request || typeof request !== "object" || Array.isArray(request)
    || Object.keys(request).some((key) => !["kind", "question", "context"].includes(key))
    || !["information", "tool_authorization"].includes(request.kind)
    || ![request.question, request.context].every((value) => typeof value === "string" && value.trim() && value.length <= 8000)
    || !Array.isArray(work.waiting_for) || !work.waiting_for.some((entry) => entry?.owner === "external")) {
    throw blockerValidationError("/reconciliation/owner_request", "owner_request_invalid",
      "Use owner_request={kind:information|tool_authorization,question,context} only with reconciliation_required and an explicit external waiting_for entry. Disclose the exact operation and denial context; this request grants no permission.");
  }
}

/** Exposes structured external questions from older checkpoints as information
 * requests without inferring approval intent from English or Vietnamese prose. */
export function blockerOwnerRequest(recovery, executionId) {
  if (recovery?.status !== "reconciliation_required" || !recovery.job_id) return null;
  const external = (recovery.waiting_for ?? []).filter((entry) => entry?.owner === "external");
  if (!external.length) return null;
  const request = recovery.owner_request ?? { kind: "information", question: external.map((entry) => entry.question).join("\n"),
    context: recovery.guidance || "Provide the requested external evidence. This response does not grant tool permission or approve a plan." };
  const binding = { job_id: recovery.job_id, execution_id: executionId, kind: request.kind, question: request.question, context: request.context };
  return { ...binding, request_id: createHash("sha256").update(JSON.stringify(binding)).digest("hex") };
}

/** Teaches both SDK communication paths how to distinguish a human input from
 * an AM policy escalation and consume recorded answers without bypassing tools. */
export function blockerOwnerInputPrompt(inputs = []) {
  return "reconciliation_required means unresolved technical work, not automatically an Owner decision. For a concrete direct Owner answer required by a tool boundary or missing external fact, include reconciliation.owner_request={kind:tool_authorization|information,question:exact disclosed question,context:exact operation, reason and impact} and waiting_for:[{owner:external,operation:execute,question}]. Node presents this question to the Owner. Do not hide a human question only in guidance or wait for an unspecified operator. Only AM uses owner_required for a decision beyond approved authority, with the existing boundary and proposal contract. Recorded Owner inputs are responses, not tool authorization receipts or approved plan revisions; actual tool controls still apply. Consume the answer and select a permitted next step; do not ask the same answered question again. NODE-RECORDED OWNER INPUTS: " + JSON.stringify(inputs);
}
