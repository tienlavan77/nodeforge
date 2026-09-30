<!-- Records redacted, reproducible release evidence for the immutable ticket pipeline. -->
# Immutable Ticket Pipeline — acceptance record

> **2026-09-30 model update:** Earlier rows below record worktree-model evidence only. Root-only acceptance requires a separate commit/tree/manifest/archive witness under `docs/giai-doan-3/root-only-ticket-commit-plan.md`; passing historical A1–A3 rows does not authorize root-only enforce or migration of blocked A5.

## Root-only implementation witness — 2026-09-30

| Gate | Result |
| --- | --- |
| Root commit and recovery | Disposable repository tests cover unrelated dirty files, dirty claimed baseline rejection, transaction trailer and orphan recovery, ref-advanced restart, duplicate commit, and no shared staged entries. |
| Concurrency | Two disjoint ticket commits serialize on one root branch; a competing same-path write fails its file claim. |
| Immutable evidence | Ticket A's archive verification and committed Reviewer source remain valid after ticket B advances root `HEAD`; the artifact records the commit tree and `git-archive` method. A real TypeScript command runs from the disposable archive. |
| Production startup | Explicit `NODEFORGE_TICKET_EXECUTION_MODE=root-only` starts and restarts a disposable Control API; a no-profile ticket RUN fails closed. This does not prove a live provider lifecycle. |
| Commands | Root commit, concurrency, workspace, and Git Service tests: **20/20 pass**; explicit root-only Control API startup/restart witness: **1/1 pass**; `pnpm typecheck`: pass; `pnpm validate:schemas`: 97 schemas and 91 fixtures pass; targeted ESLint: pass; `git diff --check`: pass. |
| Release state | **Blocked:** legacy ticket disposition, durable human baseline approval transaction, full live-provider root-only canary, and release authority remain outstanding. The execution mode is explicit opt-in. `NF-PIPE-ERR-005-A5` remains blocked historical evidence. |

Full `pnpm lint` currently fails with 32 errors in other repository files, including pre-existing unused symbols in `start-control-api.mjs`; targeted lint for the root-only implementation passes. This witness must not be used as an A5 or A6 acceptance receipt.

## Root-only live Coder canary — 2026-09-30

**Result: blocked before `report_done`; no acceptance evidence.** Command: `NODEFORGE_REAL_PROVIDER_WITNESS=1 NODEFORGE_REAL_PROVIDER_ROOT_CODER=1 node --test backend/tests/integration/control-api-real-provider-witness.test.js`. The disposable Control API selected the real Codex Coder and completed one Forge `sed_lines` read of `workflows/agents/coder.md`. The second `sed_lines` request for `backend/src/witness.js` was rejected by automatic approval review: provider HTTP 503, system CPU 91.7% above its 90% threshold. Supervisor recorded `AGENT_REPORT_MISSING`; the Coder checkpoint remained `in_progress` after one successful tool call. No edit, commit, verification artifact, or `report_done` was observed. The canary-owned process was terminated without touching the user's Control API. This attempt must not be counted as root-only live-provider acceptance; a new run requires explicit authorization after the automatic approval rejection is reported.

**Authorized retries:** After the user authorized another run, the first retry exited after 35 seconds with `AGENT_REPORT_MISSING`; the fixture cleaned its disposable logs before tool failure details were retained. The diagnostic retry exited after 67 seconds with `AGENT_REPORT_MISSING` and a failed `edit_diff` call whose error mentioned automatic approval review. The fixture had already deleted the detailed log, so its HTTP status and reviewer rationale are unknown. Neither retry reached `report_done`, commit, or verification. The disposable Control API was cleaned up. Further retries were paused at that point; bypassing review was not an acceptable canary result.

