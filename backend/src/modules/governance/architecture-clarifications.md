<!-- Defines owner clarification before immutable Architecture planning and inherited Sprint policies. -->
# Architecture owner decisions

`/plan <project-relative.md>` first runs read-only Architecture discovery.
Architecture respects existing source decisions, resolves delegated technical
details itself, and returns only unresolved owner-level questions as JSON.
Each question has an ID, title, rationale, 2–10 concrete options and an optional
recommendation. A recommendation never counts as an owner answer.

The Architecture conversation presents questions individually, progress,
optional notes and a review summary. Explicit selections are saved with owner
authentication. **Xác nhận & tạo plan** seals the answers; it does not approve
the resulting plan or start ticket execution. No questions means Node proceeds
directly to generation.

Node writes the selected policies, notes and a `nodeforge-owner-decisions`
record into the immutable Markdown. The record binds session, input path and
SHA-256, authenticated owner and confirmation time. Plan review and approval
remain separate exact-revision/checksum actions.

## Transport and recovery

- `GET /forge/v1/conversations/:conversation/plan-clarifications` restores sessions.
- `PATCH .../plan-clarifications/:session` saves choices/notes or cancels a draft.
- `POST .../plan-clarifications/:session/confirm` confirms and generates the plan.
- Mutations use an authenticated owner token, exact version and source checksum.
- Tokens are never stored in clarification records or browser storage.
- Node stores drafts under `.forge/runtime/nf/plan-clarifications/:project`.
- Waiting releases the SDK turn. Reload restores answers without rerunning discovery.
- Read-only backend planning uses its clarification recovery record, not the
  direct document-editing execution checkpoint. Direct editing keeps its gates.
- Changed/missing source blocks confirmation; analyze the source again.
- Failed generation retains answers. Retry reconciles the fixed plan identity;
  editing any answer invalidates the old confirmation and requires a fresh one.
- Project events and visibility restoration trigger refresh; no active-tab polling.

## Sprint authority

SL consumes the exact approved Architecture policy record and embeds Node-owned
parent approval provenance in Sprint scope. SL cannot create a new
`decision_requests` questionnaire or deferred human policy verification step.
An unresolved authority conflict returns `ARCHITECTURE_REPLAN_REQUIRED`.
Each ticket receives the approved policy descriptions before dispatch.
Executable admission rechecks parent approval and exact inherited policy content.
Policies never waive test/build/browser evidence, scope, dependency or Reviewer gates.

Historical Sprint Plans retain their existing decision protocol. This change
does not automatically migrate, approve or clear existing tickets/executions.
