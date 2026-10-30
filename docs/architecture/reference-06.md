<!-- Preserves original architecture reference lines 911–1098 in their original order so repository documentation remains navigable in bounded files without losing historical design detail. -->
## Integration

```text
integration tests
API tests
database tests
```

## Full verification

```text
full test suite
build
lint
typecheck
```

Workflow:

```text
Builder
   ↓
Node detects changes
   ↓
Fast Verification
   ├── FAIL → Builder
   └── PASS
          ↓
      Integration
          ↓
      Full Verify
          ↓
       Reviewer
```

---

# 25. Test selection dựa trên Code Index

Không phải mọi thay đổi đều cần full test ngay.

Ví dụ:

```text
src/auth/session.js
       ↓
Code Index
       ↓
related tests
       ├── tests/auth.test.js
       └── tests/session.test.js
```

Node có thể chạy targeted tests trước.

Trước Reviewer/merge có thể chạy full verification.

---

# 26. Agent có thể đề xuất test

Agent có thể nói:

> Thay đổi này ảnh hưởng authentication, hãy chạy auth.test.js và session.test.js.

Node nhận đề xuất rồi áp dụng Test Policy:

```text
Agent recommendation
        ↓
Node Policy
        ├── allowed?
        ├── relevant?
        ├── timeout?
        └── dependency?
        ↓
Test Runner
```

Node có quyền quyết định test chính thức.

---

# 27. Project-wide changes

Không chỉ code file mới quan trọng.

Các file như:

```text
package.json
package-lock.json
pnpm-lock.yaml
tsconfig.json
vite.config.js
```

có thể ảnh hưởng toàn project.

Nếu các file này thay đổi:

```text
invalidate caches
↓
recalculate project state
↓
possibly full verification
```

Node nên phân biệt:

```text
LOCAL CHANGE
vs
PROJECT-WIDE CHANGE
```

---

# 28. Test Result chuẩn hóa

Node thu:

```text
stdout
stderr
exit code
test count
passed
failed
skipped
duration
build
lint
typecheck
```

Sau đó trả `Result Schema`.

Ví dụ:

```json
{
  "status": "passed",
  "exit_code": 0,
  "tests": {
    "total": 47,
    "passed": 47,
    "failed": 0
  }
}
```

Reviewer nhận kết quả do Node xác minh.

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

