<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
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
