# Forge — Node.js Orchestrator Architecture
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

## Human

Có quyền theo filesystem/OS và project policy.

Node không phải file proxy/gatekeeper. Node là:

> Observer + Orchestrator + Verifier

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

Nếu Node theo dõi toàn project mà cũng theo dõi `.forge/`, sẽ có vòng lặp:

```text
Node ghi history.db
   ↓
Watcher phát hiện
   ↓
Node xử lý event
   ↓
Node ghi history.db
   ↓
...
```

Do đó watcher phải ignore ít nhất:

```text
.forge/**
node_modules/**
.git/**
dist/**
coverage/**
```

Các thư mục ignore khác phụ thuộc project.

---

# 8. Filesystem Watcher

Node theo dõi các event:

```text
CREATE
MODIFY
DELETE
RENAME
MOVE
```

Ví dụ:

```text
AI / Coder
    ↓
Filesystem
    ↓
Node Watcher
```

Không quan trọng ai sửa:

- Builder AI
- Reviewer AI
- Codex
- Coder
- VS Code
- script
- command line

Node đều thấy filesystem event.

---

# 9. Debounce và file stability

Không được đọc file ngay ở event đầu tiên nếu Agent đang ghi.

Ví dụ:

```text
WRITE
  ↓
MODIFY event
  ↓
wait 100–300ms hoặc theo policy
  ↓
check file stable
  ↓
read
  ↓
re-index
```

Nếu Agent ghi liên tiếp:

```text
WRITE
WRITE
WRITE
WRITE
```

Node nên gom lại thành một lần indexing sau khi file ổn định.

---

# 10. Code Index

Code Index là mục lục sống của source code.

Ví dụ:

```text
src/aa.js

function login()
function refreshSession()
function logout()
```

Index có thể biết:

```text
aa.js
 ├── login          lines 1-20
 ├── refreshSession lines 22-60
 └── logout         lines 62-90
```

Nó có thể chứa:

```text
files
symbols
imports
exports
calls
references
tests
dependency relationships
```

Có thể lưu bằng SQLite:

```text
.forge/index.db
```

---

# 11. Incremental Index

Không index lại toàn bộ repository mỗi lần một file thay đổi.

Nếu:

```text
aa.js MODIFY
```

thì:

```text
MODIFY
 ↓
re-index aa.js
```

Nếu:

```text
CREATE
```

thì index file mới.

Nếu:

```text
DELETE
```

thì remove khỏi index.

Nếu:

```text
RENAME/MOVE
```

thì cập nhật path và các quan hệ liên quan.

---

# 12. File ID ổn định

Không nên chỉ dùng path làm identity của file.

Ví dụ:

```text
src/auth.js
    ↓
src/security/auth.js
```

Node nên có `file_id` ổn định để theo dõi rename/move tốt hơn.

Rename có thể ảnh hưởng:

- Code Index
- imports
- references
- tests
- history
- dependency graph

---

# 13. Code Index không phải source of truth

Code Index là cache có cấu trúc.

Source of truth:

```text
Filesystem + Git
```

Nếu index hỏng hoặc không nhất quán:

```text
index inconsistent
       ↓
full rebuild
```

Có thể có command:

```text
forge index rebuild
```

Hoặc Node tự phát hiện và rebuild.

---

# 14. Context Broker / Context Engine

Node không đưa toàn bộ project cho AI.

Node đóng vai trò Context Broker:

```text
             BUILDER
                 │
          cần context
                 │
                 ▼
              NODE
                 │
        ┌────────┼─────────┐
        ▼        ▼         ▼
      Index    Files      Git
        │
        ▼
   đúng dữ liệu
        │
        ▼
     BUILDER
```

Agent có thể yêu cầu:

```text
READ_FILE
READ_SYMBOL
READ_RANGE
SEARCH
GET_CALLERS
GET_DEFINITION
GET_IMPORTS
GET_DIFF
GET_TESTS
```

Node trả phần cần thiết.

---

# 15. Không gửi cả file mặc định

Ví dụ file nhỏ:

```text
aa.js = 80 dòng
```

Có thể gửi toàn bộ.

File lớn:

```text
aa.js = 1.000 dòng
```

