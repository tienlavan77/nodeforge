<!-- Records the approved direct-engineering P1 decision and deployment constraints for shared owner execution recovery. -->
# Owner execution checkpoint: P1

## Decision

On 2026-10-12 the project owner authorized direct implementation of P1:
shared checkpoint implementation and record-based role policy, with separate
physical roots for System Engineer and Architecture Manager.

- System Engineer: `.forge/runtime/owner-executions`.
- Architecture Manager: `.forge/runtime/architecture-executions`.
- The factory requires an explicit supported role; root and display name are
  resolved only from `owner-execution-role-policy.js`.
- Role-local conversation leases and instance ownership remain unchanged.
- No migration, automatic cleanup, privilege expansion, or Coder checkpoint change.

## Recovery safety

Loading or listing a missing-role, wrong-role, or wrong-identity record fails
closed, logs the mismatch, and requires manual review. The original record is
not rewritten, removed, or made runnable. Continue, Restart, and Discard remain
blocked until the identity issue is investigated.

Transitions reject changes to conversation, execution, role, lineage, attempt,
and resume identity. Recovery summaries expose `role` and `display_name`.
The SDK verifies the profile/store/record role at the execution boundary.
Architecture retains single-mutation guards, intended document evidence,
verified-delete semantics, and its existing owner-authorization requirements.
Only System Engineer checkpoints settle returned `run_check` boundaries.

## Deployment

Drain active owner executions before restarting the Control API to load the new
backend code. No UI rebuild or runtime-file migration is required for P1.
This change does not grant Architecture pause/resume GO, alter HTTP read-auth
policy, or approve any other architecture plan revision.
