// Releases settled ticket attempts without discarding source changes or resumable Coder history.

// Frees file and agent claims even when one cleanup fails, preserving the journal for retry.
export async function releaseTicketAttempt({ workspace, agentOccupancy, claim, taskId, ownerId, reason }) {
  try { await workspace?.changeLedger?.release?.({ close: false }); }
  finally { if (claim) await agentOccupancy.release({ claimId: claim.claim_id, taskId, supervisorId: ownerId, reason }); }
}
