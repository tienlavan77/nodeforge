# SE Engineering Report: `delegate_subagent` hardening

Date: 2026-11-07
Recipient: Project Owner / Architecture Manager

## Scope

Implemented the follow-up changes requested by `docs/architecture/subagent-forge-tool-review.md` for the read-only Explorer delegation path. Existing unrelated handoff work in the working tree was preserved.

## Changes

- Preserved child provenance through batch normalization in `backend/src/tools/discovery/delegate-subagent-tool.js`: `parent_execution_id`, `child_execution_id`, `child_agent_id`, `observed_at`, and `source_tool` are retained in returned observations.
- Preserved the delegated child context in `backend/src/application/owner-sdk-stream.js` by deriving the runtime child context from the isolated context supplied by `delegate-subagent-tool`.
- Enforced the child tool boundary in `backend/src/tools/governance/tool-authorization.js` by invoking `context.assertToolAllowed(toolName)` before capability checks.
- Connected source observation collection to the actual read paths in `backend/src/tools/governance/agent-lifecycle-tools.js`: `read_file` records code and Markdown observations, and merged observations retain `source_tool`.
- `Read` already records its successful observation in `backend/src/tools/discovery/source-read.js`; the collector now preserves its provenance when the same path was previously observed by `read_file`.

## Evidence inspected

- `docs/architecture/subagent-forge-tool-review.md` — AM decision `REVISE` and four requested follow-ups.
- `backend/src/tools/discovery/delegate-subagent-tool.js` — child-context construction, batch normalization, and provenance fields.
- `backend/src/application/owner-sdk-stream.js` — runtime child executor composition.
- `backend/src/tools/roles/owner-conversation-tools.js` — tool registry wrapper and authorization call site.
- `backend/src/tools/governance/tool-authorization.js` — runtime authorization gate.
- `backend/src/tools/governance/agent-lifecycle-tools.js` and `backend/src/tools/discovery/source-read.js` — read observation collectors.

## Checks

Focused check passed: `npm run test --prefix backend -- tests/unit/delegate-subagent-tool.test.js tests/unit/source-read-policy.test.js` (exit 0).

Forge verification evidence: run `VERIFY-RUN-8ca7cba2-e16d-48d0-b4c6-53f3a61927a8`, evaluated 2026-11-07T06:58:09.961Z, status `passed`, `ready_for_review: true`.

Two earlier invocations were invalid command forms and are not code-test evidence: the repository wrapper exited 9 with only `npm notice`, and the workspace form failed with `No workspaces found`. The successful `--prefix backend` invocation is the authoritative focused result.

## AM disposition

AM marked the `delegate_subagent` hardening item `PASS`. This disposition applies to this hardening scope only; it does not establish the full provider matrix or the AM–SE–RV handoff flow.

## Follow-up cleanup

Removed the duplicate `child_agent_id` property spread in `normalizeObserved` in `backend/src/tools/discovery/delegate-subagent-tool.js`. This is a non-blocking cleanup with no intended runtime behavior change.

## Limitations

This is not evidence of provider-neutral production readiness or crash safety. No full project suite, provider matrix, restart/replay test, or production migration was run. Existing handoff-related modifications were not authored or discarded by this follow-up.
