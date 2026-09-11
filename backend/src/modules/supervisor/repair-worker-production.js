import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";
import { CODE_REQUIRE_INSTRUCTION, STRUCTURED_PATCH_CONTRACT } from "../workflows/stage1-instructions.js";

export function createProductionRepairWorker({ queue, senderQueue, workerId = "repair-1", statusBus, signalBus, projectLogger = () => {} } = {}) {
  if (typeof queue?.claim !== "function" || typeof senderQueue?.enqueue !== "function") throw new ConfigurationError("Repair Worker requires repair and sender queues.");
  const forwarded = new Map(); let timer; let heartbeat; let unsubscribe;
  return Object.freeze({ processOnce, start, stop });
  function start(intervalMs = 250) { if (!timer) { statusBus?.publish({ worker_id: workerId, worker_type: "repair", status: "ready", sequence: Date.now() }); heartbeat = setInterval(() => statusBus?.publish({ worker_id: workerId, worker_type: "repair", status: "ready", sequence: Date.now() }), 15000); heartbeat.unref?.(); unsubscribe = signalBus?.onWakeup?.((message) => { if (message.target === "repair.request" || message.queue === "repair.request") void processOnce(); }); } }
  function stop() { if (timer) clearInterval(timer); if (heartbeat) clearInterval(heartbeat); unsubscribe?.(); unsubscribe = undefined; timer = undefined; heartbeat = undefined; statusBus?.publish({ worker_id: workerId, worker_type: "repair", status: "stopped", sequence: Date.now() }); }
  async function processOnce() {
    const job = await queue.claim(workerId); if (!job) return null;
    projectLogger({ event_name: "repair.request_started", level: "info", status: "info", message: "Repair Worker started job.", task_id: job.task_id, correlation_id: job.correlation_id, source: "repair-worker", payload: { request_id: job.request_id, job_id: job.id } });
    if (forwarded.has(job.request_id)) { await queue.ack(job.id); return forwarded.get(job.request_id); }
    const repairPayload = buildRepairPayload(job);
    const agentRequest = { task_id: job.task_id, supervisor_id: job.supervisor_id, request_id: randomUUID(), parent_id: typeof job.request_id === "string" ? job.request_id : null, correlation_id: job.correlation_id, attempt: (job.attempt ?? 1) + 1, agent_id: job.agent_id ?? "builder", type: "agent.request", payload: repairPayload };
    try { const forwardedJob = await senderQueue.enqueue(agentRequest); forwarded.set(job.request_id, forwardedJob); projectLogger({ event_name: "repair.request_completed", level: "info", status: "success", message: "Repair Worker forwarded job to Sender.", task_id: job.task_id, correlation_id: job.correlation_id, source: "repair-worker", payload: { request_id: job.request_id, forwarded_request_id: forwardedJob.request_id, job_id: job.id } }); await queue.ack(job.id); return forwardedJob; }
    catch (error) { projectLogger({ event_name: "repair.request_failed", level: "error", status: "failed", message: error.message, task_id: job.task_id, correlation_id: job.correlation_id, source: "repair-worker", payload: { request_id: job.request_id, job_id: job.id } }); await queue.reject(job.id, error.message); throw error; }
  }

  function buildRepairPayload(job) {
    const payload = job.payload && typeof job.payload === "object" ? job.payload : job;
    const invalid = payload.invalid && typeof payload.invalid === "object" ? payload.invalid : {};
    const invalidEntries = Object.values(invalid).filter((entry) => entry?.path);
    const files = invalidEntries.map((entry) => ({ path: entry.path, format: entry.format === "full_content" ? "full_content" : "structured_patch", content: entry.format === "full_content" ? (entry.current_content ?? null) : (entry.submitted_content ?? null), current_content: entry.current_content ?? null, exists: entry.format !== "full_content", before_checksum: entry.before_checksum ?? null, language: entry.language ?? "text", size_bytes: entry.size_bytes ?? 0 }));
    const correction = "Repair every rejected or missing approved file using the complete current source provided by Node. Return every failed approved file exactly once. Do not return READ_ONLY files.";
    return {
      ...payload,
      type: "code_provide",
      task_id: job.task_id,
      step_id: 3,
      files,
      valid: payload.valid ?? {},
      invalid,
      repair_context: payload.repair_context ?? null,
      instruction_blocks: [{ block_id: "code_require", content: CODE_REQUIRE_INSTRUCTION, cacheable: false }, { block_id: "structured-patch-contract", content: STRUCTURED_PATCH_CONTRACT, cacheable: true }, { block_id: "repair-correction", content: correction, cacheable: false }],
      user_blocks: [{ block_id: "repair-context", content: JSON.stringify({ files, invalid, repair_context: payload.repair_context ?? null }), cacheable: false }],
      expected_output: { type: "submit_code_response", transport: "function_tool" }
    };
  }
}
