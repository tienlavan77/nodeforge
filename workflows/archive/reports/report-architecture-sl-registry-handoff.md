# Architecture → SL → persistence → Registry implementation

## Scope — 2026-10-09

Implement the previously audited planning/handoff defects. This is code work, not a migration, RUN authorization, legacy-store retirement or rollout. Existing approval and Ticket verification gates remain enabled.

## Implemented changes

1. Owner commands: /approve validates any supplied approvalRevision/approvalSha256 pair against the current indexed plan before handoff. Wrong or incomplete captured identity produces PLAN_APPROVAL_STALE, rather than silently selecting a different revision. Uncaptured authenticated commands retain current-head compatibility and still require an existing exact approval; /approve does not itself create approval.
2. Architecture role: /summary and /plan stream through the configured architecture_manager profile, not the selected conversation's agent. Missing configured profile fails without falling back to SL. Production HTTP wiring passes the role resolver; default Architecture ID remains available for isolated legacy construction without a resolver.
3. SL ingestion: recognize the configured sprint_leader profile instead of only the literal sprint-leader ID. Handoff submits completion using that configured identity.
4. Persistence admission: append position after the maximum retained position, including archived Sprints; retain Sprint dependencies during first registration. Existing version/CAS and immutable-conflict recovery gates are preserved.
5. Registry-owned orchestration: resolve planning input with Registry.getDetail; require persistence to produce the exact Registry plan ID/revision/hash/path before publishing. Do not write/read Roadmap projection or register legacy Roadmap provenance on this path. Legacy service construction without Registry retains its existing projection behavior. Orchestration.run is now asynchronous; the Forge draft route awaits it.
6. Markdown handoff/replay: completion validates the immutable child binding in Registry and executable child approval against the exact approved parent key. Missing binding retries admission using the saved generated draft, without asking SL again. Existing mismatched child binding fails closed. The legacy JSON-plan completed-receipt compatibility branch remains unchanged.
7. Markdown plan status: completed receipts with a missing, archived or index-identity-mismatched Registry binding appear as recovery_required, instead of checking Roadmap presence. This status projection is an index check; handoff independently reads and verifies immutable bytes/approval.
8. UI: approval recovery messages now refer to Registry binding, not adding a Sprint to Roadmap. Exact revision/checksum submission remains intact.

## Added/updated evidence

- owner-chat-command-service.test.js: captured wrong/incomplete identities do not hand off; correct identity succeeds.
- owner-planning-role.test.js: summary/plan route to custom Architecture profile; missing profile does not dispatch selected SL.
- sprint-plan-draft-concurrency.test.js: append after retained archive and preserve Sprint dependency; existing stale-binding tests retained.
- sprint-orchestration-sdk.test.js: Registry-only draft avoids legacy reads/writes; custom SL ingestion; add missing verification_plan to three old fixtures without weakening production gates; await asynchronous run.
- markdown-plan-approval.test.js: real handoff + orchestration + immutable stores + SQLite Registry with custom SL, no Roadmap projection write, one child revision and replay; mismatched index binding requires recovery.
- plan-handoff-service.test.js: no re-ingestion solely because Roadmap projection disappeared; missing Registry binding repairs from retained generated result.
- plan-registry-handoff.test.js: source assertions for Registry recovery messages and reviewed identity submission.

## Focused verification — FAIL retained

Command:

```text
node --test backend/tests/unit/owner-chat-command-service.test.js backend/tests/unit/plan-handoff-service.test.js backend/tests/unit/markdown-plan-approval.test.js backend/tests/unit/sprint-orchestration-sdk.test.js backend/tests/unit/sprint-plan-draft-concurrency.test.js backend/tests/unit/owner-planning-role.test.js backend/tests/integration/human-plan-workflow.test.js ui/nextjs/tests/plan-registry-handoff.test.js
```

- Run: VERIFY-RUN-07cd30e7-4c84-4cb2-9c06-f1290c02a88a.
- Evaluated at: 2026-10-09T11:22:05.315Z.
- Result: FAILED, exit 1; ready_for_review=false.
- Returned failure: approved Markdown produces one executable JSON projection without a second owner decision.
- Cause: production bindMarkdownSprintMetadata still required an active Roadmap, throwing SPRINT_ROADMAP_UNAVAILABLE in the Registry-only fixture. This exposed a real remaining legacy gate, not a reason to insert a Roadmap into the fixture.
- The service returned one failure; it did not return a complete raw-output/test-count bundle. No independent Reviewer PASS is claimed.

## Changes after the failed check — historical pending-verification state

- Registry-owned Markdown metadata normalization now skips querying Roadmap. Preserve an existing roadmap_id label or default it to ROADMAP-{projectId}; this compatibility field is not scheduling authority. Legacy construction still validates the active Roadmap; project mismatch still rejects.
- Updated the handoff fixture's expected fallback label to ROADMAP-PROJECT-A.
- Registry-owned persistence skips legacy Roadmap provenance registration and current projection reads, avoiding a post-bind lookup against an unwritten legacy Sprint.
- Final handoff source SHA-256: d4b771ef118e380a59a36873e9254f4bcf0ec973dc1b9cca3743421cb87328b2.
- Final orchestration source SHA-256: 8e4e9baa9430b2c221f3755c1e13bbafb49c7cb7d34d39c45b4414f0683a1d76.
- Final handoff test SHA-256: 31c3b8af6e156b96cdb0a05dce1e952f0494e073f9500cabfb421b0b30732148.
- These are individual Forge edit identities, not an atomic source-bound verification manifest. They must not be bound to the preceding FAIL as if that run tested them.
- At the end of the implementation turn, its single run_check call had been consumed. The post-FAIL sources were pending a new eight-file verification. The follow-up below supersedes that pending-check status; the historical FAIL remains unchanged.

## Follow-up verification — PASS, 2026-10-09

- Rechecked the Registry-owned metadata gate in plan-handoff-service.js before running the same eight-file command shown above.
- Run: VERIFY-RUN-3e477aa4-393f-4f30-bb44-a7d07dfc6840.
- Evaluated at: 2026-10-09T11:32:08.885Z.
- Result: PASSED, exit 0; ready_for_review=true.
- This run verifies the post-FAIL fixes; no additional source/test changes were needed in the follow-up turn.
- Coverage includes real Markdown approval/handoff/persistence with disposable SQLite, Registry-only planning, custom Architecture/SL profiles, captured approval identity, archived scheduling positions/dependencies, retained replay/concurrency cases, human-plan workflow gates and UI source assertions.
- Handoff source returned by the current Forge read remains SHA-256 d4b771ef118e380a59a36873e9254f4bcf0ec973dc1b9cca3743421cb87328b2. Individual identities listed above are not an atomic run manifest.
- Service-reported focused PASS, not independent Reviewer acceptance. The service did not return raw output or test totals; none are invented. The accumulated changed_paths list is not proof that all earlier batches passed.
- No provider execution, live migration, browser rendering, full suite, build or lint was performed.

## Delivery and remaining boundaries

No live data mutation, migration, provider RUN, deployment, browser check, full suite or independent acceptance. Files remain below the 250-line limit (owner-chat-service stays at 250). This report is internal and must not be staged.

Final focused verification now passes. Accumulated earlier changes remain in the worktree with separate verification limits. Forge commit_changes has no path-selection argument and would also stage prior conversation changes; no combined commit/push is claimed on the strength of this eight-file check. No claim that the broader execution-recovery R1–R6 work is complete. Cross-process handoff admission, replacement fencing, and other consumers outside this planning batch retain their previously documented evidence limits.
