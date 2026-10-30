// Runs approved upstream repairs as durable independent ticket work rather than repeated AM research.
// The parent checkpoint waits for new commit-bound verification and review; provider work never holds a queue lock.
import { blockerValidationError } from "../blocker/blocker-validation.js";
import { statePath } from "../../../infrastructure/filesystem/forge-paths.js";
import { dependencyRepairId, inspectDependencyRequest, dependencyRepairError } from "./dependency-repair-contract.js";
import { prepareDependencyExecution, dependencyRepairCompletion } from "./dependency-repair-execution.js";
import { DEPENDENCY_REPAIR_QUEUE as QUEUE, persistDependencyRequest, reserveDependencyRepair, saveDependencyRepair, dependencyRepairOwnerAlive } from "./dependency-repair-queue.js";
import { recoverDependencyRepairCheckpoint } from "./dependency-repair-checkpoint-recovery.js";

// Coordinates restart-safe intent, ordinary RUN dispatch, occupancy waits and evidence-driven continuation.
export function createDependencyRepairCoordinator({ store, fileService, ticketStatusStore, sprintRegistry, checkpoints,
  resolveTicketWorkspace, dispatchTicket, disposition, projectId, projectLogger = () => {}, logger = console, clock = Date.now }) {
  const active = new Set();
  let timer; let started = false; let scanning = false;
  const services = { resolveTicketWorkspace, checkpoints, ticketStatusStore, fileService, isCurrent, disposition,
    validateTarget: (entry) => inspectDependencyRequest(entry.source_job, { action: "dependency_requested", dependency_request: entry.request }, { sprintRegistry, ticketStatusStore }),
    saveBinding: (entry, binding) => save(entry, { integrated_binding: binding }) };
  return Object.freeze({ request, validate, refresh, tick, start, stop });

  // Revalidates approved ownership and rejects unchanged failed requests instead of re-entering a dispatch loop.
  async function validate(job, value) {
    if (projectId && job.request.project_id !== projectId) throw dependencyRepairError("Dependency request belongs to another project.");
    if (typeof dispatchTicket !== "function") throw dependencyRepairError("Dependency RUN dispatcher is unavailable.");
    if (job.dependency_result?.status === "failed" && job.dependency_result.request_id === dependencyRepairId(job, value.dependency_request))
      throw blockerValidationError("/dependency_request", "dependency_repair_no_progress", "The same dependency repair already failed; SL must change its instructions or supply new evidence.");
    return inspectDependencyRequest(job, value, { sprintRegistry, ticketStatusStore });
  }

  // Writes one durable intent before the parent is parked; duplicate delivery reuses the same request.
  async function request(job, value) {
    const target = await validate(job, value);
    const id = dependencyRepairId(job, value.dependency_request);
    const entry = await store.withLock(QUEUE, async () => {
      const existing = (await store.list(QUEUE)).find((item) => item.id === id);
      if (existing && existing.status !== "cancelled") return existing;
      if (existing) {
        if (existing.target.execution_id !== target.execution_id) throw dependencyRepairError("Cancelled dependency execution was replaced.");
        const resumed = { ...existing, status: "queued", owner: null, updated_at: clock() };
        await store.save(QUEUE, resumed); return resumed;
      }
      const record = { id, target, request: value.dependency_request, status: "queued", created_at: clock(),
        receipt: `${statePath()}/dependency-repair-requests/${id}.json`,
        dependency_repair: true, source_job: { stage: "sprint_leader", request: { project_id: job.request.project_id, task_id: job.request.task_id,
          ticket: { sprint_id: job.request.ticket.sprint_id }, payload: { execution_id: job.request.payload.execution_id, sprint_basis: job.request.payload.sprint_basis } } },
        parent: { project_id: job.request.project_id, task_id: job.request.task_id, execution_id: job.request.payload.execution_id, job_id: job.id } };
      const retained = await persistDependencyRequest(fileService, record);
      await store.save(QUEUE, retained);
      return retained;
    });
    const parent = ticketStatusStore.get(job.request.task_id);
    if (parent?.details.execution_id === entry.parent.execution_id && parent.status === "needs_human_review"
      && parent.details.reason !== "TICKET_STOPPED") ticketStatusStore.retry(job.request.task_id, { ...parent.details, reason: "dependency_wait" });
    log(entry, "ticket.dependency_wait", "Waiting for the approved dependency repair; checkpoint retained.");
    return id;
  }

  // Requires the original parent reservation, project, execution and Stop state at every dispatch boundary.
  async function isCurrent(entry) {
    const parent = ticketStatusStore.get(entry.parent.task_id);
    if (parent?.project_id !== entry.parent.project_id || parent.details.execution_id !== entry.parent.execution_id
      || !["pending", "running", "needs_human_review"].includes(parent.status) || parent.details.reason === "TICKET_STOPPED"
      || (await disposition?.get(entry.parent.task_id))?.disposition === "cancelled") return false;
    const ledger = await store.withLock("blocker.recovery", async () => (await store.list("blocker.recovery")).find((item) => item.task_id === entry.parent.task_id
      && item.project_id === entry.parent.project_id && item.execution_id === entry.parent.execution_id));
    return !ledger?.cancelled && ledger?.jobs.some((job) => job.id === entry.parent.job_id && job.status === "dependency_wait" && job.dependency_request_id === entry.id);
  }

  // Observes target receipts and schedules independent SDK work without blocking sibling tickets.
  async function tick() {
    if (scanning) return;
    scanning = true;
    try {
      const entries = await store.withLock(QUEUE, () => store.list(QUEUE));
      for (const entry of entries) {
        if (projectId && entry.parent.project_id !== projectId) continue;
        if (["failed", "recovering"].includes(entry.status)) {
          try {
            if (await recoverDependencyRepairCheckpoint(entry, { ...services, store, clock }))
              log(entry, "ticket.dependency_checkpoint_recovered", "Unlaunched dependency checkpoint recovered; repair will resume automatically.");
          } catch (error) { logger.error?.("Dependency checkpoint recovery failed.", { task_id: entry.parent.task_id, code: error.code, error: error.message }); }
          continue;
        }
        if (["completed", "failed", "cancelled"].includes(entry.status) || active.has(entry.id) || clock() < (entry.available_at ?? 0)) continue;
        if (!await isCurrent(entry)) {
          const parent = ticketStatusStore.get(entry.parent.task_id);
          if (parent?.details.execution_id === entry.parent.execution_id && ["pending", "running", "needs_human_review"].includes(parent.status)
            && parent.details.reason !== "TICKET_STOPPED" && entry.status === "queued" && clock() - entry.created_at < 30_000) continue;
          try {
            const target = ticketStatusStore.get(entry.target.ticket.id);
            if (target?.details.dependency_repair?.id === entry.id && target.details.dependency_repair.state === "preparing") {
              if (dependencyRepairOwnerAlive(entry.owner)) continue;
              if (!await prepareDependencyExecution(entry, { ...services, finishOnly: true })) continue;
            }
            await save(entry, { status: "cancelled", owner: null });
          } catch (error) { await fail(entry, error); }
          continue;
        }
        try {
          const result = await dependencyRepairCompletion(entry, services);
          if (result) { if (await save(entry, { status: "completed", result, owner: null })) log(entry, "ticket.dependency_completed", "Dependency repair verified and independently reviewed; waiting ticket can continue."); continue; }
          const current = ticketStatusStore.get(entry.target.ticket.id);
          if (current.details.launch_claim || ["running", "reviewing"].includes(current.status)) continue;
          if (entry.status === "running") {
            const waiting = (await store.list("ticket.run-agent-wait")).some((item) => item.request?.ticketId === entry.target.ticket.id && ["waiting", "dispatching"].includes(item.status));
            const checkpoint = await checkpoints.load(entry.target.ticket.id);
            const recovering = (await store.list("blocker.recovery")).some((ledger) => ledger.task_id === entry.target.ticket.id
              && ledger.execution_id === entry.target.execution_id && !ledger.cancelled && ledger.jobs.some((job) =>
                ["pending", "invoking", "resume_pending", "dispatching", "approval_retry_pending", "dependency_request_pending", "dependency_wait"].includes(job.status)));
            if (waiting || recovering || checkpoint?.phase === "operational_retry_pending") continue;
            // No provider launch claim exists. Only the untouched prepared checkpoint can be safely retried after a process exit.
            if (entry.dispatch_result || checkpoint?.dependency_repair?.id !== entry.id || checkpoint.phase !== "dependency_repair")
              throw dependencyRepairError(`Dependency repair stopped: ${checkpoint?.failure?.code ?? current.details.failure_code ?? current.details.reason ?? current.status}. ${checkpoint?.failure?.message ?? current.details.error ?? "No new accepted repair was produced."}`);
          }
          const reserved = await reserveDependencyRepair(store, entry, clock);
          if (!reserved) continue;
          active.add(entry.id);
          void execute(reserved).catch((error) => logger.error?.("Dependency repair result persistence failed.", { task_id: entry.parent.task_id, error: error.message })).finally(() => active.delete(entry.id));
        } catch (error) { await fail(entry, error); }
      }
    } finally { scanning = false; }
  }

  // Reuses normal approval, launch, agent-wait, verification and review gates for the target ticket.
  async function execute(entry) {
    try {
      const prepared = await prepareDependencyExecution(entry, services);
      if (!prepared) { await save(entry, { status: "queued", owner: null }); return; }
      if (!await isCurrent(entry)) { await save(entry, { status: "cancelled", owner: null }); return; }
      if (!await save(entry, { status: "running" })) return;
      log(entry, "ticket.dependency_dispatched", "Dispatching dependency repair to its own Coder through normal RUN.");
      const result = await dispatchTicket({ projectId: entry.parent.project_id, ticketId: entry.target.ticket.id,
        expectedSprintVersion: entry.target.basis.version, expectedExecutionBasis: entry.target.basis,
        dependencyRepair: { id: entry.id, parent_ticket_id: entry.parent.task_id, parent_execution_id: entry.parent.execution_id,
          project_id: entry.parent.project_id, job_id: entry.parent.job_id } });
      if (result.status === "already_running") {
        await save(entry, { status: "queued", dispatch_result: null, owner: null, available_at: clock() + 30_000 });
        log(entry, "ticket.dependency_dispatch_wait", "Another RUN is preparing this dependency; Node will recheck dispatch in 30s.");
        return;
      }
      await save(entry, { dispatch_result: result, owner: null });
    } catch (error) { await fail(entry, error); }
  }

  // Returns SL only when a real completion or operational failure supplies new information.
  async function refresh(job) {
    if (job.status !== "dependency_wait") return false;
    const entry = await store.withLock(QUEUE, async () => (await store.list(QUEUE)).find((item) => item.id === job.dependency_request_id));
    if (!entry || !["completed", "failed"].includes(entry.status)) return false;
    job.dependency_result = { request_id: entry.id, ticket_id: entry.target.ticket.id, status: entry.status, result: entry.result ?? null, error: entry.error ?? null };
    job.history.push({ stage: "sprint_leader", event: "dependency_result_returned", ...job.dependency_result, completed_at: clock() });
    delete job.dependency_result_consumed; delete job.resolution; delete job.technical_reconciliation; delete job.validation_feedback;
    return true;
  }

  // Delegates persistence to an execution-fenced queue update so stale callbacks cannot revive cancelled work.
  function save(entry, patch) { return saveDependencyRepair(store, entry, patch, clock); }
  // Retains original technical causes for SL, without converting operational failures into Owner policy decisions.
  async function fail(entry, error) {
    const target = ticketStatusStore.get(entry.target.ticket.id);
    const preparing = target?.details.dependency_repair?.id === entry.id && target.details.dependency_repair.state === "preparing";
    const saved = await save(entry, { status: preparing ? "queued" : "failed", owner: null, available_at: preparing ? clock() + 30_000 : null,
      error: { code: error.code ?? "DEPENDENCY_REPAIR_FAILED", message: error.message } });
    if (!saved) return;
    log(entry, preparing ? "ticket.dependency_preparation_retry" : "ticket.dependency_failed",
      preparing ? `Dependency preparation retained; retry in 30s: ${error.message}` : error.message, "warn");
  }
  // Emits compact progress with both ticket identities instead of repeating context or successful test output.
  function log(entry, event, message, level = "info") {
    projectLogger({ event_name: event, level, status: level === "warn" ? "failed" : "pending", task_id: entry.parent.task_id,
      message, payload: { dependency_ticket_id: entry.target.ticket.id, dependency_request_id: entry.id } });
  }
  // Restarts short coordinator scans; invocation ownership stays with the ordinary ticket launcher.
  function start() { if (started) return; started = true; timer = setInterval(() => { void tick().catch((error) => logger.error?.("Dependency repair scan failed.", { error: error.message })); }, 1000); timer.unref?.(); }
  // Stops new scheduling without pretending an already launched provider has stopped.
  function stop() { started = false; clearInterval(timer); }
}
