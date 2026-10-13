// Keeps owner policy choices isolated to one exact Sprint Plan revision in the review UI.

// Identifies the immutable approval basis so choices never carry across plans or revisions.
export function planDecisionSelectionKey(plan) {
  return JSON.stringify([plan?.project_id, plan?.plan_id, plan?.revision, plan?.sha256]);
}

// Enables approval only after the owner explicitly chooses every proposed policy.
export function planDecisionSelectionsComplete(requests = [], selections = {}) {
  return requests.every((request) => Object.hasOwn(selections, request.id) && request.options.some((option) => option.id === selections[request.id]));
}
