/** Persists shared agent messages through the project File Service so requests,
 * answers and checkpoint bindings survive restart without rewriting legacy data. */
import { statePath } from "../../infrastructure/filesystem/forge-paths.js";
import { assertAgentExchange, bindAgentExchangeResponse } from "./agent-exchange.js";

/** Stores content-addressed messages idempotently; a reply is published only when
 * its request exists under the same project, ticket and execution. */
export function createAgentExchangeStorage({ fileService, projectLogger = () => {} }) {
  return { save, read };

  /** Resolves only Node-issued message identities within the selected ticket;
   * untrusted paths and cross-ticket reads never become filesystem operations. */
  function path(context, id) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(context?.ticket_id ?? "") || !/^MSG-[a-f0-9]{64}$/.test(id ?? "")) throw new Error("Invalid agent message storage identity.");
    return `${statePath()}/agent-messages/${context.ticket_id}/${id}.json`;
  }

  /** Reads an exact message and verifies its retained context before exposing it
   * to a continuation; missing messages remain explicit rather than fabricated. */
  async function read(context, id) {
    const message = assertAgentExchange(JSON.parse(await fileService.readFile({ path: path(context, id) })));
    if (message.message_id !== id) throw new Error("Agent message storage identity changed.");
    if (["project_id", "ticket_id", "execution_id"].some((key) => context[key] !== message.context[key])) throw new Error("Agent message context changed.");
    return message;
  }

  /** Publishes immutable request/response bytes through the existing File Service;
   * accepted business decisions still require their original owning validators. */
  async function save(message) {
    assertAgentExchange(message);
    if (message.in_reply_to) {
      const request = await read(message.context, message.in_reply_to);
      if (message.kind !== "correction") bindAgentExchangeResponse(message, request);
      else if (message.recipient.agent_id !== request.recipient.agent_id) throw new Error("Correction recipient differs from the pending assignment.");
    }
    const target = path(message.context, message.message_id), content = JSON.stringify(message);
    try {
      const existing = await fileService.readFile({ path: target });
      if (existing !== content) throw new Error("Immutable agent message content changed.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      try { await fileService.atomicWrite({ path: target, content, replace: false }); }
      catch (writeError) {
        if (writeError.code !== "EEXIST" || await fileService.readFile({ path: target }) !== content) throw writeError;
      }
    }
    projectLogger({ event_name: "agent.exchange", source: "agent-exchange-storage", level: "info", status: "success", project_id: message.context.project_id,
      task_id: message.context.ticket_id, correlation_id: message.context.execution_id, message: `Agent exchange ${message.kind}: ${message.sender.role} -> ${message.recipient.role}.`,
      payload: { message_id: message.message_id, in_reply_to: message.in_reply_to, sender: message.sender, recipient: message.recipient, ref: target } });
    return { type: "decision", ref: target, purpose: "Agent exchange record; not execution permission or acceptance." };
  }
}