Nếu Builder chỉ cần:

```text
refreshSession()
```

Node có thể trả:

```text
aa.js:420-468
```

Nếu Agent cần thêm context, nó request tiếp.

Mục tiêu:

> Ít token nhưng đủ context.

---

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
  project_id = wp-static

Reviewer #1
  project_id = wp-static

Builder #2
  project_id = forge
```

Đảm bảo:

```text
Builder A → Project A filesystem
Builder B → Project B filesystem
```

Không được vô tình ghi project khác khi switch.

---

# 37. Rules và Workflow theo project

Project A có:

```text
rules A
workflows A
```

Project B có:

```text
rules B
workflows B
```

Global rules có thể áp dụng cho tất cả.

Cấu trúc:

```text
GLOBAL
  ↓
PROJECT
  ↓
TASK
```

---

# 38. Project State

Forge nên có object trung tâm:

```text
ProjectState
```

Ví dụ:

```json
{
  "project": "wp-static-commerce",
  "git": {},
  "index": {},
  "active_tasks": [],
  "agents": [],
  "tests": {},
  "workflow": {},
  "changes": {}
}
```

Node luôn biết project hiện tại đang ở trạng thái nào.

UI hiển thị state này.

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

Một hướng tổ chức:

```text
project/
├── src/
├── tests/
├── package.json
│
└── .forge/
    ├── schemas/
    │   ├── task.schema.json
    │   ├── rule.schema.json
    │   ├── workflow.schema.json
    │   ├── context.schema.json
    │   ├── event.schema.json
    │   └── result.schema.json
    │
    ├── rules/
    │   ├── architecture.json
    │   ├── coding.json
    │   ├── testing.json
    │   └── review.json
    │
    ├── workflows/
    │   └── build-review.json
    │
    ├── roadmap/                  # PLAN — xem mục 63
    │   └── roadmap.json
    │
    └── runtime/                  # STATE — xem mục 63
        ├── index.db
        ├── history.db
        ├── state.json             # gồm cả sprint-state/commit-state, không tách folder riêng
        ├── events/
        └── cache/
```

Runtime data can be gitignored:

```text
.forge/runtime/
```

Rules/Workflow/Roadmap may be committed because they are project configuration/plan —
runtime là phần duy nhất chứa state, không tách thêm thư mục `state/` riêng (xem mục 63 vì
sao `state.json` trong `runtime/` đã đủ).

---

# 54. Git

Node nên theo dõi cả:

```text
Filesystem
+
Git
```

Ví dụ:

```text
filesystem says:
auth.js modified

git says:
M src/auth.js
```

Node có thể tạo `Project Change Set`:

```json
{
  "modified": ["src/auth.js"],
  "added": [],
  "deleted": [],
  "untracked": []
}
```

Reviewer dùng:

```text
Change Set + Git Diff + Test Result + Rules
```

---

# 55. Nguyên tắc source of truth

Có thứ tự rõ:

```text
Filesystem
    ↓
source of truth

Git
    ↓
version/change truth

Code Index
    ↓
structured cache

History/Event Store
    ↓
audit truth

Project State
    ↓
orchestration truth

UI
    ↓
visualization only
```

---

# 56. Kiến trúc tổng thể

```text
                         FORGE
                           │
                    ┌──────▼──────┐
                    │    NODE     │
                    │ ORCHESTRATOR│
                    └──────┬──────┘
                           │
       ┌───────────────────┼───────────────────┐
       │                   │                   │
       ▼                   ▼                   ▼
 File Watcher         Code Index          Test Runner
       │                   │                   │
       └───────────────────┼───────────────────┘
                           │
                    Context Engine
                           │
                    Rule + Workflow
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
           BUILDER                  REVIEWER
              │                         │
              └──────────┬──────────────┘
                         ▼
                    FILESYSTEM
                         │
                         ▼
                     WATCHER
                         │
                        LOOP
