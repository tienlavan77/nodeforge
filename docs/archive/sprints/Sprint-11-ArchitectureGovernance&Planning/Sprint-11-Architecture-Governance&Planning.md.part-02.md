<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
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
