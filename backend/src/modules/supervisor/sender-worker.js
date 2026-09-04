import { ConfigurationError } from "../../shared/errors.js";
import { persistAgentResponse } from "../agent/response-persistence.js";
import { stage1AgentTools } from "../workflows/stage1-agent-tools.js";
export function createSenderWorker({ queue, agentRegistry, eventBus, processedStore, protocolStorage, conversationStateStore, conversationIdResolver = (job) => `CONV-BUILDER-${job.task_id}`, workerId = "sender-1" } = {}) {
  if (typeof queue?.claim !== "function" || typeof agentRegistry?.resolve !== "function" || typeof eventBus?.publish !== "function") throw new ConfigurationError("Sender Worker requires queue, agent registry and event bus.");
  const processed = new Map();
  let timer;
  return Object.freeze({ processOnce, start, stop });
  function start(intervalMs = 50) { if (timer) return; timer = setInterval(() => { void processOnce(); }, intervalMs); timer.unref?.(); }
  function stop() { if (timer) clearInterval(timer); timer = undefined; }
  async function processOnce() {
    const job = await queue.claim(workerId); if (!job) return null;
    const stored = await processedStore?.get?.(job.request_id);
    if (stored || processed.has(job.request_id)) { const result = stored ?? processed.get(job.request_id); await queue.ack(job.id); return result; }
    try { const { adapter } = agentRegistry.resolve(job.agent_id ?? "builder"); const response = await adapter.send({ agentId: job.agent_id ?? "builder", payload: job.payload, correlationId: job.correlation_id, tools: job.tools ?? toolsForRequest(job) }); const event = identityEvent(job, "agent.response.received", { response }); await persistResponse(job, response); processed.set(job.request_id, event); await processedStore?.save?.(job.request_id, event); await eventBus.publish(event); await queue.ack(job.id); return event; }
    catch (error) {
      if (error?.rawResponse !== undefined && protocolStorage) {
        const round = Number(job.payload?.step_id ?? 1);
        await persistAgentResponse({ protocolStorage, taskId: job.task_id, round, response: error.rawResponse, raw: true }).catch(() => {});
      }
      const event = identityEvent(job, "agent.response.failed", { error: { code: error.code ?? "AGENT_REQUEST_FAILED", message: error.message } });
      await eventBus.publish(event); await queue.ack(job.id); return event;
    }
  }
  function toolsForRequest(job) {
    const type = job.payload?.type ?? job.type;
    const expected = job.payload?.expected_output?.type;
    const name = expected === "submit_code_response" || type === "code_provide"
      ? "submit_code_response"
      : expected === "planning" || type === "planning"
        ? "planning"
        : "code_needed";
    return stage1AgentTools.filter((tool) => tool.name === name);
  }

  async function persistResponse(job, response) {
    const round = Number(job.payload?.step_id ?? (job.payload?.type === "planning" ? 2 : job.payload?.type === "code_provide" ? 3 : 1));
    await persistAgentResponse({ protocolStorage, taskId: job.task_id, round, response });
    if (conversationStateStore?.update) {
      const providerResponseId = response?.provider_metadata?.response_id ?? response?.response_id ?? response?.payload?.response_id ?? null;
      await conversationStateStore.update(conversationIdResolver(job), { last_provider_response_id: providerResponseId, last_provider_status: response?.status ?? "completed" }).catch(() => {});
    }
  }
}
function identityEvent(job, type, payload) { return { type, task_id: job.task_id, supervisor_id: job.supervisor_id, request_id: job.request_id, correlation_id: job.correlation_id, attempt: job.attempt ?? 1, payload }; }
