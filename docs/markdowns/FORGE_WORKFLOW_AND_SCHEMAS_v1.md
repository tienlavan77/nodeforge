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

Tasks are represented as a dependency graph rather than a mandatory
linear sequence.

``` text
       C01
      /       C02   C03
      \   /
       C04
```

Node may execute C02 and C03 in parallel when: - dependencies permit; -
workspace/resources do not conflict; - architecture constraints
permit; - verification policy permits.

------------------------------------------------------------------------

## 5. Context and Memory

Context pipeline:

``` text
Project Architecture
        ↓
Sprint Architecture Scope
        ↓
Task Architecture Scope
        ↓
Code Index + Dependencies
        ↓
Relevant Rules
        ↓
Relevant Memory
        ↓
Verification/Review Evidence
        ↓
Agent Task Package
```

Memory is historical knowledge, not current authority.

Priority:

``` text
Current Architecture
>
Current Rules
>
Current Task State
>
Current Evidence
>
Current Decisions
>
Relevant Memory
>
Raw History
```

Context must be invalidated/refreshed when relevant files, architecture,
rules, dependencies, or assumptions change.

------------------------------------------------------------------------

# 6. Verification and Token Efficiency

Rules: 1. Never send the whole repository when bounded context is
sufficient. 2. Normalize test failures before sending them to AI. 3.
Reuse context while its fingerprint remains valid. 4. Retrieve relevant
memory instead of replaying all history. 5. Use deterministic Node
operations before AI calls. 6. Prefer focused tests before broad tests
when risk allows. 7. Give Reviewer diff + relevant context rather than
the entire project. 8. Keep Builder and Reviewer context role-specific.

------------------------------------------------------------------------

# 7. Decision Agent

Decision Agent augments Node; it does not replace Node.

``` text
Node
 ├─ deterministic decision → execute
 └─ ambiguous → Decision Agent → structured decision → Node
```

Decision output must contain: - proposed action; - evidence; -
confidence; - assumptions; - unresolved questions.

Node validates it before applying it.

------------------------------------------------------------------------

# 8. Agent Responsibilities

  Component        Responsibility
  ---------------- --------------------------------------------------------
  Node             observe, plan, resolve, dispatch, verify, state, route
  Builder          implement code
  Reviewer         judge implementation
  Decision Agent   reason about ambiguity
  Memory           preserve/retrieve project knowledge
  Code Index       map project structure
  Architecture     define system constraints
  Roadmap          define intended work
  Schemas          define machine contracts
  Git              change/history truth
  Filesystem       current implementation truth

------------------------------------------------------------------------

# 9. Core Schemas

Recommended files:

``` text
schemas/
├── task.schema.json
├── agent-task.schema.json
├── agent-result.schema.json
├── execution-state.schema.json
├── decision.schema.json
├── verification-result.schema.json
├── review-result.schema.json
├── context-pack.schema.json
└── execution-event.schema.json
```

## 9.1 task.schema.json

Defines planned executable work.

``` json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "forge/task.schema.json",
  "type": "object",
  "required": ["task_id", "title", "objective", "acceptance_criteria", "status"],
  "properties": {
    "task_id": {"type": "string"},
    "title": {"type": "string"},
    "objective": {"type": "string"},
    "sprint_id": {"type": "string"},
    "priority": {"enum": ["critical", "high", "normal", "low"]},
    "dependencies": {"type": "array", "items": {"type": "string"}},
    "architecture_scope": {"type": "array", "items": {"type": "string"}},
    "acceptance_criteria": {"type": "array", "items": {"type": "string"}, "minItems": 1},
    "risk": {"enum": ["low", "medium", "high", "critical"]},
    "status": {
      "enum": ["planned", "ready", "blocked", "running", "verifying", "reviewing", "approved", "failed", "cancelled"]
    }
  },
  "additionalProperties": false
}
```

## 9.2 agent-task.schema.json

Defines the bounded package sent by Node.

