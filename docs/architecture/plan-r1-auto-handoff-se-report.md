# SE Implementation Report: R1 Plan and Automatic Handoff

Date: 2026-11-07
Role: System Engineer
Audience: Project Owner / Architecture Manager
Specification: `docs/architecture/plan-r1-auto-handoff-spec.md`

## Executive summary

Implemented the approved R1 plan and automatic-handoff primitives without committing or pushing. The implementation now distinguishes AM–SE critique from later Owner updates:

- AM critique updates the current unapproved `r1` in place.
- An Owner update creates a new `plan_id` at `r1`; the previous plan remains immutable.
- An explicit authenticated Owner delivery command can approve and hand off to `SE` or `SL` after critique reaches `ALIGNED`.
- SE execution remains behind durable checkpoint and receipt validation.
- Invalid critique patches fail closed and are durably represented as paused handoffs.

## Implemented behavior

### Plan identity and source integrity

- `conversation-planning-service.js` now creates a new `PLAN-${projectId}-${randomUUID()}` for Owner updates with `expectedRevision: 0` and revision `1`.
- `retainFencedPlanSource` accepts the new-plan `baseRevision: 0` case while retaining the conflict guard for existing revisions.
- `conversation-plan-source.js` supports explicit `overwriteUnapproved: true`; ordinary retention remains create-if-absent and immutable.
- `markdown-plan-store.js` adds `updateDraftRevision` for unapproved `r1` only.
- Draft updates use a plan lock, reject existing decisions, verify exact source bytes, retain the source snapshot, atomically write Markdown, and update the indexed digest.
- Critique persistence passes the new canonical source bytes as `summaryContent`, so the checksum verifies the revised source rather than the old source.

### Approval authority

- `markdownPlanStore.decide` is idempotent for the same decision, plan checksum, and approver.
- `startHandoff` derives approval mode on the server:
  - `explicit_owner_command`
  - `existing_decision`
  - `manual_panel_approval`
- Explicit `deliveryTarget: "se"` or `"sl"` commands call the server-owned `decide("approved")` path after `ALIGNED` consensus.
- Manual or panel flows still require an existing matching approval.
- Durable handoff records persist `approval_mode`; redacted handoff projections expose it.

### Critique and fail-closed behavior

- AM critique prompts explicitly state that critique never creates `r2`.
- A final `DISCUSS` is not treated as consensus. The handoff pauses with `CRITIQUE_CONSENSUS_REQUIRED`.
- A malformed, schema-invalid, conflicting, or source-mismatched fenced patch is not ignored. The handoff is persisted as paused with its typed error code, including `PLAN_PATCH_INVALID`, `PLAN_REVISION_CONFLICT`, `PLAN_DECISION_EXISTS`, or `PLAN_SOURCE_MISMATCH`.
- Critique source and Markdown updates remain guarded by the unapproved-r1 decision boundary.

### Readiness and recovery

- `startHandoff` fails fast before critique when the durable checkpoint is unavailable.
- AM, SE, and RV adapters are all required before automatic handoff begins.
- Missing dependencies return `HANDOFF_CHECKPOINT_UNAVAILABLE` or `HANDOFF_ADAPTER_UNAVAILABLE`.
- Existing durable checkpoint code continues to fence generations, preserve terminal receipts, avoid replay of completed steps, and require reconciliation for uncertain executions.
- Handoff projections expose server-derived `run`, `resume`, `stop`, and `reconcile` capabilities, plus compatibility fields used by existing consumers.
- Critique resume state is included in the `resume` capability.

## AM Review Round 1 (`docs/architecture/plan-r1-auto-handoff-review.md`) Remediation

1. **Full `SE → RV → AM` execution loop and dual conversation messages (`backend/src/application/am-se-handoff-service.js`, `am-se-handoff-checkpoint.js`, `am-se-handoff-store.js`):**
   - `resumeHandoff` now publishes dual conversation messages (`system_engineer.message.received`, `reviewer.message.received`, `architecture.message.received`) inside `invoke` when a receipted step completes, and supports `runToCompletion = true` (used by `startHandoff`) to iterate through durable `pending` steps (`SE → RV → AM` across review rounds) until `completed` (`[VERDICT: PASS]`) or a non-pending safe point (`paused`, `reconciliation_required`, `unknown`, `blocked`), while keeping single-step `resumeHandoff()` default behavior for step-by-step callers.
   - Aligned generation fencing across `plan_critique` and `implementation` checkpoints in `am-se-handoff-store.js`, `am-se-handoff-checkpoint.js`, and `am-se-handoff-service.js`, and ensured `replace: true` is passed to `fileService.atomicWrite` during unapproved `r1` draft/source overwrites.
