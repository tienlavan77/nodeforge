# Pipeline NodeForge — toàn cảnh 2 tầng + vòng đời ticket

> Ngày lập: 2026-09-11 · Đọc trực tiếp từ code tại commit `c8f026b` (branch `task/FORGE-NOTIFY-001`).
> File chị em: `audit-arch.md` (kiến trúc tổng thể), `supervisor-legacy.md` (chi tiết Supervisor pipeline).

---

## TẦNG 1 — Governance / Orchestration tầng cao (Owner → Ticket)

```text
Owner (UI Chat / Dashboard)
  │
  ├─ Chat tự nhiên ──► OwnerChatService
  │      ├─ intent detect: normal_chat | ticket_create | ticket_dispatch (/ticket <id>)
  │      ├─ ticket_create → ProseTicketService (parse prose HOẶC JSON có fence)
  │      │     → validate ticket.schema (Ajv) → roadmap-store.save (version mới mỗi lần)
  │      └─ ticket_dispatch → TicketCommandParser → dispatchAgentTicket
  │
  ├─ Upload sprint plan ──► SprintPlanUploadService
  │      └─ validate sprint-plan.schema → roadmap-store
  │
  └─ RUN Sprint ──► dispatchSprint
         └─ NHÁNH 1: stage orchestration (SprintOrchestrationService)
         │     architecture-manager → sprint-leader → builder → reviewer
         │     (stream qua agentGateway, sprint-leader trả sprint-plan JSON → persist)
         │
         └─ NHÁNH 2 (pipeline chính): Promise.all(dispatchTask từng ticket)
               → supervisor runtime (Tầng 2)
```

Code tham chiếu:
- `backend/src/application/owner-chat-service.js` — intent routing, ticket input lock khi đang running
- `backend/src/application/prose-ticket-service.js` — tạo ticket từ chat (prose/JSON)
- `backend/src/application/sprint-plan-upload-service.js` — upload/update/delete sprint
- `backend/src/application/sprint-orchestration-service.js` — nhánh stage orchestration
- `backend/scripts/start-control-api.mjs:103-131` — `dispatchTask`, `dispatchTicket`, `dispatchSprint`

---

## TẦNG 2 — Supervisor runtime pipeline

Chi tiết đầy đủ xem `supervisor-legacy.md`. Tóm tắt:

```text
dispatchTicket → integration.submitTicket → startTaskExclusive (mutex theo task_id)
  → Supervisor state machine: CREATED → PREPARING → READY → REQUESTING
    → WAITING_AGENT → MATERIALIZING → VERIFYING → (REPAIRING → lặp) → COMPLETED/FAILED
  → Round controller: R1(task) → R2(planning) → R3(code) → R4+ (repair)
  → Workers: Sender (agent turns + Forge tools) → Materializer (4 gate)
    → Verification → repair loop → terminal task.completed / task.failed
```

---

## Vòng đời Ticket Status (riêng với supervisor state)

`backend/src/modules/projects/ticket-status.js`:

```text
TICKET_STATUSES: pending | blocked | running | reviewing | done | failed | cancelled
                 | needs_human_review

TRANSITIONS:
  pending   → blocked | running | cancelled
  blocked   → pending | cancelled
  running   → reviewing | failed | cancelled | needs_human_review
  reviewing → running | done | failed | cancelled | needs_human_review
  done      → (terminal)
  failed    → pending (retry)
  cancelled → (terminal)
  needs_human_review → pending | cancelled
```

Ai cập nhật:
- `stage1-task-initializer.js` (`initTask`): ensure pending → kiểm tra
  `dependenciesReady()` → blocked nếu thiếu dependency → `pending→running` khi
  đủ điều kiện (+ tạo branch `task/{ticket_id}`)
- `stage1-ticket-runner.js`: `reviewing→done` (coder_completed),
  `reviewing→running` (verification_retry), `needs_human_review` khi vượt
  round limit, `failed` khi stage1_error
