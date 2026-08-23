# Sprint 9 — Hardening: Failure & Recovery

## Goal

Đảm bảo Agent Runtime có khả năng:

- Persist state
- Recover state
- Replay event history
- Resume workflow
- Prevent duplicate execution

sau process restart hoặc crash.

---

# Architecture

Event Store (Persistent)
        │
        ▼
 Runtime Recovery
        │
        ▼
  Event Replay
        │
        ▼
 Workflow Resume
        │
        ▼
Idempotent Guard
        │
        ▼
Continue Execution

---

# NF-095 — Persistent Event Store ✅ PASS

Commit: 9a8441d

## Goal

Event không bị mất sau process restart.

## Deliverables

src/modules/events/persistent-event-store.js

## Kết quả

- SQLite append-only Event Store
- Persist qua restart
- Giữ event ordering
- Hỗ trợ getById()
- Hỗ trợ getByType()
- Tương thích NF-079 idempotency

---

# NF-096 — Retry Policy ✅ PASS

Commit: 66419d8

## Goal

Retry deterministic cho transient failures.

## Deliverables

src/modules/recovery/retry-policy.js

## Kết quả

- Retry deterministic
- Configurable maxAttempts
- Override theo operation
- Trả về last error chính xác

---

# NF-097 — Dead Letter Queue ✅ PASS

Commit: 85d996c

## Goal

Không làm mất failure sau khi retry exhausted.

## Deliverables

src/modules/recovery/dead-letter-queue.js

## Kết quả

- Append-only DLQ
- Lưu payload gốc
- Lưu failure reason
- Query theo type
- Giữ insert ordering

---

# NF-098 — Session Persistence ✅ PASS

Commit: b6888e3

## Goal

Agent Session không bị mất sau restart.

## Deliverables

src/modules/agent/session-store.js

## Kết quả

- Persist Agent Session
- Restore sau restart
- Giữ identity
- Giữ timestamps
- Không thay đổi lifecycle NF-088

---

# NF-099 — Runtime Recovery ✅ PASS

Commit: 4385c15

## Goal

Khôi phục session chưa hoàn thành.

## Deliverables

src/modules/recovery/runtime-recovery.js

## Kết quả

- Recover RUNNING sessions
- Recover PAUSED sessions
- Ignore COMPLETED sessions
- Ignore FAILED sessions
- Không replay event
- Không resume workflow

---

# NF-100 — Event Replay Engine ✅ PASS

Commit: 0e3c5ed

## Goal

Rebuild runtime state từ persisted event stream.

## Deliverables

src/modules/recovery/event-replay-engine.js

## Kết quả

- Rebuild task state
- Rebuild session state
- Rebuild agent state
- Failure reconstruction
- Replay deterministic
- Không publish event mới

---

# NF-101 — Workflow Resume ✅ PASS

Commit: e1e7100

## Goal

Xác định chính xác workflow tiếp tục từ đâu.

## Deliverables

src/modules/recovery/workflow-resume.js

## Kết quả

- Find next executable step
- Skip completed steps
- Không resume COMPLETED workflows
- Không resume FAILED workflows
- Dựa trên replayed plan state

---

# NF-102 — Idempotent Recovery ✅ PASS

Commit: 475e5ef

## Goal

Ngăn side effects trùng lặp sau recovery.

## Deliverables

src/modules/recovery/idempotent-recovery.js

## Kết quả

- Block completed step execution
- Block duplicate completion
- Allow pending steps
- Deterministic
- Không thay đổi Event Schema
- Không thay đổi Session Lifecycle

---

# NF-103 — Sprint 9 Integration ✅ PASS

Commit: 898b692

## Deliverables

tests/integration/failure-recovery-e2e.test.js

## E2E Verification

Persist Session
→ Persist Events
→ Crash
→ Restart
→ Recover Session
→ Replay Events
→ Resume Workflow
→ Block Duplicate Execution
→ Continue
→ Complete

## KPI

- Recovered Sessions: 1
- Replayed Events: 3
- Resume Point: STEP-2
- Final Events: 6
- Retry Success: Attempt 2
- DLQ Verified: YES
- Duplicate Execution: BLOCKED

## Verified

- Persist session + event trước crash
- Restart recover RUNNING session
- Replay event history
- Resume đúng step tiếp theo
- Block completed step re-execution
- Retry transient failures
- DLQ receive exhausted retries
- Completed workflow không resume
- Failed workflow không resume

---

# Sprint 9 Exit Criteria

Crash
→ Restart
→ Recover
→ Replay
→ Resume
→ Continue
→ Complete

Requirements:

- No Event Loss
- No Session Loss
- Recovery Works
- Replay Works
- Resume Works
- Idempotency Works
- DLQ Works

Status: PASS ✅

---

# Sprint 9 Outcome

Nodeforge Runtime hiện hỗ trợ:

- Persistent Events
- Persistent Sessions
- Runtime Recovery
- Event Replay
- Workflow Resume
- Idempotent Recovery

Sprint 9 hoàn tất.