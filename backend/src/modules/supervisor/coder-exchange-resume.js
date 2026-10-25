/** Restores Coder communication across explicit checkpoint resumes without
 * rewriting immutable messages or treating historical answers as new approval.
 * Project, ticket and recipient remain fixed when Node renews an assignment for
 * a replacement execution that was already admitted by the RUN lifecycle. */
import { createAgentExchange, assertAgentExchange, bindAgentExchangeResponse } from "../governance/agent-exchange.js";
import { statePath } from "../../infrastructure/filesystem/forge-paths.js";

/** Reuses a current assignment or issues an immutable continuation from the
 * exact saved checkpoint; a stale directly supplied assignment cannot be replayed. */
export async function resumeCoderExchange({ storage, retained, context, selected, request }) {
  const message = assertAgentExchange(retained);
  if (message.kind !== "work_request" || message.recipient.role !== "coder" || message.recipient.agent_id !== selected.agent_id
    || ["project_id", "ticket_id"].some((key) => message.context[key] !== context[key])) throw new Error("Coder exchange does not match the selected project, ticket or profile.");
  const saved = await storage.read(message.context, message.message_id);
  if (saved.context.execution_id === context.execution_id) return saved;
  const checkpoint = request.payload?.resume_from;
  if (!checkpoint || checkpoint.agent_exchange?.message_id !== saved.message_id
    || checkpoint.task_id && checkpoint.task_id !== context.ticket_id
    || checkpoint.agent_id && checkpoint.agent_id !== selected.agent_id) throw new Error("Agent message context changed; a replacement execution requires its retained Coder checkpoint.");
  return createAgentExchange({ context, sender: saved.sender, recipient: saved.recipient, kind: saved.kind,
    subject: saved.subject, payload: saved.payload,
    evidence: [...saved.evidence, { type: "decision", ref: `${statePath()}/agent-messages/${context.ticket_id}/${saved.message_id}.json`,
      purpose: "Historical assignment continued from the saved checkpoint; not new approval or current verification evidence." }],
    continuation: { assignment_id: request.request_id, checkpoint_ref: `task/${context.ticket_id}/checkpoint` } });
}

/** Reads only the exact retained SL answer and validates its original question.
 * Historical context stays unchanged and cannot become execution authorization;
 * a superseded recovery is not reintroduced into a later finding-repair prompt. */
export async function readCoderConsultation({ fileService, storage, context, selected, request }) {
  const recovery = request.payload?.resume_from?.blocker_recovery;
  if (recovery?.status === "superseded_by_review") return null;
  const id = recovery?.communication?.response_id;
  if (!id) return null;
  if (!/^MSG-[a-f0-9]{64}$/.test(id)) throw new Error("Invalid retained Coder consultation identity.");
  const path = `${statePath()}/agent-messages/${context.ticket_id}/${id}.json`;
  const record = assertAgentExchange(JSON.parse(await fileService.readFile({ path })));
  if (["project_id", "ticket_id"].some((key) => record.context[key] !== context[key])
    || record.kind !== "consultation_response" || record.sender.role !== "sprint_leader"
    || record.recipient.role !== "coder" || record.recipient.agent_id && record.recipient.agent_id !== selected.agent_id) throw new Error("Retained consultation does not answer this Coder's SL request.");
  const answer = await storage.read(record.context, id);
  const question = await storage.read(answer.context, answer.in_reply_to);
  bindAgentExchangeResponse(answer, question);
  return answer;
}
