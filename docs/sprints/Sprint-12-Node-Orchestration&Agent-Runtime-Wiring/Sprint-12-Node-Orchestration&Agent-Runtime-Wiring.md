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
- builder
- reviewer

## Deliverable

```text
src/modules/agent/agent-registry.js
tests/unit/agent-registry.test.js
```

## Requirements

Hỗ trợ:

- register(agent)
- unregister(id)
- get(id)
- has(id)
- list()

Registry phải deterministic.

## Acceptance

- Register Agent
- Reject duplicate Agent
- Lookup Agent
- List Agent
- Không mutate input

---

# 6. NF-127 — Agent Bootstrap

## Goal

Node bootstrap toàn bộ Agent cần thiết.

## Deliverable

```text
src/modules/agent/agent-bootstrap.js
tests/integration/agent-bootstrap.test.js
```

Bootstrap phải đăng ký:

```text
Architecture Manager
Sprint Leader
Agent Runtime
Builder
Reviewer
```

Tất cả dependency phải dùng implementation hiện tại.

Không tạo implementation mới.

## Acceptance

- Node startup đăng ký đầy đủ Agent
- Dependency được inject đúng
- Communication Bus được dùng chung
- Store được dùng chung
- Không duplicate Agent

---

# 7. NF-128 — Node Governance Orchestrator

## Goal

Tạo orchestration layer chính của Node.

## Deliverable

```text
src/modules/governance/governance-orchestrator.js
tests/integration/governance-orchestrator.test.js
```

## Flow

```text
Owner Request
      ↓
Architecture Manager
      ↓
Roadmap
      ↓
Sprint Leader
      ↓
Tickets
      ↓
Agent Runtime
```

## Requirements

Orchestrator phải:

- nhận request
- dispatch Architecture Manager
- nhận architecture result
- dispatch Sprint Leader
- nhận tickets
- dispatch Runtime

Không cho Agent gọi Agent trực tiếp.

---

# 8. NF-129 — Project Owner Request Intake

## Goal

Tạo entry point chính thức cho Project Owner.

Project Owner là Human.

## Deliverable

```text
src/application/owner-request-service.js
tests/unit/owner-request-service.test.js
```

## Requirements

Owner Request phải:

- có request_id
- persist vào Node
- có timestamp
- có correlation_id
- có status
- có audit trail

Flow:

```text
Project Owner
      ↓
Node
      ↓
Owner Request Store
```

## Acceptance

- Request được persist
- Duplicate request reject
- Request có correlation ID
- Request replay được

---

# 9. NF-130 — Architecture Manager Runtime Adapter

## Goal

Đưa Architecture Manager vào Agent Runtime lifecycle.

## Deliverable

```text
src/modules/governance/architecture-manager-adapter.js
tests/integration/architecture-manager-adapter.test.js
```

Adapter phải:

- nhận request từ Node
- gọi Architecture Manager
- persist result
- publish result về Node

Không gọi Sprint Leader trực tiếp.

## Acceptance

```text
Node
 ↓
Architecture Manager
 ↓
Node
```

hoạt động thực tế.

---

# 10. NF-131 — Sprint Leader Runtime Adapter

## Goal

Đưa Sprint Leader vào Runtime lifecycle.

## Deliverable

```text
src/modules/governance/sprint-leader-adapter.js
tests/integration/sprint-leader-adapter.test.js
```

Flow:

```text
Node
 ↓
Sprint Leader
 ↓
Node
```

Sprint Leader phải:

- đọc Sprint Projection
- generate Tickets
- validate provenance
- publish Tickets
- trả kết quả về Node

Không gọi Runtime trực tiếp.

---

# 11. NF-132 — Agent Result Router

## Goal

Node định tuyến kết quả Agent về đúng workflow.

## Deliverable

```text
src/modules/agent/agent-result-router.js
tests/unit/agent-result-router.test.js
```

Router phải xử lý:

- architecture.completed
- sprint.plan.completed
- ticket.completed
- review.completed
- agent.failed

## Acceptance

- Result đúng workflow
- Unknown result reject
- Duplicate result không tạo side effect
- Deterministic routing
- Audit đầy đủ

---

# 12. NF-133 — Persistent Agent Session Composition

## Goal

Đảm bảo Governance Agents cũng có lifecycle persistence.

Các session phải survive restart.

## Agents

