<!-- Preserves original architecture reference lines 2017–2174 in their original order so repository documentation remains navigable in bounded files without losing historical design detail. -->
# 57. Kiến trúc multi-project

```text
                         FORGE
                           │
                     ┌─────▼─────┐
                     │   NODE    │
                     │           │
                     │ Project   │
                     │ Registry  │
                     └─────┬─────┘
                           │
                 ┌─────────┴─────────┐
                 ▼                   ▼
            PROJECT A            PROJECT B
                 │                   │
          ┌──────┼──────┐      ┌─────┼─────┐
          ▼      ▼      ▼      ▼     ▼     ▼
        Index  Rules  History Index Rules History
          │      │      │      │     │     │
          └──────┴──────┘      └─────┴─────┘
                 │                   │
              Builder             Builder
              Reviewer            Reviewer
```

Một Forge instance có thể mở nhiều project nhưng mỗi project có state độc lập.

---

# 58. Năm thứ cần chốt trước khi code Node

Nếu bắt đầu implementation, ưu tiên chốt:

## 1. Agent Protocol

Agent ↔ Node nói chuyện bằng gì.

## 2. Project State

Node quản lý trạng thái project thế nào.

## 3. Schema

Task / Rule / Workflow / Context / Event / Result.

## 4. Filesystem Watch + Code Index

Cơ chế đồng bộ project state.

## 5. Failure/Recovery

Crash, timeout, cancel, retry, concurrent edits.

---

# 59. Những thứ nên để sau

Không cần giải quyết ngay:

- UI quá phức tạp
- quá nhiều loại Agent
- provider-specific optimization
- advanced memory
- fancy visualization
- distributed deployment

Trước hết phải làm chắc:

```text
Filesystem
Watcher
Index
Schema
State
History
Test
Workflow
Agent Protocol
Context normalization
```

---

# 60. Kết luận kiến trúc

Forge không nên là một tập hợp prompt nối với nhau.

Forge nên là:

> **Protocol-driven multi-agent orchestration system.**

Trong đó:

```text
Agent
= intelligence / coding / reasoning

Node.js
= observation / orchestration / verification / normalization

Filesystem
= source of truth

Git
= version/change truth

Code Index
= structured code map

History
= audit trail

Rules
= constraints

Workflow
= state machine

Context Engine
= token firewall

UI
= visualization
```

Mục tiêu cuối:

```text
Agent tự do code
        ↓
Filesystem thay đổi
        ↓
Node phát hiện
        ↓
Code Index cập nhật
        ↓
Context được chuẩn hóa
        ↓
Node chạy verification
        ↓
Test Result
        ↓
Reviewer
        ↓
Approve / Changes Required
        ↓
Builder
        ↓
...
```

**Một nguyên tắc xuyên suốt:**

> Không bắt AI làm việc mà Node có thể làm rẻ và xác định được; không bắt Node thay AI suy luận những thứ chỉ AI nên quyết định.

---

