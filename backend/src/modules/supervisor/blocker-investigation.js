/** Persists read-only recovery communication and raw agent replies under the
 * active invocation fence. Splitting this journal writer keeps the dispatcher
 * focused on stage transitions while preserving correction and restart data. */
import { createDiscoveryCheckpointWriter, discoveryAssignment } from "./blocker-discovery-checkpoint.js";
import { blockerResponseEvidence } from "./blocker-validation.js";

/** Binds agent callbacks to the same durable reservation as the dispatcher;
 * cancelled or superseded work cannot overwrite a newer ticket checkpoint. */
export function createBlockerInvestigation({ store, validate, investigate, update, clock, deadlineMs }) {
  // Records completed agent output before validation so format correction can
  // reuse its evidence without rerunning the investigation after restart.
  return async function investigateAndRecord(work, job) {
    const response = await investigate(job, { deadline: work.deadline, onDiscoveryCheckpoint: createDiscoveryCheckpointWriter({ store, ledgerId: work.ledgerId, job, validate }),
      onNodeVerificationCompleted: async () => { if (!await update(work, (_current, ledger) => { ledger.deadline_at = clock() + deadlineMs; })) throw new Error("Baseline recovery reservation changed."); return clock() + deadlineMs; },
      onAgentSelected: async (actor) => { job.invocation_actor = actor; if (!await update(work, (current) => { current.invocation_actor = actor; })) throw new Error("Investigation ownership changed before provider dispatch."); },
      onCommunication: async (communication) => { if (!await update(work, (current) => { current.communication = { ...current.communication, ...communication }; })) throw new Error("Communication no longer owns the recovery assignment."); },
      onTicketProgress: async (progress) => { if (!await update(work, (current) => { current.ticket_progress = progress; })) throw new Error("Ticket progress reservation changed; do not invoke provider."); } });
    const saved = await update(work, (current) => {
      current.disposition_attempts ??= [];
      current.disposition_attempts.push({ stage: current.stage, assignment_id: discoveryAssignment(job), status: "received", received_at: clock(), response: blockerResponseEvidence(response) });
    });
    return saved ? response : null;
  };
}
