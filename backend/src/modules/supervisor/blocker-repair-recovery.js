// Restores structured repair blockers from exact retained handoffs and tool receipts after older review paths lost triage.
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readLogEvents } from "../../core/project-log-service.js";
import { coderFailureTriage } from "./coder-recovery-policy.js";
import { retainBlockerContract } from "./blocker-contract-evidence.js";

// Recovers only a witnessed blocked report belonging to the current execution, never a guessed reason from agent prose.
export async function restoreRepairBlocker({ checkpoint, current, store, projectRoot, readEvents = readLogEvents }) {
  if (checkpoint.triage?.reason_code || !store || !checkpoint.correlation_id || !checkpoint.failure?.at) return checkpoint;
  const handoffs = (await store.list("sender.handoff")).filter((entry) => entry.task_id === checkpoint.task_id
    && entry.project_id === current.project_id && entry.correlation_id === checkpoint.correlation_id
    && entry.payload?.execution_id === current.details.execution_id
    && isDeepStrictEqual(entry.payload.sprint_basis, current.details.execution_basis));
  if (!handoffs.length) return checkpoint;
  const window = await readEvents({ logPath: process.env.NODEFORGE_PROJECT_LOG_PATH ?? join(projectRoot, ".forge/runtime/nf/project.log"),
    project_id: current.project_id, task_id: checkpoint.task_id, correlation_id: checkpoint.correlation_id,
    event_name: "supervisor.agent_tool_event", from: handoffs.map((entry) => entry.created_at).filter(Boolean).sort().at(-1), to: checkpoint.failure.at });
  const report = window.events.filter((event) => event.task_id === checkpoint.task_id && event.project_id === current.project_id
    && event.correlation_id === checkpoint.correlation_id && event.status === "failed" && event.payload?.tool === "report_done"
    && event.payload.arguments?.status === "blocked" && event.payload.error?.code === "CODER_BLOCKED"
    && handoffs.some((entry) => entry.request_id === event.payload.request_id)
    && Date.parse(event.timestamp) <= Date.parse(checkpoint.failure.at)).sort((a, b) => a.timestamp.localeCompare(b.timestamp)).at(-1);
  if (!report) return checkpoint;
  const details = report.payload.error.details;
  const blocker = details?.blocker ?? report.payload.arguments.blocker;
  if (!blocker?.reason_code || !blocker.owner_action || !Array.isArray(details?.evidence ?? report.payload.arguments.evidence)) return checkpoint;
  return { ...checkpoint, triage: coderFailureTriage({ code: "CODER_BLOCKED", details: {
    blocker, evidence: details?.evidence ?? report.payload.arguments.evidence } }), failure_request_id: report.payload.request_id,
    blocker_recovery_receipt: { event_id: report.event_id, timestamp: report.timestamp, request_id: report.payload.request_id } };
}

// Carries prior accepted AM terms into a new repair blocker without asserting that current source still satisfies them.
export async function retainPriorBlockerContracts({ checkpoint, current, store, fileService }) {
  if (!store || !fileService) return checkpoint;
  let restored = checkpoint;
  for (const ledger of await store.list("blocker.recovery")) for (const job of ledger.jobs ?? []) {
    if (job.request?.task_id !== checkpoint.task_id || job.request.project_id !== current.project_id
      || job.request.payload?.execution_id !== current.details.execution_id
      || !isDeepStrictEqual(job.request.payload.sprint_basis, current.details.execution_basis)) continue;
    restored = { ...restored, contract_decisions: await retainBlockerContract({ job, checkpoint: restored, fileService }) };
  }
  return restored;
}