``` json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "forge/agent-task.schema.json",
  "type": "object",
  "required": ["task_id", "agent_role", "objective", "context", "constraints", "acceptance_criteria"],
  "properties": {
    "task_id": {"type": "string"},
    "agent_role": {"enum": ["builder", "reviewer", "decision"]},
    "objective": {"type": "string"},
    "architecture_scope": {"type": "array", "items": {"type": "string"}},
    "context": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["type", "reference"],
        "properties": {
          "type": {
            "enum": ["file", "symbol", "diff", "architecture", "rule", "memory", "decision", "verification", "review"]
          },
          "reference": {"type": "string"},
          "summary": {"type": "string"}
        },
        "additionalProperties": false
      }
    },
    "constraints": {"type": "array", "items": {"type": "string"}},
    "acceptance_criteria": {"type": "array", "items": {"type": "string"}},
    "workspace": {
      "type": "object",
      "properties": {
        "root": {"type": "string"},
        "write_allowed": {"type": "boolean"},
        "allowed_paths": {"type": "array", "items": {"type": "string"}}
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}
```

## 9.3 agent-result.schema.json

Common Agent result envelope.

``` json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "forge/agent-result.schema.json",
  "type": "object",
  "required": ["task_id", "agent_role", "result", "summary"],
  "properties": {
    "task_id": {"type": "string"},
    "agent_role": {"enum": ["builder", "reviewer", "decision"]},
    "result": {
      "enum": ["completed", "failed", "blocked", "needs_changes", "approved", "rejected", "escalate"]
    },
    "summary": {"type": "string"},
    "changed_files": {"type": "array", "items": {"type": "string"}},
    "risks": {"type": "array", "items": {"type": "string"}},
    "questions": {"type": "array", "items": {"type": "string"}},
    "evidence": {"type": "array", "items": {"type": "string"}}
  },
  "additionalProperties": false
}
```

## 9.4 execution-state.schema.json

Authoritative Node runtime state.

``` json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "forge/execution-state.schema.json",
  "type": "object",
  "required": ["project_id", "state", "updated_at"],
  "properties": {
    "project_id": {"type": "string"},
    "sprint_id": {"type": "string"},
    "task_id": {"type": "string"},
    "state": {
      "enum": [
        "idle", "planned", "ready", "dispatched", "running", "handoff",
        "verifying", "reviewing", "approved", "blocked", "failed",
        "escalated", "cancelled", "completed"
      ]
    },
    "active_agent": {"enum": ["builder", "reviewer", "decision", "none"]},
    "attempt": {"type": "integer", "minimum": 0},
    "updated_at": {"type": "string", "format": "date-time"},
    "reason": {"type": "string"}
  },
  "additionalProperties": false
}
```

## 9.5 decision.schema.json

Node/Decision Agent decision contract.

``` json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "forge/decision.schema.json",
  "type": "object",
  "required": ["decision_id", "action", "basis", "confidence"],
  "properties": {
    "decision_id": {"type": "string"},
    "action": {
      "enum": ["continue", "dispatch", "retry", "verify", "review", "request_changes", "block", "escalate", "skip", "complete"]
    },
    "basis": {"type": "array", "items": {"type": "string"}},
    "evidence": {"type": "array", "items": {"type": "string"}},
    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
    "assumptions": {"type": "array", "items": {"type": "string"}},
    "requires_human": {"type": "boolean"}
  },
  "additionalProperties": false
}
```

## 9.6 verification-result.schema.json

Normalized deterministic verification result.

``` json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "forge/verification-result.schema.json",
  "type": "object",
  "required": ["task_id", "status", "checks"],
  "properties": {
    "task_id": {"type": "string"},
    "status": {"enum": ["passed", "failed", "skipped", "blocked"]},
    "level": {"enum": ["focused", "related", "full"]},
    "checks": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name", "status"],
        "properties": {
          "name": {"type": "string"},
          "status": {"enum": ["passed", "failed", "skipped"]},
          "duration_ms": {"type": "integer", "minimum": 0},
          "summary": {"type": "string"}
        },
        "additionalProperties": false
      }
    },
    "failures": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["summary"],
        "properties": {
          "summary": {"type": "string"},
          "file": {"type": "string"},
          "line": {"type": "integer", "minimum": 1},
          "category": {"type": "string"},
          "evidence_ref": {"type": "string"}
        },
        "additionalProperties": false
      }
    }
  },
  "additionalProperties": false
}
```

## 9.7 review-result.schema.json

Reviewer verdict.

