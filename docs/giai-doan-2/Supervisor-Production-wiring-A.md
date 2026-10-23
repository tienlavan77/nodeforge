Mục tiêu:

Hoàn thiện các thành phần còn thiếu để Supervisor có thể thực sự trở thành
production execution owner.

KHÔNG bật production path trong sprint này.
KHÔNG dùng in-memory queue làm production workaround.
KHÔNG bypass Supervisor.

NF-110A — Durable Queue Production Store

- Implement persistent production store đáp ứng interface list/save hiện tại.
- Queue state phải tồn tại qua process restart.
- Persist queued / processing / completed / failed state cần thiết cho recovery.
- Không thay đổi Execution Contract nếu không có contract gap thực sự.

Acceptance:
- enqueue → persist → process restart → queue state vẫn recover được.
- Không mất command.
- Không tạo duplicate command khi recovery.


NF-111A — Supervisor State Persistence & Recovery

- Persist Supervisor registry/state.
- SupervisorManager có thể rebuild registry sau restart.
- Khôi phục Supervisor theo task_id/supervisor_id.
- Recovery phải tiếp tục từ state hợp lệ hiện tại.
- Không restart task từ CREATED nếu state đã tiến xa hơn.

Acceptance:
- Supervisor đang WAITING_AGENT / VERIFYING / REPAIRING khi restart
  → recover đúng state.
- supervisor_id/task_id/request_id/correlation_id vẫn giữ nguyên.
- Không duplicate execution.


NF-112A — Stage-1 Runner Integration

- Gắn SupervisorLoop/Supervisor Manager vào stage1-ticket-runner.
- Stage-1 task phải được đưa vào Supervisor thay vì coordinator độc lập.
- Không để Stage-1 cũ và Supervisor cùng execute một task.
- Supervisor trở thành owner của execution lifecycle.

Acceptance:
Stage-1 request
→ Supervisor
→ Supervisor state transition

Không có execution path song song.


NF-113A — Production Sender Worker

- Implement production consume `agent.request`.
- Sender Worker lấy request từ Durable Queue.
- Resolve agent qua Agent Registry.
- Gọi agent/provider thật theo production adapter hiện có.
- Publish `agent.response.received` hoặc `agent.response.failed`.
- Không chứa workflow orchestration.

Acceptance:
agent.request
→ Durable Queue
→ Sender Worker
→ real agent/provider
→ Event Bus.


NF-114A — Production Repair Worker

- Implement production consume `repair.request`.
- Gửi repair request tới agent/provider.
- Publish repair response về Event Bus.
- Không tự quyết định retry.
- Supervisor vẫn là owner của retry/attempt/state.

Acceptance:
repair.request
→ Durable Queue
→ Repair Worker
→ agent/provider
→ Event Bus
→ Supervisor.


NF-115A — Production Worker/Event Wiring

- Wire đầy đủ:
  Supervisor
  → Queue
  → Sender Worker
  → Event Bus
  → Materializer
  → Verification
  → Repair
  → Event Bus
  → Supervisor.
- Routing phải giữ đúng task_id/supervisor_id/request_id/correlation_id.
- Không worker nào được gọi worker khác trực tiếp để bypass Supervisor.

Acceptance:
Một command đi qua đúng worker và kết quả quay đúng Supervisor.


NF-116A — Infrastructure Recovery Gate

- Kiểm tra recovery cho Queue + Supervisor + Worker processing.
- Xử lý process restart tại các execution state quan trọng.
- Đảm bảo idempotency không tạo duplicate agent request.
- Chưa cần production E2E hoàn chỉnh; chỉ cần chứng minh infrastructure
  recovery hoạt động độc lập.

Acceptance:
Restart tại các điểm:
CREATED / WAITING_AGENT / MATERIALIZING / VERIFYING / REPAIRING

→ state được recover hợp lệ.


SPRINT 10A GATE

Chỉ PASS khi có evidence:

1. Durable Queue persistent thật.
2. Supervisor state persistent thật.
3. SupervisorManager recovery thật.
4. stage1-ticket-runner đã nối vào Supervisor.
5. Sender Worker production consume `agent.request`.
6. Repair Worker production consume `repair.request`.
7. Queue/Event Bus routing đúng identity.
8. Restart không mất state.
9. Restart không tạo duplicate request.
10. Không có production bypass/workaround.

KHÔNG yêu cầu production E2E ở sprint này.
Production E2E sẽ quay lại NF-117/NF-118 sau khi 10A PASS.