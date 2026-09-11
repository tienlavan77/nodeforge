# Sprint 10 — Transport & External Agent Integration

## Goal

Kết nối Agent Runtime với thế giới bên ngoài thông qua:

- Application Layer
- HTTP API
- SSE Runtime Stream
- CLI Adapter
- External Agent Contract
- Builder Adapter
- Reviewer Adapter

Mục tiêu của Sprint 10 là hoàn thiện execution layer end-to-end từ việc tạo task đến khi hoàn thành workflow và cập nhật Memory.

---

# Architecture

Project Owner (Human)
        ↓
Sprint Leader
        ↓
Node
        │
        ├── Runtime Service
        │
        ├── Agent Runtime
        │
        ├── Event Store
        ├── History
        ├── Memory
        ├── Recovery
        │
        ├── HTTP API
        ├── SSE Stream
        └── CLI
                │
                ▼
         External Agents
                │
        ┌───────┴────────┐
        ▼                ▼
     Builder         Reviewer

---

# NF-104 — Application Layer Foundation ✅ PASS

Commit:

c02f832

## Deliverables

src/application/runtime-service.js

tests/unit/runtime-service.test.js

## Responsibilities

Runtime Service là entry point duy nhất cho:

- HTTP
- SSE
- CLI

Không transport nào được gọi Runtime trực tiếp.

## API

startTask()

pauseSession()

resumeSession()

getSession()

getProjectMemory()

## Verified

- startTask() tạo RUNNING session
- pauseSession() RUNNING → PAUSED
- resumeSession() PAUSED → RUNNING
- getSession() trả snapshot
- getProjectMemory() dùng Memory Retriever
- reject unknown session
- reject duplicate session

## Quality Gates

- Test 2/2 PASS
- Lint PASS
- Typecheck PASS
- Diff Check PASS

---

# NF-105 — HTTP API Adapter ✅ PASS

Commit:

e219cd8

## Deliverables

src/transport/http/server.js

tests/unit/http-api.test.js

## Endpoints

POST /tasks

POST /sessions/:id/pause

POST /sessions/:id/resume

GET /sessions/:id

GET /projects/:id/memory

## Verified

- Create Session
- Pause Session
- Resume Session
- Query Session
- Query Memory

## Architecture

HTTP
↓
Runtime Service
↓
Runtime

Không truy cập Runtime hoặc Store trực tiếp.

## Quality Gates

- Test 1/1 PASS
- Lint PASS
- Typecheck PASS
- Diff Check PASS

---

# NF-106 — SSE Runtime Stream ✅ PASS

Commit:

59ebf2f

## Deliverables

src/transport/sse/runtime-stream.js

tests/unit/runtime-stream.test.js

## Event Source

Subscription Registry (NF-080)

## Stream Events

agent.started

agent.step.started

agent.step.completed

agent.failed

agent.completed

## Verified

- Subscribe hoạt động
- agent.started được stream
- agent.step.completed được stream
- agent.completed được stream
- Allowlist filtering hoạt động
- Unsubscribe hoạt động
- Unsubscribe idempotent

## Architecture

Event System
↓
SSE Runtime Stream
↓
Client

## Quality Gates

- Test 1/1 PASS
- Lint PASS
- Typecheck PASS
- Diff Check PASS

---

# NF-107 — CLI Adapter ✅ PASS

Commit:

96aa394

## Deliverables

src/transport/cli/index.js

tests/unit/cli-runtime.test.js

## Commands

run

pause

resume

session

## Verified

run
→ tạo session

pause
→ PAUSED

resume
→ RUNNING

session
→ session snapshot

## Architecture

CLI
↓
Runtime Service
↓
Runtime

## Quality Gates

- Test 1/1 PASS
- Lint PASS
- Typecheck PASS
- Diff Check PASS

---

# NF-108 — External Agent Contract ✅ PASS

Commit:

aaf6507

## Deliverables

src/agents/agent-contract.js

tests/unit/agent-contract.test.js

## Contract

id

name

canHandle(task)

execute(context)

## Verified

