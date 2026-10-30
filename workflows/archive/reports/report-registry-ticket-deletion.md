# Registry-owned ticket deletion repair

Date: 2026-10-09 UTC.

## Latest follow-up — corrected integration test PASS

At `2026-10-09T09:13:41.511Z`, focused run `VERIFY-RUN-3b947fd1-a8a9-411c-a57e-7555262b8efe` returned PASS, exit 0:

```text
node --test ui/nextjs/tests/coding-ticket-deletion.test.js ui/nextjs/tests/coding-sprint-deletion.test.js backend/tests/integration/registry-ticket-deletion.test.js backend/tests/unit/sprint-plan-upload-service.test.js backend/tests/unit/http-api.test.js
```

The corrected `null` assertion and all six Registry ticket-deletion integration cases executed successfully, including dashboard projection and existing UI client over local HTTP. This new bundle does not rerun every file of the historical failed command below; that failed run remains FAILED.

Delete responses and Registry `ticket.deleted` events now also carry `version`, `status` and `plan_sha256`, letting Coding apply the reduced scope and new approval basis locally without refetching all Sprints. Integration assertions verify response/event basis agreement. See `workflows/report-coding-ticket-local-deletion.md` for the UI changes.

Current follow-up identities (individual Forge edit results, not an atomic run manifest):

- `registry-ticket-deletion.js`: `61f06c0d85ac15bb6038fc1092e79193ef8fd454af8c0439f853cfa3066f6d52`.
- `sprint-plan-upload-service.js`: `065f33b7150457c2719cf28fa128d52fbe7d776ccc556cb790665cfe4e3f6696`.
- `registry-ticket-deletion.test.js`: `42dc318ea346ab55df63b7b9e60e6e44b95c51054c15d85043b60fa6eb312bf8`.

The verification and identities below describe the earlier batch and are historical. Browser/live-project verification and rollout remain unperformed.

## Reported failure

`Unknown ticket: TICKET-PROJECT-NODEFORGE-1790839727833.` during deletion after Sprint Registry cutover.

Source-confirmed cause: both Forge v1 ticket DELETE routes delegated to `sprintPlanUploadService.removeTicket`, which looked up the ticket exclusively in the current legacy Roadmap. That lookup was not authoritative for Registry-owned Sprint scope. This diagnosis does not claim live access to that specific ticket's database row.

## Implemented changes

- `/forge/v1/tickets/:id` and `/forge/v1/projects/:projectId/tickets/:id` pass configured Registry and immutable plan store into ticket deletion, and await the asynchronous result.
- Registry-enabled deletion does not fall back to Roadmap lookup. Standalone runtimes without Registry retain legacy deletion behavior.
- Resolve exactly one active Registry Sprint containing the ticket, reject wrong project/ambiguous ownership, and validate the exact bound plan identity.
- Gate mutation through existing `assertMutable` and transactional `bindPlan` version fencing. Running/completed Sprint and unresolved retained execution ownership remain blocked.
- Reject deletion of the last ticket, preserving the existing contract; reject dependencies on the ticket in active immutable ticket specs.
- Create a new immutable revision with the ticket removed from `tickets` / `ticket_specs`, recompute ticket dependencies, and bind the Sprint to the new revision.
- Keep old plan revisions, old decisions, legacy metadata and execution history. The revised Sprint returns to `awaiting_human_approval`; deletion grants no RUN authority.
- Publish `ticket.deleted` with the new plan ID/revision after successful bind. Dashboard recognizes these Registry-bound deletion events while retaining legacy snapshots, rather than reporting their removed metadata as extra current scope.
- An unsuccessful bind returns retained-revision recovery identity, not a deletion success.

## Changed source and tests

- New: `backend/src/application/registry-ticket-deletion.js`.
- Updated: `backend/src/application/sprint-plan-upload-service.js`.
- Updated: `backend/src/transport/http/forge-v1-router.js`.
- Updated: `backend/src/application/registry-dashboard.js`.
- New: `backend/tests/integration/registry-ticket-deletion.test.js` (six test registrations).

The new test fixture uses real SQLite and immutable plan storage, rejects legacy deletion lookup, exercises project-scoped routing and the existing UI Delete client through a local HTTP server. It covers wrong scope, dependency/last-ticket gates, retained execution ownership, missing plan storage and a concurrent Registry version change.

## Verification — FAILED, final assertion correction not rerun

Exactly one focused check was run:

```text
node --test backend/tests/integration/registry-ticket-deletion.test.js backend/tests/integration/coding-registry-dashboard.test.js backend/tests/unit/http-api.test.js backend/tests/unit/sprint-plan-upload-service.test.js backend/tests/unit/sprint-registry-concurrency.test.js
```

- Run: `VERIFY-RUN-bfabc36f-24dc-4403-b80b-9d014e189786`.
- Evaluated: `2026-10-09T08:56:05.988Z`.
- Result: FAILED, exit 1; not ready for review.
- Returned failure: the new test expected `getByTicket(TARGET)` to return `undefined` after deletion, but the actual established Registry contract returns `null`.
- Confirmed the implementation's `return null` with Forge read_lines and corrected only that assertion.
- The corrected test has NOT been rerun: this user turn permits one run_check call, already consumed. Do not promote the failed run to PASS or assume assertions after the failure were executed.
- The executed test reached successful deletion, revision 2 and removal from current ticket IDs before the assertion failed. This is partial evidence, not full acceptance.
- No browser click verification, production ticket mutation, rollout, migration or independent Reviewer verdict was performed.

## Individual file identities after edits

These identities are not an atomic manifest of the failed verification run. The test identity below is the correction made AFTER that run.

| File | SHA-256 |
| --- | --- |
| `backend/src/application/registry-ticket-deletion.js` | `37db36e4094359787f81e7364a77c3e5e4fdcaafb2efdb2b800f60dd037e9b2b` |
| `backend/src/application/sprint-plan-upload-service.js` | `7a5f26de36fe3616c14b68e06e40340fd40dbd54a36a5fdbadbbc2c7077be579` |
| `backend/src/transport/http/forge-v1-router.js` | `6d59ec883b586a46311e31c4e8c8be847fb488f8b8f36c7e62772ab8ba48f32d` |
| `backend/src/application/registry-dashboard.js` | `60e621a6b14f3ce23ae8b2d29fbadf465a82dcef54eb4969f09d8ce5586b2666` |
| `backend/tests/integration/registry-ticket-deletion.test.js` | `8493a318fc91886c71eda962e78a3e91b6992715db42d974624dd5b3a77c9ec2` |

## Remaining boundaries

- Rerun the focused command with the corrected assertion before claiming PASS.
- This batch repairs Forge v1 DELETE, not the remaining legacy ticket list/create/detail/update/regenerate paths. It does not claim full Registry ticket CRUD convergence.
- Dashboard exclusion still depends on successful deletion-event persistence. The existing best-effort publisher is not made atomic with Registry bind; failed notification/persistence may require reconciliation. Cross-Sprint dependency validation is a read-time check, not a new global cross-Sprint serialization protocol.
- No data was erased from the live project. The requested production ticket ID has not been directly deleted by tools.
- No commit/push is performed with a failed focused run or by combining this batch with accumulated, incompletely verified work. Internal `workflows/` reports remain excluded from Git staging.
