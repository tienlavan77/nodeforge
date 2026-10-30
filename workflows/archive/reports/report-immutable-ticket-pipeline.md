<!-- Reports implementation evidence and remaining gates for the immutable ticket pipeline. -->
# Immutable Ticket Pipeline — implementation report

## Re-audit conclusion

The implementation is materially ahead of the original report, but the epic is **not yet releasable as a completed immutable-evidence pipeline**. A1, scoped A2 Reviewer evidence, and A3 have passed in a disposable production Control API composition with live provider Coder/Reviewer, restart, terminal evidence, duplicate-delivery checks, and per-event shadow identity receipts. A4–A6 remain release-blocking: the 15 legacy records have no recorded owner disposition, A5 still requires an adapter-removal or time-bounded human extension decision, and no enforce canary or human release decision exists.

## Ticket status

| Ticket | Re-audit status | Evidence and remaining condition |
| --- | --- | --- |
| NF-PIPE-CTX-001 | Code implemented; acceptance pending | `ticket-execution-context.js` persists versioned context, CAS updates, and ledger-derived manifest. Read-only migration inventory classified 15 active legacy records; production restart/ownership evidence remains. |
| NF-PIPE-VERIFY-002 | Code implemented; acceptance pending | `ticket-verification-service.js` persists redacted artifacts and checks commit/source/base/manifest identity. The final receipt is durable, but production dispatch/restart coverage is not fully demonstrated. |
| NF-PIPE-REV-003 | A1 live witness and A2 negative cases passed; broader acceptance pending | `ticket-review-evidence.js` checks context/artifact/commit/base/manifest and committed worktree state. Forge source windows carry verified provenance and reject drift. The live Codex Reviewer checkpoint persisted `completed/approved` with the exact artifact and reviewer ID before terminal integration. A2 rejects changed commit/manifest/checksum, missing artifact, and unavailable read tool. |
| NF-PIPE-FIND-004 | Code implemented; acceptance pending | `ticket-review-findings.js` provides IDs, statuses, evidence, and stale-resolution checks. Needs production loop proof that only unresolved required findings are dispatched. |
| NF-PIPE-ERR-005 | Transport coverage implemented; acceptance pending | HTTP, SSE, TestService, and Agent Settings errors now emit the canonical envelope. Legacy fields remain only in boundary adapters, with a dated removal target below. Production consumer audit remains. |
| NF-PIPE-E2E-006 | A1/A3 passed; epic still partial | Disposable Git/File Service integration, full production composition with a live provider, API restart, SDK Reviewer, terminal claims, SQLite duplicate-event replay, legacy-envelope transport, migration inventory, and live per-event shadow identity comparison are covered. Legacy dispositions, error-consumer closeout, and enforce canary remain open. |

## E2E evidence

`node --test backend/tests/integration/immutable-ticket-pipeline.test.js` passes 2/2. The fixture exercises competing tickets on one file, claim retention, disjoint root edits, untracked worktree edits, created/deleted/renamed files, duplicate verification request, API-service restart, wrong/missing artifact, source mutation, root HEAD conflict, a repeated Reviewer finding across commits, re-verification, unavailable Reviewer source tools, approved integration, terminal context, and idempotent integration receipt. The tests execute Git commits and the selected TypeScript verification command in disposable projects. They do not invoke a real SDK Reviewer or a full Control API process.

The tests uncovered and the implementation fixed three identity bugs: dependency symlinks were reported as dirty source; a later ticket commit included a previously deleted path in Git pathspec; and integration rejected a verified multi-commit review revision whose project HEAD was still its ancestor. The child-process HTTP witness reads persisted commit/artifact identity before and after service restart, and checks terminal context and claim release. It does not start the full production composition root.

## Migration and rollout evidence

`ticket-pipeline-inventory.js` reads worktree/checkpoint/ledger/context/job metadata without changing ticket state. Its inventory of this project found **15 active legacy records requiring human review**; `NF-UI-CONV-003` and `TICKET-PROJECT-NODEFORGE-1790660105591` include pre-context worktree commits. These records are not relabeled as immutable evidence.