**Authorized confirmation run:** `NODEFORGE_REAL_PROVIDER_WITNESS=1 NODEFORGE_REAL_PROVIDER_ROOT_CODER=1 NODEFORGE_REAL_PROVIDER_PRESERVE_FAILURE=1 node --test backend/tests/integration/control-api-real-provider-witness.test.js` passed 1/1 in 322.4 seconds. The real Codex Coder successfully called Forge `edit_diff`, `commit_changes`, `run_test`, and `report_done` with the existing `on-request` and `auto_review` settings. The disposable root-only project produced commit `292ca2ca758415c0bc11c4bae891c7123429a0d2`, tree `08569f220f12d8527e32ff1b4ba666017f6dd3a8`, passed archive artifact `ARTIFACT-60d57720-0116-4b64-8748-305aeb9df165`, and a completed Coder checkpoint. No Reviewer checkpoint was created, as this run intentionally stopped at `report_done`. The successful run shows the approval path can allow `edit_diff`; it cannot establish the exact reason for the earlier `edit_diff` failure because that attempt's detailed log was deleted. The first attempt's HTTP 503 CPU-overload response remains direct evidence of a reviewer service outage on that attempt. The test cleaned its disposable Control API and project.

## A1 — historical blocked startup attempt

| Field | Recorded value |
| --- | --- |
| package_id | `A1` |
| result | `blocked` — composition startup/restart passed; full ticket lifecycle has no configured disposable Coder/Reviewer provider |
| recorded_at | `2026-09-29T11:12:54Z` |
| source_commit_sha | `a528c69a43304f0f80f5539b1465d092d41222dd` (working tree changes are uncommitted) |
| fixture_identity | `PROJECT-COMPOSITION-WITNESS`; unique temporary Git project and Control API database per run |
| ticket_id | `TICKET-COMPOSITION-WITNESS` |
| context_id / manifest_sha | `null` / `null` — dispatch stopped before Coder claim |
| base_sha / source_sha / review_sha / integration_sha | `null` / `null` / `null` / `null` — no ticket commit was produced |
| artifact_id | `null` — no verification job was started |
| event_id / idempotency_id | `null` / `null` — duplicate dispatch/event remains untested |
| command | `node --test backend/tests/integration/control-api-composition-witness.test.js` |
| command_exit_code | `0` (one startup/restart and fail-closed dispatch test passed) |
| additional_checks | `pnpm typecheck`: `0`; scoped ESLint on witness test with `--rulesdir eslint-rules`: `0`; `git diff --check`: `0` |
| audit_evidence | Test fixture asserts real `/forge/v1/health`, ticket creation through `/forge/v1/tickets`, `agent_not_available` from ticket RUN, unchanged project source, and unchanged persisted shadow flag after SIGTERM/restart. No secrets or raw source retained. |
| missing_dependency | A disposable configured Coder and independent Reviewer provider path that can produce the exact ticket commit and verification artifact; controlled restart between verification and review plus duplicate delivery remain required. |

This record is not approval evidence. The previous child-process HTTP witness tests durable service receipts, while this fixture starts the full production entrypoint; neither fixture yet exercises the whole A1 sequence.

## A1 — historical partial artifact attempt

| Field | Recorded value |
| --- | --- |
| package_id | `A1` |
| result | `partial` — real Codex Coder, durable passed artifact, Control API restart, and retained claim proved; final Reviewer/integration and duplicate event still open |
| recorded_at | `2026-09-29T11:40:09Z` |
| fixture_identity | `PROJECT-REAL-PROVIDER-WITNESS` / `TICKET-REAL-PROVIDER-WITNESS`; disposable Git project and encrypted profile vault |
| context_revision | `4` |
| manifest_sha | `sha256:7d0aa666fab421dfe3578ca177bf1d6cc6248ac0f5d89d5863431cfa03f92c47` |
| base_sha | `909ccd6cec40d567d11697db83628c1fe78c9a56` |
| source_revision | `sha256:1500bcd7c023864cd675e6fd337bd60b42c99c9aa915bf374114aeddaa337eb3` |
| review_commit_sha | `6fdf43d9dfdaca5a5725fc58006a7bd772b69c4d` |
| artifact_id | `ARTIFACT-2bf9bb6b-03de-4dd5-8859-1bde53554587` |
| active_claim_id | `9b01477d-9d0d-485c-9683-8c5b15d7114c` after restart |
| integration_sha / event_id | `null` / `null` — not yet proved |
| command | `NODEFORGE_REAL_PROVIDER_WITNESS=1 node --test backend/tests/integration/control-api-real-provider-witness.test.js` |
| command_exit_code | `0`; one real provider ticket dispatch and restart test passed in 102.8 seconds |
| audit_evidence | The fixture used the configured Codex SDK with two separate agent profiles, ran Forge edits/commit/verification, persisted an artifact whose commit/manifest/source IDs match context, terminated only the disposable API, restarted production composition, reloaded the same artifact, and observed a retained Coder claim with nonterminal context. Test TAP diagnostic contains only IDs and hashes. |

