# Human Plan Approval Workflow

## Purpose

This workflow defines how an agent prepares implementation plans and how a human reviews and authorizes them. A plan is a proposal, not permission to execute.

## Responsibilities

- **Planning agent:** investigates the request and repository context, then produces a concrete, reviewable plan.
- **Human:** owns scope decisions and grants or withholds authorization to execute.
- **Execution agents:** may act only on a human-approved plan revision.

## Plan Draft Requirements

For each request, the planning agent creates a draft that identifies:

- objective and intended outcome;
- in-scope and out-of-scope work;
- proposed implementation approach;
- expected files or components affected;
- proposed tickets, sequencing, and dependencies;
- risks, assumptions, and open questions; and
- acceptance criteria.

The draft is evidence-based and may recommend an approach, but it must not be treated as approval to implement it.

## Canonical Storage and Effective Revision

Node manages plan artifacts in durable project storage. The canonical plan is an immutable JSON file, not chat content or a Markdown document:

```text
.forge/runtime/nf/plans/<plan_id>/<revision>.json
```

Each changed plan receives a new revision; an existing approved file is never overwritten. The JSON artifact contains the reviewable plan content and its identity, including `plan_id`, `revision`, and the metadata needed to link it to any approved architecture proposal or human decision.

SQLite stores only the registry/index and governance metadata, not a duplicate full plan payload:

- `plan_id`, revision, project and sprint identifiers;
- canonical file path and SHA-256;
- current/effective status and timestamps; and
- the approval decision ID and approved proposal reference, where applicable.

The human decision is an append-only record bound to the exact `plan_id`, revision, and SHA-256 reviewed. A revision is effective for execution only when its indexed file exists, its computed SHA-256 matches the index, and its linked human decision is `approved`. A missing file, hash mismatch, unindexed revision, or missing/rejected approval makes the plan non-executable.

Markdown may be generated as a readable export, for example under `.forge/exports/plans/`, but it is not authoritative and cannot grant execution permission. The plan JSON files and their SQLite index/decision records must be backed up together.

## Project Sprint Registry

A project is organized through a SQLite-backed sprint registry. The registry, rather than a roadmap document or `roadmap_json` payload, is the authoritative record of sprint scheduling and lifecycle.

For every sprint, the registry records at least:

- project and sprint identifiers;
- its explicit order within the project;
- dependencies on other sprints;
- lifecycle status; and
- the exact immutable `plan_id`, revision, path, and SHA-256 that define its work.

A sprint may reference only one execution-basis plan revision at a time. It may become `ready` only when that referenced revision passes the file/hash/index/approval checks above and its required sprint dependencies are satisfied. Status changes record progress; they do not alter the referenced plan artifact. Replanning or a material scope change creates a new immutable plan revision and requires the sprint reference and approval gate to be updated before execution continues.

Roadmaps are intentionally not part of this workflow: they are neither a canonical plan store nor a scheduling authority. SQLite provides the plan index, integrity checks, approval linkage, and sprint registry; the plan content remains in its immutable JSON file.

## Sprint Registry API

Sprint-plan/roadmap CRUD and Human Plan governance are separate public resources. The existing `/forge/v1/sprints` API remains owned by the sprint-plan upload service; it must not be expanded into a second authority for registry lifecycle, dependencies, immutable plan binding, or readiness. The Human Plan registry is exposed only below the sprint namespace:

```text
/forge/v1/sprints/registry
```

All registry requests include `?project=<project_id>`. `sprintRegistry` remains the internal domain service and authoritative registry storage; this route structure changes only the HTTP boundary, not the registry, plan-store, approval, or gate logic.

| Method | Route | Responsibility |
| --- | --- | --- |
| `GET` | `/forge/v1/sprints/registry` | List registry records for the project. |
| `POST` | `/forge/v1/sprints/registry` | Register a sprint with explicit order, dependencies, lifecycle state, and optional execution-basis plan reference. |
| `GET` | `/forge/v1/sprints/registry/:sprint_id` | Read one registry record and its effective plan/readiness data. |
| `PUT` | `/forge/v1/sprints/registry/:sprint_id/plan` | Bind a new immutable plan revision after index, file/hash, approval, and audit validation. |
| `PUT` | `/forge/v1/sprints/registry/:sprint_id/status` | Perform a permitted lifecycle transition after dependency and readiness validation. |

