<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
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
