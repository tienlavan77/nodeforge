<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
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
