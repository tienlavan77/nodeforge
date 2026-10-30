<!-- Preserves the ordered historical supervisor design so repository restructuring retains its technical requirements and original reading sequence. -->
Nếu tôi là Sprint Leader và được giao thiết kế để Builder code theo mô hình này, tôi sẽ không cho Builder làm Supervisor + Queue + Workers trong một ticket. Tôi sẽ chia thành các tầng, mỗi ticket khóa một boundary rõ ràng.
Với Nodeforge hiện tại đã có Event Publisher/Store và Agent Runtime, tôi sẽ đi theo plan này:
Phase 1 — Contract nền tảng
NF-095 — Task Execution Contract
Định nghĩa contract chung cho toàn bộ execution flow:
task_id
supervisor_id
request_id
operation
agent_id
correlation_id
payload
Xác định lifecycle:
CREATED
→ RUNNING
→ WAITING
→ MATERIALIZING
→ VERIFYING
→ REPAIRING
→ COMPLETED
→ FAILED
Không implement worker.
NF-096 — Agent Request / Result Events
Định nghĩa event contract:
agent.request.created
agent.response.received
agent.response.failed
Mọi event phải có:
task_id
supervisor_id
request_id
để routing chính xác về Supervisor.
Phase 2 — Queue
NF-097 — Command Queue Foundation
Tạo abstraction queue:
enqueue()
dequeue()
ack()
reject()
Các queue logic:
agent.request
materializer.request
verification.request
repair.request
Chưa cần distributed queue.
Mục tiêu trước tiên là queue contract + in-memory implementation để kiểm chứng architecture.
Phase 3 — Sender
NF-098 — Agent Registry & Router
Supervisor chỉ biết:
agent_id
Sender tự resolve:
agent_id
   ↓
Agent Registry
   ↓
Adapter
Ví dụ:
builder.claude → Claude Adapter
builder.openai → OpenAI Adapter
NF-099 — Sender Worker
Sender Worker:
agent.request
      ↓
resolve agent
      ↓
send
      ↓
receive response
      ↓
publish agent.response.received
Nếu transport failure:
agent.response.failed
Sender không biết workflow.
Phase 4 — Supervisor
NF-100 — Supervisor Runtime
Đây là ticket quan trọng nhất.
Tạo:
Supervisor
SupervisorManager
Mỗi task có một instance:
task-001 → sup-001
task-002 → sup-002
task-003 → sup-003
Supervisor state machine:
CREATED
   ↓
RUNNING
   ↓
WAITING_AGENT
   ↓
WAITING_MATERIALIZER
   ↓
WAITING_VERIFICATION / WAITING_REPAIR
   ↓
...
   ↓
COMPLETED
Supervisor không gọi worker trực tiếp.
Chỉ:
publish command
       ↓
queue
và:
event
  ↓
Supervisor
NF-101 — Supervisor Event Router
Đảm bảo:
event.supervisor_id
        ↓
SupervisorManager
        ↓
đúng Supervisor instance
Ví dụ:
agent.response.received
task_id=A
supervisor_id=A

             ↓

Supervisor A
Không được rơi sang Supervisor B.
Đây là ticket cần làm rất cẩn thận vì nó quyết định khả năng chạy song song.
Phase 5 — Materializer
NF-102 — Materializer Worker
Flow:
materializer.request
        ↓
Materializer Worker
        ↓
patch analysis
        ↓
       ┌───────┐
       ▼       ▼
      VP      iVP
Phát event:
patch.valid
patch.invalid
Kèm:
task_id
supervisor_id
request_id
Phase 6 — Verification / Repair
NF-103 — Verification Worker
Nhận:
verification.request
Xử lý VP:
VP
 ↓
Verification
 ↓
verification.passed
       hoặc
verification.failed
Không tự quyết định repair.
NF-104 — Repair Worker
Nhận:
repair.request
Xử lý iVP:
iVP
 ↓
Repair
 ↓
repair.completed
Sau đó Supervisor quyết định bước tiếp.
Phase 7 — Full Supervisor Loop
NF-105 — Supervisor Execution Loop
Đây mới là lúc nối toàn bộ flow:
Task
 ↓
Supervisor
 ↓
Agent Request
 ↓
Sender Queue
 ↓
Sender
 ↓
Agent
 ↓
agent.response.received
 ↓
Supervisor
 ↓
Materializer Queue
 ↓
Materializer
 ├──────── VP ────────→ Verification
 │                         ↓
 │                  verification.result
