# Sprint 11 — Governance & Planning Layer

## Status

**SPRINT 11 — COMPLETED**

```text
14 / 14 tickets PASS
```

---

# 1. Sprint Goal

Xây dựng tầng Governance & Planning phía trên Runtime, đồng thời giữ nguyên kiến trúc filesystem/Git hiện hành.

Sprint 11 hoàn thiện:

- Architecture Manager
- Architecture Decision Store
- Architecture Knowledge Model
- Roadmap Store
- Sprint Plan Projection
- Governance Dependency Graph
- Governance Rules Engine
- Agent Communication Store
- Agent Communication Bus
- Ticket Provenance
- Sprint Leader Planner
- Persistent Runtime Composition
- Governance End-to-End

---

# 2. Architecture Principles

## Principle 01 — Source Code

Filesystem/Git là Source of Truth cho:

- Source Code
- Repository State
- Git Commit
- Working Tree

Node không thay thế Git.

---

## Principle 02 — Node Governance Source of Truth

Node là Source of Truth cho:

- Architecture
- Architecture Decisions
- Standards
- Constraints
- Roadmaps
- Sprint Plans
- Tickets
- Communications
- Events
- History
- Memory
- Runtime State
- Recovery State
- Audit Data

---

## Principle 03 — Agent Communication

Mọi communication giữa Agents phải đi qua Node.

Không Agent nào được giao tiếp trực tiếp với Agent khác.

---

## Principle 04 — Filesystem Access

Giữ nguyên Architecture hiện hành.

Builder và Reviewer vẫn được phép:

- đọc filesystem
- sửa source code
- tạo file
- chạy tooling
- commit code

Sprint 11 KHÔNG sandbox filesystem.

---

## Principle 05 — Agent Result

Sau mỗi Ticket, Agent phải báo cáo về Node:

- commit_id
- changed_files
- execution_summary
- status
- review_result

Node lưu metadata để phục vụ:

- Audit
- History
- Memory
- Recovery

---

# 3. Target Operating Model

```text
Project Owner (Human)
        ↓
       Node
        ↓
Architecture Manager
        ↓
       Node
        ↓
Sprint Leader
        ↓
       Node
        ↓
Agent Runtime
        ↓
       Node
        ↓
Builder
        ↓
       Node
        ↓
Reviewer
        ↓
       Node
```

Project Owner là con người, không phải Agent.

Architecture Manager và Sprint Leader không giao tiếp trực tiếp.

---

# 4. Governance Schema Layer

Các Governance Principles phải được materialize thành schema.

Directory:

```text
schemas/governance/
```

Contracts:

```text
architecture-decision.schema.json
roadmap.schema.json
sprint-plan.schema.json
ticket.schema.json
agent-message.schema.json
ticket-completion.schema.json
governance-rule.schema.json
```

NF-114A đã hoàn tất:

```text
41 schemas
61 fixtures
```

---

# 5. Final Ticket Dependency

```text
NF-114A Governance Schemas
        ↓
NF-113 Architecture Decision Store
        ↓
NF-114 Architecture Knowledge Model
        ↓
NF-115 Roadmap Store
        ↓
NF-116 Sprint Plan Projection
        ↓
NF-117 Governance Dependency Graph
        ↓
NF-120 Governance Rules Engine
        ↓
NF-122 Agent Communication Store
        ↓
NF-123 Agent Communication Bus
        ↓
NF-118 Architecture Manager
        ↓
NF-124 Ticket Provenance Tracking
        ↓
NF-119 Sprint Leader Planner
        ↓
NF-125 Persistent Runtime Composition
        ↓
NF-121 Governance End-to-End
```

---

# 6. Ticket Results

## NF-114A — Governance Schemas

**Status: PASS**

Commit:

```text
d916002 NF-114A PASS: add governance schemas
```

Đã thêm 7 governance contracts:

- Architecture Decision
- Roadmap
- Sprint Plan
- Ticket
- Agent Message
- Ticket Completion
- Governance Rule

Validation:

```text
41 schemas / 61 fixtures
```

---

## NF-113 — Architecture Decision Store

**Status: PASS**

Commit:

```text
81cc13d NF-113 PASS: persist Architecture Decisions in Node
```

Đã kiểm chứng:

- Append-only
- getById()
- getByType()
- getAll()
- Insert order
- Invalid decision reject
- Duplicate ID reject
- Input immutability

---

## NF-114 — Architecture Knowledge Model

**Status: PASS**

Commit:

```text
4f6b604 NF-114 PASS: add Architecture Knowledge Model
```

Đã kiểm chứng:

- getArchitecture()
- getStandards()
- getConstraints()
- getDecisions()
- Deterministic projection
- Classification theo decision.type
- Không mutate source

---

## NF-115 — Roadmap Store

**Status: PASS**

Commit:

```text
f32d74c NF-115 PASS: store canonical Roadmap versions
```

Đã kiểm chứng:

- Canonical Roadmap
- Append-only versioning
- Multiple versions
- getCurrent()
- getVersion()
- getAllVersions()
- Invalid roadmap reject
- Duplicate version reject
- Input immutability

Nguyên tắc:

```text
Roadmap Store
= Canonical Source of Truth
```

---

## NF-116 — Sprint Plan Projection

**Status: PASS**

Commit:

```text
074009f NF-116 PASS: add Sprint Plan projection
```

Đã kiểm chứng:

- Current Sprint
- Sprint by ID
- Sprint backlog
- Sprint status
- Deterministic projection
- Không mutate Roadmap
- Không tạo persistence mới
- Không tạo Source of Truth thứ hai

Nguyên tắc:

```text
Roadmap
= Canonical Data

Sprint Plan Projection
= Read Model
```

---

## NF-117 — Governance Dependency Graph

**Status: PASS**

Commit:

```text
c8a518b NF-117 PASS: add Governance Dependency Graph
```

Graph quản lý:

```text
Roadmap
↓
Sprint
↓
Ticket
↓
Commit
```

Không phải code dependency graph.

Đã kiểm chứng:

- Dependency tracking
- Dependent tracking
- Cycle detection
- Deterministic execution order

---

## NF-120 — Governance Rules Engine

**Status: PASS**

Commit:

```text
ff459c4 NF-120 PASS: add Governance Rules Engine
```

Đã kiểm chứng:

- Rule validation
- registerRule()
- evaluate()
- getRules()
- ALLOW
- DENY
- Deterministic ordering
- Immutability

Governance Rules được schema-driven.

---

## NF-122 — Agent Communication Store

**Status: PASS**

Commit:

```text
0e3e1c1 NF-122 PASS: add Agent Communication Store
```

Đã kiểm chứng:

- append()
- getById()
- getAll()
- getBySender()
- getByReceiver()
- getByCorrelationId()
- Invalid message reject
- Duplicate message ID reject
- Input immutability

---

## NF-123 — Agent Communication Bus

**Status: PASS**

Commit:

```text
1e3f30b NF-123 PASS: add Agent Communication Bus
```

Đã kiểm chứng:

- send()
- subscribe()
- unsubscribe()
- Persist trước dispatch
- Multiple subscribers
- Unsubscribe
- Invalid message reject
- Duplicate delivery prevention
- Deterministic dispatch

Regression:

```text
17/17 governance tests pass
```

---

## NF-118 — Architecture Manager

**Status: PASS**

Commit:

```text
c1edf3b NF-118 PASS: add Architecture Manager
```

Architecture Manager có khả năng tạo deterministic:

- Architecture Plan
- Roadmap
- Sprint Breakdown

Đồng thời:

- lưu Architecture Decisions
- lưu Roadmap
- publish qua Communication Bus

Không giao tiếp trực tiếp với Agent khác.

