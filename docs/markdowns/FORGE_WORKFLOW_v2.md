# Forge — Workflow v2
## Node-Orchestrated Multi-Agent Delivery Workflow

**Status:** Proposed replacement for the previous Agent-driven workflow
**Basis:** Current Forge `CONSTITUTION.md`, `ARCHITECTURE.md` and `WORKFLOW.md`
**Core change:** Node becomes the orchestration/control plane; existing Forge roles and responsibilities remain intact.

---

# 1. Purpose

Forge is a controlled software-engineering system in which:

- the **Project Owner** remains the final authority;
- the **Sprint Lead** owns Sprint decomposition and delivery coordination;
- the **Builder** implements;
- the **Reviewer** independently reviews;
- the **Architecture Manager** is an optional specialist gate;
- the **Forge Core Structure Indexer** provides deterministic project structure information;
- **Node** orchestrates execution, context, verification, state, events and routing;
- future AI decision capabilities may assist Node when deterministic rules are insufficient.

The current Constitution remains the highest authority:

```text
CONSTITUTION.md
    >
ARCHITECTURE.md
    >
SPRINT.md
    >
COMMIT.md
```

The Constitution explicitly requires Architecture/Sprint/Commit discipline, prohibits Builder/Reviewer role mixing, requires no hidden work, and establishes the User as final authority.

---

# 2. Architectural Shift

## Previous model

The previous workflow required agents to directly read and manipulate Sprint/Commit state artifacts:

```text
Sprint Lead
    ↓
roadmap.json
    ↓
COMMIT.md + status.json
    ↓
Builder
    ↓
status.json
    ↓
Reviewer
    ↓
status.json
    ↓
Sprint Lead
```

This remains valid as the **project artifact model**, but it should no longer be the preferred **runtime orchestration mechanism**.

## New model

Node becomes the runtime control plane:

```text
                         PROJECT OWNER
                              │
                              │ approval / decision
                              ▼
                            NODE
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
          ▼                   ▼                   ▼
    Sprint Lead       Architecture Manager    System Services
          │                   │                   │
          │                   │                   ├─ Structure Indexer
          │                   │                   ├─ Test Runner
          │                   │                   ├─ Git Observer
          │                   │                   ├─ Context Builder
          │                   │                   ├─ State Manager
          │                   │                   └─ Event Stream
          │                   │
          └──────────────┬────┘
                         │
                         ▼
                      BUILDER
                         │
                         ▼
                    VERIFICATION
                         │
                         ▼
                      REVIEWER
                         │
                         ▼
                        NODE
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
            NEXT       RETRY      ESCALATE
```

Node does **not** replace the existing roles.

Node coordinates them.

---

# 3. Role Model

## 3.1 Project Owner

The Project Owner remains the final human authority.

Responsibilities:

- approve Sprint scope and roadmap;
- resolve scope, architecture and policy decisions;
- approve changes that exceed the approved Sprint/Architecture contract;
- approve final Sprint closure.

Node may route decisions to the Project Owner but cannot replace this authority.

---

## 3.2 Sprint Lead

Sprint Lead remains responsible for Sprint planning and decomposition.

Responsibilities:

- read approved Sprint and Decision Memory;
- divide Sprint into atomic Commits;
- define Commit dependencies and order;
- define Commit contracts;
- prepare the next eligible Commit;
- maintain Sprint-level planning artifacts;
- coordinate Builder/Reviewer handoffs;
- resolve Builder requests within approved authority;
- request Project Owner approval when required;
- produce final Sprint Report;
- request Sprint closure.

### Important change

Node may **execute and enforce the coordination mechanics**, but it must not silently redefine the Sprint Lead's authority.

The logical responsibility remains:

```text
Sprint Lead = Sprint planning authority
Node        = Runtime execution authority
```

---

## 3.3 Builder

Builder remains implementation-only.

Responsibilities:

- implement the active Commit;
- inspect relevant project source;
- modify implementation files;
- add/update tests as required;
- run required focused verification;
- create Builder Report;
- report changed files, tests, risks and concerns;
- request clarification when the Commit contract is insufficient.