The live run exposed two verifier bugs before it passed: ESLint ignored source because ticket worktrees live below `.forge`, and Node 26 could not use `backend/tests/unit` as a positional test directory. `ticket-verification-service.js` now passes `--no-ignore` for its explicit manifest paths and enumerates `.test.js` files. `node --test backend/tests/integration/ticket-verification-worktree.test.js` passes 1/1 as a deterministic regression check.

## A1 — historical partial review attempt

| Field | Recorded value |
| --- | --- |
| package_id | `A1` |
| result | `partial` — real Coder and Reviewer reached a completed integration receipt, but the Reviewer checkpoint was still `in_progress`; this contradicts the expected write order and needs investigation. A duplicate Supervisor event also remains unproven. |
| recorded_at | `2026-09-29T12:03:00Z` |
| fixture_identity | `PROJECT-REAL-PROVIDER-WITNESS` / `TICKET-REAL-PROVIDER-WITNESS`; disposable Git project and Control API process |
| base_sha | `85941e25d4b812dbe0dfb21ef9532cfb188b1aa0` |
| source_revision | `sha256:1500bcd7c023864cd675e6fd337bd60b42c99c9aa915bf374114aeddaa337eb3` |
| manifest_sha | `sha256:7d0aa666fab421dfe3578ca177bf1d6cc6248ac0f5d89d5863431cfa03f92c47` |
| review_commit_sha / reviewed_commit | `e977bf10fa014809b093d759907c7550d183a8a0` / same |
| artifact_id | `ARTIFACT-f6bda622-8e4d-4b0a-9666-8648be91f679` |
| active_claim_id after restart | `ba023e8a-2406-4ad6-a032-4f40a6c854e1` |
| integration_receipt | `completed`; duplicate RUN returned HTTP `202` with ticket status `accepted` |
| command | `NODEFORGE_REAL_PROVIDER_WITNESS=1 NODEFORGE_REAL_PROVIDER_FULL=1 node --test backend/tests/integration/control-api-real-provider-witness.test.js` |
| command_exit_code | `0`; 1/1 passed in 384.1 seconds |
| audit_evidence | Coder and Reviewer used distinct Codex profiles and the live provider SDK through production Control API composition on a disposable project. The fixture restarted its own API after the passed artifact, then observed an integration receipt for the exact review commit. It did not stop or restart the user's Control API. |

The preceding live attempt produced a real `request_changes` finding: a mutable source read lacked commit/artifact provenance. Reviewer source windows now include `review_evidence` with artifact, commit, manifest and checksum IDs; a mismatch fails closed. The offline SDK regression passed 1/1, as did typecheck, scoped ESLint and `git diff --check`. In the direct review path, `completeReview()` precedes approved integration, so a completed receipt alongside an `in_progress` checkpoint cannot be dismissed as an early sample. A concurrent retry or later overwrite is possible but not yet proved. The fixture now requires an explicitly completed and approved Reviewer checkpoint as well as the receipt; this stricter assertion was added after the live run and has not yet been rerun against the provider.

## A1 — current authoritative passing production composition witness

