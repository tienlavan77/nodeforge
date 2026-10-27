# Recorded-environment baseline recovery

Node owns baseline execution. SL and AM retain their read-only consultation tools;
they do not need shell access, a Coder claim, or another Owner approval to invoke
an existing internal verification operation.

Before a recovery consultation, Node checks the latest job for the current ticket
commit and source revision. `VERIFY_BASELINE_UNAVAILABLE` selects
`workspace.testService.recoverBaseline({executionId, signal, assertActive})`.
The operation uses a typed request derived from the immutable failed artifact:
project, ticket, execution, artifact, candidate commit, baseline commit, source
revision, manifest digest, recorded environment digest and original plan suffix.
Agent prose cannot introduce a command, test path or approval through this path.

Passing command receipts stay attached to their original source and environment.
Node restores the recorded environment, retries the unresolved regression on the
candidate and baseline, then finishes any remaining commands from the same plan.
It does not capture a new workspace snapshot or run a new full suite.

The service publishes a new immutable artifact. It marks verification passed only
when the full original plan and current acceptance policy are satisfied. Missing
baseline/environment evidence stays unproven. A new regression remains failed.
The old artifact, Coder checkpoint, commit, report and Reviewer authority remain.

Durable evidence uses the existing ticket-verification storage namespace:

- `checks/CHECK-BASELINE-<digest>.json`: execution-bound request and result.
- `artifacts/ARTIFACT-BASELINE-<digest>.json`: combined command evidence.
- `jobs/VERIFY-BASELINE-<digest>.json`: ordinary discoverable job result.

The normal runtime path resolver maps these logical paths to the project's
configured runtime storage. Deterministic identities and a ticket file lock prevent
duplicate execution. Restart after artifact publication completes persistence
without rerunning tests. An unchanged failed result is reused; a changed runner
revision permits a new recovery attempt.

Stop, execution replacement and changed source revoke the operation. The recovery
worker remains free to serve other tickets while Node collects verification.
After execution, Node supplies the receipt and a fresh consultation deadline to
SL/AM. A historical `ACCESS_REQUIRED` label is retained for audit, while complete
technical receipts and the matching validated passed artifact are classified as
`VERIFY_RECOVERY_READY`. Superseded evidence-gap correction feedback is removed
from the next assignment; independent errors and genuine denials remain enforced.
SL resumes the retained Coder checkpoint for the report once the blocker is
actually resolved; recovery itself does not submit a report or accept review.

Focused checks:

```sh
node --test backend/tests/integration/ticket-baseline-recovery.test.js backend/tests/unit/blocker-baseline-recovery.test.js
```
