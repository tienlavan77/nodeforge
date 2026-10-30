<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
# Sprint 12 — Node Orchestration & Agent Runtime Wiring

## Status

PLANNED

---

# 1. Sprint Goal

Hoàn thiện việc đấu nối các Agent Governance vào Node Runtime thực tế.

Sprint 11 đã xây:

- Architecture Manager
- Sprint Leader
- Communication Store
- Communication Bus
- Ticket Provenance
- Governance Rules
- Runtime Persistence
- Governance E2E

Sprint 12 chuyển các thành phần đó từ:

```text
Module / Contract / Test
```

thành:

```text
Node Runtime Components
```

Mục tiêu cuối:

```text
Project Owner
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

---

# 2. Architecture Principles

## Principle 01

Project Owner là Human.

Không đưa Project Owner vào Agent Runtime.

---

## Principle 02

Node là trung tâm orchestration.

Node chịu trách nhiệm:

- nhận request
- persist request
- dispatch Agent
- nhận Agent result
- persist result
- chuyển workflow sang bước tiếp theo

---

## Principle 03

Architecture Manager và Sprint Leader không giao tiếp trực tiếp.

Tất cả communication:

```text
Agent
 ↓
Node Communication Bus
 ↓
Agent
```

---

## Principle 04

Filesystem/Git vẫn là Source of Truth cho source code.

Builder và Reviewer vẫn được phép làm việc trực tiếp với repository.

Không sandbox filesystem trong Sprint 12.

---

## Principle 05

Node là Source of Truth cho:

- Governance
- Planning
- Communication
- Runtime State
- Audit
- Recovery
- Memory

---

# 3. Sprint 12 Scope

Sprint 12 tập trung vào:

1. Node Agent Registry
2. Agent Bootstrap
3. Governance Orchestrator
4. Project Owner Request Intake
5. Architecture Manager dispatch
6. Sprint Leader dispatch
7. Runtime dispatch
8. Persistent Agent Sessions
9. Agent Result Routing
10. Full operational E2E

Không mở rộng:

- Architecture design mới
- Sandbox filesystem
- LLM integration
- Distributed agents
- Multi-node deployment

---

# 4. Dependency Order

```text
NF-126 Agent Registry
        ↓
NF-127 Agent Bootstrap
        ↓
NF-128 Node Governance Orchestrator
        ↓
NF-129 Project Owner Request Intake
        ↓
NF-130 Architecture Manager Runtime Adapter
        ↓
NF-131 Sprint Leader Runtime Adapter
        ↓
NF-132 Agent Result Router
        ↓
NF-133 Persistent Agent Session Composition
        ↓
NF-134 Full Node Operating Loop
```

---

# 5. NF-126 — Agent Registry

## Goal

Tạo registry chính thức để Node biết các Agent đang được đăng ký.

Agents:

- architecture-manager
- sprint-leader
- runtime
