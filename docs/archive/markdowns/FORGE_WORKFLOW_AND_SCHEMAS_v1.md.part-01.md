<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
# Forge --- WORKFLOW & CORE SCHEMAS v1

## 1. Purpose

Forge is a **Node-orchestrated software engineering system**.

Node is responsible for: - observing the project; - maintaining
execution state; - resolving eligible work; - selecting and assembling
context; - dispatching bounded work to agents; - validating agent
results; - running deterministic verification; - deciding workflow
transitions; - preserving execution evidence; - escalating ambiguous
decisions to an AI decision layer.

Agents remain specialist executors: - **Builder:** implements code
within the supplied task contract. - **Reviewer:** evaluates
implementation against the supplied review contract. - **Decision
Agent:** reasons about ambiguity, conflicts, architecture uncertainty,
or cases Node cannot safely resolve deterministically.

> **Core rule:** Agents execute bounded responsibilities. Node owns
> orchestration, state transitions, context delivery, verification, and
> workflow decisions.

------------------------------------------------------------------------

## 2. New Workflow

The old Agent-driven workflow is replaced by a Node-owned decision loop.

``` text
PLAN
  ↓
OBSERVE
  ↓
UNDERSTAND
  ↓
RESOLVE
  ↓
DISPATCH
  ↓
EXECUTE
  ↓
VERIFY
  ↓
DECIDE
  ├── NEXT TASK
  ├── RETRY
  ├── REQUEST CHANGES
  ├── BLOCK
  ├── ESCALATE
  └── COMPLETE
```

### PLAN

Node reads roadmap/sprint planning information and converts it into an
internal **Execution Graph**.

Roadmap is planning input, not runtime authority.

### OBSERVE

Node watches: - filesystem; - Git; - agent output; - tests; -
processes; - execution events; - code index; - persisted state.

Node must also detect changes made by human developers or external
tools.

### UNDERSTAND

Node combines deterministic project knowledge:

``` text
Architecture
+ Rules
+ Code Index
+ Dependencies
+ Execution Graph
+ Current State
+ Verification Evidence
+ Relevant Memory
+ Git Diff
```

Deterministic sources are preferred before AI reasoning.

### RESOLVE

Node determines: - which task is eligible; - relevant architecture
scope; - relevant files/symbols; - dependencies; - rules; - acceptance
criteria; - relevant memory; - previous failures/reviews; - verification
requirements.

The goal is **minimum sufficient context**, not minimum context.

### DISPATCH

Node creates an **Agent Task Package**.

Builder receives: - task; - architecture scope; - rules; - acceptance
criteria; - relevant context; - workspace policy; - verification
expectations.

Reviewer receives: - review target; - architecture scope; - acceptance
criteria; - rules; - diff; - relevant source; - verification evidence; -
builder result; - relevant memory.

Agents do not need to read the entire roadmap, sprint plan, or runtime
state.

### EXECUTE --- BUILDER

Builder: 1. implements the requested change; 2. stays within approved
scope; 3. writes project files; 4. reports changed files; 5. reports
risks/questions; 6. returns a structured Builder Result.

Builder must not: - approve itself; - advance workflow; - activate
another task; - rewrite roadmap; - bypass verification; - silently
expand scope.

### EXECUTE --- REVIEWER

Reviewer: 1. evaluates correctness; 2. checks architecture compliance;
3. checks scope compliance; 4. checks test adequacy; 5. identifies
defects/risks; 6. returns a structured Review Result.

Reviewer does not control workflow state.

### VERIFY

Verification is primarily Node responsibility.

Recommended order:

``` text
FOCUSED → RELATED → FULL
```

Node can run: - syntax/type checks; - lint; - unit/focused/related/full
tests; - dependency checks; - schema checks; - generated-artifact
checks.

Raw terminal output is normalized before being sent to agents.

### DECIDE

Node chooses:

``` text
CONTINUE
RETRY
REQUEST_CHANGES
REVIEW
BLOCK
ESCALATE
SKIP
COMPLETE
```

AI is invoked only for ambiguous/high-risk reasoning.

------------------------------------------------------------------------

## 3. State Ownership

Node is the **single authoritative writer of runtime execution state**.

Correct:

``` text
Builder → Builder Result → Node → Execution State
Reviewer → Review Result → Node → Execution State
```

Incorrect:

``` text
Builder ─────┐
Reviewer ────┼→ status.json
Sprint Lead ─┤
Node ────────┘
```

Roadmap remains a plan. Persistent state remains an audit/recovery
artifact. Runtime transitions are owned by Node.

------------------------------------------------------------------------

## 4. Execution Graph

