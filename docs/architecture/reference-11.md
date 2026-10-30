<!-- Preserves original architecture reference lines 1826–2016 in their original order so repository documentation remains navigable in bounded files without losing historical design detail. -->
# 52. Nguyên tắc "không proxy filesystem"

Không nên biến Forge thành:

```text
Agent
 ↓
Node
 ↓
read/write API
 ↓
Filesystem
```

cho mọi thao tác.

Nên:

```text
Agent ─────────► Filesystem
                  │
                  ▼
             Node Watcher
                  │
                  ▼
            Index / Events
```

Điều này giúp Agent làm việc tự nhiên như developer bình thường.

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

Node nên theo dõi cả:

```text
Filesystem
+
Git
```

Ví dụ:

```text
filesystem says:
auth.js modified

git says:
M src/auth.js
```

Node có thể tạo `Project Change Set`:

```json
{
  "modified": ["src/auth.js"],
  "added": [],
  "deleted": [],
  "untracked": []
}
```

Reviewer dùng:

```text
Change Set + Git Diff + Test Result + Rules
```

---

# 55. Nguyên tắc source of truth

Có thứ tự rõ:

```text
Filesystem
    ↓
source of truth

Git
    ↓
version/change truth

Code Index
    ↓
structured cache

History/Event Store
    ↓
audit truth

Project State
    ↓
orchestration truth

UI
    ↓
visualization only
```

---

# 56. Kiến trúc tổng thể

```text
                         FORGE
                           │
                    ┌──────▼──────┐
                    │    NODE     │
                    │ ORCHESTRATOR│
                    └──────┬──────┘
                           │
       ┌───────────────────┼───────────────────┐
       │                   │                   │
       ▼                   ▼                   ▼
 File Watcher         Code Index          Test Runner
       │                   │                   │
       └───────────────────┼───────────────────┘
                           │
                    Context Engine
                           │
                    Rule + Workflow
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
           BUILDER                  REVIEWER
              │                         │
              └──────────┬──────────────┘
                         ▼
                    FILESYSTEM
                         │
                         ▼
                     WATCHER
                         │
                        LOOP
```

---

