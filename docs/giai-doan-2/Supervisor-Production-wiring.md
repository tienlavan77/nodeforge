# Sprint 10 — Supervisor Production Activation

Mục tiêu:
Nối Supervisor Execution Foundation vào Stage-1 production pipeline để task thật
được điều phối qua Supervisor → Queue → Worker → Event → Supervisor → NodeForge.

Không làm lại NF-095 → NF-109.

---

## NF-110 — Production Wiring Contract

- Xác định entrypoint production → Supervisor.
- Map Stage-1 request → task.started.
- Map task.completed / task.failed / task.needs_human_review → NodeForge.
- Không thay đổi Execution Contract đã chốt.

## NF-111 — Stage-1 → Supervisor

- start-control-api / Stage-1 runner gửi task vào Supervisor.
- Không chạy pipeline Stage-1 cũ song song cho cùng task.
- Supervisor trở thành owner execution của task được chuyển sang.

## NF-112 — Supervisor → Agent Request

- Supervisor publish agent.request vào Durable Queue.
- Sender Worker consume request.
- Agent response quay về Event Bus.
- Verify routing đúng supervisor_id/task_id/request_id.

## NF-113 — Production Materialization Flow

- Agent response → Materializer Queue.
- Materializer → valid_patches / invalid_patches.
- VP → Verification Queue.
- iVP → Repair Queue.
- Không filesystem write ngoài Atomic Apply Gate.

## NF-114 — Production Verification / Repair Loop

- Verification result → Supervisor.
- Failure → Repair Queue.
- Repair result → Materializer.
- Supervisor tiếp tục loop theo attempt/max_attempts.
- Hết retry → NEEDS_HUMAN_REVIEW.

## NF-115 — Production Atomic Apply

- Chỉ apply khi toàn bộ patch cuối cùng verified.
- Final materialization → verification → atomic write → commit.
- Không partial write.
- Không commit khi còn patch lỗi.

## NF-116 — Production Recovery

- Restart trong từng trạng thái execution.
- Durable Queue recovery.
- Supervisor recovery.
- Không tạo duplicate request sau restart.
- Task tiếp tục từ state hợp lệ thay vì chạy lại từ đầu.

## NF-117 — Stage-1 Production E2E

Chạy task thật:

task.started
→ Supervisor
→ Agent
→ Materializer
→ Verification / Repair
→ Atomic Apply
→ commit
→ task.completed
→ NodeForge

Không mock Worker/Queue trong production path.

## NF-118 — Concurrent Production E2E

Chạy đồng thời tối thiểu:

Task A → Supervisor A
Task B → Supervisor B
Task C → Supervisor C

Dùng chung Worker Pools nhưng state hoàn toàn độc lập.

---

# Global Rules

- Không sửa lại NF-095 → NF-109 nếu không phát hiện contract gap thực sự.
- Không bypass Supervisor để gọi Worker trực tiếp.
- Queue truyền command.
- Event Bus truyền result.
- Supervisor là owner của task execution.
- Không partial filesystem write.
- Không commit trước khi toàn bộ patch pass.
- Production path phải dùng Durable Queue + Event Bus thật.
- Không để Stage-1 cũ và Supervisor cùng xử lý một task.
- Nếu phát hiện conflict với pipeline hiện tại: dừng phần wiring bị ảnh hưởng và báo cáo.

# Sprint Gate

Phải báo cáo:

- NF-110 → NF-118 PASS/FAIL.
- Production E2E evidence.
- Agent request/response evidence.
- Materializer VP/iVP evidence.
- Verification → Repair loop evidence.
- Atomic write + commit evidence.
- Restart/recovery evidence.
- Concurrent Supervisor evidence.
- Test/lint/typecheck/schema validation.