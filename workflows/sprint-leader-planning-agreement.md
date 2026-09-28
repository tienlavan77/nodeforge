# Sprint Leader Planning Agreement

## Purpose

This document records the agreed operating model for Sprint Leader (SL), Ticket Supervisor (SV), Coder, Reviewer, and Forge/Node. It is the planning and orchestration contract; it does not prescribe implementation files.

## Core separation of responsibilities

| Role | Owns | Must not own |
| --- | --- | --- |
| Sprint Leader | Sprint-level planning, ticket definitions, dependency DAG, priorities, policies, and escalation decisions | Per-ticket Coder/Reviewer dispatch and individual revision-review loops |
| Ticket Supervisor | The complete execution loop for exactly one ticket | Sprint-wide sequencing, replanning, or changing the ticket's approved scope |
| Coder | Implementing the ticket and supplying required verification evidence | Self-approval or independent review verdict |
| Reviewer | Independent quality verdict against the ticket contract | Implementing the reviewed change or workflow-state control |
| Forge/Node | Execution infrastructure: queueing, dispatch, events, persistence, timeouts, retries, and checkpoints | Business scope decisions or a review-quality verdict |
| Code Index / Forge discovery | Locating and validating candidate files, symbols, dependencies, project ownership, and current checksums | Defining the ticket's business scope |

## Scope logic: SL responsibility

Scope logic means the business boundary and required behavior of a ticket, **not** a list of files to edit.

For every ticket, SL defines and persists:

- **Objective:** the problem or outcome to achieve.
- **In scope:** allowed functional changes.
- **Out of scope:** explicit exclusions and protected behavior.
- **Behavior / contract:** required behavior after completion, including compatibility expectations.
- **Acceptance criteria:** objective conditions for acceptance.
- **Dependencies:** prerequisite tickets and effects on downstream tickets.
- **Project/module scope:** the project or module boundary within which work is allowed.
- **Execution policy:** verification requirements, independent review requirement, retry limit, and escalation rule.

Example:

```yaml
ticket: NF-UI-CONV-001
objective: Chuẩn hóa mapping role cho Sprint Leader
in_scope:
  - canonical role: sprint_leader
  - display label: Sprint Leader
  - builder chỉ giữ compatibility alias
out_of_scope:
  - không đổi behavior của Coder/Reviewer
  - không tạo role mới
  - không sửa project khác
acceptance:
  - ticket mới không dùng builder
  - dữ liệu cũ dùng builder vẫn đọc được
```

Forge/Code Index then finds and validates the relevant files and symbols. It may return `candidate_files`; it does not redefine the ticket.

## Planning lifecycle

```text
SL receives approved architecture/goal
→ defines scope logic and ticket contracts
→ builds dependency DAG, order, priority, and policies
→ requests Forge/Code Index evidence for candidate locations
→ persists complete tickets
→ starts one Ticket Supervisor for each runnable ticket
→ monitors only terminal results, dependencies, and escalations
→ opens downstream work, replans, defers, or escalates at sprint level
```

SL must not give an entire phase or an unbounded plan directly to a Coder. A ticket must be independently executable within its declared scope.

## One ticket, one Ticket Supervisor

Each executable ticket has exactly one accountable SV. There is no separate `ReviewSupervisor` and no separate review DAG, ticket store, or control plane.

The SV owns the ticket's full implementation and review loop:

```text
SL starts SV(ticket-123)
→ SV dispatches Coder
→ Coder implements and returns verification evidence
→ SV dispatches independent Reviewer
→ Reviewer approves
   or requests changes
→ SV dispatches Coder revision
→ SV repeats review subject to policy
→ SV returns terminal result to SL
```

Typical terminal results are:

```text
accepted | blocked | failed | deferred
```

The detailed workflow may expose states such as:

```text
coder_running → verification → reviewer_running
→ accepted
or → changes_requested → coder_revision → reviewer_running
```

## Review governance

- Reviewer independently checks the implementation against acceptance criteria, applicable architecture boundaries, and supplied evidence.
- Reviewer returns a verdict such as `approved` or `request_changes` with findings and evidence.
- Reviewer does not implement the change while acting as Reviewer.
- The implementation author cannot be the sole reviewer.
- The SV, not SL, reacts to `request_changes`, dispatches revisions, and requests re-review.
- SL does not convert a review request into approval, override findings informally, or call Reviewer directly per ticket.
- Any override requires an explicit sprint policy or human-authority decision and must be recorded as an escalation/decision.

## SL control-plane duties

SL remains responsible for:

1. Creating a coherent sprint plan and bounded ticket contracts.
2. Ordering tickets by dependency and risk.
3. Starting SVs only when their dependencies and admission criteria are satisfied.
4. Monitoring terminal ticket results and cross-ticket effects.
5. Deciding whether to open dependent work, replan remaining work, defer work, or escalate.
6. Setting sprint-wide policies, for example mandatory independent review, maximum revision/review attempts, and human-override requirements.

SL does **not** perform the operational work inside a ticket: it does not repeatedly dispatch Coder/Reviewer, wait on individual attempts, or manage ticket-local timeout/retry/checkpoint mechanics.

## SV execution-plane duties

For its single ticket, SV:

1. Enforces the persisted ticket scope, acceptance criteria, dependencies, and policy.
2. Dispatches Coder, gathers implementation and verification evidence, and dispatches Reviewer.
3. Manages revision-review iterations, timeouts, retries, checkpoints, and evidence.
4. Prevents invalid role mixing and invalid transitions.
5. Reports only material progress, terminal status, and escalation context to SL.
6. Does not silently expand or rewrite ticket scope; it blocks and escalates scope/dependency defects to SL.

## Decision rule

> SL decides **what changes are needed across the sprint and their boundaries**. Forge/Code Index identifies **where relevant code is located**. A Ticket Supervisor executes **how one approved ticket reaches a terminal result**. Reviewer decides **whether that implementation meets the quality gate**.

## Reconciliation with older wording

Any wording that says “SL dispatches Reviewer after every code ticket” is superseded by this agreement. The correct model is: **SV dispatches and manages Coder ↔ Reviewer for its own ticket; SL receives terminal results or escalations only.**