Builder must not:

- approve its own implementation;
- act as Reviewer;
- silently change Architecture;
- add unapproved dependencies;
- expand Commit scope;
- change public API without authorization.

---

## 3.4 Reviewer

Reviewer remains independent.

Responsibilities:

- inspect Commit contract;
- inspect relevant Architecture and decisions;
- inspect Builder Report;
- inspect diff and actual source;
- verify tests;
- check correctness, regression risk, scope and Architecture compliance;
- issue exactly one verdict:
  - `APPROVED`
  - `REQUEST_CHANGES`
  - `BLOCKED`

Reviewer does not edit implementation code while acting as Reviewer.

---

## 3.5 Architecture Manager

Architecture Manager remains an optional specialist.

It starts only when:

- the active Commit explicitly requests an architecture gate; or
- Project Owner/Sprint Lead requests architecture analysis.

Possible outputs:

```text
architecture-report.md
architecture-decision.md
rfc-draft.md
architecture risk findings
```

Possible outcomes:

```text
ARCHITECTURE_ACCEPTABLE
ARCHITECTURE_CHANGES_REQUIRED
RFC_REQUIRED
OWNER_GATE
BLOCKED
```

`ARCHITECTURE_ACCEPTABLE` does not approve the Commit.

Architecture Manager cannot:

- approve its own proposal;
- replace Reviewer;
- modify frozen Architecture directly;
- close a Sprint;
- write implementation code.

---

## 3.6 Forge Core Structure Indexer

This is infrastructure, not an AI role.

It:

- generates deterministic project inventory;
- maintains the target project's `structure.md`;
- excludes credentials, environment contents, dependency caches, generated outputs and sensitive/ignored paths;
- writes atomically;
- preserves the last valid index if refresh fails;
- supplies the full map to Sprint Lead;
- supplies bounded sections to other roles.

It does not make semantic architecture decisions.

---

## 3.7 Future Decision Agent

The Decision Agent is a future intelligent specialist, not a replacement for the existing roles.

Use it only when deterministic Node logic cannot safely decide.

Examples:

- ambiguous architecture conflict;
- uncertain dependency impact;
- unclear failure root cause;
- conflicting evidence;
- complex replanning.

The Decision Agent proposes.

Node validates and applies.

Project Owner remains the final authority for decisions requiring human approval.

---

# 4. Node Responsibilities

Node is the **runtime control plane**.

Node owns:

1. project observation;
2. execution state;
3. task/Commit eligibility;
4. agent dispatch;
5. context assembly;
6. context minimization;
7. filesystem/project change observation;
8. code-index refresh triggering;
9. test execution;
10. test-output normalization;
11. agent-result validation;
12. workflow transition enforcement;
13. event streaming;
14. retry control;
15. review-loop routing;
16. escalation;
17. recovery/resume;
18. execution history;
19. UI stream delivery.

Node must not silently replace role authority.

---

# 5. Source of Truth Model

The existing Forge source-of-truth hierarchy remains.

```text
CONSTITUTION
      ↓
ARCHITECTURE
      ↓
SPRINT
      ↓
COMMIT
```

Runtime state is separately managed by Node.

The distinction is:

```text
Project Rules / Intent
        ↓
Constitution / Architecture / Sprint / Commit

Runtime Execution
        ↓
Node State / Events / Queue

Actual Implementation
        ↓
Filesystem + Git
```

`status.json` remains the authoritative Commit lifecycle artifact for the project workflow.

Node mirrors/consumes that state and is responsible for preventing invalid transitions.

Node must not create a second contradictory status authority.

---

# 6. Planning Model

The Sprint remains the user-facing planning unit.

```text
User
  ↓
Sprint
  ↓
Sprint Lead
  ↓
Atomic Commits
  ↓
Execution Graph
```

`roadmap.json` remains a planning artifact describing Commit order/dependencies.

Node converts it into an internal execution graph.

Example:

```text
C001
  │
  ├────→ C002
  │
  └────→ C003
            │
            ▼
           C004
```