`/forge/v1/sprints` continues to serve its existing sprint-plan/roadmap and ticket contract. It does not create, merge, infer, or mutate registry records. A caller that needs both representations must call the relevant resource explicitly; no adapter may silently synchronize two independent stores.

The legacy top-level `/forge/v1/sprint-registry` route is retired. It must return a clear `ROUTE_RETIRED` error and must not alias or redirect to `/forge/v1/sprints/registry`, because aliases would preserve two public authorities and obscure caller migration.

Draft and execution routes are not implicitly created by this registry move. Until a separate approved contract attaches them to the registry resource, `POST /forge/v1/sprints/:sprint_id/draft` and `POST /forge/v1/sprints/:sprint_id/run` retain their current sprint-service ownership. Any future registry draft/run endpoint must be specified explicitly and must use the same immutable revision, exact-approval, file/hash/index, and dependency gates. UI, SDK, tests, documentation, and callers must migrate registry operations from `/forge/v1/sprint-registry` to `/forge/v1/sprints/registry` together.

## Chat Command Contract

The chat accepts these exact, slash-prefixed commands. Command identifiers are opaque, immutable references; the runtime must resolve them in the current project and reject an unknown, inaccessible, malformed, or stale identifier. The agent returns the resulting identifier in the chat response.

### `/summary`

```text
/summary
```

Summarize only the portion of the conversation just discussed. The summary must state the objective/outcome, in-scope work, out-of-scope work, decisions, assumptions/risks/open questions, and relevant repository context when available.

Save this as a temporary Markdown artifact under `workflows/` and return its file identifier as `<id-file>`. The temporary summary is input for planning; it is not a plan, approval, sprint, ticket, or permission to run work.

### `/plan <id-file>`

```text
/plan <id-file>
```

Resolve the referenced temporary summary, investigate the stated request and repository context, then create and persist a reviewable immutable **draft** plan. Return its `<id kế hoạch>` (plan ID). The draft must meet the Plan Draft Requirements and is bound to the relevant sprint as `awaiting_human_approval` where a sprint is created or selected.

This command does not start RUN and does not dispatch a Coder or Supervisor.

### `/approve <id kế hoạch>`

```text
/approve <id kế hoạch>
```

Resolve the plan ID and hand the approved-plan request to Node, which invokes Sprint Leader (SL) to create the Sprint Plan (SP) from that plan. Return the SP/sprint identifier and the handoff status.

`/approve` is a chat command for the Node-to-SL planning handoff only. It must not start RUN, dispatch a Coder or Supervisor, or bypass the exact plan-revision, SHA-256, authenticated human-decision, dependency, and readiness gates required before execution. If the plan has not received the required authenticated approval for its exact revision and hash, Node must report that it is blocked and must not invoke SL.

### Revisions

To request a change after a draft or approval, use:

```text
Sửa kế hoạch <plan_id> revision <revision>: <thay đổi yêu cầu>
```

The agent creates a new draft revision; the prior revision and decision remain immutable. The configured owner must review and approve the exact plan ID, revision, and SHA-256 in the authenticated UI or Plan Decision API before `/approve <id kế hoạch>` can hand it to Node and SL.

## Review and Revision

1. The agent submits the draft plan for human review.
2. The human may approve it, reject it, or request changes to scope, priority, sequence, solution, tickets, dependencies, or acceptance criteria.
3. A response requesting changes requires the agent to create a new plan revision.
4. A revision previously reviewed by the human is never silently edited. Prior revisions remain available for audit.
5. The revised plan is submitted for human review again.

## Approval Gate

Execution is prohibited until a human explicitly approves the exact plan revision proposed for execution.

