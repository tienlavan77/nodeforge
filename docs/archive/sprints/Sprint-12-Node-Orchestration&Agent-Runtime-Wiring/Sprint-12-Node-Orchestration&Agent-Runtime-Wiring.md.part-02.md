<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
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