Node determines which Commit is eligible.

The Agent does not need to independently interpret the entire roadmap.

---

# 7. Commit Lifecycle

Canonical Commit lifecycle:

```text
PLANNED
   ↓
IN_PROGRESS
   ↓
READY_FOR_REVIEW
   ↓
REVIEWING
   ├── REQUEST_CHANGES ──→ IN_PROGRESS
   │
   ├── BLOCKED
   │
   └── APPROVED
          ↓
      NEXT COMMIT
```

Node enforces valid transitions.

Builder and Reviewer return results; Node applies orchestration transitions.

---

# 8. Complete Execution Loop

## Step 1 — Sprint approved

Project Owner approves Sprint scope.

```text
Project Owner
      ↓
Node
      ↓
Sprint Lead
```

Node records the execution start and prepares runtime state.

---

## Step 2 — Sprint Lead prepares Commit graph

Sprint Lead:

- creates/updates `roadmap.json`;
- defines atomic Commits;
- defines dependencies;
- defines Commit contracts;
- identifies specialist gates.

Node builds an execution graph from that plan.

---

## Step 3 — Node selects eligible Commit

Node evaluates:

- Sprint approval;
- Commit dependencies;
- current status;
- specialist gates;
- previous failures;
- workspace conflicts;
- required approvals.

Only an eligible Commit can enter execution.

---

## Step 4 — Architecture gate, when required

If the Commit requires architecture review:

```text
Node
 ↓
Architecture Manager
 ↓
architecture result
 ↓
Node
```

Possible result:

```text
ARCHITECTURE_ACCEPTABLE
```

→ continue.

```text
RFC_REQUIRED
OWNER_GATE
ARCHITECTURE_CHANGES_REQUIRED
```

→ stop and route to the appropriate authority.

---

## Step 5 — Context assembly

Node builds a bounded context package.

Builder receives only what is needed:

```text
Commit Contract
+
Relevant Architecture
+
Relevant Rules
+
Relevant Decisions
+
Relevant structure.md section
+
Relevant Source
+
Relevant Tests
+
Relevant historical evidence
```

Builder does not need the entire project.

---

# 9. Context Selection

Node should use the Code/Structure Index to discover relevant project areas.

Example:

```text
Commit:
"Implement runner timeout handling"

Node resolves:

src/runner/
src/runner/timeout.ts
src/runner/process.ts
test/runner/
Architecture runner section
relevant decisions
relevant rules
```

Node then sends the minimum sufficient context.

The objective is:

> **Do not minimize context blindly. Minimize irrelevant context.**

---

# 10. Builder Dispatch

Node creates a Builder Task Package:

```text
task_id
role = builder
commit_id
objective
architecture_scope
rules
allowed_change_areas
acceptance_criteria
relevant_context
test_policy
workspace_policy
```

Builder then implements directly in the target project workspace.

The project filesystem remains the implementation source of truth.

---

# 11. Builder Verification

Builder runs the required focused checks:

```text
FOCUSED
+
syntax checks
+
git diff --check
```

Builder creates:

```text
builder-report.md
```

and optionally:

```text
changes.diff
```

Builder then reports completion to Node.

Node does not trust an Agent's textual claim alone.

---

# 12. Node Verification

This is a major responsibility of Node.

Node runs deterministic verification independently where possible.

Recommended escalation:

```text
FOCUSED
   ↓
RELATED
   ↓
FULL
```

### Focused

Changed module/direct behavior.

### Related

Shared modules, contracts, public APIs, adjacent behavior.

### Full

Required:

- final Commit/Sprint integration gate;
- release/merge;
- broad regression risk;
- changes to shared contracts;
- dependency changes;
- public API changes;
- core Architecture changes unless explicit exception is approved.

---

# 13. Test Result Compression

Raw output:

```text
20,000 lines
```

must not automatically be sent to Builder/Reviewer.

Node transforms it into:

```json
{
  "status": "failed",
  "level": "focused",
  "failed_checks": 1,
  "failure": {
    "test": "runner timeout",
    "file": "test/runner/timeout.test.js",
    "line": 82,
    "category": "assertion",
    "summary": "Expected process termination after timeout"
  }
}
```

Only the relevant evidence is added to the next Agent context.

This is one of the main mechanisms for reducing token consumption.

---

# 14. Reviewer Dispatch

After the Builder handoff and required verification:

```text
Node
 ↓
Reviewer Task Package
```

Reviewer receives:

```text
Commit Contract
+
Architecture scope
+
Rules
+
Sprint decisions
+
Builder Report
+
Diff
+
Relevant source
+
Test evidence
+
Previous review findings
```

Reviewer does not need the entire project.

---

# 15. Reviewer Gate

Reviewer performs:

1. artifact consistency gate;
2. Commit/acceptance criteria review;
3. Architecture/decision review;
4. source/diff inspection;
5. focused/related test verification;
6. bug/regression review;
7. scope review;
8. Architecture compliance review.

Then exactly one:

```text
APPROVED
REQUEST_CHANGES
BLOCKED
```

---

# 16. Request Changes Loop

If Reviewer returns:

```text
REQUEST_CHANGES
```

Node routes the same Commit back to Builder.

```text
Builder
   ↓
Verification
   ↓
Reviewer
   ↓
REQUEST_CHANGES
   ↓
Builder
```

The next Commit remains locked.

Builder addresses only:

- concrete review findings;
- approved Commit scope.

The loop continues until:

```text
APPROVED
```

or:

```text
BLOCKED
```

---

# 17. Builder Request / Blocker

If Builder discovers that the Commit contract is insufficient:

```text
Builder
   ↓
builder-request.md
   ↓
Node
   ↓
Sprint Lead
```

If the request changes:

- scope;
- Architecture;
- API;
- dependency policy;
- acceptance criteria;

then Project Owner approval is required.

Node routes the request but does not invent the decision.

---

# 18. Opening the Next Commit

When Reviewer approves:

```text
Reviewer
   ↓
APPROVED
   ↓
Node
```

Node validates:

- correct Commit;
- review evidence;
- required tests;
- dependencies;
- specialist gates;
- state consistency.

Then:

```text
Node
 ↓
Sprint Lead coordination
 ↓
next eligible Commit
```

The next Commit is opened only when dependencies are approved.

Code completion alone does not unlock the next Commit.

---

# 19. Sprint Completion

After all required Commits are approved:

```text
All Commits APPROVED
        ↓
Final verification
        ↓
Sprint Report
        ↓
Project Owner
        ↓
SPRINT COMPLETED
```

Project Owner remains responsible for final Sprint closure.

---

# 20. File Watcher vs Node Observation

The previous Architecture explicitly rejected using a File Watcher as the workflow orchestrator.

That principle remains.

The distinction is:

### Not allowed

```text
File changed
   ↓
Watcher decides next Agent
```

### Allowed

```text
Filesystem/Git event
   ↓
Node observation layer
   ↓
State reconciliation
   ↓
Workflow engine
   ↓
Decision
```

The filesystem observer is an **input signal**, not the workflow authority.

---

# 21. Project Change Detection

Node may observe changes made by:

- Builder;
- human coder;
- external tool;
- Git operation;
- another automation process.

On change:

```text
Change detected
      ↓
Identify project
      ↓
Update structure/index
      ↓
Invalidate stale context
      ↓
Analyze affected Commit
      ↓
Run required verification
      ↓
Reconcile execution state
```

Node must not assume that every change originated from Builder.

---

# 22. Structure Index

Each target project has its own Forge-owned structure index.

Conceptually:

```text
<forge-data-root>/
└── projects/
    └── <target-project-fingerprint>/
        └── structure.md
```

The index is deterministic.

Node uses it for:

- context discovery;
- impact analysis;
- fast project navigation;
- bounded structure handoff.

It is not an Architecture decision engine.

---

# 23. Memory

Forge memory is divided conceptually into:

```text
Current authoritative state
        ↓
Current decisions
        ↓
Current review/verification evidence
        ↓
Historical project knowledge
        ↓
Conversation/history
```

Raw chat history must not be replayed blindly.

Node should retrieve only relevant historical knowledge.

Memory can help answer:

- Has this issue occurred before?
- Why was this design chosen?
- What failed previously?
- What workaround was accepted?
- What review finding keeps recurring?

Memory cannot override current Architecture or approved decisions.

---

# 24. Event Model

Node publishes structured execution events.

Examples:

```text
SPRINT_STARTED
COMMIT_READY
AGENT_DISPATCHED
AGENT_STARTED
AGENT_STREAM
AGENT_COMPLETED
FILE_CHANGED
INDEX_UPDATED
TEST_STARTED
TEST_COMPLETED
REVIEW_STARTED
REVIEW_COMPLETED
REQUEST_CHANGES
COMMIT_APPROVED
COMMIT_BLOCKED
DECISION_REQUIRED
OWNER_GATE_REQUIRED
NEXT_COMMIT_READY
SPRINT_COMPLETED
```

The UI subscribes to these events.

Agent streams can therefore be displayed without making the UI responsible for workflow interpretation.

---

# 25. UI Stream

The local Node server can provide:

```text
Agent process
      ↓
Node stream collector
      ↓
event normalization
      ↓
WebSocket/SSE
      ↓
Forge UI
```

The UI should display:

- active Agent;
- current Commit;
- current state;
- live output;
- verification;
- review findings;
- decisions;
- blockers.

The UI should not become the workflow authority.

---

# 26. Agent Context Firewall

Node acts as a context firewall.

```text
                 PROJECT
                    │
           ┌────────▼────────┐
           │       NODE      │
           │ Context Builder │
           └────────┬────────┘
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
     Builder     Reviewer    Arch Manager
```

Each role receives only:

- relevant files;
- relevant symbols;
- relevant Architecture;
- relevant rules;
- relevant evidence;
- relevant memory;
- relevant task contract.

This prevents unnecessary token consumption.

---

# 27. Agent Result Contract

Every Agent response must be normalized into a machine-readable result.

Common result fields:

```text
task_id
agent_role
result
summary
changed_files
risks
questions
evidence
```

Node validates the result against its schema before acting on it.

A malformed Agent response must not mutate workflow state.

---

# 28. Deterministic First, AI Second

Node decision priority:

```text
Deterministic rule
       ↓
Known state transition
       ↓
Known workflow policy
       ↓
Known verification result
       ↓
Known dependency graph
       ↓
Known historical evidence
       ↓
AI reasoning
       ↓
Human authority
```

AI should not be called merely because an Agent could technically answer something.

---

# 29. AI Orchestration Evolution

The architecture supports progressive intelligence.

## Level 1 — Deterministic Node

```text
State
Queue
Rules
Dependencies
Verification
```

## Level 2 — Context Intelligence

```text
Code Index
Memory Retrieval
Impact Analysis
Context Ranking
```

## Level 3 — AI Decision Support

```text
Failure Diagnosis
Architecture Reasoning
Replanning
Risk Classification
```

## Level 4 — Intelligent Orchestration

```text
Observe
→ Understand
→ Plan
→ Dispatch
→ Verify
→ Review
→ Learn
→ Replan
```

The AI layer remains constrained by Forge's Constitution and authority model.

---

# 30. Role Capability Model

Node should eventually discover Agent capabilities through manifests rather than hard-coding every Agent.

Example:

```json
{
  "role": "architecture-manager",
  "capabilities": [
    "architecture-analysis",
    "rfc-draft",
    "architecture-risk-analysis"
  ],
  "permissions": {
    "write_implementation": false,
    "approve_commit": false,
    "modify_frozen_architecture": false,
    "close_sprint": false
  }
}
```

Another:

```json
{
  "role": "builder",
  "capabilities": [
    "implementation",
    "test-authoring",
    "focused-verification"
  ],
  "permissions": {
    "write_implementation": true,
    "approve_commit": false,
    "review_code": false
  }
}
```