- Architecture Manager
- Sprint Leader
- Runtime
- Builder
- Reviewer

## Requirements

Persist:

- agent_id
- session_id
- workflow_id
- status
- timestamps
- correlation_id

Khi Node restart:

```text
Persistent Session Store
        ↓
Recovery
        ↓
Agent Registry
        ↓
Agent Runtime
```

## Acceptance

- RUNNING session recover
- PAUSED session recover
- COMPLETED không recover
- FAILED không recover
- Không duplicate execution

---

# 13. NF-134 — Full Node Operating Loop

## Goal

Xác minh toàn bộ operating loop thực tế.

## Integration Test

```text
tests/integration/node-operating-loop-e2e.test.js
```

## Scenario

### Step 1

Project Owner gửi:

```text
Build Project X
```

### Step 2

Node persist Owner Request.

### Step 3

Node dispatch Architecture Manager.

### Step 4

Architecture Manager tạo:

- Architecture Decision
- Architecture
- Roadmap
- Sprint Breakdown

### Step 5

Node persist tất cả.

### Step 6

Node dispatch Sprint Leader.

### Step 7

Sprint Leader:

- chọn Sprint
- tạo Tickets
- validate provenance
- prioritize backlog

### Step 8

Node persist Tickets.

### Step 9

Node dispatch Agent Runtime.

### Step 10

Runtime dispatch Builder.

### Step 11

Builder:

- đọc repository
- code
- test
- commit

### Step 12

Builder trả:

- commit_id
- changed_files
- status

về Node.

### Step 13

Node dispatch Reviewer.

### Step 14

Reviewer trả:

- approve
- reject

về Node.

### Step 15

Node cập nhật:

- Ticket
- Sprint
- Workflow
- History
- Memory

### Step 16

Node lưu toàn bộ Communication.

### Step 17

Restart Node.

### Step 18

Verify:

- Runtime state
- Agent sessions
- Event history
- Communication history
- Recovery state

được khôi phục.

---

# 14. Quality Gates

Mỗi Ticket phải chạy:

```text
Test mới
+
Test liên quan
+
Lint
+
Typecheck
+
Schema Validation
+
git diff --check
```

Không chỉ chạy test riêng của Ticket.

Đặc biệt các ticket integration phải chạy regression:

```text
Sprint 9 Recovery
Sprint 10 Transport
Sprint 11 Governance
```

---

# 15. Forbidden Scope

Sprint 12 KHÔNG làm:

- Sandbox filesystem
- Cấm Builder đọc repository
- LLM integration
- Distributed Node
- Multi-node cluster
- Agent-to-Agent direct communication
- Thay đổi Event schema nếu không bắt buộc
- Thay đổi Session lifecycle NF-088
- Thay đổi Git workflow

---

# 16. Exit Criteria

Sprint 12 chỉ PASS khi:

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

hoạt động bằng implementation thật.

Ngoài ra:

- Owner Request được persist
- Architecture được persist
- Roadmap được persist
- Sprint Plan được persist
- Ticket provenance được enforce
- Agent communication được persist
- Agent sessions được persist
- Runtime state được persist
- Builder commit được lưu
- Reviewer result được lưu
- Memory được cập nhật
- Recovery hoạt động
- Event replay hoạt động
- Không Agent-to-Agent direct communication
- Không regression Sprint 9
- Không regression Sprint 10
- Không regression Sprint 11

---

# 17. Final Target

Sau Sprint 12:

```text
                    PROJECT OWNER
                        HUMAN
                          │
                          ▼
                        NODE
                          │
             ┌────────────┴────────────┐
             ▼                         ▼
      ARCHITECTURE                 SPRINT
        MANAGER                    LEADER
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
                  ┌───────┴───────┐
                  ▼               ▼
               BUILDER         REVIEWER
                  │               │
                  └───────┬───────┘
                          ▼
                         NODE
```

Node là:

- Communication Hub
- Governance Hub
- Planning Hub
- Runtime State Hub
- Audit Hub
- Recovery Hub

Filesystem/Git vẫn là:

```text
Source of Truth
for Source Code
```

---

# Sprint 12 Success Definition

Sprint 11 đã xây "các bộ phận".

Sprint 12 phải chứng minh:

```text
Các bộ phận đó thực sự được Node bootstrap,
được Node điều phối,
được Node lưu trạng thái,
và có thể chạy qua một operating loop hoàn chỉnh.
```