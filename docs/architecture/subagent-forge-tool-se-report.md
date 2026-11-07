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

Follow-up regression check passed: `npm run test --prefix backend -- tests/unit/delegate-subagent-tool.test.js` (exit 0), Forge run `VERIFY-RUN-c88104f0-80dd-46ee-a255-91c32c65a00f`, evaluated 2026-11-07T07:51:09.512Z, `ready_for_review: true`.

Forge verification evidence: run `VERIFY-RUN-8ca7cba2-e16d-48d0-b4c6-53f3a61927a8`, evaluated 2026-11-07T06:58:09.961Z, status `passed`, `ready_for_review: true`.

Two earlier invocations were invalid command forms and are not code-test evidence: the repository wrapper exited 9 with only `npm notice`, and the workspace form failed with `No workspaces found`. The successful `--prefix backend` invocation is the authoritative focused result.

## AM disposition

AM marked the `delegate_subagent` hardening item `PASS`. This disposition applies to this hardening scope only; it does not establish the full provider matrix or the AM–SE–RV handoff flow.

## Follow-up cleanup

Removed the duplicate `child_agent_id` property spread in `normalizeObserved` in `backend/src/tools/discovery/delegate-subagent-tool.js`. This is a non-blocking cleanup with no intended runtime behavior change.

Applied the AM non-blocking provenance hardening: `executeOne` now prefers `childContext.observed_files` and only falls back to `result.observed_files` when the collector has no observations. The delegate unit test now verifies that collector metadata wins over conflicting executor-supplied metadata.

## Runtime revalidation findings

A real Forge `delegate_subagent` invocation was attempted with three independent read-only audit tasks. The platform returned `status: partial_success`, all three tasks were `rejected`, `tasks_completed: 0`, and `observed_files: []`; each rejection was `CONFIGURATION_ERROR: Claude SDK correlation_id is required.` A second single-task invocation after the owner child-executor patch reproduced the same error.

Source inspection found the concrete owner-chat defect: `backend/src/application/owner-sdk-stream.js` invoked the child Claude/Codex gateway with `subagentId` but omitted the required `correlationId`, while both `backend/src/modules/agent/claude-sdk-gateway.js` and `backend/src/modules/agent/codex-sdk-gateway.js` assert that field. The owner child call now passes `correlationId: child.correlation_id ?? child.execution_id`.

The repeated Forge-level error after this source patch indicates that the attempted platform invocation did not traverse this repository child executor (or uses another injected executor). Therefore the live subagent attempt is evidence of an environment/wiring blocker, not evidence that the child read loop works. No claim of end-to-end runtime success is made.

The combined focused run after the patch was not green because existing `system-engineer-sdk-tools.test.js` fixtures are out of sync with the current Forge surface (`read_lines` versus `Read`/`read_file_binary`/`delegate_subagent`) and also hit an isolated `/project` EACCES fixture path. Those fixture issues were subsequently corrected under AM Review V3 Section 5.4; the intermediate failure remains recorded here as historical evidence, not as the final verification result.

## AM Review V3 Section 5.4 remediation

- `backend/src/application/owner-sdk-stream.js` now builds a child Forge-tool bundle, converts it through `createOwnerClaudeMcpTools` and `createClaudeForgeOptions` for Claude/Anthropic, and passes `tools: []`, `mcpServers.forge`, and the child Forge allowlist. The Codex thread path receives `sandboxMode: "read-only"`, `approvalPolicy: "on-request"`, `networkAccessEnabled: false`, and `webSearchMode: "disabled"`. The child call also receives the parent `conversationId` and child correlation ID.
- `backend/tests/unit/system-engineer-sdk-tools.test.js` now uses a writable temporary project/Claude-home root, expects the current `Read`/`read_file_binary`/`delegate_subagent` surface, follows the `read_file` metadata → `Read` symbol contract, and includes a parent/child Claude composition assertion for isolated MCP read-only options.

Final focused verification passed: `npm run test --prefix backend -- tests/unit/delegate-subagent-tool.test.js tests/unit/system-engineer-sdk-tools.test.js` (exit 0), Forge run `VERIFY-RUN-3914299f-a01d-438f-b2b4-b8455eb2964f`, evaluated 2026-11-07T08:41:14.005Z, `ready_for_review: true`. Earlier equivalent pass: `VERIFY-RUN-bad6d11c-88a8-4bbf-aacb-02bf87519b58`; the system-engineer SDK test also passed independently in `VERIFY-RUN-f3cbb12c-4310-483a-a6fd-78878e5c6443` (exit 0).

## Live `delegate_subagent` revalidation

A direct Forge invocation with two independent read-only tasks completed successfully: `status: completed`, `tasks_completed: 2`, both tasks `fulfilled`, and non-empty `observed_files`. The child observations carried exact `parent_execution_id`, `child_execution_id`, `child_agent_id`, `observed_at`, and `source_tool` values. The runtime-Claude audit confirmed `correlationId`, `conversationId`, `subagentId`, `mcpServers.forge`, and the exact five-tool read-only allowlist. The runtime-provenance audit confirmed `read_file` and `Read` observations reach `childContext.observed_files` and survive normalization. This is live Forge evidence for the current execution, not merely a fixture assertion.

The live audit also identified a minor limitation: when multiple children report the same path, `mergeObserved` unions symbols but keeps the first record's provenance fields rather than representing provenance from every child.


## Limitations

This is not evidence of provider-neutral production readiness or crash safety. No full project suite, provider matrix, restart/replay test, or production migration was run. The Forge-level child execution blocker remains unresolved outside the verified owner child call. Existing handoff-related modifications were not authored or discarded by this follow-up.
