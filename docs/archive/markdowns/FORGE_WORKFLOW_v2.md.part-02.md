<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
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