A valid approval is bound to the plan identity, revision, and content hash, and records:

- approver identity;
- decision: `approved`, `rejected`, or `changes_requested`;
- decision time;
- plan ID, revision, and SHA-256; and
- optional review comments.

General agreement or approval of an earlier revision does not authorize execution of a different revision.

## Final Update Before Execution

Before any implementation begins, the planning agent or human may request one final update to the plan. This update is permitted even after a prior revision was approved, but it must follow the same immutable revision process:

1. create a new JSON revision with a new SHA-256;
2. retain the previously approved revision and its decision for audit;
3. mark the new revision `awaiting_human_approval` and do not execute it; and
4. obtain explicit human approval bound to the new `plan_id`, revision, and SHA-256.

The earlier approval does not carry over to the final-update revision. The sprint must remain non-executable, or return from `ready` to a blocked approval state, until the new revision passes the file/hash/index/approval checks. If no content changes are needed, the already approved revision remains the execution basis and no new revision is created.

## Execution Readiness

After valid approval, the approved revision becomes the current execution basis. Associated sprint work and tickets may then move to `ready`, subject to their normal dependency and operational gates.

A rejected plan, or a plan with requested changes, remains non-executable.

## Changes During Execution

Operational progress is recorded separately from the plan. It does not require rewriting the approved plan.

A material change requires a new plan revision and a new human approval before the changed scope can proceed. Material changes include changes to:

- objectives or in/out scope;
- the significant technical approach or mandatory architecture guardrails;
- approved outcome acceptance criteria; or
- mandatory dependencies or execution constraints explicitly approved by the human.

Architecture plans define outcomes and guardrails; Sprint Leader owns delivery decomposition. Suggested ticket names, counts, candidate files, and presentation order are not mandatory unless explicitly identified as approved constraints. SL may split/regroup suggested work, choose evidence-based paths, refine ticket criteria, and schedule independent work within the approved boundary without revising the architecture proposal. The Sprint Plan must trace all approved outcomes and criteria to tickets without weakening them.

This delegation does not authorize editing a locked execution artifact or transferring approval to a new hash. Changes to persisted execution-basis revisions still follow their immutable revision and exact-approval contract. Existing runtime/schema requirements are not waived by this documentation; incompatible exact-ticket matching must be resolved separately before using the outcome-based template.

The earlier revision remains in the audit history but must not be used as the basis for the superseding work.

## Flow

```text
Human request
  -> agent investigates and creates draft plan
  -> human review
  -> changes requested: agent creates a new revision -> human review
  -> approved: exact revision is locked as execution basis
  -> sprint/tickets become ready when operational gates pass
  -> material scope change: new revision -> human approval again
```

## Sprint and Ticket Visibility on UI

Every project sprint, including historical, blocked, retired, and out-of-scope records, must be visible in the project UI. The UI must reconcile the roadmap projection with the authoritative Sprint Registry by `project_id` and sprint ID; it must not hide a record merely because it has no runnable plan or is not the active sprint.

- Each sprint row must show a specific lifecycle/progress state, its execution-basis plan identity when present, and a clear outcome label. `done`/completed sprints are collapsed by default but remain expandable; an active coding sprint is visibly marked as `running`/`coding` rather than being inferred from display order.
- Each ticket must show its persisted current state, not a client-side guess: `pending`, `blocked`, `running`, `reviewing`, `needs_human_review`, `done`, `failed`, or `cancelled`, plus an actionable blocked/error reason where safe to render.
- Registry lifecycle and ticket execution state remain separate facts. A UI projection may summarize them, but must preserve both source states and must not claim that a sprint is completed merely because a plan was approved or that a ticket is done merely because it was dispatched.
- Project-stream/status events refresh the affected sprint and ticket. On reconnect or missed events, the UI reloads the project-scoped authoritative snapshot. Empty, loading, stale, and failed states must be explicit.
- Historical records continue to obey the production-disposition rule: rendering them does not make them ready or runnable.

