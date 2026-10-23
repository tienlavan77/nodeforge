# Sprint Dispatch Hardening R1

**Plan ID:** `PLAN-SPRINT-DISPATCH-HARDENING-R1`  
**Revision:** `1`  
**Artifact status:** `draft` — requires immutable persistence and an exact owner decision before any implementation or Sprint RUN.  
**Authority:** SDK immutable-plan path is the canonical production path.

## Objective

Make Sprint Leader planning and Sprint RUN fail closed: every runnable ticket must belong to the exact approved immutable plan, registry identity must be durable and exact, and duplicate requests must not create duplicate sprint, registry, ticket, or execution records.

## Governance invariants

- The immutable plan identity is `{plan_id, revision, sha256, path}`. The persisted artifact SHA-256, not this working Markdown checksum, is approval identity.
- Draft persistence creates or rebinds one idempotent registry record in `awaiting_human_approval`; it must not set `ready`, `running`, or `done`.
- Only an owner-authenticated decision on the exact persisted identity may move the plan through the approval gate.
- Sprint RUN dispatches only tickets whose ID set exactly matches both the approved plan content and its validated projection.
- No SL, caller, bus adapter, or legacy path may self-set `approved`, `ready`, `running`, or `done`.
- SDK immutable-plan flow is the sole production authority for plan-to-ticket creation. Bus planner/adapter code must be test/legacy-only or removed from production composition, and must never publish directly runnable tickets.
- Coder dispatch remains downstream of plan approval, registry authority, ticket admission, and DAG readiness.

## Ticket 1 — Registry persistence after immutable draft

**ID:** `SPDHR1-REGISTRY-001`  
**Owner:** Coder  
**Reviewer:** Independent Reviewer  
**Style:** backend  
**File budget:** maximum 4 production files, excluding focused tests.

### Scope

After an immutable Sprint Plan draft is accepted, create or rebind its registry record idempotently. Persist the exact `plan_id`, `revision`, `path`, and `sha256`; preserve project and correlation provenance; initialize lifecycle only as `awaiting_human_approval`.

### Acceptance criteria

- Drafting creates a registry record discoverable through the authoritative registry GET/read path.
- Record identity exactly equals the immutable artifact identity; no reconstructed or display-only identity is accepted.
- Replayed draft request/correlation binds the same record and does not duplicate it.
- Drafting never auto-promotes lifecycle to `ready`, `running`, or `done`.
- Failure in the persistence boundary leaves no contradictory partial registry identity.

### Verification

Focused unit/integration coverage: `draft → registry GET` returns one record with exact identity and `awaiting_human_approval`; replay remains idempotent; invalid/missing identity fails closed.

## Ticket 2 — Sprint RUN membership gate

**ID:** `SPDHR1-MEMBERSHIP-002`  
**Owner:** Coder  
**Reviewer:** Independent Reviewer  
**Style:** backend  
**File budget:** maximum 4 production files, excluding focused tests.  
**Dependency:** `SPDHR1-REGISTRY-001`

### Scope

Replace object/string membership behavior with explicit ticket-ID set comparison between projection tickets and `plan.content.tickets` before any Coder dispatch.

### Acceptance criteria

- Matching ID sets pass the membership gate.
- A projection ticket absent from plan content fails with `SPRINT_PLAN_SCOPE`.
- A plan-content ticket absent from projection fails with `SPRINT_PLAN_SCOPE`.
- Duplicate, malformed, or mismatched IDs fail closed before Coder dispatch.
- This ticket does not change owner-approval authority or registry-status authority.

### Verification

Focused tests cover matching, missing, extra, duplicate, and type/object-versus-string cases, and assert that failures occur before execution dispatch.

## Ticket 3 — Canonical Sprint Leader dispatch

**ID:** `SPDHR1-CANONICAL-003`  
**Owner:** Coder  
**Reviewer:** Independent Reviewer  
**Style:** backend/architecture  
**File budget:** maximum 4 production files, excluding focused tests.  
**Dependency:** `SPDHR1-REGISTRY-001`

### Scope

Make the SDK immutable-plan path the only production composition authority. Constrain bus planner/adapter behavior to explicit legacy-test-only use, or retire it from runtime composition. Ensure one draft request/correlation produces at most one immutable revision, one registry action, and one ticket creation transaction.

### Acceptance criteria

- Production composition reaches the SDK immutable-plan authority only.
- Legacy/bus planner paths are clearly marked and cannot publish tickets that can RUN directly.
- Duplicate request/correlation does not create a duplicate immutable revision, sprint, registry record, ticket, or execution.
- Ticket provenance names the canonical plan identity and source path.

### Verification

Composition and idempotency tests demonstrate the canonical route, reject legacy executable-ticket publication, and prove duplicate-request stability.

## Ticket 4 — Verified Sprint Leader planning context

**ID:** `SPDHR1-CONTEXT-004`  
**Owner:** Coder  
**Reviewer:** Independent Reviewer  
**Style:** backend/prompt contract  
**File budget:** maximum 4 production files, excluding focused tests.  
**Dependency:** `SPDHR1-CANONICAL-003`

### Scope

Supply SL either read-only discovery under an auditable budget or a server-generated verified context pack. Synchronize the SL prompt/rulebook with actual capability. Evidence references must resolve to evidence actually supplied or recorded.

### Acceptance criteria

- SL receives only capabilities/context represented by the active contract.
- Discovery is read-only, bounded, and auditable, or is replaced by a verified context pack.
- Output cannot claim source inspection or cite evidence that was neither supplied nor recorded.
- Intake naming and behavior are aligned: it is either a dependency intake guard or emits/asserts the stated planning invariants.

### Verification

Tests prove that unsupported source-inspection claims and unverified evidence refs are rejected or absent, and that supplied evidence is traceable.

## Delivery order

`SPDHR1-REGISTRY-001 → (SPDHR1-MEMBERSHIP-002 + SPDHR1-CANONICAL-003) → SPDHR1-CONTEXT-004`

Each ticket must be persisted and approved through the plan gate before Coder work. Reviewer assignment must be independent of the implementing Coder.

## End-to-end acceptance gate

1. `draft → immutable plan → registry awaiting_human_approval → owner decision → ready → Sprint RUN` is enforced.
2. Matching ticket IDs dispatch in validated DAG order.
3. Duplicate request/correlation creates no duplicate registry, ticket, or ticket execution.
4. Scope mismatch is blocked before Coder dispatch.
5. No route lets SL or caller self-set `approved`, `ready` outside the plan/registry gate, `running`, or `done`.
6. Production acceptance remains `BLOCKED / NOT ACCEPTED FOR PRODUCTION` until an owner-approved artifact completes canary RUN with valid terminal receipt and evidence.

## Out of scope

This plan does not retroactively approve or alter `NF-HUMAN-APPROVE-SL-SP-001` revision 2, does not manually mutate `.forge/` state, and does not authorize production deployment or RUN merely by creating this Markdown draft.

## Approval requirement

Before execution, persist this plan as an immutable artifact, compute and display its SHA-256, create/bind the registry record at `awaiting_human_approval`, and obtain an owner-authenticated decision over the exact `{plan_id, revision, sha256}`. A chat statement or this file alone is not that decision.
