// Reuses immutable AM decisions during later blocker recovery without turning historical authority into tool permission.
import { readBlockerContracts } from "./blocker-contract-evidence.js";
import { assertArchitectureDisposition } from "./blocker-decision-authority.js";

// Authenticates checkpoint receipts against the current ticket, execution continuation and approved Architecture before SL consumes them.
export async function readBlockerContractDelegation({ job, checkpoint, fileService, architecture }) {
  const contracts = await readBlockerContracts({ receipts: checkpoint?.contract_decisions, fileService, allowContinuation: true,
    binding: { project_id: job.request.project_id, task_id: job.request.task_id,
      execution_id: job.request.payload.execution_id, sprint_basis: job.request.payload.sprint_basis } });
  const receipt = contracts.findLast(({ record }) => architecture && ["plan_id", "revision", "sha256"].every((key) =>
    record.disposition.architecture_basis?.[key] === architecture.basis[key]));
  if (!receipt) return { contracts, delegation: null };
  assertArchitectureDisposition(receipt.record.disposition, { job: { ...job, stage: "architecture_manager" }, architecture });
  return { contracts, delegation: receipt.record.disposition };
}

// Re-arms one legacy false missing-contract stop after authenticated authority becomes usable; Stop and execution fences remain in the caller.
export function createBlockerContractRefresh({ inspect, fileService, clock = Date.now, projectLogger = () => {} }) {
  return async (job) => {
    if (job.stage !== "sprint_leader" || job.outcome_reason !== "BLOCKER_DISPOSITION_INVALID"
      || !job.validation_feedback?.some((entry) => entry.message === "A contract requires approved contract evidence; source existence alone is not approval.")) return false;
    const authority = await inspect(job);
    if (!authority) return false;
    const { contracts, delegation } = await readBlockerContractDelegation({ job, checkpoint: authority.checkpoint, fileService, architecture: authority.architecture });
    const identity = contracts.map((entry) => entry.sha256).join(":");
    if (!delegation || job.contract_delegation_refresh === identity) return false;
    job.contract_delegation_refresh = identity;
    job.history.push({ stage: "sprint_leader", event: "retained_contract_delegation_restored", completed_at: clock(),
      previous_feedback: job.validation_feedback, receipt_refs: contracts.map(({ path, sha256 }) => ({ path, sha256 })) });
    delete job.validation_feedback;
    projectLogger({ event_name: "supervisor.blocker_contract_delegation_restored", level: "info", status: "pending", task_id: job.request.task_id,
      message: "Authenticated checkpoint AM decisions are available to Sprint Leader validation; original checkpoint and tool denials remain enforced.", payload: { job_id: job.id } });
    return true;
  };
}
