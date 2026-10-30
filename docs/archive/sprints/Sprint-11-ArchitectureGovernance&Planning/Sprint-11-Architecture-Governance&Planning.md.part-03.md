<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
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

