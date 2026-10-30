<!-- Preserves original architecture reference lines 1466–1641 in their original order so repository documentation remains navigable in bounded files without losing historical design detail. -->
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

Nếu Node nhận cùng request hai lần:

```text
test.request #123
test.request #123
```

không nên vô tình thực hiện hai workflow giống nhau nếu request đó phải idempotent.

Node cần lưu request/event identity và trạng thái xử lý.

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

