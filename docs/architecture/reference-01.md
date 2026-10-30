<!-- Preserves original architecture reference lines 1–200 in their original order so repository documentation can be navigated in bounded files without losing historical design detail. -->
# Forge — Node.js Orchestrator Architecture V1.3
## Tổng hợp kiến trúc đã thống nhất trong cuộc trao đổi

> Mục tiêu: xây Forge như một hệ thống điều phối multi-agent, trong đó Agent tự do làm việc trực tiếp trên filesystem của project; Node.js là lớp quan sát, điều phối, kiểm chứng, chuẩn hóa context và stream dữ liệu về UI.

---

# 1. Nguyên tắc kiến trúc cốt lõi

Forge được chia thành các vai trò rõ ràng:

- **Agent**: suy luận, đọc code, viết code, sửa file, chạy lệnh khi cần.
- **Node.js**: orchestrator/infrastructure; theo dõi project, index code, chạy verification, chuẩn hóa dữ liệu, điều phối workflow, lưu history và stream về UI.
- **Reviewer**: đánh giá thay đổi dựa trên requirements, diff, rules và kết quả verification.
- **Filesystem**: source of truth của project.
- **Git**: nguồn dữ liệu thay đổi/version control.
- **Schema**: protocol và contract giữa các thành phần.
- **UI**: hiển thị state/event, không tự suy luận trạng thái hệ thống.

Nguyên tắc quan trọng:

> **Agent được tự do code trên project; Node.js quan sát project, duy trì Code Index, chạy verification, chuẩn hóa dữ liệu theo schema, điều phối workflow và chỉ đưa cho AI đúng context cần thiết.**

---

# 2. Node.js là Orchestrator

Node không làm AI và không thay Agent code.

Node phụ trách:

- Filesystem Watcher
- Code Index
- Git diff/change set
- Test Runner
- Build/Lint/Typecheck Runner
- Event Store
- Session History
- Context Engine
- Rule Engine
- Workflow Engine
- Project State
- Agent stream
- chuẩn hóa dữ liệu
- token/context budget
- timeout/cancel/retry
- điều phối Builder/Reviewer
- API/WebSocket cho UI

Mô hình:

```text
                    NODE.JS
                 ORCHESTRATOR
                       │
       ┌───────────────┼────────────────┐
       ▼               ▼                ▼
   FILE WATCHER    TEST RUNNER     CONTEXT ENGINE
       │               │                │
       ▼               ▼                ▼
   CODE INDEX       TEST RESULT     AI CONTEXT
       │                                │
       └──────────────┬─────────────────┘
                      ▼
               BUILDER / REVIEWER
```

---

# 3. Agent trực tiếp đọc/ghi project

Không cần biến mọi thao tác filesystem thành API call qua Node.

Agent có thể:

```text
read file
write file
create file
delete file
rename file
run command
```

Ví dụ:

```text
Builder
  ↓
Filesystem
  ↓
src/auth.js
```

Việc `writeFile()` không tạo token AI riêng.

Token chủ yếu phát sinh khi:

```text
đọc code vào context → input tokens
suy luận → model computation
tạo code → output tokens
```

Do đó không cần:

```text
Builder
  ↓
Node API: WRITE_FILE
  ↓
Node
  ↓
Filesystem
```

trừ khi cần sandbox/security đặc biệt.

---

# 4. Agent có được ghi vào project mà Node đang theo dõi không?

**Có.**

Node theo dõi project không có nghĩa Node khóa project.

Ví dụ:

```text
              PROJECT
                 │
        ┌────────┴────────┐
        ▼                 ▼
      AGENT              NODE
        │                 │
   đọc/ghi code        theo dõi
        │                 │
        ▼                 ▼
     FILESYSTEM ──────► EVENT
                         │
                         ▼
                     CODE INDEX
```

Agent ghi file:

```text
Builder
  ↓
write src/auth.js
  ↓
Filesystem
  ↓
Node Watcher
  ↓
MODIFY src/auth.js
  ↓
Re-index auth.js
```

Node không cần cấp phép từng lần Agent ghi file.

Điều kiện:

- Node chạy với user có quyền đọc/ghi cần thiết.
- Agent chạy với quyền filesystem phù hợp.
- OS/sandbox không chặn truy cập.

Node và Agent là các process độc lập cùng truy cập filesystem.

---

# 5. Phân quyền

Nên có ranh giới rõ:

## Agent

```text
PROJECT SOURCE
  src/          READ/WRITE
  tests/        READ/WRITE
  config        READ/WRITE theo policy

.forge/
  READ hạn chế
  WRITE không được tự ý
```

## Node

```text
PROJECT SOURCE
  READ
  WRITE chỉ khi workflow yêu cầu

.forge/
  READ/WRITE
```

