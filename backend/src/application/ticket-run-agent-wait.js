// Keeps an authorized initial RUN durable while its contracted Coder is occupied.
// Queue reservations prevent duplicate dispatch across callers and processes; each retry
// re-enters the normal approval, dependency and execution gates without clearing a checkpoint.
import { randomUUID } from "node:crypto";

const QUEUE = "ticket.run-agent-wait";
const INTERVAL = 30_000;

// Wraps the shared RUN entrypoint with cancellable, restart-safe waits for proven occupancy only.
export function createTicketRunAgentWait({ dispatch, queueStore: store, ticketStatusStore: statuses,
  clock = Date.now, projectLogger = () => {}, projectId }) {
  const local = new Map();
  let timer;
  let started = false;
  let scanning = false;
  let closed = false;
  run.stop = stop;
  run.tick = tick;
  run.start = start;
  run.close = close;
  run.waitForLaunch = waitForLaunch;
  return run;

  // Deduplicates manual RUN clicks against an already retained availability request.
  async function run(request) {
    if (projectId && request.projectId !== projectId) return dispatch(request);
    const existing = await store.withLock(QUEUE, async () => (await store.list(QUEUE))
      .find((entry) => entry.request.projectId === request.projectId && entry.request.ticketId === request.ticketId
        && ["waiting", "dispatching"].includes(entry.status)));
    if (existing) return response(existing);
    return execute(request);
  }

  // Calls the ordinary dispatcher and queues only failures proving that no provider was started.
  async function execute(request, reservation) {
    try {
      const result = await dispatch({ ...request, ...(reservation ? {
        waitSignal: local.get(reservation.id)?.signal, waitGuard: () => guard(reservation), waitVersion: reservation.version
      } : {}) });
      if (reservation) await settle(reservation, "completed", null, result);
      return result;
    } catch (error) {
      if (error.code === "AGENT_BUSY" && error.not_started === true && error.agent_wait?.claim_id
        && error.agent_wait?.agent_id && error.ticket_run_wait) {
        try { return await enqueue({ ...request, ...error.ticket_run_wait }, error, reservation); }
        catch (waitError) { if (reservation) await settle(reservation, "failed", waitError); throw waitError; }
      }
      if (reservation) await settle(reservation, "failed", error);
      throw error;
    } finally { if (reservation) local.delete(reservation.id); }
  }

  // Saves the exact admitted Sprint/dependency intent together with the unchanged ticket version.
  async function enqueue(request, error, reservation) {
    const entry = await store.withLock(QUEUE, async () => {
      if (reservation) await assertReservation(reservation);
      const duplicate = !reservation && (await store.list(QUEUE)).find((item) => item.request.projectId === request.projectId
        && item.request.ticketId === request.ticketId && ["waiting", "dispatching"].includes(item.status));
      if (duplicate) return duplicate;
      let current = statuses.get(request.ticketId) ?? statuses.create(request.ticketId);
      if (request.expectedTicketVersion !== undefined && current.version !== request.expectedTicketVersion)
        throw Object.assign(new Error("Ticket changed before RUN could be queued."), { code: "STATUS_CONFLICT" });
      if (current.details?.launch_claim || !["pending", "failed"].includes(current.status)) throw error;
      if (current.status === "failed") current = statuses.retry(request.ticketId, { reason: "agent_wait_pending" });
      const saved = { id: reservation?.id ?? randomUUID(), request: structuredClone(request), status: "waiting",
        version: current.version, execution_id: current.details?.execution_id ?? null,
        agent_wait: { ...error.agent_wait, interval_ms: INTERVAL, available_at: clock() + INTERVAL },
        attempts: (reservation?.attempts ?? 0) + 1, updated_at: clock() };
      await store.save(QUEUE, saved);
      return saved;
    });
    publish(entry, "ticket.run_wait_scheduled", "Coder đang bận ticket khác. Node giữ yêu cầu RUN, tự thử lại sau 30 giây; nhấn Stop để tạm dừng.");
    return response(entry);
  }

  // Reserves due tickets briefly under the cross-process queue lock; SDK work runs outside it.
  async function tick() {
    if (scanning || closed) return;
    scanning = true;
    try {
      const due = await store.withLock(QUEUE, async () => {
        const selected = [];
        for (const entry of await store.list(QUEUE)) {
          if (closed) break;
          if (projectId && entry.request.projectId !== projectId) continue;
          if (entry.status === "dispatching" && !alive(entry.owner_pid)) entry.status = "waiting";
          if (entry.status !== "waiting" || entry.agent_wait.available_at > clock()) continue;
          if (!currentIntent(entry)) { await store.save(QUEUE, { ...entry, status: "superseded" }); continue; }
          const next = { ...entry, status: "dispatching", owner_pid: process.pid, token: randomUUID() };
          await store.save(QUEUE, next);
          local.set(next.id, new AbortController());
          selected.push(next);
        }
        return selected;
      });
      for (const entry of due) {
        if (closed) { await settle(entry, "waiting"); local.delete(entry.id); continue; }
        void execute(entry.request, entry).catch((error) => { publish(entry, "ticket.run_wait_failed", error.message, error); });
      }
    } finally { scanning = false; }
  }

  // Rejects cancelled or replaced reservations immediately before destructive preparation and launch.
  async function guard(entry) {
    return store.withLock(QUEUE, () => assertReservation(entry));
  }

  // Checks the durable dispatch token under an already held queue lock.
  async function assertReservation(entry) {
    const saved = (await store.list(QUEUE)).find((item) => item.id === entry.id);
    if (saved?.status !== "dispatching" || saved.token !== entry.token)
      throw Object.assign(new Error("Queued RUN was stopped or replaced."), { code: "TICKET_STOPPED" });
  }

  // Fences automatic retries to the ticket state that originally requested the Coder.
  function currentIntent(entry) {
    const current = statuses.get(entry.request.ticketId);
    return current?.project_id === entry.request.projectId && current.version === entry.version
      && ["pending", "failed"].includes(current.status) && !current.details?.launch_claim
      && (current.details?.execution_id ?? null) === entry.execution_id;
  }

  // Retires a reservation without overwriting an intervening Stop or replacement.
  async function settle(entry, status, error, result) {
    await store.withLock(QUEUE, async () => {
      const saved = (await store.list(QUEUE)).find((item) => item.id === entry.id);
      if (saved?.status === "dispatching" && saved.token === entry.token)
        await store.save(QUEUE, { ...saved, status, completed_at: new Date(clock()).toISOString(),
          ...(error ? { error: { code: error.code, message: error.message } } : {}), ...(result ? { result } : {}) });
    });
  }

  // Lets the Sprint DAG await the real launch identity while an HTTP RUN can return queued immediately.
  async function waitForLaunch(id) {
    for (;;) {
      if (closed) throw Object.assign(new Error("RUN queue worker is stopping."), { code: "TICKET_STOPPED" });
      const entry = await store.withLock(QUEUE, async () => (await store.list(QUEUE)).find((item) => item.id === id));
      if (entry?.status === "completed") return entry.result;
      if (!entry || !["waiting", "dispatching"].includes(entry.status)) throw Object.assign(new Error(entry?.error?.message ?? "Queued RUN stopped or was replaced."), { code: entry?.error?.code ?? "TICKET_STOPPED" });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // Cancels queued intent first so a released Coder cannot restart a ticket after Owner Stop.
  async function stop(request) {
    if (projectId && request.projectId !== projectId) return dispatch.stop(request);
    const stopped = await store.withLock(QUEUE, async () => {
      const entry = (await store.list(QUEUE)).find((item) => item.request.projectId === request.projectId
        && item.request.ticketId === request.ticketId && ["waiting", "dispatching"].includes(item.status));
      if (!entry) return null;
      local.get(entry.id)?.abort(Object.assign(new Error("Ticket stopped by owner."), { code: "TICKET_STOPPED" }));
      await store.save(QUEUE, { ...entry, status: "cancelled", updated_at: clock() });
      return entry;
    });
    if (!stopped) return dispatch.stop(request);
    publish(stopped, "ticket.run_wait_stopped", "Đã tạm dừng yêu cầu RUN đang chờ Coder.");
    return { ticket_id: request.ticketId, status: "stopped", reason: "agent_wait_cancelled" };
  }

  // Publishes compact wait/retry evidence through the existing project log and UI stream.
  function publish(entry, event, message, error) {
    projectLogger({ event_name: event, level: error ? "error" : "info", status: error ? "failed" : "pending",
      project_id: entry.request.projectId, task_id: entry.request.ticketId, message,
      ...(error ? { error_code: error.code } : {}), payload: { job_id: entry.id, agent_wait: entry.agent_wait } });
  }

  // Starts a project-owned poller; persisted due times enforce the thirty-second retry interval.
  function start() {
    if (started) return;
    started = true;
    closed = false;
    timer = setInterval(() => { void tick().catch((error) => projectLogger({ event_name: "ticket.run_wait_poll_failed",
      level: "error", message: error.message, error_code: error.code, project_id: projectId })); }, 1000);
    timer.unref?.();
  }

  // Stops scanning on API disposal while preserving queued requests for the next process.
  function close() { closed = true; started = false; clearInterval(timer); }
}

// Exposes queue state through the standard RUN response without implying that a provider started.
function response(entry) {
  return { ticket_id: entry.request.ticketId, status: "accepted", pipeline: "supervisor",
    reason: "agent_wait_pending", agent_wait: entry.agent_wait, queued: true, wait_id: entry.id };
}

// Protects live reservations while allowing a replacement API process to reclaim unstarted work.
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; if (error.code === "EPERM") return true; throw error; }
}