## Sprint Leader Ticket Granularity and Style Boundary

Sprint Leader must decompose an approved sprint plan into independently executable, dependency-linked tickets. This is an admission rule, not merely prompt guidance.

- A ticket declares exactly **one** primary `style`: `frontend`, `backend`, `security`, `infra`, or `docs`. A multi-style array is invalid for newly created or replanned tickets. A cross-cutting outcome must be split into one-style tickets with explicit dependencies (for example backend contract → frontend consumer → security validation); a security change is never hidden inside a frontend or backend ticket.
- A ticket may modify at most **four distinct repository files**, counting source, schema/configuration, test, and documentation files. The cap applies to the actual immutable changed-file manifest, not to exploratory reads or `REFERENCE` candidates. If a fifth changed file is required, SL must split/resequence the work or create a separately approved replan.
- Before dispatch, the persisted ticket must state its single style, objective, in/out-of-scope boundary, acceptance criteria, dependencies, and an expected mutable-file budget of no more than four. Discovery may attach read-only candidate evidence, but cannot expand the approved ticket scope.
- The Supervisor/Coder preflight, change ledger/manifest, verification, review, and terminal receipt enforce the same file cap and single-style contract. A violation blocks the ticket; it cannot be waived by truncating the report or by silently changing the ticket after approval.
- Existing multi-style or oversized historical tickets must be displayed and dispositioned, but cannot be newly dispatched until an owner-approved replacement/replan satisfies this rule.

Any modification to these UI, ticket-boundary, style, or file-budget rules is a material plan change: it requires a new immutable plan revision and exact human approval before execution.

## Production Acceptance

Technical tests do not replace production acceptance. A release is accepted for production only after one controlled canary completes the same end-to-end path used by operators:

1. Deploy/restart the Control API from the reviewed commit, with the production owner credential configured server-side. Do not expose the credential in UI state, browser storage, command output, or logs.
2. Confirm the selected Sprint Leader gateway is healthy and quota is available; record provider, model/profile, timestamp, and correlation ID. A `429` or provider failure is a failed/blocked canary, not evidence of acceptance.
3. Create or reuse one isolated canary sprint and request a draft. Preserve the returned plan ID, revision, artifact path, SHA-256, registry record/status, agent events, and provenance. The draft must reach `awaiting_human_approval`; missing required evidence, invalid provenance, or a tracker/architecture-policy failure must be resolved and the canary rerun.
4. A configured owner independently reviews the rendered plan, its evidence and acceptance criteria, then approves the exact plan ID, revision, and SHA-256 through the authenticated UI/API. Record the append-only decision ID, owner identity, timestamp, and comments. Never treat a chat acknowledgement or approval of another revision as approval.
5. Bind that approved revision to the canary registry record, transition it to `ready`, and verify dependency, file, index, checksum, and approval gates in the live API. Capture the successful registry response.
6. Start RUN only for the ticket/sprint covered by that exact approved revision. Capture the execution correlation ID and the terminal receipt (`done` or `failed`), including agent and reviewer evidence. A failed RUN is not production acceptance; diagnose, create a new revision when scope/content changes, and repeat approval and the canary.
7. Perform a negative live check: an absent/invalid owner token, an unapproved or superseded revision, and a checksum/file mismatch must each remain unable to make a sprint ready or execute. Store redacted responses as evidence.
8. Disposition every pre-existing sprint before enabling it: create/review/approve and bind a valid revision, or explicitly mark/retain it blocked, retired, or out of scope under an owner decision. No historical sprint may be opened merely because the system is deployed.

The release owner signs production acceptance only when steps 1–8 have evidence, the canary terminal receipt is successful, no unresolved security/integrity failure exists, and the historical-sprint disposition register is complete. Otherwise the verdict remains `NOT ACCEPTED FOR PRODUCTION` and execution remains limited to remediation/canary work.

## Rule

Agents propose and detail plans. Humans confirm scope and authorize execution. Without explicit human approval for the exact revision and hash, no implementation may start.
