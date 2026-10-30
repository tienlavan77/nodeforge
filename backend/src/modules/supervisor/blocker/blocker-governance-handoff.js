// Persists AM's source-bound contract as a reviewable governance draft without rebinding the approved Sprint.
import { statePath } from "../../../infrastructure/filesystem/forge-paths.js";
import { createHash } from "node:crypto";

// Binds immutable handoff bytes to their review identity.
const hash = (value) => createHash("sha256").update(value).digest("hex");

// Publishes the concrete review identity while leaving the original immutable Sprint and Coder parked.
export async function notifyBlockerGovernance({ job, authority, prepareGovernance, checkpoints, eventBus, projectLogger }) {
  if (!prepareGovernance) throw Object.assign(new Error("Contract revision persistence is unavailable."), { code: "BLOCKER_GOVERNANCE_UNAVAILABLE" });
  const handoff = await prepareGovernance({ job, plan: authority.plan });
  const latest = await checkpoints.load(job.request.task_id);
  if (latest?.failure?.at !== job.failure_at || latest.blocker_recovery?.job_id !== job.id) throw new Error("Contract handoff checkpoint changed before publication.");
  await checkpoints.save({ ...latest, status: "blocked", phase: "blocker_governance_required",
    blocker_recovery: { ...latest.blocker_recovery, status: "governance_required", governance_handoff: handoff, history: job.history } });
  await eventBus.publish({ type: "task.blocker.reconciliation_required", event_id: `BLOCKER-GOVERNANCE-${job.id}`, task_id: job.request.task_id,
    project_id: job.request.project_id, supervisor_id: job.request.supervisor_id, request_id: job.request.request_id,
    correlation_id: job.request.correlation_id, attempt: 1, payload: { job_id: job.id, reason: "contract_revision_required", governance_handoff: handoff,
      execution_id: job.request.payload.execution_id, execution_basis: job.request.payload.sprint_basis } });
  projectLogger({ event_name: "ticket.blocker_governance_handoff", level: "info", status: "blocked", task_id: job.request.task_id,
    message: `Architecture contract draft persisted: ${handoff.plan_id} revision=${handoff.revision} sha256=${handoff.sha256}. Exact governance approval and binding are required; Coder remains parked.`, payload: handoff });
}

// Stages immutable contract bytes and a canonical review index through the existing plan store.
export function createBlockerGovernanceHandoff({ plans, fileService, projectId }) {
  if (!projectId || !plans?.createRevision || !plans?.getRevision || !fileService?.atomicCreate) return null;
  return prepare;

  // Reuses the same draft after retries and preserves every original ticket criterion for owner review.
  async function prepare({ job, plan }) {
    if (job.request.project_id !== projectId || plan.project_id && plan.project_id !== projectId) throw new Error("Contract draft belongs to a different project.");
    const draft = job.resolution.contract_draft;
    const binding = { project_id: job.request.project_id, ticket_id: job.request.task_id,
      execution_id: job.request.payload.execution_id, sprint_basis: job.request.payload.sprint_basis,
      source_identity: job.request.execution_context, owner_decision_id: job.fulfillment_decision_id,
      owner_decisions: job.owner_decisions, job_id: job.id };
    const identity = hash(JSON.stringify({ binding, draft }));
    const planId = `PLAN-CONTRACT-${identity}`;
    const sourcePath = `${statePath()}/nf/plans/${planId}/ke-hoach-r1.md`;
    const bytes = `# ${draft.title}\n\nStatus: awaiting_human_approval. This draft does not authorize execution.\n\n${draft.markdown}\n\n## Immutable handoff binding\n\n\`\`\`json\n${JSON.stringify(binding, null, 2)}\n\`\`\`\n`;
    try { await fileService.atomicCreate({ path: sourcePath, content: bytes }); }
    catch (error) {
      if (error.code !== "FILE_ALREADY_EXISTS") throw error;
      if (await fileService.readFile({ path: sourcePath }) !== bytes) throw new Error("Contract draft bytes conflict with their immutable handoff identity.");
    }
    const ticket = job.request.ticket;
    const content = { objective: draft.title, outcome: "Finalize the selected contract through an exact governance revision and binding before Coder resumes.",
      in_scope: plan.content.in_scope || ticket.objective,
      out_of_scope: `${plan.content.out_of_scope || "No unrelated changes."}\nNo approval inheritance, Sprint rebinding, Coder launch or acceptance is granted by this draft.`,
      approach: draft.markdown, components: ["Architecture contract handoff"], tickets: [ticket.id],
      ticket_specs: [structuredClone(ticket)], dependencies: [...(ticket.dependencies ?? [])],
      risks: ["The original Sprint remains authoritative until a separately approved revision is bound through governance."],
      assumptions: [], open_questions: ["Exact contract approval and binding remain required before transport execution."],
      evidence_refs: draft.evidence.map((entry) => `${entry.path} sha256=${entry.sha256}`),
      acceptance_criteria: [...ticket.acceptance_criteria], governance_handoff: { ...binding, source_evidence: draft.evidence } };
    let revision;
    try { revision = await plans.createRevision({ planId, expectedRevision: 0, content, sourcePath, sourceSha256: hash(bytes) }); }
    catch (error) {
      if (error.code !== "PLAN_REVISION_CONFLICT") throw error;
      revision = await plans.getRevision({ planId, revision: 1 });
      if (revision.project_id !== binding.project_id || revision.source_path !== sourcePath || revision.source_sha256 !== hash(bytes)
        || JSON.stringify(revision.content) !== JSON.stringify(content)) throw new Error("Contract governance draft identity changed.");
    }
    return { plan_id: revision.plan_id, revision: revision.revision, sha256: revision.sha256, file_path: revision.file_path,
      source_path: sourcePath, source_sha256: hash(bytes), status: revision.status,
      execution_authorized: false, next_step: "Approve the exact contract revision and bind it through Sprint governance; then resume the unchanged acceptance scope." };
  }
}