| Field | Recorded value |
| --- | --- |
| package_id / result | `A1` / `passed` on a disposable production composition; later epic packages remain open |
| recorded_at | `2026-09-29T13:15:47Z` |
| source_commit_sha | `a528c69a43304f0f80f5539b1465d092d41222dd`; implementation changes are uncommitted in the working tree |
| fixture_identity / ticket_id | `PROJECT-REAL-PROVIDER-WITNESS` / `TICKET-REAL-PROVIDER-WITNESS` |
| context_revision / terminal_state | `4` at verified handoff / `terminal` after integration |
| manifest_sha | `sha256:7d0aa666fab421dfe3578ca177bf1d6cc6248ac0f5d89d5863431cfa03f92c47` |
| base_sha | `150e123946346a0bc944ca8834a8736c4b92577d` |
| source_revision | `sha256:1500bcd7c023864cd675e6fd337bd60b42c99c9aa915bf374114aeddaa337eb3` |
| review_commit_sha / integration reviewed_commit | `374957bac5065a2e5b5a2f6b0015a4067d8aaa77` / same; root HEAD also matched the integration commit |
| artifact_id | `ARTIFACT-6ffa9345-0a9d-4dc3-8185-2a162ba4df1a` |
| reviewer_id / checkpoint | `a2222222-2222-4222-8222-222222222222` / `completed`, verdict `approved`, matching artifact ID |
| active claim after restart | `c240a240-2bdf-46d7-88c7-48007aed8af5` (Coder); final Coder and Reviewer claims both released |
| integration receipt | `completed`; one artifact and unchanged reviewed commit after repeated RUN |
| duplicate dispatch | Second RUN after terminal returned HTTP `202`, ticket status `accepted` |
| duplicate event / idempotency ID | `EVT-A1-DUPLICATE` replay rejected after SQLite-backed event-store restart; Supervisor duplicate `review.approved` test produced one integration, one claim release, and one terminal event |
| command / exit code | `NODEFORGE_REAL_PROVIDER_WITNESS=1 NODEFORGE_REAL_PROVIDER_FULL=1 node --test backend/tests/integration/control-api-real-provider-witness.test.js` / `0` (1/1, 499.8 s) |
| supporting checks | `node --test backend/tests/integration/supervisor-production-safety.test.js backend/tests/unit/supervisor-loop.test.js` / `0` (15/15); Reviewer/checkpoint focused tests 13/13; `pnpm typecheck`, scoped ESLint, `pnpm validate:schemas` (97 schemas, 91 fixtures), and `git diff --check` / `0` |

The live request was a resume after the disposable API restart. The idempotency probe was a separate RUN after terminal state; it returned immediately and left the artifact and integration receipt unchanged. The event replay check uses the same persistent SQLite event-store implementation on a restarted test database, while the live provider witness verifies the real Control API lifecycle. No user's Control API process was stopped or restarted.

## A2–A6 continuation — 2026-09-29

| Package | Result | Evidence and release condition |
| --- | --- | --- |
| A2 | `passed` for Reviewer identity/tool cases | A1 live Codex Reviewer passed on the exact artifact and commit. `ticket-review-evidence.test.js` and `reviewer-sdk-immutable.test.js` reject changed commit, manifest, checksum, missing artifact, and unavailable source tool; successful Forge reads carry artifact/commit/manifest/checksum provenance in audit. Negative cases fail before provider dispatch. |
| A3 | `passed` | The live disposable production Control API witness produced matching receipts for `verification.passed`, `review.approved`, and `task.completed`, each bound to the verified artifact and reviewed commit. Reviewer checkpoint was `completed/approved`; integration was `completed`; terminal context and duplicate RUN (`202/accepted`) were verified. The shadow unit test also proves same-event replay is idempotent and drift becomes `mismatch`. |
| A4 | `blocked` on owner dispositions | Fresh read-only inventory of `PROJECT-NODEFORGE`: **15 active records**, all `human-review-required`, all undispositioned. `ticket-pipeline-disposition.js` now stores owner decisions with inventory fingerprint, actor, and evidence refs; stale/missing/human-review decisions block enforce. No migration, cancellation, or claim takeover was inferred. Sprint Leader/human owner must decide each record. |
| A5 | `partial` | Real HTTP listener, SSE projection, application normalizers, Node fetch client, and UI ingress pass canonical envelope tests. Historical communication storage has 18 JSONL files, 2,305 parseable messages, 167 error messages, 50 with legacy error fields, and zero stored canonical error objects. A read-only replay of all 167 historical error messages produced 167 canonical SSE envelopes and 167 UI accepted errors, with zero parse/projection failures. Legacy adaptation remains at HTTP/SSE/UI ingress boundaries through the 2026-10-13 audit deadline; adapter removal or an explicit time-bounded extension still needs an owner decision. |
| A6 | `blocked` | Production rollout remains `shadow`. `setMode("enforce")` now requires an injected release gate plus current owner dispositions; production has no release gate configured. No enforce canary or release authority decision was performed while A3–A5 remain open. The release authority must review and sign the evidence record before that gate can be configured. |