```

---

# 57. Kiến trúc multi-project

```text
                         FORGE
                           │
                     ┌─────▼─────┐
                     │   NODE    │
                     │           │
                     │ Project   │
                     │ Registry  │
                     └─────┬─────┘
                           │
                 ┌─────────┴─────────┐
                 ▼                   ▼
            PROJECT A            PROJECT B
                 │                   │
          ┌──────┼──────┐      ┌─────┼─────┐
          ▼      ▼      ▼      ▼     ▼     ▼
        Index  Rules  History Index Rules History
          │      │      │      │     │     │
          └──────┴──────┘      └─────┴─────┘
                 │                   │
              Builder             Builder
              Reviewer            Reviewer
```

Một Forge instance có thể mở nhiều project nhưng mỗi project có state độc lập.

---

# 58. Năm thứ cần chốt trước khi code Node

Nếu bắt đầu implementation, ưu tiên chốt:

## 1. Agent Protocol

Agent ↔ Node nói chuyện bằng gì.

## 2. Project State

Node quản lý trạng thái project thế nào.

## 3. Schema

Task / Rule / Workflow / Context / Event / Result.

## 4. Filesystem Watch + Code Index

Cơ chế đồng bộ project state.

## 5. Failure/Recovery

Crash, timeout, cancel, retry, concurrent edits.

---

# 59. Những thứ nên để sau

Không cần giải quyết ngay:

- UI quá phức tạp
- quá nhiều loại Agent
- provider-specific optimization
- advanced memory
- fancy visualization
- distributed deployment

Trước hết phải làm chắc:

```text
Filesystem
Watcher
Index
Schema
State
History
Test
Workflow
Agent Protocol
Context normalization
```

---

# 60. Kết luận kiến trúc

Forge không nên là một tập hợp prompt nối với nhau.

Forge nên là:

> **Protocol-driven multi-agent orchestration system.**

Trong đó:

```text
Agent
= intelligence / coding / reasoning

Node.js
= observation / orchestration / verification / normalization

Filesystem
= source of truth

Git
= version/change truth

Code Index
= structured code map

History
= audit trail

Rules
= constraints

Workflow
= state machine

Context Engine
= token firewall

UI
= visualization
```

Mục tiêu cuối:

```text
Agent tự do code
        ↓
Filesystem thay đổi
        ↓
Node phát hiện
        ↓
Code Index cập nhật
        ↓
Context được chuẩn hóa
        ↓
Node chạy verification
        ↓
Test Result
        ↓
Reviewer
        ↓
Approve / Changes Required
        ↓
Builder
        ↓
...
```

**Một nguyên tắc xuyên suốt:**

> Không bắt AI làm việc mà Node có thể làm rẻ và xác định được; không bắt Node thay AI suy luận những thứ chỉ AI nên quyết định.

---

# 61. Tóm tắt cực ngắn

```text
FORGE
│
├── NODE.JS
│   ├── Orchestrator
│   ├── Watcher
│   ├── Code Index
│   ├── Test Runner
│   ├── Context Engine
│   ├── Rule Engine
│   ├── Workflow Engine
│   ├── History/Event Store
│   ├── Project State
│   └── Agent Stream
│
├── BUILDER
│   └── trực tiếp đọc/ghi project
│
├── REVIEWER
│   └── review diff + verification + rules
│
├── PROJECT
│   ├── source
│   ├── tests
│   ├── config
│   └── .forge/
│
└── UI
    └── hiển thị state/event/stream
