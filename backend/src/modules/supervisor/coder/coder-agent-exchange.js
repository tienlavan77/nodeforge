/** Wraps real Coder executions in durable shared work messages while leaving
 * governed report_done, commit, verification and finding tools authoritative. */
import { createFileService } from "../../../infrastructure/filesystem/file-service.js";
import { createAgentExchange } from "../../governance/agent-exchange.js";
import { createAgentExchangeStorage } from "../../governance/agent-exchange-storage.js";
import { ticketSourceChangesPrompt } from "../ticket/ticket-source-observation.js";
import { resumeCoderExchange, readCoderConsultation } from "./coder-exchange-resume.js";

/** Retains the assignment on resume and records explicit tool-validated results;
 * SDK prose alone cannot satisfy the Coder completion gate. */
export function withCoderExchange(execute, { projectRoot, projectLogger = () => {} }) {
  return async (selected, request) => {
    if (selected.role !== "coder" || request.payload?.tool_test || !request.project_id || !request.payload?.execution_id) return execute(selected, request);
    const fileService = createFileService({ projectRoot, role: "system_engineer" });
    const storage = createAgentExchangeStorage({ fileService, projectLogger });
    const context = { project_id: request.project_id, ticket_id: request.task_id, execution_id: request.payload.execution_id };
    const retained = request.payload?.agent_exchange ?? request.payload?.resume_from?.agent_exchange;
    request.abortSignal?.throwIfAborted();
    const message = retained ? await resumeCoderExchange({ storage, retained, context, selected, request }) : createAgentExchange({ context, sender: { agent_id: "node", role: "node" },
      recipient: { agent_id: selected.agent_id, role: "coder" }, kind: "work_request", subject: request.ticket.title || request.task_id,
      payload: { objective: request.ticket.objective || request.ticket.title || request.task_id,
        criterion_ids: (request.ticket.acceptance_criteria ?? []).map((_, index) => `AC-${index + 1}`), decision_refs: [],
        remaining_work: [request.payload?.resume_from ? "Continue the next unfinished step from the retained checkpoint." : "Implement the approved ticket."],
        expected_outputs: ["Committed ticket changes, passed Node verification and saved Coder report through report_done."] },
      continuation: { assignment_id: request.request_id, checkpoint_ref: request.payload?.resume_from ? `task/${request.task_id}/checkpoint` : null } });
    if (message.kind !== "work_request" || ["project_id", "ticket_id", "execution_id"].some((key) => message.context[key] !== context[key]) || message.recipient.agent_id !== selected.agent_id) throw new Error("Coder exchange does not match the current execution or selected profile.");
    const ref = await storage.save(message);
    projectLogger({ event_name: "agent.exchange", level: "info", status: "started", task_id: request.task_id, correlation_id: request.correlation_id,
      message: "Coder continues the retained structured assignment.", payload: { message_id: message.message_id, kind: message.kind, ref: ref.ref } });
    const consultation = await readCoderConsultation({ fileService, storage, context, selected, request });
    const next = { ...request, payload: { ...request.payload, agent_exchange: message, agent_consultation: consultation } };
    request.abortSignal?.throwIfAborted();
    const result = await execute(selected, next);
    request.abortSignal?.throwIfAborted();
    const response = createAgentExchange({ context, sender: message.recipient, recipient: message.sender, kind: "work_result",
      subject: "Coder submitted the assignment through governed completion tools.", inReplyTo: message.message_id, continuation: message.continuation,
      payload: { outcome: "completed", summary: result.summary || "Coder submitted its report.", change_refs: [], verification_refs: [],
        report_ref: `task/${request.task_id}/final_report`, remaining_work: [] } });
    const responseRef = await storage.save(response);
    projectLogger({ event_name: "agent.exchange", level: "info", status: "success", task_id: request.task_id, correlation_id: request.correlation_id,
      message: "Coder structured result retained; independent review and acceptance gates remain enforced.", payload: { message_id: response.message_id, in_reply_to: message.message_id, ref: responseRef.ref } });
    return { ...result, communication: { request_ref: ref, response_ref: responseRef } };
  };
}

/** Presents the shared assignment while naming the existing Forge tools that
 * submit its typed result; a narrative final answer never replaces those tools. */
export function coderExchangePrompt(request) {
  const sourcePrompt = ticketSourceChangesPrompt(request.payload?.source_changes);
  if (!request.payload?.agent_exchange) return sourcePrompt;
  return `${sourcePrompt}AGENT EXCHANGE v1 — CURRENT WORK REQUEST: ${JSON.stringify(request.payload.agent_exchange)}\n${request.payload.agent_consultation ? `SL ANSWER TO YOUR RETAINED QUESTION (original context preserved; historical answers are not new execution permission, verification or Reviewer acceptance): ${JSON.stringify(request.payload.agent_consultation)}\n` : ""}Answer directly and concisely. Continue the retained checkpoint, preserving completed work and decisions. Submit the work_result through report_done and finding responses through respond_to_review using their supplied tool schemas; Node constructs the common envelope from those validated records. For a blocker use report_done(status=blocked) to consult SL. SL consults AM if necessary; never consult AM directly. Do not use prose as a replacement for a required tool result or claim Reviewer acceptance.`;
}
