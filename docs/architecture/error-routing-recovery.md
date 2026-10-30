<!-- Describes safe recovery integration, evidence contracts, and activation dependencies without granting new policy. -->
# Error routing and Coder recovery

Implementation reference: `workflows/multiproject/plan-error-routing-recovery.md`; D1/D2/D3 implementation updated 2026-10-16 at the owner's request.

## Default behavior and activation

Production creates the recovery adapters by default for Registry-owned ticket workspaces. Defaults are **2 operational retries per execution, within 600,000 ms (10 minutes) from the first confirmed failure**, with at least 30 seconds before each retry. These are implementation defaults, not fabricated approval records or a registered plan revision. Standalone/direct-code requests retain their existing lifecycle. No live ticket RUN, provider fallback, or approval bypass is performed by installing this code.

`coderRecoveryPolicy()` reads deploy-time settings: `NODEFORGE_CODER_RETRY_ENABLED=true|false` (default true), `NODEFORGE_CODER_MAX_RETRIES` (default 2, range 1–10), and `NODEFORGE_CODER_RETRY_DEADLINE_MS` (default 600000, greater than 30000 and at most 86400000). Invalid values fail startup rather than creating an unlimited policy. The policy snapshot and deadline persist in the execution ledger and cannot reset on process restart, request/provider changes, or repair revision. Explicit `coderRetryPolicy` injection is available for tests and trusted deployments; Coder prose cannot override it.

`createCoderRecoveryRuntime()` builds the shared dependency for production Supervisor loops and inline SDK failure handling. Production worker startup starts its poller. `stop()` stops local polling; owner ticket Stop also fences status, aborts the local initial/retry provider, persists execution cancellation, and emits an execution-bound failure. Pending retries therefore remain stopped after restart. Disabling retries pauses scheduling; use ticket Stop to cancel existing pending work. No API restart is performed automatically by this change.

## Production adapters

- `validateExecution(request)` checks current Project/task/execution, immutable scheduling basis, approved ticket scope, source/manifest/commit, status, durable cancellation disposition, and dependency authority at scheduling and delivery. Invalidated work is cancelled, never rebound to a new revision.
- `dispatch(childRequest)` restores the current checkpoint and uses the existing `submitTicket` inline transactional launch claim for either failure source. It preserves the ledger's child ID, rechecks dependencies at launch, and rejects changed source during preparation. Generic queue lease expiry is **not** proof a provider invocation ended.
- `publishTerminal({request,event_id,reason})` uses the existing `task.failed` contract, stable event ID and persistent event bus; stale execution is fenced out. Exhaustion retains the checkpoint and never marks the ticket Coder-completed.
- `sdkFailureEvidence()` marks structured HTTP 429/503 rejection or a fully ended transient turn as safe. An aborted SDK, timeout or dropped connection without terminal evidence is unknown, retains launch ownership, and is not redispatched. Generic timeout text, process exit, authentication/configuration errors and ambiguous gateway errors are not blanket retry permission.

SL remains the triage coordinator, not a new approver. Structured blocked-report reason/evidence persists through SDK normalization into checkpoints and outcome audit. Allowed actions are evidence inspection, clarification of already-approved criteria, follow-up proposal and escalation. Scope/contract/access/security changes, owner rejection and finding adjudication keep existing human/Reviewer boundaries. No owner decision IDs, plan approvals or permission grants are generated.

## Durable state and failure ownership

The internal `coder-operational-recovery` ledger uses the existing interprocess file lock and atomic writes, keyed by Project/task/execution/Coder. It reserves the retry ordinal and child ID before dispatch. Both failure paths deduplicate by parent invocation ID before normal terminal handling. Retry availability is observed failure time plus 30 seconds; restart never resets this time or budget. Each tick dispatches at most one retry.

`pending` can advance to `invoking`, `cancelled`, or `terminal_pending`. A persisted `invoking` is never lease-reclaimed. A dispatch exception becomes `reconciliation_required`, not another automatic invocation. Successful dispatch becomes `dispatched`; an expired/exhausted budget creates a stable terminal event. Terminal publication is an idempotent outbox operation, not a new approval.

Unknown outcomes, owner rejection, blocked authority, verification logic, and invalid Reviewer output do not consume Coder infrastructure retry budget. Existing Reviewer operational and repair revision budgets are unchanged. Soft-review lifecycle and adjudication authority remain unchanged; a Coder failure is not success just because the review gate is off.

## Repair evidence

New Reviewer responses require canonical finding objects on both strict and compatibility paths: acceptance criterion, concrete failure, nonblank evidence/location references, and minimum change scope. Multi-file demands need a unique matching justification per file. Legacy strings cause `REVIEW_VERDICT_INVALID` on fresh review or reconciliation failure on cached reuse; no evidence is fabricated to adapt them.

Verification failure diagnostics load the latest failed artifact matching task/Project/commit/source/base/manifest, include actual command kind/argv/exit code and already-redacted stdout/stderr, and retain a durable artifact reference when output is truncated. Collector mismatch or missing/stale diagnostics cannot request blind Coder repair. Storage failures remain infrastructure faults. The same diagnostic is included in bounded verification-recovery SDK errors so checkpoint/resume retains useful evidence.

## Verification scope

Targeted tests cover fake-clock 29.999s/30s, real file locking with competing service instances, restart/dedup, independent budget/deadline, cancellation/stale validation, persisted unknown invocation, both failure hooks, canonical/legacy Reviewer parsing, command diagnostics, and verification infrastructure routing. Existing automatic-review E2E tests cover report → review → repair revision → approval → integration and soft-gate invariants. No real provider requests or full project suite are required.

`coder-production-recovery.test.js` exercises the real SDK ticket integration and locked file/checkpoint stores with a simulated provider: bounded retry/exhaustion, success/integration, Stop while pending/active, restart, competing adapters, stale authority and unknown provider ownership. Provider gateways also have targeted simulated-SDK tests. No paid/live provider call is used; deployment of the code requires the normal service restart and existing ticket RUN/approval gates. This document does not register or approve the governing plan.
