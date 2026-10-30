<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
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

