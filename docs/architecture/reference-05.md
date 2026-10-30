<!-- Preserves original architecture reference lines 718–910 in their original order so repository documentation remains navigable in bounded files without losing historical design detail. -->
# 20. Workflow dùng Schema

Workflow định nghĩa trình tự thực hiện.

Ví dụ:

```json
{
  "id": "WF-001",
  "name": "build-review",
  "version": 1,
  "states": [
    "planning",
    "building",
    "testing",
    "reviewing",
    "completed",
    "failed"
  ],
  "transitions": [
    {
      "from": "building",
      "event": "build_finished",
      "to": "testing"
    },
    {
      "from": "testing",
      "event": "test_passed",
      "to": "reviewing"
    },
    {
      "from": "testing",
      "event": "test_failed",
      "to": "building"
    },
    {
      "from": "reviewing",
      "event": "approved",
      "to": "completed"
    },
    {
      "from": "reviewing",
      "event": "changes_required",
      "to": "building"
    }
  ]
}
```

Không nên hard-code workflow bằng quá nhiều `if/else`.

Node đọc Workflow Schema và thực thi state machine.

---

# 21. Sáu schema nền tảng

Nên có:

```text
1. Task Schema
   → nhiệm vụ là gì

2. Rule Schema
   → luật nào phải tuân thủ

3. Workflow Schema
   → trình tự thực hiện

4. Context Schema
   → AI được nhận gì

5. Command/Event Schema
   → Agent ↔ Node giao tiếp thế nào

6. Result Schema
   → Test/Build/Review trả gì
```

Cấu trúc có thể:

```text
.forge/
├── schemas/
│   ├── task.schema.json
│   ├── rule.schema.json
│   ├── workflow.schema.json
│   ├── context.schema.json
│   ├── event.schema.json
│   └── result.schema.json
│
├── rules/
├── workflows/
└── runtime/
```

---

# 22. Rules/Workflow có 3 cấp

Có thể có:

```text
GLOBAL
  ↓
PROJECT
  ↓
TASK
```

Ví dụ Global:

```text
Không tự ý thêm feature.
Phải có test.
Không bypass Reviewer.
```

Project:

```text
pnpm
Vitest
TypeScript
architecture.md immutable
```

Task:

```text
Chỉ sửa Theme Engine.
Không sửa WooCommerce adapter.
```

Node hợp nhất thành:

```text
Effective Rules
```

và cung cấp cho Agent/Reviewer.

---

# 23. Test nên do Node chạy

Đây là một nguyên tắc quan trọng.

Agent có thể tự chạy test để lấy feedback.

Nhưng:

> **Test chính thức để xác nhận workflow phải do Node chạy.**

Phân biệt:

```text
Agent-run test
= feedback cho Agent

Node-run test
= authoritative verification
```

Builder có thể:

```text
sửa code
↓
npm test
↓
thấy lỗi
↓
sửa tiếp
```

Node vẫn phải chạy verification chính thức.

---

# 24. Test pipeline

Có thể chia 3 tầng.

## Fast verification

```text
syntax
lint
typecheck
unit tests liên quan
```