```

> **Agent không bị Node khóa filesystem. Node chỉ quan sát và điều phối.**
>
> **History và Code Index nằm trong `.forge/` của chính project.**
>
> **Rules, Workflow, Context, Event và Result đều có schema.**
>
> **Node chạy verification chính thức.**
>
> **AI chỉ nhận context cần thiết, không nhận toàn bộ project/history.**

---

# 62. Verification Engine — schema hoá pipeline verification

Bổ sung vào mục 55 (nguyên tắc source of truth): kết quả verification không được để
Builder tự claim. Nếu Node đảm nhiệm verification để tiết kiệm token (mục 47), quy trình
đó phải là một **contract có schema**, không phải logic rải rác trong code.

## 62.1. Quan hệ với `results/` đã có (README v1.2) — không phá nguyên tắc "gộp thay vì tách"

README v1.2 cố tình gộp build/lint/typecheck vào **1 file**
`results/check-result.schema.json` (field `kind` phân biệt), tách riêng
`results/test-result.schema.json` cho test. Đây vẫn là schema mô tả **hình dạng của 1 lần
chạy check** — không đổi.

5 schema verification mới ở dưới là một **tầng khác**: tầng *orchestration/gate*, trả lời
"phải chạy gì, đã chạy gì, kết quả tổng hợp có đủ điều kiện review chưa" — không mô tả lại
hình dạng của check. Để không lặp field, `verification-run.schema.json` **không** nhúng lại
toàn bộ nội dung `test-result`/`check-result`; nó chỉ giữ `result_ref` (id) trỏ tới record
`test-result`/`check-result` đã có sẵn trong `results/`. Vậy nguyên tắc "một enum/một shape,
không nhân đôi" của README vẫn giữ nguyên.

```
schemas/
├── results/                          # hình dạng 1 lần chạy check (đã có, README v1.2)
│   ├── test-result.schema.json
│   ├── check-result.schema.json
│   └── review-result.schema.json
│
└── verification/                     # tầng orchestration/gate (mới)
    ├── verification-plan.schema.json
    ├── verification-run.schema.json   # $ref tới results/ qua result_ref, không nhúng lại
    ├── verification-result.schema.json
    ├── test-failure.schema.json
    └── verification-policy.schema.json
```

## 62.2. `verification/verification-plan.schema.json`

Mô tả 1 commit cần kiểm tra những gì. Node đọc để biết phải chạy gì.

> **Cập nhật sau review NF-028:** bản đầu để `levels`/`checks[].type` là enum inline. Builder
> chỉ ra lỗ hổng khi `roadmap/commit.schema.json` (mục 63.3) cần tái dùng enum `levels` ở
> **cấp item** (mỗi phần tử trong mảng `verification.levels` của Commit) — nếu `$ref` thẳng
> tới `#/properties/levels` (nguyên cả field, vốn đã là 1 mảng), item sẽ bị ép phải là mảng
> lồng mảng, sai. Sửa bằng cách tách 2 giá trị dùng lại thành `$defs` cấp-giá-trị-đơn
> (`verification_level`, `check_type`), đúng nguyên tắc "một enum, không nhân đôi" (README
> v1.2) — các nơi khác `$ref` tới `$defs` này ở cấp item, không tới `properties.levels` nguyên
> field nữa.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://forge.dev/schemas/verification/verification-plan.schema.json",
  "title": "VerificationPlan",
  "description": "The checks Node must run for a commit. This is orchestration metadata, not an individual check result.",
  "type": "object",
  "additionalProperties": false,
  "required": ["commit_id", "levels", "checks"],
  "$defs": {
    "verification_level": {
      "type": "string",
      "enum": ["focused", "related", "full"]
    },
    "check_type": {
      "type": "string",
      "enum": ["test", "lint", "typecheck", "build"]
    }
  },
  "properties": {
    "schema_version": { "type": "string", "const": "1.0" },
    "commit_id": { "type": "string" },
    "levels": {
      "type": "array",
      "items": { "$ref": "#/$defs/verification_level" },
      "minItems": 1,
      "uniqueItems": true
    },
    "checks": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["type", "command"],
        "properties": {
          "type": { "$ref": "#/$defs/check_type" },
          "command": { "type": "string", "minLength": 1 },
          "timeout_ms": { "type": "integer", "minimum": 0 }
        }
      }
    }
  }
}
```

> `title` giữ nguyên `"VerificationPlan"` (PascalCase, không prefix) để nhất quán với 7 schema
> còn lại trong `verification/`+`roadmap/` — nếu Builder cần đổi convention đặt tên, áp dụng
> đồng loạt cho cả 8 file trong 1 ticket riêng, không đổi lẻ tẻ từng file.

## 62.3. `verification/verification-run.schema.json`

Mỗi lần Node thực sự chạy verification. Hữu ích cho history/audit; mỗi phần tử `checks`
chỉ giữ `result_ref` trỏ tới `test-result`/`check-result` thật, không nhúng lại nội dung.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://forge.dev/schemas/verification/verification-run.schema.json",
  "title": "VerificationRun",
  "type": "object",
  "additionalProperties": false,
  "required": ["run_id", "commit_id", "level", "started_at", "checks", "status"],
  "properties": {
    "run_id": { "type": "string" },
    "commit_id": { "type": "string" },
    "level": { "enum": ["focused", "related", "full"] },
    "started_at": { "type": "string", "format": "date-time" },
    "completed_at": { "type": "string", "format": "date-time" },
    "status": { "enum": ["passed", "failed", "error", "running"] },
    "checks": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["type", "command", "status"],
        "properties": {
          "type": { "enum": ["test", "lint", "typecheck", "build"] },
          "command": { "type": "string" },
          "status": { "enum": ["passed", "failed", "error", "skipped"] },
          "exit_code": { "type": "integer" },
          "duration_ms": { "type": "integer", "minimum": 0 },
          "result_ref": {
            "type": "string",
            "description": "ID của record trong results/test-result.schema.json hoặc results/check-result.schema.json — KHÔNG nhúng lại nội dung ở đây."
          }
        }
      }
    }
  }
}
```

