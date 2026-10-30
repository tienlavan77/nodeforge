<!-- Internal report: exclude workflow documentation from System Engineer Git staging without deleting local audit evidence. -->
# System Engineer commit scope — internal workflows

Date: 2026-10-09

## Owner decision

`workflows/` contains internal plans, reports, and audits. Do not add, force-track, un-ignore, or delete these documents to unblock a source-code commit.

## Implementation

- `backend/src/tools/owner-engineer-tools.js`: filter root `workflows/` documents out of the recorded paths passed to Git commit.
- Retain internal document paths in the conversation's local change records after a successful source commit.
- A documentation-only change returns `COMMIT_SCOPE_EMPTY` without calling Git or manufacturing a commit SHA.
- A failed source commit retains source and internal document records for retry.
- The policy matches the root directory, not similarly named source files or nested directories such as `docs/workflows/`.
- Updated the commit tool description to communicate this exclusion.

Source identity: `56fa5afd0dc89c736badde445db555f7ac6d0e9659c9d8c763a06708388e4a8f`.

## Regression coverage

`backend/tests/unit/owner-engineer-tools.test.js` adds coverage for mixed source/internal paths, repeated source commits, exact-SHA push, documentation-only changes, and failed Git commits that preserve retry evidence.

Test identity: `6a00d70dbd054e7aa41991ab32e9aa5990bc7cf0e76f2bcfa7710d0b22db98c2`.

One focused check was invoked:

```text
node --test backend/tests/unit/owner-engineer-tools.test.js
```

The tool response was truncated before the final result was available to the assistant. PASS/FAIL and verification run ID are therefore not confirmed. No second check or full suite was run.

## Git handoff

Forge `git_status` and `git_diff` were inspected before the commit attempt. Status showed 12 changed source/test paths: 10 already staged from the earlier failed Sprint handoff and the 2 owner-tool files modified in this turn.

`commit_changes` with message `fix(forge): exclude internal workflows from owner commit staging` still returned `GIT_ADD_FAILED`, explicitly naming ignored `workflows`. No commit SHA was returned, so no push was attempted.

The source filter is present on disk, but the active tool still attempts to stage internal documents. This is consistent with the running Forge service retaining the previously loaded implementation; runtime activation/reload has not been verified. The supplied tools do not provide a service restart or a staging-path override. A service reload is needed before retrying the handoff with the new implementation.

No force-add, ignore-rule change, document deletion, or direct conversation-state manipulation was used. Internal reports remain local. Verification result remains unconfirmed because the focused-check response was truncated.

This change does not expand or certify Sprint execution recovery acceptance; earlier Sprint audit limitations remain unchanged.