- `ticket-status-store.js`: optimistic concurrency (version check +
  `STATUS_CONFLICT`), history table đầy đủ (`ticket_status_history`), emit
  `ticket.status_change` / `ticket.dependency_blocked` / `ticket.retry`

Lưu ý: ticket status **độc lập** với supervisor state machine (12 trạng thái
CREATED…COMPLETED). Hai cái hiện chưa được nối tự động — xem phần phát hiện bên dưới.

---

## Ba phát hiện (khoảng hở) khi rà code 2026-09-11

### 1. `dispatchSprint` chạy song song, bỏ qua `dependencies`

`start-control-api.mjs:129`:

```js
const results = await Promise.all(tickets.map((ticket) => dispatchTask({ ... })));
```

Toàn bộ tickets của sprint được dispatch **cùng lúc** qua `Promise.all` — ticket B
phụ thuộc ticket A vẫn chạy song song với A. Trong khi đó `ticketStatusStore.dependenciesReady()`
đã có sẵn (trả `{ready, blocked_by}`) nhưng chỉ được dùng trong
`stage1-task-initializer` (đánh dấu `blocked`), mà initializer đó chỉ nằm trong
`stage1-ticket-runner` — runner này **không có caller production** (không được wire
vào supervisor runtime).

**Hệ quả:** sprint chạy theo DAG lệch — ticket sau có thể code trên nền ticket trước
chưa xong; ticket bị dispatch trước khi dependency done không tự chờ.

### 2. Ticket status ↔ Supervisor terminal chưa có cầu nối

Supervisor kết thúc publish `task.completed` / `task.failed` (supervisor-loop
`terminal()`), nhưng **không có consumer nào** cập nhật `ticketStatusStore` hay
`roadmaps.updateTicketStatus` từ 2 event này. Tức là:

- Ticket trên UI không tự chuyển `running → done` khi supervisor chạy xong
- `dispatchTicket` đọc `ticketStatusStore.get(ticketId)` để quyết định clear
  protocol/conversation trước khi chạy lại — dữ liệu stale sẽ làm quyết định sai

Bằng chứng gián tiếp: ticket `FORGE-NOTIFY-001` có `status: "done"` kèm
`last_error` — trạng thái có vẻ được set thủ công hoặc từ đường stage1 cũ,
không phải từ supervisor terminal event.

### 3. Hai đường sprint orchestration song song tồn tại

- `SprintOrchestrationService.run`: gọi tuần tự 4 roles
  (architecture-manager → sprint-leader → builder → reviewer) qua
  `agentGateway.stream`, model hard-code `claude-haiku-4-5`, sprint-leader
  trả sprint-plan JSON fenced block → persist.
- `dispatchSprint`: supervisor pipeline (Tầng 2) qua `Promise.all`.

Cả hai đều "run sprint" nhưng语义 khác nhau (một cái là hội thoại 4 roles,
một cái là dispatch tickets). UI bấm Run đi đường nào phụ thuộc wiring —
cần consolidate hoặc đặt tên rõ ràng cho 2 luồng.

---

## Hướng đề xuất (chưa chốt — chờ Owner duyệt)

1. **Dispatch tuần tự theo DAG**: `dispatchSprint` sort tickets theo
   dependencies, chạy từng ticket chờ terminal (`task.completed`/`task.failed`)
   rồi mới dispatch ticket kế; dùng `dependenciesReady()` làm gate.
2. **Cầu nối terminal → ticket status**: subscribe `task.completed` /
   `task.failed` / `NEEDS_HUMAN_REVIEW` trong `start-control-api.mjs` (hoặc
   production-runtime) → `ticketStatusStore.updateStatus` tương ứng
   (running→reviewing/done, failed, needs_human_review) + đồng bộ
   `roadmaps.updateTicketStatus` để UI dashboard thấy.
3. **Consolidate 2 đường sprint**: đặt tên rõ (vd `sprint-plan-generation` vs
   `sprint-execution`) hoặc gộp — quyết định khi lên ticket.
