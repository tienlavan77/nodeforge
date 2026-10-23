<!-- Reports local Coding Sprint deletion updates that avoid reloading the complete dashboard. -->
# Coding Sprint deletion without dashboard reload

## Implemented

After a successful Delete/archive on `/coding`, remove only that Sprint from the locally held dashboard. Do not call getProjectDashboard, emit a loading state, or remount all Sprint cards as part of deletion.

- Coding page owns a stable onSprintDeleted callback to the dashboard loader.
- CodingWorkspaceMonitor forwards it to SprintPlanDashboard.
- The Delete success branch uses that callback; pages without it retain their previous refresh fallback.
- Coding handles a valid project-scoped `sprint.deleted` SSE event with the same callback rather than a full dashboard reload.
- Loader retains the other Sprint object references and uses deletion tombstones to filter stale snapshots.
- Confirmed deletion invalidates older in-flight dashboard responses; they cannot resurrect the removed Sprint.
- Existing reconciliation errors remain visible; deletion does not silently turn an error state into ready.
- Backend Delete/archive contract and other dashboard refresh triggers are unchanged.

## Focused verification

```text
node --test ui/nextjs/tests/coding-sprint-deletion.test.js ui/nextjs/tests/sprint-plan-panels.test.js ui/nextjs/tests/conversations-navigation.test.js
```

PASS, exit 0.
Run: `VERIFY-RUN-a5449c25-300d-48a0-bf8c-6883e1bd1c5c`.
Evaluated: `2026-10-09T08:08:54.659Z`.

New tests execute the dashboard loader to check no extra request/loading state, unchanged remaining Sprint references, duplicate deletion, stale in-flight reads, deletion before initial snapshot, empty list and retained conflict diagnostics. Component callback and SSE branching are checked through source assertions, not a browser event simulation.
No full suite, build, browser session, runtime restart or rollout was performed. This PASS does not close the earlier backend CRUD verification failure or migration acceptance gaps.

## Individual changed source identities

- `ui/nextjs/app/coding/page.jsx`: `b2f56fd3cf3ca79eec96352bbf7af204ec9342e5310967c522dd46d831fc36f0`.
- `ui/nextjs/components/coding-workspace-monitor.jsx`: `7322010affc42773469ac822fbe08c063eec5c7b70f3ebfd76a409e0ec653bea`.
- `ui/nextjs/components/sprint-plan-panels.jsx`: `18394cea00529ad1052a41d15e98ab734ae8bb1da805d1f608a298d5af393d76`.
- `ui/nextjs/lib/coding-dashboard-loader.js`: `77c14ca2e132cd895cd5aef34d291a57f5e62b4797ba782fbea2a1c2f6f2e139`.
- `ui/nextjs/lib/home-page-event-stream.js`: `3fbee7691b9c04255db0460f04bccf15fc2856a68561b9a1c6dda5ac91a11dfe`.
- `ui/nextjs/tests/coding-sprint-deletion.test.js`: `4d11f5cab921ba3d29126fe77f6c06e82317676179149f691a8041b8ef3b9d70`.

These are individual file identities, not an atomic verification bundle. The internal report remains local and is not force-added to Git. Accumulated prior backend/migration changes are outside this UI fix's focused PASS; no combined commit/push is authorized by treating this PASS as their acceptance.
