# ARCHITECTURE.md — trích riêng cho Sprint 2 (Project State & Session)

> File này là bản trích lọc từ `ARCHITECTURE.md` gốc, chỉ gồm các mục liên quan trực tiếp
> tới phạm vi Sprint 2 (`SPRINT_PLAN.md`): Project Registry, multi-project isolation,
> Session schema, `.forge/` layout đầy đủ, và quan hệ Commit↔Task (field `commit_id`).
> Đây KHÔNG phải bản thay thế `ARCHITECTURE.md` đầy đủ — chỉ là bản rút gọn để Builder
> không phải đọc lướt qua 65 mục để tìm phần liên quan Sprint 2. Số thứ tự mục (`# N.`)
> giữ nguyên như bản gốc để dễ đối chiếu ngược.

---

# 6. `.forge/` thuộc về Node

Mỗi project có state riêng.

Ví dụ:

```text
my-project/
├── src/
├── tests/
├── package.json
└── .forge/
    ├── index.db
    ├── history.db
    ├── events/
    ├── cache/
    └── state.json
```

Node có thể tự tạo `.forge/` khi mở project lần đầu.

`.forge/` nên là vùng Node-owned runtime state.

Agent không được tự ý sửa:

```text
.forge/index.db
.forge/history.db
.forge/state.json
```

---

# 7. Watcher phải ignore `.forge/`
-e
---

# 32. Session liên kết Agent và File

History nên biết Agent nào đã làm gì với file nào.

Ví dụ:

```text
SESSION #1042

Builder
 ├── read → auth.js
 ├── modified → auth.js
 ├── read → session.js
 └── modified → session.js

Reviewer
 ├── read → auth.js
 └── reviewed → diff
```

Có thể truy vấn:

> Tại sao file này bị thay đổi?

Node có lịch sử để trả lời.

---

# 33. SQLite cho state/history
-e
---

# 33. SQLite cho state/history

Có thể dùng:

```text
.forge/forge.db
```

với các bảng:

```text
projects
sessions
messages
events
file_changes
test_runs
agent_actions
context_requests
reviews
workflow_runs
```

Hoặc tách:

```text
.forge/
├── index.db
└── history.db
```

Tùy mức độ cần tách workload.

---

# 34. History retention
-e
---

# 35. Project Registry và multi-project

Một Forge instance có thể điều phối nhiều project:

```text
Forge
 │
 ├── Project A
 │   └── /work/wp-static
 │
 ├── Project B
 │   └── /work/forge
 │
 └── Project C
     └── /work/shop
```

Mỗi project có state riêng.

Khi switch project:

```text
stop watcher A
stop/handle active agents A
persist state A

load project B
load Code Index B
load Rules B
load Workflow B
start watcher B
```

Không được lẫn:

```text
Project A history
Project B history
Project A Code Index
Project B Code Index
```

---

# 36. Project ID
-e
---

# 36. Project ID

Mỗi project có ID:

```json
{
  "project_id": "wp-static-commerce",
  "root": "/workspace/wp-static-commerce"
}
```

Mọi session/event/test/review đều gắn:

```text
project_id
```

Agent process cũng phải gắn với Project ID.

Ví dụ:

```text
Builder #1
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

Node quản lý trạng thái project thế nào.

## 3. Schema

Task / Rule / Workflow / Context / Event / Result.

## 4. Filesystem Watch + Code Index

Cơ chế đồng bộ project state.

## 5. Failure/Recovery

Crash, timeout, cancel, retry, concurrent edits.

---

# 59. Những thứ nên để sau
-e
---

## 63.1. Quan hệ Commit ↔ Task — quyết định thiết kế bắt buộc phải chốt

`project/task.schema.json` (README, Sprint 2) đã là entity **runtime** Node quản lý trong
lúc thực thi. Roadmap/Sprint/Commit ở đây là **PLAN** — nếu để cả hai khái niệm tồn tại độc
lập, dễ chồng chéo ("Commit" và "Task" cùng mô tả 1 đơn vị công việc nhưng 2 schema khác
nhau, dữ liệu dễ lệch nhau).

**Quyết định:** Commit thuộc tầng PLAN (định nghĩa *"phải làm gì"*, viết trước khi chạy).
Task là tầng RUNTIME (định nghĩa *"đang làm đến đâu"*, Node tự sinh ra khi Commit Dispatcher
giao việc cho Builder). Một Commit khi được dispatch sẽ tạo **đúng 1** Task runtime tương
ứng; Task đó giữ thêm field tham chiếu ngược `commit_id` (optional trong
`project/task.schema.json`, bổ sung khi Builder code Sprint 2 — không thuộc phạm vi 3 schema
mới ở mục 63.3, không tạo schema Commit-runtime riêng để tránh nhân đôi khái niệm).

```text
ROADMAP (PLAN)                          RUNTIME
─────────────────                       ─────────────────
roadmap.json
  └── sprint
        └── commit ──── dispatch ────▶ task (project/task.schema.json)
                                           │ commit_id ──▶ trỏ ngược về commit
                                           ▼
                                       task.status / task.workflow_state
                                       (README — không đổi)
```

Commit **không** có `status` runtime riêng (không lặp lại `pending/active/...` như Task) —
tiến độ luôn đọc qua Task đã dispatch từ Commit đó. Điều này giữ đúng nguyên tắc "tách PLAN
khỏi STATE" ở mục 63.2 bên dưới: nếu Commit tự có `status`, `roadmap.json` sẽ lại lẫn state
vào plan — đúng lỗi mà README v1.2 và mục 12 (file_id) đã tránh cho các trường hợp khác.

## 63.2. Tách PLAN khỏi STATE

Không để `roadmap.json` chứa runtime state kiểu:

```json
{
  "status": "building",
  "attempt": 3,
  "review_status": "pending"
}
```

Layout `.forge/` (đã cập nhật ở mục 53):

```text
.forge/
├── roadmap/
│   └── roadmap.json        ← PLAN, có thể commit
│
└── runtime/
    └── state.json          ← RUNTIME (sprint-state, commit-state gộp chung file này,
                                không tạo thư mục state/ riêng — runtime/ đã tồn tại
                                sẵn từ mục 6/53, tránh nhân đôi khái niệm "vùng runtime")
```

- **Roadmap** nói: "phải làm gì".
- **State** (`runtime/state.json`) nói: "đang làm đến đâu".
- **Node** nói: "bây giờ phải làm gì" (suy ra từ 2 cái trên + Commit Dependency Resolver).

Phân tách này quan trọng để Forge resume sau crash, retry Builder, chạy lại verification,
hoặc chuyển project mà không sợ lẫn dữ liệu kế hoạch với dữ liệu tiến độ.