2. **Synchronized `backend/tests/unit/conversation-plan-handoff.test.js` with R1 and auto-handoff rules:**
   - Preserved carried `conversation-intake.json` provenance into the new `plan_id` directory when `updateFromConversation` creates a new `r1` plan from a clarification-confirmed plan (`backend/src/application/conversation-planning-service.js`).
   - Updated `conversation-plan-handoff.test.js` to provide `gitService` and receipted `requestReviewer`/`requestSystemEngineer`/`requestArchitecture` mocks, verifying in-place `r1` critique merge patches, automatic SL handoff (`handed_to_node`), and full multi-round `SE → RV → AM` completion (`completed`).

## Files changed for this scope

- `backend/src/application/conversation-planning-service.js` (`sha256:f73b98514956e6f74835e3541a7c859b482753d460b05d2c250eb08806bdf0c3`)
- `backend/src/application/am-se-handoff-service.js` (`sha256:d06064cc635ba52bdbfc173d959e1070eff2739ad5f510e23b471d0dc3661dd9`)
- `backend/src/application/am-se-handoff-checkpoint.js` (`sha256:756ce676e493d0a44f8c5b7e0defe29d6b6de5c734914ba144f64c38ad41ac81`)
- `backend/src/application/am-se-handoff-store.js` (`sha256:817af94988fac93b104e1fd943f8825e7e5d6eeb214b25e17cab669616b11419`)
- `backend/src/modules/governance/conversation-plan-source.js` (`sha256:6bf672f7111bbb0a8503ae0299bb317fb28ca89101b764561f31f9ba317b3ce0`)
- `backend/src/modules/governance/markdown-plan-source.js` (`sha256:ad4837c80527b51c397494fab7b9caea145db1dbc99f0125b195713fc0f2791f`)
- `backend/src/modules/governance/markdown-plan-store.js` (`sha256:3715d3fae2cca7b3495162bb1500818f99ca7177064331f00e15b329e1d7c72d`)
- `backend/tests/unit/conversation-plan-update.test.js` (`sha256:ffa8ad5adde4d7ab8c546d5cecd231dc6c6044c349246d77b400e96b6c555566`)
- `backend/tests/unit/conversation-plan-handoff.test.js` (`sha256:dd6176246331d6e4c14e9e253baf2a327f3c5cb3b563a518a661c649f45ef5ff`)

Related earlier work preserved in the working tree includes the delegate-subagent provenance, runtime authorization, provider-option, and SDK fixture changes documented in `docs/architecture/subagent-forge-tool-se-report.md`.

## Verification evidence

All of the following focused checks passed:

| Verification | Forge run |
|---|---|
| AM Review required 3-suite check (`am-se-handoff-service-resume`, `am-se-handoff-checkpoint`, `conversation-plan-handoff`) | `VERIFY-RUN-d6711c85-0805-4539-89c9-d537e0dd4fa3` |
| Combined 6-suite R1 plan, approval, checkpoint, handoff, and HTTP route check | `VERIFY-RUN-68aaf4bb-af64-45e8-ab9d-2f1a630c183d` |
| Final backend typecheck | `VERIFY-RUN-9a99851a-bc9e-4e16-b895-6b75c4399e86` |
| Source, approval, clarification, and Owner-update suite | `VERIFY-RUN-23f7c304-5538-4b65-8028-159790120305` |
| Delegate-subagent and System Engineer SDK tests | `VERIFY-RUN-25302b35-afff-4b03-a563-52438f160c6d` |
| Owner-chat and plan-creation tests | `VERIFY-RUN-c6e4a45d-aeab-409e-a501-f01c5bf6c6be` |

The final focused commands included:

```text
npm run test --prefix backend -- tests/unit/am-se-handoff-service-resume.test.js tests/unit/am-se-handoff-checkpoint.test.js tests/unit/conversation-plan-handoff.test.js
npm run test --prefix backend -- tests/unit/am-se-handoff-service-resume.test.js tests/unit/am-se-handoff-checkpoint.test.js tests/unit/conversation-plan-handoff.test.js tests/unit/conversation-plan-update.test.js tests/unit/markdown-plan-approval.test.js tests/integration/am-se-handoff-run-route.test.js
npm run typecheck --prefix backend
```

## Compatibility and limitations

- The implementation was verified with focused unit/integration tests and backend typecheck; the full project suite, production migration, and live multi-provider matrix were not run.
- No production database migration was claimed. The report describes repository code and test verification only.
- Existing unrelated changes, including the pre-existing `conversation-crud-service.js` modification, were preserved.
- No commit or push was performed.
