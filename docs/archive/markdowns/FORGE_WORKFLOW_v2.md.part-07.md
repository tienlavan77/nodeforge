<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->

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
