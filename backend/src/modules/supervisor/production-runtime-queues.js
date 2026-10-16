// Supplies production queue polling and serialization without changing ticket execution authority.

// Polls a worker queue on demand without overlapping local claims.
export function createQueuePoller(queue, workerId, signalBus, handler) {
  let active = false;
  let unsubscribe;
  let running = false;
  // Processes one claimed job while preserving the worker's local serialization.
  const processOnce = async () => {
    if (running) return;
    running = true;
    try { const job = await queue.claim(workerId); if (job) await handler(job); }
    finally { running = false; }
  };
  return { start() {
    if (active) return;
    active = true;
    unsubscribe = signalBus?.onWakeup?.((message) => { if (message.queue === (queue.name ?? "")) void processOnce(); });
    void processOnce();
  }, stop() { unsubscribe?.(); unsubscribe = undefined; active = false; } };
}

// Serializes Supervisor control operations by task without swallowing prior operation errors.
export function createProcessMutex() {
  const tails = new Map();
  return { run(key, operation) {
    const previous = tails.get(key) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    tails.set(key, current);
    return current.finally(() => { if (tails.get(key) === current) tails.delete(key); });
  } };
}

// Wakes existing workers only after their queue entry is persisted.
export function createSignaledQueue(queue, signalBus, name) {
  return Object.freeze({ ...queue, name, enqueue: async (job) => {
    const result = await queue.enqueue(job);
    signalBus.wakeup({ source: "queue-enqueue", target: name, queue: name, job_id: result.id, task_id: result.task_id,
      supervisor_id: result.supervisor_id, request_id: result.request_id, correlation_id: result.correlation_id, attempt: result.attempt ?? 1 });
    return result;
  } });
}
