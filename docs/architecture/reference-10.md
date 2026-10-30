<!-- Preserves original architecture reference lines 1642–1825 in their original order so repository documentation remains navigable in bounded files without losing historical design detail. -->
# 46. Secrets

Agent có thể đọc:

```text
.env
API keys
credentials
SSH keys
```

Context Broker phải có security policy.

Ví dụ:

```text
.env → NEVER automatically send to LLM
credentials → NEVER automatically send
private keys → NEVER automatically send
```

Secrets cần exclusion/redaction policy.

---

# 47. Token Firewall

Đây là một mục tiêu lớn của Node:

```text
              FULL PROJECT DATA
                     │
                     ▼
              ┌──────────────┐
              │    Node.js   │
              │              │
              │ Index        │
              │ Filter       │
              │ Deduplicate  │
              │ Select       │
              │ Normalize    │
              │ Token Budget │
              └──────┬───────┘
                     │
              SMALL CONTEXT
                 ┌───┴───┐
                 ▼       ▼
              Builder Reviewer
```

Nguyên tắc:

> Node xử lý dữ liệu rẻ; AI xử lý suy luận đắt.

---

# 48. Context Cache

Node có thể cache:

```text
symbol context
file summary
dependency graph
test result
review context
```

Nếu Builder yêu cầu lại context:

```text
request
 ↓
Context Cache
 ↓
HIT
 ↓
return
```

Khi file thay đổi:

```text
file changed
 ↓
invalidate affected cache
```

Code Index + Watcher giúp quản lý cache.

---

# 49. Context Budget

Không cho Agent yêu cầu vô hạn:

```text
max_files
max_bytes
max_context_tokens
max_history
max_depth
```

Ví dụ policy:

```text
Builder context budget: 40k tokens
Reviewer context budget: 30k tokens
```

Con số cụ thể là configuration, không phải kiến trúc bắt buộc.

---

# 50. Memory của project

Sau mỗi task:

```text
Raw History
     ↓
Event Store
     ↓
Task Summary
     ↓
Project Memory
```

Ví dụ:

```text
Session timeout logic nằm ở src/session.js.
auth.js validate token trước khi refresh.
session.test.js bao phủ refreshSession.
```

Task sau chỉ lấy facts liên quan.

Không cần gửi toàn bộ lịch sử cũ.

---

# 51. Workflow Builder → Test → Reviewer

Flow chính:

```text
                 TASK
                   │
                   ▼
                BUILDER
                   │
               code/modify
                   │
                   ▼
              FILESYSTEM
                   │
                   ▼
             NODE WATCHER
                   │
              Code Index
                   │
                   ▼
             NODE TEST RUNNER
                   │
             ┌─────┴─────┐
             ▼           ▼
           FAIL         PASS
             │           │
             ▼           ▼
          BUILDER     REVIEWER
             │           │
             │      review diff
             │           │
             │     ┌─────┴─────┐
             │     ▼           ▼
             │   APPROVE    CHANGES
             │                 │
             └─────────────────┘
```

---