The project remains in **shadow** mode. `start-control-api.mjs` persists the project-scoped shadow flag when absent and logs classification counts. The live disposable production witness now exercises direct-path, per-event shadow recording: it persists matching identity receipts for `verification.passed`, `review.approved`, and `task.completed`, bound to the context, manifest, verified artifact, reviewed commit, Reviewer, and integration identities. The witness restarts its disposable API and proves same-event replay idempotency; the shadow unit test classifies identity drift as `mismatch`. This closes A3, but it does not authorize enforce: all 15 legacy records remain undispositioned, A5 remains partial, and the production release gate is not configured.

## A1 acceptance recovery (2026-09-29)

`backend/tests/integration/control-api-composition-witness.test.js` launches the actual `start-control-api.mjs` composition against a disposable Git project via `NODE_CONTROL_PROJECT_ROOT`, with an isolated control database and port. Its no-profile RUN fails closed as expected. The separate live-provider fixture supplies the full A1 lifecycle; the no-profile fixture remains a startup and fail-closed regression check.

The live-provider fixture supplies separate Codex Coder and Reviewer profiles to a disposable production Control API and uses the actual provider SDK. The final A1 run passes 1/1: Coder produced a passed artifact, the API restarted, Reviewer checkpoint persisted `completed/approved` with matching reviewer/artifact IDs, the integration receipt and root HEAD matched the reviewed commit, context became terminal, and both claims were released. A second RUN after terminal returned `202/accepted` without creating another artifact or receipt. A separate SQLite event-store test rejects replay of the same approval event ID after restart, and the Supervisor test verifies that repeated approval has one terminal effect. Earlier runs exposed a checkpoint regression, now prevented by the Reviewer checkpoint store, and a missing commit/artifact provenance field in source reads, now supplied by Reviewer Forge tools. Exact IDs and commands are in the acceptance record.

## Evidence reviewed

- `backend/src/modules/supervisor/ticket-execution-context.js`: persisted context, version/CAS checks, Supervisor-owned manifest identity, and terminal freeze.
- `backend/src/modules/supervisor/ticket-verification-service.js`: durable artifact persistence and checks for commit, source revision, base SHA, manifest SHA, current HEAD, and file checksums.
- `backend/src/modules/supervisor/ticket-review-evidence.js`: review-time identity and clean-worktree gates.
- `backend/src/modules/supervisor/ticket-review-findings.js`: durable finding IDs and stale-resolution protection.
- `backend/tests/integration/immutable-ticket-pipeline.test.js` plus focused unit tests: useful disposable-project evidence, but not a production-process proof.

## Release gate

The ERR-005 transport fixture starts a real HTTP listener and sends a legacy application error through HTTP, SSE projection, and UI ingress. It verifies exactly `{code,message,retryable,scope,requestId}`, secret redaction, and legacy `recoverable: false`. `node --test backend/tests/integration/error-envelope-transport.test.js backend/tests/unit/test-service.test.js` passes 9/9. The compatibility adapters for `error_code`, `request_id`, and `recoverable` have a **removal target of 2026-10-13** after production consumers and historical messages are audited; they must not be removed automatically before that audit passes.

- Focused backend test set: 36/36 passed.
- `pnpm typecheck`: passed.
- `pnpm validate:schemas`: 97 schemas and 91 fixtures passed.
- Focused ESLint for changed pipeline modules: passed.
- `git diff --check`: passed.
- Full `pnpm lint`: fails with 32 errors in other repo files; these are outside the focused pipeline lint set and need separate ownership/review.

