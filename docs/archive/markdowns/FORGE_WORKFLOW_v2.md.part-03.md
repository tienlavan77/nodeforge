<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
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
