Chốt thiết kế 0d như sau.

  Mục tiêu

  Tách dữ liệu ticket khỏi trạng thái runtime:

  roadmap-store
    -> ticket title, objective, dependencies, acceptance criteria

  ticket-status-store
    -> pending, blocked, running, reviewing, done, failed,
       cancelled, needs_human_review

  Không xóa hoặc thay đổi ticket trong roadmap khi cập nhật runtime status.

  0d.1 — Status enum và transition matrix

  Tạo constants dùng chung:

  const TICKET_STATUSES = [
    "pending",
    "blocked",
    "running",
    "reviewing",
    "done",
    "failed",
    "cancelled",
    "needs_human_review"
  ];

  Transition hợp lệ:

  pending             -> blocked
  pending             -> running
  pending             -> cancelled
  blocked             -> pending
  blocked             -> cancelled
  running             -> reviewing
  running             -> failed
  running             -> cancelled
  reviewing           -> done
  reviewing           -> failed
  reviewing           -> cancelled
  failed              -> pending
  needs_human_review  -> pending
  needs_human_review  -> cancelled

  Không cho phép:

  done      -> running
  done      -> pending
  cancelled -> running
  blocked   -> running
  failed    -> running

  failed và needs_human_review chỉ quay về pending, sau đó chạy guard lại.

  File dự kiến:

  backend/src/modules/projects/ticket-status.js

  0d.2 — SQLite schema

  Tạo module:

  backend/src/modules/projects/ticket-status-store.js

  Bảng trạng thái hiện tại:

  CREATE TABLE IF NOT EXISTS ticket_status (
    project_id TEXT NOT NULL,
    ticket_id TEXT NOT NULL,
    status TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    details_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, ticket_id)
  )

  Bảng lịch sử:

  CREATE TABLE IF NOT EXISTS ticket_status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    ticket_id TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    reason TEXT,
    details_json TEXT,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )

  Các query phải luôn lọc cả:

  project_id + ticket_id

  để tránh lẫn ticket giữa các project.

  0d.3 — Factory và API công khai

  Factory:

  createTicketStatusStore({
    database,
    projectId,
    clock,
    createId
  })

  API:

  get(ticketId)
  getStatus(ticketId)
  create(ticketId, details)
  updateStatus(ticketId, nextStatus, details, options)
  listByStatus(status)
  getHistory(ticketId)

  Record trả về:

  {
    project_id,
    ticket_id,
    status,
    version,
    error,
    details,
    created_at,
    updated_at
  }

  create() mặc định tạo status pending, version 0.

  0d.4 — Compare-and-swap status update

  Chữ ký bắt buộc:

  updateStatus(
    ticketId,
    nextStatus,
    details = {},
    { expectedCurrentStatus } = {}
  )

  Luồng xử lý:

  1. Đọc current row theo project_id + ticket_id.
  2. Nếu chưa có row thì báo STATUS_NOT_FOUND, trừ khi caller yêu cầu create.
  3. Kiểm tra expectedCurrentStatus, nếu được truyền.
  4. Nếu status thực tế khác expected status, throw:

     STATUS_CONFLICT

  5. Kiểm tra transition matrix.
  6. Update bằng điều kiện version/status:

     UPDATE ticket_status
     SET status = ?, version = version + 1, ...
     WHERE project_id = ?
       AND ticket_id = ?
       AND version = ?
       AND status = ?

  7. Nếu số row update là 0, throw STATUS_CONFLICT.
  8. Insert vào ticket_status_history.
  9. Trả record mới.

  Toàn bộ bước update + history phải nằm trong một transaction.

  0d.5 — Dependency check

  API:

  dependenciesReady(taskId, dependencyIds)

  task-status-store chỉ nhận danh sách dependency IDs, không import roadmap-store.

  Kết quả:

  {
    ready: false,
    blocked_by: [
      { id: "FORGE-VALIDATE-001", status: "failed" },
      { id: "FORGE-VALIDATE-002", status: "not_found" }
    ]
  }

  Quy tắc:

  - Dependency chỉ sẵn sàng khi status runtime là done.
  - Không có status row thì coi là pending hoặc not_found tùy ngữ cảnh.
  - Nếu chưa sẵn sàng, caller chuyển ticket sang blocked.
  - Khi dispatch/retry lại, guard kiểm tra lại.
  - Không cần status store tự quét ngược dependency.

  0d.6 — Retry flow

  Tạo API riêng để tránh bypass guard:

  retry(ticketId, details)

  Retry chỉ cho phép:

  failed             -> pending
  needs_human_review -> pending

  Không cho retry:

  done
  cancelled
  running
  reviewing

  Sau khi chuyển về pending, /ticket <id> phải chạy lại dependency guard:

  failed
    -> pending
    -> dependency check
    -> blocked hoặc running

  0d.7 — Event integration

  Mỗi thay đổi status phát một event:

  ticket.status_change

  Payload:

  {
    project_id,
    ticket_id,
    from,
    to,
    version,
    reason,
    details,
    timestamp
  }

  Các event bổ sung:

  ticket.dependency_blocked
  ticket.retry

  Event phải được phát sau khi transaction ghi thành công, không phát event giả nếu update thất bại.

  0d.8 — Control API wiring

  Nối status store vào Control API:

  - Khi nhận ticket mới: tạo row pending.
  - Khi dependency guard fail: pending -> blocked.
  - Khi bắt đầu dispatch: pending -> running.
  - Khi Builder gửi code xong: running -> reviewing.
  - Khi commit/verification pass: reviewing -> done.
  - Khi lỗi: running/reviewing -> failed.
  - Khi user chạy lại ticket failed: failed -> pending.

  Không thay đổi logic /ticket <id> để từ chối ticket failed; chỉ thêm bước retry hợp lệ.

  0d.9 — Tests

  Bắt buộc có test cho:

  - Enum có đủ 8 trạng thái.
  - Transition hợp lệ.
  - Transition không hợp lệ.
  - needs_human_review.
  - blocked -> pending.
  - failed -> pending.
  - Dependency tất cả done.
  - Dependency failed, blocked, not_found.
  - expectedCurrentStatus đúng.
  - STATUS_CONFLICT khi expected status sai.
  - Race hai update cùng version.
  - History được ghi cùng transaction.
  - Project isolation.
  - Retry không bypass dependency guard.
  - Không xóa hoặc thay đổi roadmap ticket.
  - Event chỉ phát sau update thành công.

  File test:

  backend/tests/unit/ticket-status-store.test.js
  backend/tests/integration/ticket-status-flow.test.js

  0d.10 — Verification và cập nhật kế hoạch

  Chạy:

  node --test backend/tests/unit/ticket-status-store.test.js
  node --test backend/tests/integration/ticket-status-flow.test.js
  pnpm --dir backend lint
  pnpm --dir backend typecheck
  git diff --check

  Sau khi pass:

  - Cập nhật forge-implementation-plan.md.
  - Ghi rõ 0d hoàn tất.
  - 1a dùng dependenciesReady(taskId, dependencyIds).
  - 1c dùng pending -> running trước khi gọi Git Service createBranch().