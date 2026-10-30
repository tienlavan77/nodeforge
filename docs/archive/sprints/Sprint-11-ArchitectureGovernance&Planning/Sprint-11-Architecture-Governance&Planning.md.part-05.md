<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
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

