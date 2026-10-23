<!-- Định hướng kiến trúc cho kênh liên lạc giữa các agent/supervisor trong NodeForge. -->
# Kiến trúc liên lạc giữa các agent (dự định)

Tài liệu này ghi lại **các dự định** về cách các agent trong hệ thống multi-agent liên lạc với nhau. Đây là tầng kiến trúc — chưa phải cam kết triển khai. Các kế hoạch cụ thể tách thành plan riêng (`plan-inter-supervisor-file-claim.md`, `plan-agent-occupancy-ticket-supervisor.md`, ...).

## Trạng thái hiện tại

- Mỗi ticket chạy một **Ticket Supervisor** riêng trong cùng Control API (root-only).
- Giao việc cho Coder/Reviewer đi qua `agent.request` trên `durable-queue.js` + `file-queue-store.js` (lease, ack, reject, recover).
- Liên lạc **trong một supervisor** dùng `execution-event-bus.js` (pub/sub in-process + eventStore) và `worker-signal-bus.js` (đánh thức worker cùng tiến trình).
- Quyền ghi file quản lý bởi `ticket-change-ledger.js` theo `project_id + path`.
- **Chưa có kênh liên lạc giữa các supervisor**: không có sự kiện `file_claim_released`, không có wait queue, không có cross-supervisor messaging. Va chạm file hiện kết thúc bằng `FILE_CLAIM_CONFLICT` → `REPORT_FAILED` → retry thủ công (bằng chứng `LOG-a6df93eb-...`, `ARTIFACT-ff9d2ce5-...`).

## Nguyên tắc kiến trúc

1. **Trạng thái bền vững là nguồn sự thật; sự kiện chỉ là tín hiệu đánh thức.** Mọi quyết định (claim, waiter, ownership) phải đọc lại từ store sau restart — không tin event in-memory.
2. **Không thêm datastore/bus mới nếu hạ tầng hiện có đủ dùng.** Ưu tiên tái dùng `durable-queue`, `file-queue-store`, `execution-event-bus`, ledger hiện tại.
3. **Serialize theo đúng tài nguyên tranh chấp.** Coder occupancy serialize trên agent; file claim serialize trên `project_id + path`. Hai trục độc lập, không gộp.
4. **Lỗi hạ tầng và lỗi nghiệp vụ phân biệt rõ.** Conflict claim là trạng thái chờ hợp lệ (`FILE_CLAIM_WAITING`), không phải failure.
5. **Không có vòng đời vô hạn.** Mọi wait có timeout và đường escalate có bằng chứng.

## Các kênh liên lạc dự định

| Kênh | Mục đích | Trạng thái | Ghi chú |
|---|---|---|---|
| `agent.request` (durable queue) | Dispatch việc SV → Coder/Reviewer | Đang dùng | Cần bổ sung `available_at`/delay nếu muốn retry backoff |
| Wait queue theo path | Ticket B chờ claim file do A giữ | **Dự định** — `plan-inter-supervisor-file-claim.md` | FIFO, persist cạnh `claimPath` |
| `file_claim_released` | A báo đã release → đánh thức waiter | **Dự định** — cùng plan trên | Project-scoped, phải durable hoặc có quét phục hồi sau restart |
| Supervisor event bus (cross-SV) | Pub/sub giữa các supervisor cùng project | **Dự định** — tái dùng `execution-event-bus` nếu đủ | Chỉ tạo `supervisor-message-channel.js` nếu bus hiện tại không durable/project-scoped |
| Coder occupancy | Serialize nhiều ticket dùng chung một Coder | Đã plan — `plan-agent-occupancy-ticket-supervisor.md` | Trục agent, độc lập với trục file |
| Cross-project messaging | SV ở project khác nhau trao đổi | Out of scope | Mặc định không đánh thức waiter cross-project |

## Trạng thái và luồng dự định

- Trạng thái mới: `FILE_CLAIM_WAITING` (non-terminal) — ticket suspend bằng checkpoint, UI/record hiển thị owner đang giữ file.
- Resume: head-of-queue waiter claim lại path, **đọc lại source + checksum hiện tại** rồi mới rebuild diff (không phát lại diff cũ).
- Escalate: `claim_wait_timeout` khi hết `claim_wait_timeout_ms`; corrupt queue → `claim_queue_corrupt`; deadlock nhiều file (A giữ X đợi Y, B giữ Y đợi X) → escalate có bằng chứng, không tự steal claim.

## Điều kiện tiên quyết

Cơ chế liên lạc multi-agent chỉ triển khai **sau khi ít nhất một ticket chạy trọn vòng đời** dispatch → coder → review → approve trên pipeline hiện tại. Trước đó mọi thiết kế chỉ dừng ở plan/tài liệu.

## Quyết định còn mở

- Backoff khi retry sau `file_claim_released`: immediate hay jittered delay.
- `file_claim_released` có nên đánh thức waiter cross-project (mặc định: không).
- Ai chịu trách nhiệm quét waiter mồ côi định kỳ: scheduler trong Control API hay SV tự quét khi wake.
