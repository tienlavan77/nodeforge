<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
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