Latest focused verification (2026-09-29): `node --test backend/tests/unit/ticket-pipeline-rollout.test.js backend/tests/integration/ticket-pipeline-inventory.test.js backend/tests/integration/immutable-ticket-pipeline.test.js backend/tests/integration/reviewer-sdk-immutable.test.js backend/tests/integration/error-envelope-transport.test.js` passed **6/6**. `pnpm typecheck`, `pnpm validate:schemas` (97 schemas, 91 fixtures), scoped ESLint on the inventory/rollout modules and rollout test with `--rulesdir eslint-rules`, and `git diff --check` passed. An initial ESLint invocation without the repository's required `--rulesdir` failed with an unknown-rule error; it also exposed existing unused bindings in `start-control-api.mjs`, which were not introduced by this rollout.

**Decision: keep the epic open and block release classification.** A1–A3 have current passing witnesses; the remaining release work is:

1. **A4:** refresh the inventory and obtain a durable Sprint Leader/human-owner disposition for each of the 15 active legacy records. Enforce remains prohibited while any record is undispositioned.
2. **A5:** complete the named production-consumer/historical-message audit; then, by **2026-10-13**, remove compatibility adapters or append an explicit time-bounded human extension. The successful replay does not itself close the adapter decision.
3. **A6:** after A4 and A5 pass, configure the human-authority release gate and run a bounded enforce canary covering mismatch fail-closed behavior, rollback, restart, and duplicate-event recovery. The release authority must sign the evidence record.
4. Retain the traceable command log—commands, commit SHA, artifact/event/receipt IDs, checksums, exit codes, and timestamps—in the acceptance record.

Until these are complete, an approved verdict is evidence of a locally gated review flow, not proof of production-wide immutable-ticket compliance.

## A2–A6 continuation (2026-09-29)

A2's provider Reviewer witness and negative identity/tool cases pass. A3 has passed: the live disposable production Control API witness produced matching, hashed receipts for all three eligible event types, restart, terminal integration, released claims, and duplicate RUN recovery; historical failed attempts remain retained in the acceptance record. A4 has an owner disposition store and an enforce blocker, but the current project still has 15 undispositioned legacy tickets. A5's transport, Node/UI-client, and replay tests pass—167 historical errors projected to canonical SSE and UI results with no failures—yet 50 stored messages retain legacy fields and the adapter-removal/extension decision remains open. A6 remains blocked: production has no configured release gate, no enforce canary was run, and no release authority decision exists. The project remains in shadow mode.

## A5 atomic execution-ticket gate

The A5 contract is enforced at persistence and RUN boundaries. Governance tickets with `rollout_package: "A5"` must carry an `execution_contract` containing scope, acceptance criteria, verification plan, owner, Ticket Supervisor, Coder, Reviewer, optional human authority, dependencies, `gate: "shadow"`, ledger revision, and idempotency key. Ticket creation rejects an incomplete A5 contract; `dispatchTicket` revalidates the persisted ticket before restart-resume or RUN. Ad-hoc A5 prompts and arbitrary RUN requests cannot satisfy the acceptance record.

Evidence: `node --test backend/tests/unit/ticket-crud-service.test.js` passed 18/18; `pnpm validate:schemas` passed 97 schemas and 91 fixtures; typecheck and `git diff --check` passed. No Control API restart or A5 RUN was performed by this implementation.

The required atomic ticket now exists: `NF-PIPE-ERR-005-A5`, persisted via `POST /forge/v1/tickets?project=PROJECT-NODEFORGE` with HTTP `201`, roadmap ledger revision `1.0.104`, `shadow` gate, full execution contract, and idempotency key `A5-NF-PIPE-ERR-005-001`. The ticket-list read confirmed the persisted `rollout_package: "A5"` and contract. Restart and `RUN` remain intentionally pending until this evidence is reviewed.

## Root-only terminal receipt follow-up (2026-09-30)

