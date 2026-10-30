<!-- Preserves original architecture reference lines 1099–1293 in their original order so repository documentation remains navigable in bounded files without losing historical design detail. -->
# 30. Lưu toàn bộ lịch sử Agent

Node nên lưu **toàn bộ session history**, nhưng không đưa toàn bộ history lại cho AI.

Nên chia thành 3 tầng:

```text
SESSION
  │
  ├── RAW LOG
  ├── EVENTS
  └── SUMMARY
```

## Raw Log

Lưu đầy đủ:

```text
timestamp
agent
message
tool/action
stdout
stderr
```

Dùng cho:

- debug
- audit
- xem lại UI
- điều tra lỗi

Không dùng trực tiếp làm AI context.

## Events

Chuẩn hóa:

```json
{
  "type": "file_changed",
  "agent": "builder",
  "file": "src/auth.js",
  "timestamp": "..."
}
```

Hoặc:

```json
{
  "type": "test_failed",
  "test": "session.test.js",
  "error": "Expected 401, got 200"
}
```

## Summary

Ví dụ:

```text
TASK:
Fix session timeout.

COMPLETED:
- Modified src/session.js
- Modified src/auth.js

TEST:
47 passed

REVIEW:
Changes requested:
- Add validation for expired token

CURRENT STATE:
Builder correction required.
```

---

# 31. History khác Context

Đây là nguyên tắc rất quan trọng:

```text
              SESSION HISTORY
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
       AUDIT               CONTEXT
      toàn bộ              chọn lọc
          │                   │
          ▼                   ▼
        SQLite             Builder
                            Reviewer
```

History có thể rất lớn.

Context phải nhỏ, có mục tiêu.

Không gửi 100 message cũ chỉ vì chúng tồn tại.

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

Nếu project hoạt động lâu, raw history có thể rất lớn.

Nên có:

```text
HOT
  current sessions

WARM
  recent sessions

COLD
  archived sessions
```

Raw stdout/log dài có thể compress hoặc archive.

Không đưa raw history vào AI context.

---

