<!-- Preserves the ordered historical supervisor design so repository restructuring retains its technical requirements and original reading sequence. -->
 │                         ↓
 │                    Supervisor
 │
 └──────── iVP ───────→ Repair
                           ↓
                     repair.completed
                           ↓
                       Supervisor
                           │
                           └──→ Agent request again
Supervisor lặp lại cho đến khi:
verification.passed
và task đạt điều kiện hoàn thành.
Phase 8 — Nodeforge Integration
NF-106 — Task Supervisor Gateway
Nodeforge chỉ cần:
startTask(task)
Supervisor xử lý toàn bộ lifecycle.
Khi hoàn thành:
Supervisor
    ↓
task.completed
    ↓
Nodeforge
Nodeforge không cần theo dõi từng worker.
Cuối cùng mới làm Parallel Execution
NF-107 — Concurrent Supervisor Execution
Test kiến trúc:
Task A → Supervisor A
Task B → Supervisor B
Task C → Supervisor C
đồng thời:
              Sender Pool
             /     |      \
          Agent   Agent   Agent

           Materializer Pool
             /          \
          Worker       Worker

           Verification Pool
             /          \
          Worker       Worker
Mục tiêu:
Một Supervisor bị chờ Agent không được block Supervisor khác.

Ví dụ:
Supervisor A → waiting Agent
Supervisor B → verification
Supervisor C → repair
Supervisor D → waiting Agent
tất cả vẫn chạy.
Kiến trúc cuối
                         NODEFORGE
                             │
                      start Task
                             │
                             ▼
                    ┌────────────────┐
                    │   Supervisor   │
                    │     Manager    │
                    └───────┬────────┘
                            │
             ┌──────────────┼──────────────┐
             ▼              ▼              ▼
          SUP-A           SUP-B           SUP-C
             │              │              │
             └──────────────┼──────────────┘
                            │
                         Queues
                            │
       ┌────────────────────┼────────────────────┐
       ▼                    ▼                    ▼
 Sender Worker       Materializer Worker   Verification Worker
       │                    │                    │
       ▼                    ▼                    ▼
    Agents                  VP/iVP             Result
       │                    │                    │
       └────────────────────┼────────────────────┘
                            ▼
                       Event Bus
                            │
                            ▼
                      Supervisor
                            │
                     task completed
                            ▼
                        Nodeforge
Và tôi sẽ đặt 4 nguyên tắc bắt buộc cho Builder
1. Supervisor owns state.
2. Worker never orchestrates.
3. Queue carries commands, Event Bus carries results.
4. task_id + supervisor_id + request_id phải đi xuyên suốt toàn pipeline.
Nếu làm đúng 4 nguyên tắc này thì việc từ 1 task → 100 task song song về sau chủ yếu là scale Supervisor instances và Worker pools, chứ không phải viết lại kiến trúc.