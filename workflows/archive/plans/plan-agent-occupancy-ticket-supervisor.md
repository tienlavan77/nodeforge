# Plan — Coder Occupancy, Exclusive Ticket Assignment, and Agent Status

## Purpose

Close the gap between Ticket Supervisor execution and the visible/persistent Coder state. This plan follows the agreed operating model in `workflows/sprint-leader-planning-agreement.md`.

This is work within the existing Ticket Supervisor and Forge runtime. It must not create a `ReviewSupervisor`, a second queue, a separate ticket store, or a separate DAG.
Reviewer dispatch uses a `role: reviewer`, `operation: review` job in the existing `agent.request` queue.

### Reviewer evidence-access decision

The current evidence path is **Supervisor-mediated**: Forge reads the rulebook, changed files and diff, then places bounded content in the review prompt. It does **not** give the reviewer model a Forge/MCP tool registry. This remains a valid baseline for bounded, reproducible review, but it is not equivalent to a Reviewer independently calling Forge tools.

Create a separate follow-up ticket under this plan if independent Reviewer tool access is required. It must add a least-privilege, read-only Reviewer tool policy to the Supervisor review path for every supported provider (Claude/Anthropic, OpenAI/Codex and any adapter), rather than reusing the owner-chat policy. The ticket must define the approved tool allowlist, project/path and byte/result budgets, secret/protected-path enforcement, tool-call audit/correlation, deterministic fallback when tools are unavailable, and provider-specific integration tests. It must not grant write, command execution, Git mutation, ticket-state mutation, network, or owner-only tools. `CLAUDE_MCP_TOOL_CALLS_MISSING` in a Coder remediation is a separate Coder-dispatch defect and is explicitly out of scope for this Reviewer ticket.

## Required operating model

```text
SV(ticket-A) atomically claims Coder-1 READY → WORKING
→ Coder-1 is ineligible for every other ticket while ticket-A is non-terminal
→ Coder-1 remains WORKING through code → verification → review → revision → re-review
→ ticket-A reaches its policy-defined terminal acceptance state
→ SV releases Coder-1 WORKING → READY
```

If no eligible Coder is READY, the ticket remains queued/waiting or follows the existing escalation policy. It must never dispatch a Coder already claimed by another ticket.

The normal accepted path releases a Coder only after acceptance—not after code submission and not during review. Failed, blocked, cancelled, and deferred paths need an explicit terminal release/retention policy and recorded reason.

### Terminal claim policy

| Outcome | Claim policy | Recorded reason |
| --- | --- | --- |
| Accepted after independent review | Release to READY after the approved verdict. | `accepted` |
| Resumable code failure, retry, timeout or checkpoint | Retain WORKING for the same ticket and Supervisor. | No release; checkpoint remains active. |
| Failed with no resumable checkpoint | Release after recording the terminal failure. | `agent_failed` or `agent_failed_terminal` |
| Reviewer unavailable, invalid evidence or revision limit | Escalate to `needs_human_review`, then release; the ticket cannot be marked accepted. | `review_unavailable`, `review_failed`, `review_revision_limit` or the specific error code |
| Interrupted review after a completed coding checkpoint | Escalate to `needs_human_review`, then release during recovery. | `review_interrupted` |
| Handoff fails before agent dispatch | Release the unused claim so the ticket can retry. | `handoff_failed` or `revision_handoff_failed` |
| Cancellation or deferral | Retain while the ticket is active; release only after the terminal decision is recorded. | Explicit `cancelled` or `deferred` reason when that transition is implemented. |

These exceptions return capacity without implying acceptance. Direct Code and tool-lab requests are separate modes with their own completion policy. The occupancy store alone publishes `agent.status_changed` after a persisted claim or release; Supervisor does not synthesize a status event.

## Ticket contract

| Area | Required change | Acceptance evidence |
|---|---|---|
| Atomic claim | Provide one persisted, concurrency-safe `READY → WORKING` transition, associated with `agent_id`, ticket/SV owner, and claim identity. Execute it before enqueue/dispatch. | Two SVs competing for one READY Coder yield exactly one claim and one unavailable/waiting result. |
| Eligibility | Resolve only enabled Coders that are persistently READY and have no active claim. Do not depend on a stale profile snapshot alone. | A claimed Coder is never selected by another ticket; another READY Coder remains selectable. |
| Lifecycle | Preserve the claim across code, verification, review, `request_changes`, revision, retry, timeout recovery, checkpoint, and resume. | A Coder stays WORKING through a full rejection → revision → re-review loop. |
| Release | Provide an idempotent, ownership-checked persisted `WORKING → READY` release from the SV's configured terminal path. | Accepted ticket releases exactly once; stale or foreign SV cannot release another ticket's Coder. |
| Event/UI | Publish `agent.status_changed` from the same lifecycle transition that persists the state. Pass that event through the Node client stream and render it on the Agents card. | Card changes live to WORKING on claim, to READY on release, and matches API state after reload/reconnect. |
| Resilience | Handle duplicate delivery, retries, restart, and checkpoint recovery without double dispatch or orphaned WORKING state. | Automated tests cover duplicate transition and interrupted-claim recovery. |

## Ownership

- **Sprint Leader:** creates/prioritizes this ticket, defines acceptance criteria and terminal exception policy; receives final SV outcome only.
- **Ticket Supervisor:** claims before Coder dispatch, retains ownership through the Coder/Reviewer loop, and requests release on the configured terminal path.
- **Forge runtime / Agent Profile Store:** provides authoritative atomic persistence, idempotency, event publication, queue integration, and recovery.
- **UI:** renders authoritative persisted/event state only; it must not infer READY from a local code-completed signal.

## Implementation focus

The ticket must trace and align the existing paths for:

1. Coder selection and dispatch in Supervisor runtime/integration.
2. Agent profile/status persistence and a concurrency-safe claim primitive.
3. Terminal result handling and release behavior.
4. Event publishing for `agent.status_changed`.
5. Node client event allowlist and `/agents` card reducer.
6. Checkpoint/retry/recovery handling and integration tests.

Known discrepancy in scope: Supervisor emits `agent.status_changed`, but the Node client stream currently allows `conversation.agent.status_changed` rather than the direct event. Correct the stream contract, but do not treat that UI correction as a substitute for atomic persisted claim/release.

## Validation sequence

1. Start two Ticket Supervisors with one READY Coder: only one can claim and dispatch it.
2. Start two Ticket Supervisors with two READY Coders: each claims a distinct Coder.
3. Exercise code, verification, review rejection, revision, and re-review: assigned Coder remains WORKING throughout.
4. Approve the ticket: state releases once to READY; live card updates; reload/reconnect remains correct.
5. Exercise retry, duplicate event, timeout/checkpoint recovery, and each configured terminal exception path.

## Definition of done

The scheduler cannot double-assign a Coder; agent status is durable and ownership-aware; WORKING spans the complete ticket-local implementation/review loop; READY is returned only by the defined terminal release policy; and the Agents page reflects the authoritative status both live and after reload.
