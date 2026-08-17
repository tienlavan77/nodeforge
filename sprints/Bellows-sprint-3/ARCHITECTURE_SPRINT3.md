# ARCHITECTURE — trích riêng cho Sprint 3 (Agent Protocol)

> Bản trích từ `ARCHITECTURE.md` gốc, chỉ gồm mục 3/4/5/6/29/40/41/42/44/45/52/58.1 — đủ để
> code Sprint 3 mà không cần đọc lại toàn bộ 61 mục. Đánh số mục giữ nguyên như bản gốc.

---

# 3. Agent trực tiếp đọc/ghi project

Không cần biến mọi thao tác filesystem thành API call qua Node.

Agent có thể: `read file / write file / create file / delete file / rename file / run command`.

```text
Builder
  ↓
Filesystem
  ↓
src/auth.js
```

Việc `writeFile()` không tạo token AI riêng. Token chủ yếu phát sinh khi đọc code vào context,
suy luận, và tạo code (output tokens). Do đó **không cần** proxy `Agent → Node API: WRITE_FILE →
Node → Filesystem`, trừ khi cần sandbox/security đặc biệt.

---

# 4. Agent có được ghi vào project mà Node đang theo dõi không?

**Có.** Node theo dõi project không có nghĩa Node khóa project.

```text
Builder → write src/auth.js → Filesystem → Node Watcher → MODIFY src/auth.js → Re-index auth.js
```

Node không cần cấp phép từng lần Agent ghi file. Điều kiện: Node chạy với user có quyền đọc/ghi
cần thiết; Agent chạy với quyền filesystem phù hợp; OS/sandbox không chặn truy cập. Node và Agent
là các process độc lập cùng truy cập filesystem.

---

# 5. Phân quyền

**Agent:** `src/`, `tests/` READ/WRITE; `config` READ/WRITE theo policy; `.forge/` READ hạn chế,
WRITE không được tự ý.

**Node:** project source READ, WRITE chỉ khi workflow yêu cầu; `.forge/` READ/WRITE.

**Human:** quyền theo filesystem/OS và project policy.

> Node không phải file proxy/gatekeeper. Node là: **Observer + Orchestrator + Verifier.**

(Đã hiện thực hoá thành `capability_scopes` trong `core/agent.schema.json` — Sprint 0, NF-007.)

---

# 6. `.forge/` thuộc về Node

Mỗi project có state riêng, `.forge/` là vùng Node-owned runtime state. Agent không được tự ý
sửa `.forge/index.db`, `.forge/history.db`, `.forge/state.json`.

(Đã hiện thực hoá ở Sprint 1 NF-017/022 và Sprint 2 NF-043.)

---

# 29. Agent Stream về UI

Node theo dõi stdout/stderr của Agent process:

```text
Agent
 ├── stdout
 └── stderr
       ↓
     Node.js
       ↓
   WebSocket/SSE
       ↓
      UI
```

UI có thể có 4 khung: Builder (realtime stream), Reviewer (realtime stream), Tester (test
output), Orchestrator (workflow/log).

> **Phạm vi Sprint 3:** chỉ tới bước Node capture + publish lên `internalBus`. WebSocket/SSE thật
> tới UI là Sprint 8 (Transport) — Sprint 3 chỉ đảm bảo dữ liệu sẵn sàng trên bus để cắm vào sau.

---

# 40. Agent Protocol

Builder/Reviewer nên giao tiếp với Node bằng protocol chuẩn, không phụ thuộc AI provider.

**Agent → Node** (Command): `session.start`, `context.request`, `task.status`, `test.request`,
`review.request`, `session.finish`.

**Node → Agent/UI** (Event): `context.ready`, `file.changed`, `test.started`, `test.finished`,
`review.requested`, `workflow.changed`.

Mục tiêu: `Builder = Codex | Claude | local LLM | custom agent` — Node không cần biết bên trong
Agent là model nào.

---

# 41. Request/Event identity

Mỗi command/event nên có: `event_id`, `request_id`, `session_id`, `project_id`, `timestamp`.

```json
{ "request_id": "REQ-12345", "project_id": "forge", "session_id": "SESSION-88" }
```

Giúp chống duplicate khi retry.

---

# 42. Idempotency

Nếu Node nhận cùng request hai lần (`test.request #123` gửi lặp), không nên vô tình thực hiện
hai workflow giống nhau nếu request đó phải idempotent. Node cần lưu request/event identity và
trạng thái xử lý.

---

# 44. Timeout / Cancel / Retry

Node cần quản lý process: `timeout / cancel / kill / retry`.

```text
Test → timeout → Node kill process → TEST_TIMEOUT → Builder
```

Agent timeout cũng phải có recovery path.

> **Phạm vi Sprint 3:** chỉ timeout/kill cơ bản khi spawn Agent process. Retry đầy đủ + crash
> recovery của chính Node là Sprint 9 (Hardening).

---

# 45. Concurrent modification

Nhiều actor có thể cùng sửa (`Builder A`, `Builder B`, `Human` → cùng `project/`). Node phải
phát hiện concurrent modification. Có thể có logical ownership (`Task #101 owns: src/auth.js`).
Nếu Agent khác muốn sửa cùng file → `resource already associated with Task #101`. Đây là
policy/workflow decision, không nhất thiết phải khóa file vật lý. **Node không nên âm thầm
overwrite thay đổi.**

> **Phạm vi Sprint 3:** chỉ phần nhận diện (ghi nhận file nào đang được task/session nào động
> vào) + phát warning. Xử lý policy đầy đủ (chặn/hàng đợi/báo lỗi) là quyết định của Workflow
> Engine — Sprint 6.

---

# 52. Nguyên tắc "không proxy filesystem"

Không nên biến Forge thành `Agent → Node → read/write API → Filesystem` cho mọi thao tác. Nên:
`Agent → Filesystem → Node Watcher → Index/Events`. Điều này giúp Agent làm việc tự nhiên như
developer bình thường.

---

# 58.1. Agent Protocol (trích mục 58 — 5 thứ cần chốt trước khi code Node)

> Agent ↔ Node nói chuyện bằng gì.

Đây là hợp đồng quan trọng nhất về mặt thiết kế (đứng đầu danh sách 5 thứ cần chốt) — nhưng như
đã phân tích ở `SPRINT_PLAN.md` (mục "Vì sao thứ tự sprint lệch so với thứ tự liệt kê ở mục 58"),
thứ tự **code** hợp lý đặt Schema/Watcher/Index/State trước, Agent Protocol sau — vì protocol
này bản chất serialize qua Schema (Sprint 0) và cần Project State (Sprint 2, đặc biệt Session)
đã tồn tại để liên kết `session_id`.