## 62.4. `verification/verification-result.schema.json`

Kết quả chính thức Node đưa vào Workflow Engine — đây là schema duy nhất mà Workflow Engine
cần đọc, không cần biết chi tiết từng check.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://forge.dev/schemas/verification/verification-result.schema.json",
  "title": "VerificationResult",
  "type": "object",
  "additionalProperties": false,
  "required": ["commit_id", "run_id", "status", "ready_for_review"],
  "$defs": {
    "gate_status": { "enum": ["passed", "failed", "skipped", "not_applicable"] }
  },
  "properties": {
    "commit_id": { "type": "string" },
    "run_id": { "type": "string" },
    "evaluated_at": { "type": "string", "format": "date-time" },
    "status": { "$ref": "#/$defs/gate_status" },
    "scope": { "$ref": "#/$defs/gate_status" },
    "rules": { "$ref": "#/$defs/gate_status" },
    "tests": { "$ref": "#/$defs/gate_status" },
    "lint": { "$ref": "#/$defs/gate_status" },
    "typecheck": { "$ref": "#/$defs/gate_status" },
    "build": { "$ref": "#/$defs/gate_status" },
    "ready_for_review": { "type": "boolean" }
  }
}
```

```text
verification.status == passed
             +
        rules == passed
             +
        scope == passed
             ↓
      READY_FOR_REVIEW
```

## 62.5. `verification/test-failure.schema.json`

Cơ chế giảm token quan trọng nhất của tầng này: Node không gửi log thô cho Builder, chỉ
gửi bằng chứng tối thiểu đã chuẩn hoá.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://forge.dev/schemas/verification/test-failure.schema.json",
  "title": "TestFailure",
  "type": "object",
  "additionalProperties": false,
  "required": ["test_result_id", "test", "file", "message"],
  "properties": {
    "test_result_id": {
      "type": "string",
      "description": "ID record test-result mà failure này trích ra."
    },
    "test": { "type": "string" },
    "file": { "type": "string" },
    "line": { "type": "integer", "minimum": 1 },
    "column": { "type": "integer", "minimum": 1 },
    "error": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "type": { "enum": ["assertion", "exception", "timeout", "other"] },
        "expected": {},
        "actual": {}
      }
    },
    "message": { "type": "string", "maxLength": 500 },
    "stack_excerpt": {
      "type": "string",
      "maxLength": 500,
      "description": "Tối đa vài dòng đầu của stack trace, không phải log đầy đủ."
    }
  }
}
```

```text
10,000 lines raw log
        ↓
       Node
        ↓
   normalize (test-failure.schema.json)
        ↓
    ~200 bytes / failure
        ↓
     Builder
```

`message` và `stack_excerpt` giới hạn cứng độ dài (`maxLength`) ngay ở tầng schema — đây là
cách ép nguyên tắc "context nhỏ nhất nhưng đủ suy luận" (README, mục Context compression)
không phụ thuộc vào việc Context Engine có nhớ cắt bớt hay không.

## 62.6. `verification/verification-policy.schema.json`

