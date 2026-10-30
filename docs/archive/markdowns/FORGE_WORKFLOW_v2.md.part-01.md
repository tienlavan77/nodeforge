<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
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

