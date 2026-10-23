<!-- Reports the Coding page's default-collapsed Sprint accordions without changing Sprint execution status. -->
# Coding: Sprints collapsed by default

Implemented only the requested presentation change:

- CodingWorkspaceMonitor opts into `defaultCollapsed` on SprintPlanDashboard.
- Shared dashboard retains `defaultCollapsed = false` for other consumers.
- Initial and newly loaded Sprint IDs use the collapsed fallback; explicit user toggles survive ordinary dashboard refreshes while the component remains mounted.
- Ticket list and inline add-ticket form stay hidden until expansion. Summary and existing Sprint controls remain visible.
- Toggle uses the same fallback as rendering, so the first click expands a default-collapsed Sprint. `aria-expanded` exposes the state.
- No Sprint status, approval, backend API or migration behavior changed.

## Focused verification

```text
node --test ui/nextjs/tests/sprint-plan-panels.test.js ui/nextjs/tests/conversations-navigation.test.js
```

PASS, exit 0.
Run: `VERIFY-RUN-bcf533d3-9239-4b77-a838-0bff61b84e7f`.
Evaluated: `2026-10-09T06:08:13.647Z`.
The new regression check asserts component wiring, default fallback, toggle and visibility gates in source. Existing scope tests render SprintTicketScope. This is not a browser interaction test, frontend build or independent Reviewer verdict.

## Current individual source identities

- `ui/nextjs/components/sprint-plan-panels.jsx`: `9c8a8ecc3f67fdd7d905ac7d4fb4108016e3d26c8127aaa867d0c9bf3c931d6b`.
- `ui/nextjs/components/coding-workspace-monitor.jsx`: `4d966f1d9fd4f0fdd57f1a60fc085f74d6e8e1475a8e787d45c8b6bc14176e7f`.
- `ui/nextjs/tests/sprint-plan-panels.test.js`: `d8ea7b854a342aba99d1d43974cfcf6c9a74b436cbc6d6720ae54fd3c16ab1c0`.

This internal report remains local and must not be force-added to Git. Earlier migration files are outside this UI change and are not covered by this PASS. No runtime migration, restart or rollout was performed.
