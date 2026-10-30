<!-- Preserves original architecture reference lines 563–717 in their original order so repository documentation remains navigable in bounded files without losing historical design detail. -->
# 16. Batch context request

Không nên request từng mảnh quá nhỏ nếu có thể batch.

Ví dụ:

```json
{
  "type": "context_request",
  "items": [
    {
      "action": "read_symbol",
      "file": "src/session.js",
      "symbol": "refreshSession"
    },
    {
      "action": "read_symbol",
      "file": "src/auth.js",
      "symbol": "validateToken"
    },
    {
      "action": "read_file",
      "file": "tests/session.test.js"
    }
  ]
}
```

Node trả một context pack.

---

# 17. Chuẩn hóa dữ liệu để tiết kiệm token

Không đưa raw filesystem/test/log trực tiếp cho AI.

Pipeline:

```text
RAW
 ↓
FILTER
 ↓
DEDUPLICATE
 ↓
NORMALIZE
 ↓
SELECT
 ↓
CONTEXT
```

Node chịu trách nhiệm:

- lọc
- loại trùng
- cắt log
- chọn phần liên quan
- chuẩn hóa format
- giới hạn context
- cache dữ liệu phù hợp

---

# 18. Context Builder và Reviewer khác nhau

## Builder Context

```text
Task
Requirements
Relevant files
Relevant symbols
Test failures
Constraints
```

Ví dụ:

```json
{
  "type": "builder_context",
  "version": 1,
  "task": {},
  "files": [],
  "failures": [],
  "constraints": []
}
```

## Reviewer Context

```text
Task
Requirements
Changed files
Git diff
Test result
Build result
Lint result
Relevant architecture rules
```

Ví dụ:

```json
{
  "type": "review_context",
  "version": 1,
  "task": {},
  "changes": [],
  "diff": {},
  "verification": {}
}
```

Reviewer không cần nhận toàn bộ lịch sử suy nghĩ của Builder.

---

# 19. Rules dùng Schema

Rule định nghĩa:

> Được phép / không được phép.

Ví dụ:

```json
{
  "id": "RULE-001",
  "type": "architecture",
  "severity": "error",
  "applies_to": ["builder", "reviewer"],
  "rule": "Do not modify public API",
  "enforcement": "review"
}
```

Rule khác:

```json
{
  "id": "RULE-002",
  "type": "testing",
  "severity": "error",
  "rule": "All changed code must pass tests",
  "enforcement": "orchestrator"
}
```

Rule có thể được Node hoặc Reviewer enforce tùy loại.

---

