<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
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

