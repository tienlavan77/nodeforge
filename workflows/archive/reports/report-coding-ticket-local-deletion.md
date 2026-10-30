# Coding ticket deletion without full Sprint reload

Date: 2026-10-09 UTC.

## Outcome

A confirmed ticket DELETE on `/coding` updates only that Sprint's local scope. The page no longer loads the full dashboard for `ticket.deleted`, and does not enter a global loading state because of deletion.

## Implementation

- Coding passes a stable `onTicketDeleted` callback through the workspace monitor to the existing Sprint dashboard / TicketCard.
- TicketCard invokes the callback only after successful DELETE, passing the server receipt and owning Sprint ID. Failed DELETE and cancelled confirmation do not locally remove a ticket.
- Coding SSE `ticket.deleted` uses the same callback. Shared consumers without this callback retain their existing refresh behavior; other event types remain unchanged.
- The Coding loader retains confirmed ticket deletion receipts and filters affected tasks / ticket IDs locally. Unrelated Sprint object references remain unchanged, preserving cards and expanded/collapsed state.
- Delete response/event now carry the resulting Registry version, status, plan ID, revision and SHA-256. Coding applies those server values rather than inventing a scheduling version or continuing to display the old approval.
- Remaining tasks in the revised Sprint reset to untracked / zero progress when the plan revision changes, consistent with production Registry projection invalidating old execution basis.
- Older duplicate receipts cannot downgrade metadata; in-flight snapshots cannot overwrite local deletion. A later explicit newer revision may re-add a ticket rather than being hidden by a permanent tombstone.
- Existing nonretryable reconciliation diagnostics are not cleared by local deletion.
- This path does not call the dashboard API or a per-Sprint API after deletion; the replacement basis comes from the server receipt.

## Verification

One focused check after all code/test edits:

```text
node --test ui/nextjs/tests/coding-ticket-deletion.test.js ui/nextjs/tests/coding-sprint-deletion.test.js backend/tests/integration/registry-ticket-deletion.test.js backend/tests/unit/sprint-plan-upload-service.test.js backend/tests/unit/http-api.test.js
```

- PASS, exit 0; service ready_for_review true.
- Run: `VERIFY-RUN-3b947fd1-a8a9-411c-a57e-7555262b8efe`.
- Evaluated: `2026-10-09T09:13:41.511Z`.
- Six new UI test registrations exercise local state, no extra requests/global loading, unrelated Sprint references, delayed responses, duplicate receipts, newer replan re-add, preserved diagnostics and source wiring.
- All six corrected backend Registry-deletion integration cases passed, including the real existing UI Delete client through a local HTTP server and response/event basis equality. The historical null-versus-undefined failure is preserved in the prior report; it is not rewritten as a historical PASS.
- UI callback/SSE/component wiring is source-tested, not exercised by a real browser. Loader state changes are executed JavaScript tests.
- No full suite, browser clicks, build, lint, live data deletion, rollout or independent Reviewer acceptance is claimed. No raw test count or Node version was returned by the service.

## Individual current identities

Forge edit/write identities; not an atomic source-bound verification manifest.

| File | SHA-256 |
| --- | --- |
| `ui/nextjs/lib/coding-ticket-deletion.js` | `3ed7308ff3883e783378157f8efce54330a1309406c5a0daa88f9a6d103f7da8` |
| `ui/nextjs/lib/coding-dashboard-loader.js` | `8111527ce430d2013c05e06b542350626858ad6275fddd852dc8e89194825081` |
| `ui/nextjs/app/coding/page.jsx` | `1a319811e54e6b255c1073919373a13a4216bf0cce87e87d41a5305b8682bc73` |
| `ui/nextjs/components/coding-workspace-monitor.jsx` | `ba88ec8ec37a6a358a2b005919ae1d62b77b1935fe0b379eff35ea5fd630215a` |
| `ui/nextjs/components/ticket-detail-modal.jsx` | `8331f04f3803fcf0ec12f4ece4ce9ac544a02e1e5c82de3ecbd8aecb1b808341` |
| `ui/nextjs/lib/home-page-event-stream.js` | `16d184dec4d54104980b6474419d9b0608b2e50be46c65a8b276f809c0fe086f` |
| `ui/nextjs/tests/coding-ticket-deletion.test.js` | `1409eb47b7db04a56ba02cded13534a784afa33851ee270892b20e973057ce20` |
| `backend/src/application/registry-ticket-deletion.js` | `61f06c0d85ac15bb6038fc1092e79193ef8fd454af8c0439f853cfa3066f6d52` |
| `backend/src/application/sprint-plan-upload-service.js` | `065f33b7150457c2719cf28fa128d52fbe7d776ccc556cb790665cfe4e3f6696` |
| `backend/tests/integration/registry-ticket-deletion.test.js` | `42dc318ea346ab55df63b7b9e60e6e44b95c51054c15d85043b60fa6eb312bf8` |

## Boundaries and Git

The complete replacement basis is supplied by the updated Registry producer. Historical/standalone events lacking revision/version metadata can remove the visible ticket locally but do not authorize invented Registry metadata. This change does not repair the remaining legacy list/create/detail/update/regenerate paths or make best-effort event persistence atomic with Registry bind.

Other dashboard-triggering operations still retain their existing refresh behavior. This task prevents refresh caused by deletion, not all dashboard refreshes.

No combined commit/push: the worktree and conversation change set also contain earlier, incompletely verified Registry/migration batches, and the supplied commit operation does not accept a scoped file selection. Internal workflows reports remain excluded from Git staging. No production data was removed.
