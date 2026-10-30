<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->

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
