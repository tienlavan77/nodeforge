# Double-Escape immediate recovery controls

Date: 2026-10-09 (UTC).

## Request and root cause

After double-Escape, Continue / Restart / Discard did not appear until a human-message retry. Both System Engineer and Architecture controls gated their recovery refresh on `agentTyping` becoming false and performed only one read. A read before the runner-stop checkpoint finished could leave the UI waiting indefinitely, even after the runner stopped.

## Implemented

- Both controls now use the same scoped recovery watcher, independent of typing state and message retry.
- On accepted pause, display Continue / Restart / Discard immediately, disabled while the execution is stopping. Show `Stopping current action…`.
- Read durable execution summaries immediately, then every 500 ms during pending recovery. Requests do not overlap; there is no permanent idle polling.
- A returned `running` snapshot for the paused execution remains visibly `pausing`, preventing another Escape pause while its checkpoint catches up.
- Keep watching an interrupted/manual-required record with no authorized actions, covering the runner-stop persistence window.
- Once the server exposes authorized recovery actions, enable only those actions and stop watching. A missing provider session does not enable Continue; manual verification remains separately gated.
- Surface refresh failures and retry the status read. Do not replay the human message or launch an execution automatically.
- Cleanup cancels the scheduled refresh and ignores pending responses on navigation/unmount or recovery readiness.

Backend failure handling, checkpoint safety and public execution-control contracts were not modified.

## Verification

One focused check was run after the code/test edits:

```text
node --test ui/nextjs/tests/owner-execution-recovery.test.js ui/nextjs/tests/architecture-execution.test.js backend/tests/unit/owner-execution-checkpoint.test.js backend/tests/unit/architecture-execution.test.js
```

- Result: PASS, exit code 0.
- Run: `VERIFY-RUN-095e88f3-56b4-4d1a-a6b1-049c5b59533b`.
- Evaluated: `2026-10-09T08:25:52.517Z`.
- Five new test registrations cover repeated checkpoint reads, transient failure, navigation during an in-flight read, server authorization gates and both controls' wiring.
- The new watcher tests execute JavaScript with controlled responses and timers. Component wiring tests inspect source; they are not browser-level Escape/click tests.
- Existing backend checkpoint and Architecture recovery tests also passed in this focused command.
- No browser verification, production provider interruption, build, lint, rollout or full-suite acceptance is claimed. No raw TAP count or Node version was returned by the check service.

## Individual source identities

These are file identities returned by Forge edits/reads, not an atomic source snapshot attached to the verification run.

| File | SHA-256 |
| --- | --- |
| `ui/nextjs/lib/owner-execution-recovery.js` | `5324680dd3d6afa7bafde31a8f77ab23a45dcee31b1d316379024fcc83233390` |
| `ui/nextjs/components/system-execution-controls.jsx` | `8fe65dff3509dd6d5575cfb319bf9a24a2293fc5cddbad48df84a2bc1a195550` |
| `ui/nextjs/components/architecture-execution-controls.jsx` | `d074e542d3c6e42ffaa28fcf3ba7f7a3a0dd836898509ea8ff4ea8605f3d862e` |
| `ui/nextjs/tests/owner-execution-recovery.test.js` | `5a27840b56b52df42aa760decec8769770d329b67956100aadcde719a8c8bf39` |

## Limits and Git

Recovery readiness still depends on a durable, safely stopped backend execution; the UI cannot promise a provider-stop deadline. Polling exposes readiness without relying on terminal-message delivery, but does not bypass reconciliation or mutation safety.

The worktree also contains earlier backend/Registry/migration batches with incomplete verification. This focused PASS does not certify those batches. No combined commit/push is made: the available conversation-scoped commit operation cannot isolate this UI batch from those accumulated changes. Internal `workflows/` reports stay excluded from Git staging.
