# Sprint — Supervisor Execution Pipeline
## NF-096 → NF-109

Mục tiêu:
Xây dựng Supervisor-driven asynchronous execution pipeline:
NodeForge → Supervisor → Queue → Worker → Event → Supervisor,
cho phép nhiều task chạy song song, Supervisor là owner của task state.

---

## NF-096 — Patch Material Verification Contract

- Định nghĩa contract:
  submit_code_response → material verification → valid_patches[] / invalid_patches[]
- Patch identity: patch_id, path.
- Hỗ trợ formats:
  full_content, structured_patch, apply_patch, unified_diff.
- Có operation-level và file-level result.
- Kiểm tra toàn bộ response, không dừng ở patch lỗi đầu tiên.
- Material Verification không write filesystem.
- Schema + fixtures + validation.

## NF-097 — Patch Repair Contract

- Định nghĩa `node-patch-repair → Agent → patch_repair_response`.
- Request:
  task_id, repair_id, attempt, max_attempts,
  approved_plan_ref, invalid_patches[], expected_output.
- Response:
  repair_id, repaired_patches[].
- Repaired patch phải giữ đúng schema/format của patch gốc.
- Chỉ contract, chưa implement Repair Worker.

## NF-098 — Event Bus

- `publish()` / `subscribe()`.
- Routing theo supervisor_id.
- Validate event trước publish.
- Event không được route nhầm Supervisor.
- Persist event và giữ ordering.
- Hỗ trợ các execution events cần cho pipeline.

## NF-099 — Durable Queue

Queues:

- agent.request
- materializer.request
- verification.request
- repair.request

Mỗi queue hỗ trợ:

- enqueue / claim / ack / reject
- lease timeout
- retry
- dead-letter
- recovery sau restart
- idempotency theo request_id

## NF-100 — Agent Registry & Sender Worker

- Agent Registry resolve `agent_id → adapter/config`.
- Sender Worker consume `agent.request`.
- Gửi request tới configured agent/provider.
- Nhận response và publish:
  `agent.response.received`
- Send/transport failure publish:
  `agent.response.failed`.
- Sender không chứa workflow/orchestration logic.

## NF-101 — Supervisor Manager

- Nhận `task.started`.
- Tạo một Supervisor instance cho mỗi task.
- Registry hai chiều:
  `supervisor_id ↔ task_id`.
- Route event đúng Supervisor.
- Khôi phục Supervisor sau restart.
- Đóng instance khi task hoàn tất.

## NF-102 — Supervisor Runtime

Lifecycle:

CREATED
→ REQUESTING
→ WAITING_AGENT
→ MATERIALIZING
→ VERIFYING
→ REPAIRING
→ WAITING_REPAIR
→ COMPLETED / FAILED / NEEDS_HUMAN_REVIEW

Supervisor:

- chỉ publish command và xử lý event.
- không gọi Worker trực tiếp.
- quyết định retry/next step.
- giữ task execution state.

## NF-103 — Materializer Worker

Flow:

materializer.request
→ kiểm tra toàn bộ response
→ valid_patches[]
→ invalid_patches[]

- VP → verification.request
- iVP → repair.request
- Không write filesystem.
- Publish result event về Supervisor.

## NF-104 — Verification Worker

Kiểm tra VP:

- checksum/revision
- materialized content
- syntax
- acceptance criteria
- build/lint nếu policy yêu cầu

Kết quả:

- `verification.passed`
- `verification.failed`

Failure quay về Supervisor để quyết định repair.

## NF-105 — Repair Worker

Flow:

repair.request
→ Agent sửa invalid_patches
→ patch_repair_response
→ materialize lại

- Pass → verification queue.
- Fail → báo Supervisor.
- Supervisor quyết định attempt tiếp theo.
- Hết max_attempts → NEEDS_HUMAN_REVIEW.

Repair Worker không tự điều phối workflow.

## NF-106 — Full Supervisor Loop

Nối toàn bộ pipeline:

Task
→ Supervisor
→ Sender
→ Agent
→ Materializer
→ VP → Verification
→ iVP → Repair
→ Materializer
→ Verification
→ ...

Lặp đến khi toàn bộ patch pass hoặc task đi vào FAILED / NEEDS_HUMAN_REVIEW.

Mọi worker result phải quay về Supervisor bằng event.

## NF-107 — Atomic Apply Gate

Chỉ cho phép apply khi:

all patches verified
→ final materialization
→ syntax/build
→ atomic write
→ commit
→ task.completed

Không partial write.
Không commit khi còn patch chưa pass.

## NF-108 — NodeForge Integration

NodeForge chỉ cần:

`startTask(task) → task.started`

Supervisor trả:

- `task.completed`
- `task.failed`
- `task.needs_human_review`

NodeForge không trực tiếp điều phối Worker.

## NF-109 — Concurrent Supervisor Execution

Chứng minh nhiều task chạy đồng thời:

Task A → Supervisor A
Task B → Supervisor B
Task C → Supervisor C

Dùng chung:

- Sender Worker Pool
- Materializer Worker Pool
- Verification Worker Pool
- Repair Worker Pool

Nhưng Supervisor state phải hoàn toàn độc lập.

---

# Global Rules

- Supervisor owns task state.
- Worker chỉ thực hiện một loại công việc.
- Queue truyền command.
- Event Bus truyền result.
- Không Worker nào tự orchestration.
- `task_id + supervisor_id + request_id + correlation_id` phải được giữ xuyên suốt flow.
- `request_id` dùng cho idempotency.
- `correlation_id` dùng để trace execution flow.
- Không route event sang Supervisor khác.
- Không thay đổi existing contracts/schema nếu không cần thiết.
- Không thêm scope ngoài pipeline này.
- Không partial filesystem write.
- Không commit khi verification chưa pass.

# Sprint Gate

Báo cáo một lần sau khi hoàn tất toàn bộ NF-096 → NF-109:

- tất cả ticket PASS/FAIL
- schema/fixture validation
- test/lint/typecheck
- restart/recovery evidence
- retry/dead-letter evidence
- atomic apply evidence
- concurrent Supervisor evidence
- full end-to-end execution evidence

Nếu phát hiện contract gap hoặc architectural conflict:
DỪNG phần bị ảnh hưởng, báo cáo gap trước khi tự ý đổi contract.