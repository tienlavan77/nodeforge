<!-- Documents automatic SL/Architecture blocker investigation, existing-authority resume and bounded owner escalation. -->
# Automatic blocker recovery

Coder `CODER_BLOCKED` is not an infrastructure retry. Structured reasons `SCOPE_CONFLICT`,
`CONTRACT_DECISION_REQUIRED`, `ACCEPTANCE_AMBIGUOUS`, `ACCESS_REQUIRED`, and `SECURITY_RISK`
enter a durable `blocker.recovery` ledger through the production execution event bus.
Startup also captures existing parked checkpoints with structured triage metadata, so the
owner does not need to copy logs, coordinate agents, or manually reset tickets.

## Lifecycle and authority

1. Retain the original Coder checkpoint, worktree, execution basis and source identity.
2. Dispatch a read-only Sprint Leader investigation through its configured SDK profile.
   Root-only tickets use live project files for discovery and evidence revalidation,
   including contract preflight. `worktreeFileService` in this mode is the immutable
   Reviewer commit view and must not be used for pre-commit blocker investigation.
   Reviewer reads remain commit-bound; triage exposes only role-checked read/list tools.
3. SL decides within the approved Sprint and may resume directly; it does not ask AM
   to rubber-stamp ordinary technical work. Outside Sprint authority, SL dispatches AM,
   never the owner directly. AM decides within the approved system structure; only a
   boundary beyond AM authority may produce an owner policy question.
4. Verify approved authority references (or legacy exact quotes) and live SHA-256 evidence. A contract resolution
   must match the approved `execution_policy.contract_evidence` path, SHA-256 and
   authority quote exactly; finding source or a filename in prose is not approval.
5. Revalidate plan, dependencies, cancellation, execution and source before resuming.
   Resume uses the same transactional execution and inline provider launch boundary;
   it preserves completed tool receipts/session identity and still requires normal
   verification and independent review. It never marks a ticket done by disposition.
6. AM escalation requires a concrete approved boundary, rationale, two to four options
   and a recommendation. An SL `owner_required` response is routed to AM, not the owner.
   Technical choices do not require owner permission merely because they need AM.
   Existing Human Review evidence UI
   displays them separately from Reviewer approval; Human Approve cannot clear them.
   New scope/contracts still require the existing exact plan revision/hash approval
   and execution gates. No approval records or replacement ticket contracts are forged.
   A technical failure without an agent proposal is logged as reconciliation, not as
   a successfully investigated request for new owner policy authority.
  For an AM `owner_scope` escalation, the runtime automatically creates one idempotent
  foundation-only successor Sprint from the approved Architecture parent and dispatches
  it through the normal Coder verification and review gates. The original transport
  ticket remains immutable and owner-gated; it is never completed, reopened or repaired
  by this split. Other owner boundaries do not trigger an automatic split. If successor
  creation or dispatch fails, the original checkpoint remains blocked and the failure is
  recorded for reconciliation. Only a concrete new public transport contract requires
  the bounded owner decision.

AM's `authority_scope: architecture` resolution binds `architecture_basis` to the
exact approved Markdown parent of the Sprint. Node loads it through `assertApproved`,
checks project/path/revision/SHA, supplies it to the agent and revalidates before resume.
Agents may use `authority_reference: {passage_id, rationale}` from Node-issued passages
instead of copying the plan's wording. Guidance, rationale and optional quote may be
paraphrased or translated; Node resolves the reference to the approved source text.
This is provenance grounding, not a similarity score or proof of semantic equivalence.
AM must explain applicability and preserve every restriction; a reference alone cannot
create a contract or authorize a structure/policy change. Identity, evidence checksums
and explicit contract-evidence bindings remain exact and are never fuzzy-matched.
`boundary_assessment` must explicitly retain structure, owner scope, security/data
policy, guardrails and the immutable ticket contract. An agent-authored document or
boolean claim alone cannot establish approval. Sprint scope is likewise read from the
approved plan, not only from a ticket objective. Reviewer/verification gates remain.

Only AM `owner_required` with a valid `escalation` emits
`task.blocker.owner_decision_required`. Tool/provider failures, uncorrected dispositions,
unknown outcomes or exhausted budgets emit `task.blocker.reconciliation_required`,
persist `reconciliation_required` and do not ask the owner to approve a fake policy.
Legacy terminal jobs are retained as historical evidence; loading new code does not
replay them or reset their budgets. Automatic prerequisite ticket creation and execution
are not introduced by this authority-routing change.

The source/basis fence also covers revoked approval, execution replacement and stale
findings. No retained finding is closed, no soft-review completed ticket is reopened,
and unrelated work remains untouched. A new plan invalidates old recovery intent;
approval of a new plan is not permission to replay an old source-bound job.

## Durability, limits and Stop

Completed provider responses are saved in `disposition_attempts` before validation,
with bounded response text/digest, stage and received/accepted/rejected status.
Malformed JSON is also retained. Errors identify the field, reason and expected/received
identity where applicable. Correctable response errors return to the same SL/AM stage
with `validation_feedback` and the rejected response, until valid or the original
call/deadline budget is exhausted. No rejected disposition resumes Coder. Explicit
boundary changes or unavailable authority do not become a retry-until-approved loop.
Terminal checkpoints retain attempts/feedback for audit; old terminal jobs are not replayed.
Reference feedback distinguishes unknown IDs from `reference_scope_mismatch`: a valid
Sprint reference cannot authorize an Architecture-scoped disposition. Corrections include
the actual scope and bounded valid alternatives, without silently changing authority.
Correction budget/deadline exhaustion has its own outcome reason; terminal logs include
the last validation error rather than only a generic reconciliation message.

The execution-wide policy snapshot permits at most four investigation calls and two
Coder resumes within ten minutes. Infrastructure retry and Reviewer repair budgets
remain separate. Failure redelivery is deduplicated by execution/source/reason/failure;
new failures, repair revisions, providers and process restart do not reset the budget.
Calls are reserved under the existing interprocess file lock before provider invocation.
An `invoking` or Coder `dispatching` stage is never lease-reclaimed. Unknown outcomes
retain launch/agent ownership and require reconciliation, never automatic replay.
Each SDK stage has a maximum two-minute deadline; unavailable roles wait within the
execution deadline without consuming provider calls. Terminal notification is a
stable-event-ID outbox operation. Stop cancels pending stages and interrupts local
investigation without deleting checkpoints or pretending an unknown provider ended.

## Prevention before Coder dispatch

New tickets that must reuse an existing contract declare
`execution_policy.requires_existing_contract: true` and inspected `contract_evidence`
entries `{path, sha256, authority_quote}`. Sprint Leader instructions require these
when approved scope prohibits inventing a public/management contract. Missing/stale
evidence routes discovery to SL/Architecture before a Coder invocation. The policy
is compared with the immutable approved ticket; a mutable projection cannot remove
it. Existing approved tickets are not silently rewritten or classified by prose.

## Verification and deployment

Targeted tests use real locked file/checkpoint persistence and simulated providers for
SL → Architecture → checkpoint resume, contract proposals, preflight, stale evidence,
Stop, restart/dedup, concurrent workers, finite budgets, unknown provider ownership,
tool-only discovery and proposal rendering. No paid provider request, live ticket RUN
or server restart is performed during implementation. Normal deployment must load
the new runtime wiring before these changes affect the running service.
