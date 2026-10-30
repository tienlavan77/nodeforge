<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
  project_id = wp-static

Reviewer #1
  project_id = wp-static

Builder #2
  project_id = forge
```

Đảm bảo:

```text
Builder A → Project A filesystem
Builder B → Project B filesystem
```

Không được vô tình ghi project khác khi switch.

---

# 37. Rules và Workflow theo project
-e
---

# 37. Rules và Workflow theo project

Project A có:

```text
rules A
workflows A
```

Project B có:

```text
rules B
workflows B
```

Global rules có thể áp dụng cho tất cả.

Cấu trúc:

```text
GLOBAL
  ↓
PROJECT
  ↓
TASK
```

---

# 38. Project State
-e
---

# 38. Project State

Forge nên có object trung tâm:

```text
ProjectState
```

Ví dụ:

```json
{
  "project": "wp-static-commerce",
  "git": {},
  "index": {},
  "active_tasks": [],
  "agents": [],
  "tests": {},
  "workflow": {},
  "changes": {}
}
```

Node luôn biết project hiện tại đang ở trạng thái nào.

UI hiển thị state này.

---

# 39. UI không phải source of truth
-e
---

# 53. Cấu trúc `.forge/` đề xuất

Một hướng tổ chức:

```text
project/
├── src/
├── tests/
├── package.json
│
└── .forge/
    ├── schemas/
    │   ├── task.schema.json
    │   ├── rule.schema.json
    │   ├── workflow.schema.json
    │   ├── context.schema.json
    │   ├── event.schema.json
    │   └── result.schema.json
    │
    ├── rules/
    │   ├── architecture.json
    │   ├── coding.json
    │   ├── testing.json
    │   └── review.json
    │
    ├── workflows/
    │   └── build-review.json
    │
    ├── roadmap/                  # PLAN — xem mục 63
    │   └── roadmap.json
    │
    └── runtime/                  # STATE — xem mục 63
        ├── index.db
        ├── history.db
        ├── state.json             # gồm cả sprint-state/commit-state, không tách folder riêng
        ├── events/
        └── cache/
```

Runtime data can be gitignored:

```text
.forge/runtime/
```

Rules/Workflow/Roadmap may be committed because they are project configuration/plan —
runtime là phần duy nhất chứa state, không tách thêm thư mục `state/` riêng (xem mục 63 vì
sao `state.json` trong `runtime/` đã đủ).

---

# 54. Git
-e
---

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
-e
---

# 58. Năm thứ cần chốt trước khi code Node

Nếu bắt đầu implementation, ưu tiên chốt:

## 1. Agent Protocol

Agent ↔ Node nói chuyện bằng gì.

## 2. Project State

