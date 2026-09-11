# ARCHITECTURE.md — trích riêng cho Sprint 3 (Agent Protocol)

> File này là bản trích lọc từ `ARCHITECTURE.md` gốc, chỉ gồm các mục liên quan trực tiếp
> tới phạm vi Sprint 3 (`SPRINT_PLAN.md`): Agent tự do đọc/ghi filesystem, phân quyền,
> Agent Protocol (vocabulary command/event), Request/Event identity, Idempotency,
> Timeout/Cancel/Retry, Concurrent modification, nguyên tắc "không proxy filesystem".
> Đây KHÔNG phải bản thay thế `ARCHITECTURE.md` đầy đủ. Số thứ tự mục giữ nguyên như bản gốc.
>
> **Lưu ý ranh giới sprint quan trọng:** mục 43 (Crash recovery) trích ở đây chỉ để tham
> khảo thiết kế — logic phục hồi crash **đầy đủ** thuộc Sprint 9 (Hardening: Failure &
> Recovery), Sprint 3 chỉ cần đảm bảo Request/Event identity (mục 41) đủ nền tảng để Sprint 9
> dùng lại, không tự implement crash recovery ở đây. Tương tự, mục 29 (Agent Stream về UI)
> nhắc tới WebSocket/SSE — đó là Sprint 8 (Transport); Sprint 3 chỉ cần đưa stream qua
> `internalBus` nội bộ (như đã làm ở Sprint 1, NF-023), không tự dựng WebSocket server.

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
-e
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

## Human

Có quyền theo filesystem/OS và project policy.

Node không phải file proxy/gatekeeper. Node là:

> Observer + Orchestrator + Verifier

---

# 6. `.forge/` thuộc về Node
-e
---

# 29. Agent Stream về UI

Node theo dõi stdout/stderr của Agent process:

```text
Agent
 │
 ├── stdout
 └── stderr
       ↓
     Node.js
       ↓
   WebSocket/SSE
       ↓
      UI
```

UI có thể có 4 khung:

```text
┌──────────────────┬──────────────────┐
│ Builder           │ Reviewer         │
│ realtime stream   │ realtime stream  │
├──────────────────┼──────────────────┤
│ Tester            │ Orchestrator     │
│ test output       │ workflow/log     │
└──────────────────┴──────────────────┘
```

---

# 30. Lưu toàn bộ lịch sử Agent
-e
---

# 39. UI không phải source of truth

UI chỉ nhận event/state từ Node.

Ví dụ:

```text
Builder started
File changed
Index updated
Test started
Test failed
Builder resumed
Test passed
Reviewer started
Review changes requested
Builder resumed
Review approved
```

Node là source of truth.

UI là visualization.

---

# 40. Agent Protocol
-e
---

# 40. Agent Protocol

Builder/Reviewer nên giao tiếp với Node bằng protocol chuẩn, không phụ thuộc AI provider.

Ví dụ Agent → Node:

```text
session.start
context.request
task.status
test.request
review.request
session.finish
```

Node → Agent/UI:

```text
context.ready
file.changed
test.started
test.finished
review.requested
workflow.changed
```

Mục tiêu:

```text
Builder = Codex
Builder = Claude
Builder = local LLM
Builder = custom agent
```

Node không cần biết bên trong Agent là model nào.

---

# 41. Request/Event identity

Mỗi command/event nên có:

```text
event_id
request_id
session_id
project_id
timestamp
```

Ví dụ:

```json
{
  "request_id": "REQ-12345",
  "project_id": "forge",
  "session_id": "SESSION-88"
}
```

Điều này giúp chống duplicate khi retry.

---

# 42. Idempotency
-e
---

# 42. Idempotency

Nếu Node nhận cùng request hai lần:

```text
test.request #123
test.request #123
```

không nên vô tình thực hiện hai workflow giống nhau nếu request đó phải idempotent.

Node cần lưu request/event identity và trạng thái xử lý.

---

# 43. Crash recovery
-e
---

# 43. Crash recovery

Nếu Node chết:

```text
Builder
   │
   ▼
Node
   X CRASH
```

Project không được hỏng.

Khi Node khởi động lại:

```text
load .forge/state
↓
load Code Index
↓
verify index
↓
scan changes
↓
reconstruct state
↓
resume workflow nếu hợp lệ
```

Filesystem vẫn là source of truth.

---

# 44. Timeout / Cancel / Retry
-e
---

# 44. Timeout / Cancel / Retry

Node cần quản lý process:

```text
timeout
cancel
kill
retry
```

Ví dụ test:

```text
Test
 ↓
timeout
 ↓
Node kill process
 ↓
TEST_TIMEOUT
 ↓
Builder
```

Agent timeout cũng phải có recovery path.

---

# 45. Concurrent modification

Nhiều actor có thể cùng sửa:

```text
Builder A ──┐
Builder B ──┼──► project/
Human ──────┘
```

Node phải phát hiện concurrent modification.

Có thể có logical ownership:

```text
Task #101
  owns:
    src/auth.js
    tests/auth.test.js
```

Nếu Agent khác muốn sửa cùng file:

```text
resource already associated with Task #101
```

Đây là policy/workflow decision, không nhất thiết phải khóa file vật lý.

Node không nên âm thầm overwrite thay đổi.

---

# 46. Secrets
-e
---

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

# 66.6–66.8. Cập nhật sau đối chiếu FORGE_WORKFLOW_v2.md (Sprint Lead là Agent, routing qua Node)

> Bổ sung sau khi Sprint 3 "Bridge" đã triển khai phần lớn (NF-047→053 Done) — 3 mục dưới
> đây trích từ `ARCHITECTURE.md` mục 66.6/66.7/66.8, ảnh hưởng trực tiếp tới NF-054 (còn
> Backlog) và NF-058 (schema `agent-manifest`, Sprint 0 mở lại lần 2).

