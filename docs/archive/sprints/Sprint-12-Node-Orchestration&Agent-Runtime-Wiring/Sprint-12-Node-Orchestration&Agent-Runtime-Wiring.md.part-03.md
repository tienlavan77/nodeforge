<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
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
