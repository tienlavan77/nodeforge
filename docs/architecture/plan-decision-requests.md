# Legacy owner policy proposals in Sprint Plans

This protocol applies only to historical persisted Sprint Plans. New planning
uses [Architecture clarification](architecture-clarifications.md): owner choices
are written into the Architecture Markdown before generation completes, and SL
consumes the approved policies without creating another questionnaire. A new SL
draft with unresolved human policy prerequisites is rejected with
`ARCHITECTURE_REPLAN_REQUIRED`; the old fallback must not generate new questions.

Historical Sprint Plans contain policy alternatives in each Sprint Plan's
`human_plan.decision_requests`. Each request specifies its `id`, `title`,
`reason`, affected `ticket_ids`, positional `criterion_ids` such as `AC-1`,
and `options` containing `id`, `label`, and a concrete `description` with
trade-offs. `recommended_option_id` is advisory, not an owner selection.

For example, propose storage scope, restored metadata, closing a panel while
work runs, and reopening behavior as separate requests when the ticket needs
those policies. The owner opens **Review & approve** on each Sprint Plan,
selects every option, then approves the exact revision with owner credentials.
Recommendations are never preselected. Multiple pending Sprint Plans remain
visible independently; approval of one does not approve the others.

The JSON decision endpoint accepts `selections: { "STORAGE": "LOCAL" }`
alongside the exact checksum and decision identity. Choices persist atomically
with the authenticated approval and cannot carry to a new revision. Coder receives
the approved descriptions and immutable approval basis before execution.
Architecture approval may authorize drafting but cannot approve child policies.

Legacy human verification prerequisites without proposals become visible
unresolved requests. They have no selectable options: SL or the owner must create
a new revision with concrete proposals before approval. Do not invent policy
defaults, delete the prerequisite, or mark executable checks passed to bypass it.
Owner choices satisfy policy-only human evidence, not test/build/browser checks.
This change does not clear failed executions or approve existing runtime plans.
