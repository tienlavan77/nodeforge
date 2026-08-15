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
    └── runtime/
        ├── index.db
        ├── history.db
        ├── state.json
        ├── events/
        └── cache/
```

Runtime data can be gitignored:

```text
.forge/runtime/
```

Rules/Workflow may be committed because they are project configuration.

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