Rule cho chính Verification Engine — Node không tự quyết định tuỳ tiện `stop_on_failure`
hay số lần retry.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://forge.dev/schemas/verification/verification-policy.schema.json",
  "title": "VerificationPolicy",
  "type": "object",
  "additionalProperties": false,
  "required": ["focused", "related", "full", "max_retries"],
  "$defs": {
    "level_policy": {
      "type": "object",
      "additionalProperties": false,
      "required": ["required", "stop_on_failure"],
      "properties": {
        "required": { "type": "boolean" },
        "stop_on_failure": { "type": "boolean" }
      }
    }
  },
  "properties": {
    "focused": { "$ref": "#/$defs/level_policy" },
    "related": { "$ref": "#/$defs/level_policy" },
    "full": { "$ref": "#/$defs/level_policy" },
    "max_retries": { "type": "integer", "minimum": 0 }
  }
}
```

**Vì sao không dùng `project/rule.schema.json` sẵn có cho việc này:** Rule (README) trả lời
*"thay đổi này có tốt/tuân thủ không"* — đối tượng đánh giá là **code**. Verification Policy
trả lời *"chính Verification Engine phải hành xử thế nào khi 1 check fail"* — đối tượng
cấu hình là **hành vi của Node**, không phải code. Hai schema có đối tượng áp dụng khác
nhau nên tách riêng; nếu sau này cần logic phức tạp hơn (`condition`/`condition_language`),
có thể tái dùng cơ chế đó từ `rule.schema.json` thay vì phát minh lại — nhưng ở v1,
`verification-policy` giữ dạng cấu hình đơn giản.

## 62.7. Pipeline tổng thể

```text
                 COMMIT TASK
                     │
                     ▼
             Verification Plan
                     │
                     ▼
              ┌──────────────┐
              │ NODE RUNNER  │
              └──────┬───────┘
                     │
              ┌──────┴──────┐
              ▼             ▼
           command        scope/rule
              │             │
              ▼             ▼
          raw output     check result (results/*)
              │
              ▼
        Result Normalizer
              │
        ┌─────┴─────┐
        ▼           ▼
      PASS         FAIL
        │           │
        │           ▼
        │      Failure Extractor (test-failure.schema.json)
        │           │
        │           ▼
        │        BUILDER
        │
        ▼
 verification-result.schema.json
        │
        ▼
 READY_FOR_REVIEW
        │
        ▼
    REVIEWER
```

**Nguyên tắc bổ sung vào mục 55/60:**

> Node là nguồn sự thật cho verification result. Builder có thể chạy test để hỗ trợ quá
> trình phát triển, nhưng "Builder nói tests pass" không có nghĩa Forge ghi nhận PASS —
> phải là Node executed → exit code → normalized result → `verification-result` →
> workflow gate.

---

# 63. Roadmap → Sprint → Commit — schema hoá kế hoạch cấp cao

Roadmap là tầng **cao hơn** Task: `Roadmap → Sprint → Commit → Builder → Verify → Reviewer`.
Mỗi tầng cần contract riêng, tương tự cách Task/Workflow đã có schema ở README v1.2.

## 63.1. Quan hệ Commit ↔ Task — quyết định thiết kế bắt buộc phải chốt

`project/task.schema.json` (README, Sprint 2) đã là entity **runtime** Node quản lý trong
lúc thực thi. Roadmap/Sprint/Commit ở đây là **PLAN** — nếu để cả hai khái niệm tồn tại độc
lập, dễ chồng chéo ("Commit" và "Task" cùng mô tả 1 đơn vị công việc nhưng 2 schema khác
nhau, dữ liệu dễ lệch nhau).

**Quyết định:** Commit thuộc tầng PLAN (định nghĩa *"phải làm gì"*, viết trước khi chạy).
Task là tầng RUNTIME (định nghĩa *"đang làm đến đâu"*, Node tự sinh ra khi Commit Dispatcher
giao việc cho Builder). Một Commit khi được dispatch sẽ tạo **đúng 1** Task runtime tương
ứng; Task đó giữ thêm field tham chiếu ngược `commit_id` (optional trong
`project/task.schema.json`, bổ sung khi Builder code Sprint 2 — không thuộc phạm vi 3 schema
mới ở mục 63.3, không tạo schema Commit-runtime riêng để tránh nhân đôi khái niệm).

```text
ROADMAP (PLAN)                          RUNTIME
─────────────────                       ─────────────────
roadmap.json
  └── sprint
        └── commit ──── dispatch ────▶ task (project/task.schema.json)
                                           │ commit_id ──▶ trỏ ngược về commit
                                           ▼
                                       task.status / task.workflow_state
                                       (README — không đổi)
```

Commit **không** có `status` runtime riêng (không lặp lại `pending/active/...` như Task) —
tiến độ luôn đọc qua Task đã dispatch từ Commit đó. Điều này giữ đúng nguyên tắc "tách PLAN
khỏi STATE" ở mục 63.2 bên dưới: nếu Commit tự có `status`, `roadmap.json` sẽ lại lẫn state
vào plan — đúng lỗi mà README v1.2 và mục 12 (file_id) đã tránh cho các trường hợp khác.

## 63.2. Tách PLAN khỏi STATE

Không để `roadmap.json` chứa runtime state kiểu:

```json
{
  "status": "building",
  "attempt": 3,
  "review_status": "pending"
}
```

Layout `.forge/` (đã cập nhật ở mục 53):

```text
.forge/
├── roadmap/
│   └── roadmap.json        ← PLAN, có thể commit
│
└── runtime/
    └── state.json          ← RUNTIME (sprint-state, commit-state gộp chung file này,
                                không tạo thư mục state/ riêng — runtime/ đã tồn tại
                                sẵn từ mục 6/53, tránh nhân đôi khái niệm "vùng runtime")
```

- **Roadmap** nói: "phải làm gì".
- **State** (`runtime/state.json`) nói: "đang làm đến đâu".
- **Node** nói: "bây giờ phải làm gì" (suy ra từ 2 cái trên + Commit Dependency Resolver).

Phân tách này quan trọng để Forge resume sau crash, retry Builder, chạy lại verification,
hoặc chuyển project mà không sợ lẫn dữ liệu kế hoạch với dữ liệu tiến độ.

## 63.3. `roadmap/commit.schema.json`

> **Cập nhật sau review NF-028/033:** bản đầu để `verification.levels` inline enum trực tiếp
> — trùng lặp enum với `verification-plan.schema.json` (vi phạm "một enum, không nhân đôi").
> Sửa: `items` của `verification.levels` giờ `$ref` tới `$defs/verification_level` đã tách ra
> ở `verification-plan.schema.json` (mục 62.2) — tái dùng ở **cấp item**, không phải `$ref`
> nguyên field `#/properties/levels` (sẽ gây lỗi mảng lồng mảng). `uniqueItems: true` áp dụng
> đồng nhất cho cả `verification.levels` và `dependencies` (không chỉ 1 trong 2).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://forge.dev/schemas/roadmap/commit.schema.json",
  "title": "Commit",
  "type": "object",
  "additionalProperties": false,
  "required": ["id", "order", "objective", "acceptance_criteria"],
  "properties": {
    "id": { "type": "string" },
    "order": { "type": "integer", "minimum": 1 },
    "objective": { "type": "string", "minLength": 1 },
    "allowed_change_areas": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Glob path — khớp cơ chế role × path glob của project/permission.schema.json (README, mục Filesystem/Permission/Rule), không định nghĩa lại ACL riêng ở đây."
    },
    "acceptance_criteria": {
      "type": "array",
      "items": { "type": "string" },
      "minItems": 1
    },
    "verification": {
      "type": "object",
      "additionalProperties": false,
      "required": ["levels"],
      "properties": {
        "levels": {
          "type": "array",
          "items": { "$ref": "https://forge.dev/schemas/verification/verification-plan.schema.json#/$defs/verification_level" },
          "minItems": 1,
          "uniqueItems": true
        }
      }
    },
    "dependencies": {
      "type": "array",
      "items": { "type": "string" },
      "uniqueItems": true,
      "description": "Danh sách commit_id phải hoàn tất trước."
    }
  }
}
```

Ghi chú: `verification.levels` ở đây chỉ là **khai báo cấp kế hoạch** ("commit này cần verify
tới mức nào") — khi Commit Dispatcher giao việc, Node dùng giá trị này để sinh
`verification-plan.schema.json` thật (mục 62.2) cho Task tương ứng, không phải bản thân
`verification-plan`.

## 63.4. `roadmap/sprint.schema.json`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://forge.dev/schemas/roadmap/sprint.schema.json",
  "title": "Sprint",
  "type": "object",
  "additionalProperties": false,
  "required": ["id", "objective", "commits"],
  "properties": {
    "id": { "type": "string" },
    "objective": { "type": "string", "minLength": 1 },
    "dependencies": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Danh sách sprint_id phải hoàn tất trước."
    },
    "commits": {
      "type": "array",
      "items": { "$ref": "https://forge.dev/schemas/roadmap/commit.schema.json" },
      "minItems": 1
    }
  }
}
```

## 63.5. `roadmap/roadmap.schema.json`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://forge.dev/schemas/roadmap/roadmap.schema.json",
  "title": "Roadmap",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "roadmap_id", "project_id", "version", "sprints"],
  "properties": {
    "schema_version": { "type": "string", "const": "1.0" },
    "roadmap_id": { "type": "string" },
    "project_id": { "type": "string" },
    "version": { "type": "string" },
    "goals": {
      "type": "array",
      "items": { "type": "string" }
    },
    "sprints": {
      "type": "array",
      "items": { "$ref": "https://forge.dev/schemas/roadmap/sprint.schema.json" },
      "minItems": 1
    },
    "constraints": {
      "type": "array",
      "items": { "type": "string" }
    }
  }
}
```

## 63.6. Flow thực thi

```text
roadmap.json
      │
      ▼
roadmap.schema validation
      │
      ▼
Sprint Engine
      │
      ▼
Commit Dependency Resolver
      │
      ▼
Commit Dispatcher ──▶ tạo Task runtime (project/task.schema.json, commit_id trỏ ngược)
      │
      ▼
Builder
```

---

# 64. Cây `schemas/` tổng thể sau khi thêm Verification + Roadmap

Cập nhật lại cây `schemas/` ở README v1.2 (`core/ node/ project/ context/ results/`) với 2
nhóm mới ở mục 62–63:

```text
schemas/
├── core/                  # Envelope, Agent, Event, Command, Error, Common (README v1.2)
├── node/                  # Node profile — allOf tham chiếu core (README v1.2)
├── project/                # Project, Task, Rule, Permission, Workflow, Session (README v1.2)
├── context/                 # Context Pack — Token Firewall (README v1.2)
├── results/                 # test-result, check-result, review-result (README v1.2)
├── verification/             # MỚI — mục 62: plan/run/result/test-failure/policy
│   ├── verification-plan.schema.json
│   ├── verification-run.schema.json
│   ├── verification-result.schema.json
│   ├── test-failure.schema.json
│   └── verification-policy.schema.json
└── roadmap/                  # MỚI — mục 63: roadmap/sprint/commit
    ├── roadmap.schema.json
    ├── sprint.schema.json
    └── commit.schema.json
```

`verification/` và `roadmap/` không đụng tới field hay enum đã chốt trong `core/` (nguyên
tắc "một enum, không nhân đôi" README v1.2 vẫn giữ nguyên) — chúng chỉ tham chiếu qua ID
(`result_ref`, `commit_id`) tới các record đã có schema riêng, không tự định nghĩa lại.

> Lưu ý: cây `schemas/` này cần được phản ánh song song vào `README.md` (nguồn mô tả chính
> thức của bộ schema) khi Builder thực sự tạo các file trên — nằm ngoài phạm vi cập nhật
> lần này (chỉ `ARCHITECTURE.md`).

---

# 65. Kiến trúc tổng thể — Verification Engine + Roadmap là 2 subsystem chính, không phải tiện ích phụ

Cập nhật mô hình ở mục 2:

```text
ROADMAP (PLAN)
   │
   ▼
NODE ORCHESTRATOR
   │
   ├── Roadmap / Sprint Engine   ← mới, mục 63
   ├── Task Dispatcher
   ├── Context Builder
   ├── Rule Engine
   ├── File Watcher
   ├── Code Indexer
   ├── Verification Engine       ← mới, mục 62 — không còn là "test runner" đơn giản
   ├── Workflow Engine
   └── Event/Stream Server
           │
           ├────────► BUILDER
           │
           └────────► REVIEWER
```