``` json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "forge/review-result.schema.json",
  "type": "object",
  "required": ["task_id", "verdict", "summary"],
  "properties": {
    "task_id": {"type": "string"},
    "verdict": {"enum": ["approved", "request_changes", "blocked"]},
    "summary": {"type": "string"},
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["severity", "summary"],
        "properties": {
          "severity": {"enum": ["critical", "high", "medium", "low"]},
          "summary": {"type": "string"},
          "file": {"type": "string"},
          "line": {"type": "integer", "minimum": 1},
          "required_change": {"type": "string"}
        },
        "additionalProperties": false
      }
    },
    "risks": {"type": "array", "items": {"type": "string"}}
  },
  "additionalProperties": false
}
```

## 9.8 context-pack.schema.json

Context selected by Node.

``` json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "forge/context-pack.schema.json",
  "type": "object",
  "required": ["task_id", "role", "items"],
  "properties": {
    "task_id": {"type": "string"},
    "role": {"enum": ["builder", "reviewer", "decision"]},
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["type", "reference", "relevance"],
        "properties": {
          "type": {
            "enum": ["source", "symbol", "diff", "architecture", "rule", "memory", "decision", "verification", "review"]
          },
          "reference": {"type": "string"},
          "summary": {"type": "string"},
          "relevance": {"type": "number", "minimum": 0, "maximum": 1},
          "fingerprint": {"type": "string"}
        },
        "additionalProperties": false
      }
    },
    "budget": {
      "type": "object",
      "properties": {
        "max_items": {"type": "integer", "minimum": 1},
        "max_tokens": {"type": "integer", "minimum": 1}
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}
```

## 9.9 execution-event.schema.json

Event stream for Node/UI/audit.

``` json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "forge/execution-event.schema.json",
  "type": "object",
  "required": ["event_id", "event_type", "timestamp"],
  "properties": {
    "event_id": {"type": "string"},
    "event_type": {
      "enum": [
        "task_created", "task_ready", "task_dispatched",
        "agent_started", "agent_output", "agent_completed",
        "file_changed", "index_updated",
        "verification_started", "verification_completed",
        "review_started", "review_completed",
        "decision_created", "state_changed",
        "blocked", "escalated", "task_completed"
      ]
    },
    "timestamp": {"type": "string", "format": "date-time"},
    "task_id": {"type": "string"},
    "agent_role": {"enum": ["builder", "reviewer", "decision", "node"]},
    "payload_ref": {"type": "string"},
    "summary": {"type": "string"}
  },
  "additionalProperties": false
}
```

------------------------------------------------------------------------

# 10. End-to-End Example

``` text
Roadmap / Sprint Plan
        ↓
Node builds Execution Graph
        ↓
Node determines eligible task
        ↓
Node resolves architecture + rules + code + memory
        ↓
Node creates Agent Task Package
        ↓
Builder
        ↓
Filesystem changes
        ↓
Node detects + indexes changes
        ↓
Node runs focused verification
        ├── FAIL → normalized failure → Builder
        ↓ PASS
Node creates Review Package
        ↓
Reviewer
        ├── REQUEST_CHANGES → Builder
        ↓ APPROVED
Node updates execution state
        ↓
Node resolves next eligible task
        ↓
repeat
```

------------------------------------------------------------------------

# 11. Migration Rule

The previous workflow should **not** be patched into the new
architecture.

Replace this:

``` text
Agent reads roadmap
Agent reads status
Agent decides next step
Agent writes status
Agent runs tests
Agent interprets raw output
```

with this:

``` text
Node reads plan
Node builds execution graph
Node owns runtime state
Node builds context
Node dispatches bounded task
Node observes filesystem
Node verifies
Node normalizes evidence
Node collects review
Node decides next action
```

Existing roadmap, sprint, history, and other artifacts may remain as
persistent records, but they are no longer the direct control interface
for Agents.

------------------------------------------------------------------------

# 12. Final Principle

> **Forge is a deterministic project orchestration system with an AI
> reasoning layer --- not an AI agent that happens to orchestrate a
> project.**

The architecture should therefore evolve toward:

``` text
                 FORGE NODE
                     |
          deterministic foundation
                     |
       +-------------+-------------+
       |             |             |
     State         Graph         Index
       |             |             |
    Verify         Rules        Memory
       |             |             |
       +-------------+-------------+
                     |
              Intelligent Layer
                     |
                Decision AI
                     |
          +----------+----------+
          |                     |
       Builder               Reviewer
```

This preserves agent specialization while making Node the control plane,
context firewall, verification engine, and future intelligent
orchestrator.