## 66.6. Sprint Lead là Agent spawn qua Agent Protocol — không phải role thụ động

Làm rõ: **Sprint Lead nhận nhiệm vụ từ Node, trả kết quả về cho Node điều phối tiếp tới
Builder/Reviewer** — cùng cơ chế NDJSON stdin/stdout qua Agent Protocol (NF-048) như
Builder/Reviewer, không phải vai trò "đứng ngoài" chỉ đọc tài liệu. Hệ quả:

- `agent-manifest.schema.json` (NF-058) áp dụng cho **Builder, Reviewer, và Sprint Lead** —
  cả 3 đều spawn process thật.
- **Chưa chốt:** Architecture Manager có spawn qua Agent Protocol giống 3 role trên hay
  không, hay hoạt động theo cơ chế khác (vd. 1 gate/specialist function bên trong Node, không
  phải process riêng). Cần quyết định trước khi NF-058 code xong phần Architecture Manager.
- Chỉ **Project Owner** chắc chắn không spawn process (con người, final authority) — dùng
  `role.schema.json` (NF-057) là đủ, không cần manifest.

## 66.7. Enforcement là reactive (chặn tiến độ), KHÔNG phải preventive (chặn hành động)

Trả lời câu hỏi "làm sao ngăn Agent tự do làm ngoài vai trò": kiến trúc hiện tại **không**
chặn Agent ghi file ngoài phạm vi ngay lúc xảy ra — đúng nguyên tắc đã ghi từ đầu
(*"Agent không bị Node khóa filesystem. Node chỉ quan sát và điều phối"*, kết luận cuối
`ARCHITECTURE.md`; mục 3/4/52 — Agent ghi trực tiếp, không qua `WRITE_FILE` API của Node).
**Xác nhận từ Project Owner:** giữ nguyên nguyên tắc này — không đổi sang sandbox OS-level.

Cơ chế guardrail thật sự là **reactive**, chặn ở tầng *tiến độ workflow* chứ không chặn ở
tầng *hành động*:
- Context Firewall (Sprint 5) — giảm khả năng lạc đề bằng cách không cho Agent thấy thứ
  ngoài phạm vi, không phải chặn ghi.
- `allowed_change_areas` + `WF-005` (đã có schema, Rule Engine đọc ở Sprint 5) — đối chiếu
  diff **sau khi** Agent đã ghi.
- Workflow gate (Reviewer duyệt, `WF-004`) — Commit không tiến được sang `APPROVED` nếu vi
  phạm, không phải ngăn hành động vi phạm xảy ra.
- **Kết quả/đánh giá giữa các Agent bắt buộc đi qua Node** (mục 66.8) — Builder ghi code
  trực tiếp (không đổi), nhưng Reviewer đọc code rồi trả **verdict qua Node** (Event có cấu
  trúc, `results/review-result.schema.json`), không viết file trung gian (`review.md` kiểu
  cũ) cho Agent khác đọc. Loại bỏ hẳn kênh giao tiếp Agent↔Agent ngoài Node.

## 66.8. Kết quả luôn qua Node; vòng lặp Node ↔ Sprint Leader ↔ Builder/Reviewer

**Nguyên tắc routing kết quả (xác nhận từ Project Owner):** Agent không còn giao tiếp trực
tiếp với nhau qua file trung gian (đúng lý do khiến workflow cũ thất bại — `COMMIT.md`/
`status.json`/`builder-report.md`/`review.md` là kênh Agent↔Agent ngoài tầm kiểm soát Node).
Builder ghi **code** trực tiếp (sản phẩm thật, không đổi). Mọi **kết quả/đánh giá** (review
verdict, tiến độ, findings) đi qua Node dưới dạng Command/Event có cấu trúc (Agent Protocol,
NF-048), validate được, Node lưu/điều phối tiếp — không có file "handoff" nào giữa 2 Agent.

**Vòng lặp Sprint Leader — Node tự động yêu cầu Sprint mới khi Sprint hiện tại hoàn tất:**

```
Node (theo dõi tiến độ Sprint hiện tại qua Task/Commit status)
   │  Sprint hoàn tất
   ▼
Node → Sprint Leader (Agent, spawn qua Agent Protocol giống Builder/Reviewer — mục 66.6)
   │  Command: "lập kế hoạch Sprint tiếp theo"
   ▼
Sprint Leader → Node
   │  Event: payload khớp roadmap/sprint.schema.json + commit.schema.json
   │  (ĐÃ CÓ SẴN từ Sprint 0 — NF-033–035, không cần schema mới)
   ▼
Node dispatch Commit đầu tiên của Sprint mới cho Builder → lặp lại chu trình
```

**Việc cần làm khi tới Sprint 6 (Workflow Engine) — ghi nhận, không code ngay:** thêm đúng 1
cặp Command/Event mới vào vocabulary Agent Protocol (mục 40, 12 verb hiện có chưa có verb
nào cho việc này) cho hành động "yêu cầu lập Sprint mới" / "trả về kế hoạch Sprint mới" —
chốt tên theo đúng quy trình đã dùng ở NF-047b (tên chốt trước khi code, domain nối tiếp
`sprints.*`/`roadmap.*` đã có, không phát minh casing mới).

**Việc cần sửa ngay ở Sprint 3 (NF-054 vẫn đang Backlog, chưa Done):** integration test hiện
tại chỉ test luồng kiểu Builder ("ghi file thật"). Cần bổ sung luồng kiểu Reviewer (đọc file,
trả verdict qua Node, KHÔNG viết file trung gian) trước khi coi NF-054 hoàn chỉnh — xem cập
nhật ticket bên dưới.

---
