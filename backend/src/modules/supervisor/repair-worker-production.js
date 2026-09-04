import { ConfigurationError } from "../../shared/errors.js";

export function createProductionRepairWorker({ queue, senderQueue, workerId = "repair-1" } = {}) {
  if (typeof queue?.claim !== "function" || typeof senderQueue?.enqueue !== "function") throw new ConfigurationError("Repair Worker requires repair and sender queues.");
  const forwarded = new Map(); let timer;
  return Object.freeze({ processOnce, start, stop });
  function start(intervalMs = 50) { if (!timer) { timer = setInterval(() => { void processOnce(); }, intervalMs); timer.unref?.(); } }
  function stop() { if (timer) clearInterval(timer); timer = undefined; }
  async function processOnce() {
    const job = await queue.claim(workerId); if (!job) return null;
    if (forwarded.has(job.request_id)) { await queue.ack(job.id); return forwarded.get(job.request_id); }
    const agentRequest = { ...job, request_id: job.request_id, type: "agent.request", payload: job.payload, status: undefined, attempts: undefined, lease_until: undefined, worker_id: undefined };
    try { const forwardedJob = await senderQueue.enqueue(agentRequest); forwarded.set(job.request_id, forwardedJob); await queue.ack(job.id); return forwardedJob; }
    catch (error) { await queue.reject(job.id, error.message); throw error; }
  }
}