Root-only and worktree integration now use one Forge File Service terminal receipt writer with `prepared → completed` recovery. Root-only recovery verifies the reviewed commit before reusing a receipt; both modes record a short branch name. Deterministic receipt/workspace/integration tests passed **7/7**; typecheck, scoped ESLint, and `git diff --check` passed. A full real-provider root-only canary passed **1/1** in about 245 seconds using a disposable Control API and separate Codex Coder/Reviewer fixture profiles. It recorded an approved Reviewer checkpoint, completed integration receipt, matching root HEAD and reviewed commit, terminal context, released claims, matching shadow event receipts, and duplicate RUN `202/accepted` without a second artifact. Commit, artifact, manifest, command, and historical failed attempts are recorded in `immutable-ticket-acceptance-record.md`. This resolves the missing-receipt failure of the earlier Cú đêm → Leader probe in the tested root-only fixture; that earlier probe remains a failed historical run. The canary does not close legacy dispositions, the A5 adapter decision, or A6 enforce and release authority gates. The epic remains in shadow mode.

## Release-gate progress (2026-09-30)

- **A2 advanced HEAD passed.** A disposable production Control API ran real Codex Coder and Reviewer profiles. After verification, a separate `README.md` commit advanced HEAD. Reviewer approved the original ticket commit and artifact; its checkpoint and terminal receipt completed, claims released, duplicate RUN stayed idempotent, and no `REVIEW_COMMIT_STALE` occurred. The live witness passed 1/1 in 458.8 seconds. IDs, hashes, and command are in the acceptance record.
- **A4 remains blocked.** Fresh inventory contains **16** active, undispositioned records: 15 `human-review-required` and the historical A5 attempt mechanically classified `migratable`. That A5 classification does not override its dirty-baseline incident. No owner disposition was invented or persisted.
- **A5 audit progressed, closure remains blocked.** The current corpus is 19 JSONL files and 2,414 messages. All 176 historical error messages projected to canonical SSE and UI errors, zero failures; 50 still carry legacy fields. A real HTTP/SSE/UI consumer test exposed an extra UI `recoverable` field, now removed from the normalizer. Focused tests pass 18/18; typecheck and schema validation pass. Adapter removal or an explicit dated human extension is still required by 2026-10-13. The blocked A5 ticket was not resumed, and the audit is not a substitute for its required RUN evidence.
- **A6 remains gated.** No enforce canary or release signature was attempted while A4 and A5 are unresolved. Project rollout remains `shadow`.

Next owner decisions: dispose each current A4 record against a refreshed fingerprint; choose the documented A5 dirty-baseline resolution; and decide adapter removal or an extension naming owner, scope, risk, and expiry. Only after these are persisted and A5 passes can the release authority authorize and sign an A6 enforce canary.

## Owner decisions applied (2026-09-30)

The owner chose cancellation of all 16 A4 legacy records, closure of the old A5 attempt, and removal of legacy error adapters. All 16 durable disposition records now read `cancelled`; inventory inspection reports zero blocked. Original evidence was retained. A production dispatch guard now rejects those ticket IDs before resume once the Control API loads the new code.

The old `NF-PIPE-ERR-005-A5` ticket is marked `failed` and superseded. New ticket `NF-PIPE-ERR-005-A5-R2` was persisted with a fresh contract and shadow gate, but was not run because its source baseline has not yet been proved clean. That RUN and independent Reviewer acceptance remain required to close A5.

Runtime error normalizers now use canonical fields. Fifty historical errors were moved to indexed canonical projections in one database transaction while the original JSONL stayed intact. Post-migration replay served 177/177 canonical SSE and UI errors, preserving the 50 specific historical codes. Focused tests passed 35/35, conversation/owner-chat regressions 9/9, and disposable API composition 1/1; typecheck, schema validation, scoped lint, and `git diff --check` passed. The user's Control API was left running; it must be restarted by its operator to load the new dispatch and adapter code. A6 remains closed until A5 RUN/review passes and a release authority signs the canary.

The migration also runs idempotently at Control API startup, covering any legacy messages written before that restart. A disposable production composition restart test passed 1/1. The new ticket remains unrun because the project root still contains uncommitted source changes within the A5 scope; those changes need a clean, attributable baseline before Supervisor dispatch.