- Builder mock implement được
- Reviewer mock implement được
- execute() trả status chuẩn hóa
- Không phụ thuộc Runtime
- Không phụ thuộc Transport

## Quality Gates

- Test 2/2 PASS
- Lint PASS
- Typecheck PASS
- Diff Check PASS

---

# NF-109 — Builder Agent Adapter ✅ PASS

Commit:

6758f45

## Deliverables

src/agents/builder-adapter.js

tests/unit/builder-adapter.test.js

## Responsibilities

- Implement Agent Contract
- Xử lý Builder tasks
- Trả result chuẩn hóa

## Verified

canHandle()
→ nhận Builder task

canHandle()
→ reject Review task

execute()
→ trả result chuẩn hóa

Runtime gọi qua Contract thành công

## Quality Gates

- Test 4/4 PASS
- Lint PASS
- Typecheck PASS
- Diff Check PASS

---

# NF-110 — Reviewer Agent Adapter ✅ PASS

Commit:

a7a5de8

## Deliverables

src/agents/reviewer-adapter.js

tests/unit/reviewer-adapter.test.js

## Responsibilities

- Implement Agent Contract
- Xử lý Review tasks
- Trả review result chuẩn hóa

## Verified

canHandle()
→ nhận Review task

canHandle()
→ reject Builder task

execute()
→ trả review result chuẩn hóa

Runtime gọi qua Contract thành công

## Quality Gates

- Test 4/4 PASS
- Lint PASS
- Typecheck PASS
- Diff Check PASS

---

# NF-111 — Runtime External Agent Integration ✅ PASS

Commit:

aacc548

## Deliverables

src/modules/agent/external-agent-orchestrator.js

tests/integration/external-agent-orchestrator.test.js

## Flow

Task
↓
Builder Adapter
↓
Build Result
↓
Reviewer Adapter
↓
Review Result
↓
Complete

## Verified

- Builder được gọi trước Reviewer
- Builder hoàn thành mới gọi Reviewer
- Reviewer approve → complete
- Builder fail → Reviewer không được gọi
- Lifecycle events publish đúng thứ tự
- Completion fact đi qua History
- Completion fact đi qua Task Summary
- Completion fact đi qua Project Memory
- Recovery regression pass 3/3

## Architecture

Agent Runtime
↓
Builder Adapter
↓
Reviewer Adapter
↓
Memory Pipeline

## Quality Gates

- Integration Test 2/2 PASS
- Recovery Regression 3/3 PASS
- Lint PASS
- Typecheck PASS
- Diff Check PASS

---

# NF-112 — Sprint 10 End-to-End Verification ✅ PASS

Commit:

1b6b471

## Deliverables

tests/integration/sprint-10-e2e.test.js

HTTP memory route update

## End-to-End Scenario

CLI
↓
HTTP API
↓
Runtime Service
↓
Agent Runtime
↓
Builder Adapter
↓
Reviewer Adapter
↓
Event System
↓
History
↓
Task Summary
↓
Project Memory
↓
SSE Stream

## Verified

- CLI tạo session
- HTTP đọc session
- HTTP pause session
- HTTP resume session
- Builder được gọi
- Reviewer được gọi
- Lifecycle events publish
- SSE nhận agent.started
- SSE nhận agent.completed
- Completion fact xuất hiện trong Memory
- HTTP retrieval trả fact liên quan
- Terminal session không recover

## Quality Gates

- E2E + HTTP Tests 2/2 PASS
- Lint PASS
- Typecheck PASS
- Diff Check PASS

---

# Sprint 10 Exit Criteria

HTTP
✅ PASS

CLI
✅ PASS

SSE
✅ PASS

Builder
✅ PASS

Reviewer
✅ PASS

Memory
✅ PASS

Recovery
✅ PASS

---

# Sprint 10 Outcome

Node hiện sở hữu đầy đủ execution layer:

- Runtime Service
- Agent Runtime
- HTTP API
- SSE Runtime Stream
- CLI Adapter
- External Agent Contract
- Builder Adapter
- Reviewer Adapter
- Event Pipeline
- Memory Pipeline
- Recovery Compatibility

Sprint 10 hoàn tất thành công.

Status: COMPLETE ✅