Commands and exit codes: `node --test backend/tests/integration/error-envelope-transport.test.js backend/tests/unit/ticket-pipeline-disposition.test.js backend/tests/unit/ticket-pipeline-rollout.test.js backend/tests/integration/ticket-pipeline-shadow.test.js backend/tests/unit/ticket-review-evidence.test.js backend/tests/integration/reviewer-sdk-immutable.test.js` → `0` (6/6); `node --test backend/tests/integration/control-api-composition-witness.test.js backend/tests/integration/error-envelope-transport.test.js ui/nextjs/tests/error-normalizer.test.js` → `0` (8/8); `pnpm typecheck` → `0`; `pnpm validate:schemas` → `0` (97 schemas, 91 fixtures); scoped ESLint with `--rulesdir eslint-rules` → `0`; `git diff --check` → `0`. The Control API composition test starts and stops only its disposable child process. No credential, raw source, or historical message text is retained here.

## A3 — failed live shadow witness (historical attempt)

The first three live attempts are retained as historical failures: the first two exposed the inline-path shadow gap; the third exposed an over-strict claim-retention assertion. After direct-path shadow recording and fixture correction, `NODEFORGE_REAL_PROVIDER_WITNESS=1 NODEFORGE_REAL_PROVIDER_FULL=1 node --test backend/tests/integration/control-api-real-provider-witness.test.js` exited `0` (1/1, 210.7 seconds). It recorded matching receipts for all three eligible event types with receipt hashes, exact artifact/commit identity, completed approved Reviewer checkpoint, completed integration, terminal context, released claims, and duplicate RUN `202/accepted`. The live fixture used isolated provider credentials and cleaned its own disposable API process.

## A5 atomic execution-ticket gate

The governance ticket schema and Control API RUN path now require a persisted A5 execution contract before execution. The contract contains scope, acceptance criteria, verification plan, owner, Ticket Supervisor, Coder, Reviewer, optional human authority, dependencies, `shadow` gate, ledger revision, and idempotency key. Incomplete A5 creation is rejected and persisted A5 tickets are revalidated before `RUN`. Unit coverage passes 18/18 and schema validation passes 97 schemas with 91 fixtures. This gate was implemented without restarting the user's Control API or dispatching an A5 ticket.

The first durable A5 ticket was then created through `POST /forge/v1/tickets?project=PROJECT-NODEFORGE`: `NF-PIPE-ERR-005-A5`, roadmap ledger revision `1.0.104`, idempotency key `A5-NF-PIPE-ERR-005-001`, gate `shadow`, owner `94e08fe3-bbf9-46fc-9540-534d72a4cc63`, Supervisor `SUP-NF-PIPE-ERR-005-A5`, Coder `4c01af79-98c0-4d10-b6ed-c815d4911fe6`, Reviewer `85661178-4828-4942-a4fb-6177bbb24040`, and human authority `PROJECT-OWNER`. API returned `201`; a subsequent ticket-list read confirmed the A5 package and execution contract persisted. The top-level `dependencies: ["A3"]` was then removed because A3 is an acceptance work package, not a durable ticket ID; A3 remains recorded inside the execution contract as a gate dependency. The update returned `200` at roadmap revision `1.0.104-update-1790694308400`. Control API was not restarted and `RUN` was not called.