Không code.

Flow:

```text
Project Owner
      ↓
Node
      ↓
Architecture Manager
      ↓
Node
```

---

## NF-124 — Ticket Provenance Tracking

**Status: PASS**

Commit:

```text
11bffac NF-124 PASS: add Ticket Provenance Tracking
```

Enforce chain:

```text
Architecture Decision
        ↓
Roadmap
        ↓
Sprint
        ↓
Ticket
```

Đã kiểm chứng:

- Full provenance
- Missing ancestor reject
- Orphan ticket reject
- Deterministic provenance
- Input immutability

---

## NF-119 — Sprint Leader Planner

**Status: PASS**

Commit:

```text
28d6a0f NF-119 PASS: add Sprint Leader Planner
```

Flow:

```text
Node
 ↓
Sprint Leader
 ↓
Node
```

Đã kiểm chứng:

- Chọn Sprint hiện hành
- Sinh Ticket
- Provenance hợp lệ
- Deterministic priority
- Publish qua Communication Bus
- Chống publish lặp

Regression:

```text
16/16 tests pass
```

Sprint Leader KHÔNG:

- gọi Builder trực tiếp
- gọi Reviewer trực tiếp
- gọi Runtime trực tiếp

---

## NF-125 — Persistent Runtime Composition

**Status: PASS**

Commit:

```text
37d1aeb NF-125 PASS: compose Runtime Service with persistence
```

Runtime Service không còn giữ session authority trong Map.

Runtime sử dụng:

- Persistent Event Store
- Agent Session Store
- Runtime Recovery
- Event Replay

Khi process khởi động:

```text
Persistent Session Store
        ↓
Runtime Recovery
        ↓
Event Replay
        ↓
Runtime State
```

Đã kiểm chứng:

- RUNNING survive restart
- PAUSED survive restart
- Bootstrap từ persistence
- Recovery
- Event Replay

Regression:

```text
9/9 runtime/recovery/Sprint 10 tests pass
```

---

## NF-121 — Governance End-to-End

**Status: PASS**

Commit:

```text
1cf2991 NF-121 PASS: verify Governance end-to-end flow
```

Đã chứng minh:

```text
Architecture Manager
        ↓
Node
        ↓
Sprint Leader
```

và:

```text
Builder
        ↓
Node Bus
        ↓
Reviewer
```

Đã kiểm chứng:

- Architecture Manager → Node → Sprint Leader
- Ticket provenance đầy đủ
- Builder/Reviewer communication qua Node Bus
- Communication audit
- Event replay
- Runtime recovery sau restart

Regression:

```text
26/26 tests pass
```

---

# 7. Final Governance Flow

```text
Project Owner (Human)
        ↓
       Node
        ↓
Architecture Manager
        ↓
       Node
        ↓
Sprint Leader
        ↓
       Node
        ↓
Agent Runtime
        ↓
       Node
        ↓
Builder
        ↓
       Node
        ↓
Reviewer
        ↓
       Node
```

Không Agent nào nói chuyện trực tiếp với Agent khác.

Node là communication hub.

---

# 8. Source of Truth Model

## Filesystem / Git

Source of Truth cho:

```text
Source Code
Repository
Commits
Working Tree
```

## Node

Source of Truth cho:

```text
Architecture
Architecture Decisions
Standards
Constraints
Roadmaps
Sprint Plans
Tickets
Communications
Events
History
Memory
Runtime State
Recovery State
Audit
```

---

# 9. Runtime Persistence

Runtime Service không được xem in-memory Map là authority.

Canonical runtime state:

```text
Session Store
      +
Persistent Event Store
      +
Recovery
      +
Event Replay
```

Runtime có thể sử dụng memory/cache cho execution nhưng không được mất state khi process restart.

---

# 10. Ticket Provenance

Mọi Ticket phải truy vết được:

```text
Project Owner Request
        ↓
Architecture Decision
        ↓
Roadmap
        ↓
Sprint
        ↓
Ticket
        ↓
Commit
```

Không cho phép orphan Ticket.

---

# 11. Communication Audit

Mọi communication quan trọng phải được Node lưu:

```text
sender
receiver
message_type
payload
timestamp
correlation_id
```

Communication phải:

- Persist
- Queryable
- Auditable
- Replayable

---

# 12. Agent Filesystem Policy

Sprint 11 KHÔNG thay đổi filesystem access.

Builder và Reviewer vẫn được phép trực tiếp:

```text
Read Repository
      ↓
Modify Code
      ↓
Run Tests
      ↓
Git Commit
```

Sau đó:

```text
Commit
 ↓
Node
```

Node lưu commit metadata.

Việc sandbox filesystem là một Architecture Decision riêng trong tương lai nếu cần.

---

# 13. Sprint 11 Final Status

```text
NF-114A ✅ PASS
NF-113  ✅ PASS
NF-114  ✅ PASS
NF-115  ✅ PASS
NF-116  ✅ PASS
NF-117  ✅ PASS
NF-120  ✅ PASS
NF-122  ✅ PASS
NF-123  ✅ PASS
NF-118  ✅ PASS
NF-124  ✅ PASS
NF-119  ✅ PASS
NF-125  ✅ PASS
NF-121  ✅ PASS

14 / 14 COMPLETED
```

---

# 14. Sprint 11 Outcome

Sprint 11 đã hoàn thiện tầng:

```text
Governance
Planning
Communication
Provenance
Runtime Persistence
```

Architecture Manager đã được đưa vào Governance Flow.

Sprint Leader đã được đưa vào Planning Flow.

Node trở thành trung tâm:

```text
Planning
+
Communication
+
Audit
+
Memory
+
Recovery
+
Runtime State
```

Trong khi:

```text
Filesystem/Git
=
Source of Truth cho Source Code
```

---

# 15. Final Project Operating Model

```text
                  PROJECT OWNER
                     HUMAN
                       │
                       ▼
                     NODE
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
ARCHITECTURE MANAGER          SPRINT LEADER
          │                         │
          └────────────┬────────────┘
                       ▼
                     NODE
                       │
                       ▼
                AGENT RUNTIME
                       │
                       ▼
                     NODE
                       │
              ┌────────┴────────┐
              ▼                 ▼
           BUILDER           REVIEWER
              │                 │
              └────────┬────────┘
                       ▼
                     NODE
```

**Sprint 11 — COMPLETED.**

# Core Principles

## Principle 01

Filesystem/Git là Source of Truth cho source code.

Bao gồm:

- Source files
- Repository state
- Git commits
- Working tree

Node không thay thế Git.

---

## Principle 02

Node là Source of Truth cho:

- Architecture
- Architecture Decisions
- Standards
- Constraints
- Roadmaps
- Sprint Plans
- Tickets
- Communications
- Events
- History
- Memory
- Runtime State
- Recovery State
- Audit Data

---

## Principle 03

Mọi giao tiếp giữa các Agent phải đi qua Node.

Không Agent nào được giao tiếp trực tiếp với Agent khác.

---

## Principle 04

Agent vẫn được phép:

- đọc repository
- sửa code
- tạo file
- chạy tooling
- commit code

Giữ nguyên theo ARCHITECTURE.md hiện tại.

---

## Principle 05

Sau mỗi Ticket hoàn thành:

Agent phải publish về Node:

- commit_id
- changed_files
- execution_summary
- status
- review_result

để phục vụ:

- audit
- history
- memory
- recovery

---

## Principle 06

Mọi quyết định quan trọng phải được persist.

Bao gồm:

- Owner Requests
- Architecture Decisions
- Roadmap Changes
- Sprint Plans
- Ticket Dispatches
- Builder Results
- Reviewer Decisions