This allows future specialists without rewriting the orchestration engine.

---

# 31. Required Schema Families

The workflow should use schemas for machine-to-machine contracts.

Recommended:

```text
schemas/
├── role.schema.json
├── agent-manifest.schema.json
├── agent-capability.schema.json
├── task.schema.json
├── agent-task.schema.json
├── agent-result.schema.json
├── execution-state.schema.json
├── execution-event.schema.json
├── decision.schema.json
├── context-pack.schema.json
├── verification-result.schema.json
├── review-result.schema.json
├── specialist-gate.schema.json
├── human-decision.schema.json
└── sprint-plan.schema.json
```

The existing project schema set should be reconciled with these rather than duplicated.

---

# 32. Core Workflow Contract

The most important contract is:

```text
Project Owner
     ↓
Sprint Lead
     ↓
Node
     ↓
[optional Architecture Manager]
     ↓
Builder
     ↓
Node Verification
     ↓
Reviewer
     ↓
Node
     ↓
Sprint Lead coordination
     ↓
Next Commit
```

For an architecture-sensitive Commit:

```text
Sprint Lead
     ↓
Node
     ↓
Architecture Manager
     ↓
Project Owner gate if required
     ↓
Builder
     ↓
Node Verification
     ↓
Reviewer
```

For an ambiguous runtime decision:

```text
Node
 ↓
Decision Agent
 ↓
Node
 ↓
Project Owner if authority boundary is reached
```

---

# 33. Non-Negotiable Rules

1. Constitution remains the highest authority.
2. Project Owner remains final human authority.
3. Architecture remains law.
4. Sprint scope remains law.
5. Commit remains atomic.
6. Builder implements; Builder does not review.
7. Reviewer reviews; Reviewer does not implement.
8. Architecture Manager advises/gates architecture; it does not approve its own work.
9. Structure Indexer is deterministic infrastructure, not an AI role.
10. Node owns runtime orchestration.
11. Node does not silently redefine role authority.
12. Node validates Agent outputs before applying state transitions.
13. Deterministic verification is performed by Node where possible.
14. Raw test output is normalized before AI consumption.
15. Context is bounded per role.
16. Stale context must be invalidated.
17. Memory cannot override current authority.
18. File changes are observations, not workflow commands.
19. The UI is not the workflow authority.
20. Next Commit cannot start before dependency and review requirements are satisfied.
21. Architecture/API/dependency/scope changes require the appropriate approval.
22. Historical evidence must not silently overwrite current state.
23. Every meaningful workflow transition must be observable.
24. Workflow must be restartable from persisted state.
25. AI assists decisions; it does not bypass Forge's control model.

---

# 34. Final Architecture

Forge should evolve into:

```text
                         ┌─────────────────────┐
                         │    PROJECT OWNER    │
                         │   Human Authority   │
                         └──────────┬──────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │        NODE         │
                         │  Control / Runtime  │
                         │     Orchestrator    │
                         └──────────┬──────────┘
                                    │
          ┌─────────────────────────┼─────────────────────────┐
          │                         │                         │
          ▼                         ▼                         ▼
   Sprint Planning           Specialist Gates          System Services
          │                         │                         │
          ▼                         ▼                         ├─ Indexer
    Sprint Lead             Architecture Manager            ├─ Test Runner
          │                                                   ├─ Git Observer
          │                                                   ├─ Context Engine
          │                                                   ├─ State Manager
          │                                                   └─ Event Bus
          │
          ▼
       Builder
          │
          ▼
   Node Verification
          │
          ▼
      Reviewer
          │
          ▼
         Node
          │
     ┌────┼────┐
     ▼    ▼    ▼
   Next Retry Escalate
          │
          ▼
    Project Owner
```

The result is not:

> "Node becomes another Agent."

The intended model is:

> **Node becomes the control plane that coordinates specialized Agents, deterministic project services, persistent project state and eventually an AI reasoning layer.**

This preserves the existing Forge responsibilities while removing unnecessary Agent-driven orchestration and unnecessary context/token usage.
