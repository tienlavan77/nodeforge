# Forge — Giao Ticket cho Builder trên UI (Chat trực tiếp) + Unified Event Streaming

**Doc ID:** FORGE-UI-CHAT-001
**Liên quan:** FORGE-SCHEMA-014/014-OAI, FORGE-EXEC-001/002, FORGE-UI-030 (Sprint Run)
**Phạm vi:** Luồng Owner giao ticket trực tiếp qua chat (không qua nút Run Sprint), và cơ chế stream toàn bộ hoạt động (Agent + Node) lên Builder tab UI theo thời gian thực.

---

## 0. Bối cảnh & chiến lược

Có 2 cách Owner giao việc cho Builder:

1. **Giao trực tiếp qua Chat** (tab Builder) — Owner gõ tin nhắn, có thể tham chiếu 1 ticket cụ thể.
2. **Giao qua Sprint Plan** (nút Run trên Sprint dashboard) — đã đấu nối vào Core, dùng chung logic.

**Chiến lược:** cả 2 entry point dùng chung 1 lõi xử lý (`buildAgentTicket` → `dispatchAgentTicket` → Execution Layer → Reviewer). Nên **ưu tiên làm và validate Entry A (Chat) trước** — vì đây là môi trường 1-ticket-1-lúc, dễ quan sát và debug lỗi ở Core. Khi Core đã chạy ổn định qua Chat, Entry B (Sprint Run) tự động hưởng lợi vì dùng chung logic, không cần sửa gì thêm — tỉ lệ thành công khi chạy hàng loạt qua Sprint Plan sẽ cao hơn.

```
                    ┌─────────────────────────┐
                    │   CORE: Ticket Dispatch  │   ← xây 1 lần, dùng chung
                    │  buildAgentTicket        │
                    │  dispatchAgentTicket     │
                    │  Execution Layer         │
                    │  Reviewer routing        │
                    └─────────────────────────┘
                         ▲                ▲
                         │                │
          ┌──────────────┘                └──────────────┐
   Entry A: Chat trực tiếp                   Entry B: Sprint dashboard "Run"
   (Owner gõ /ticket <id>                    (đã đấu nối — gọi vào Core
    hoặc gõ tự do không gắn ticket)           qua API assign đã thiết kế)
```

---

## 1. Nhận diện Ticket trong Chat

Owner gõ trong chat tab Builder, 2 trường hợp:

- **Chat tự do** — không gắn ticket nào, xử lý như hội thoại thông thường hiện có.
- **Tham chiếu ticket** — dùng cú pháp tường minh:
  ```
  /ticket FORGE-UI-021a
  ```
  Node parse message, nếu khớp pattern `/ticket <id>` → tra DB lấy ticket, dùng `ticket.description` làm `instruction` chính, **không đoán mò** qua regex tự do trong câu chuyện phiếm (tránh hiểu nhầm khi Owner chỉ nhắc tới ticket_id ngoài lề).

## 2. Luồng xử lý khi Chat nhận diện Ticket

```
Owner gõ: "/ticket FORGE-UI-021a"
        │
        ▼
Node parse → tra DB → tìm thấy ticket
        │
        ▼
Check depends_on
        │
   ┌────┴────┐
  blocked   hợp lệ
    │           │
 Trả lời     buildAgentTicket(taskState, ticket)
 trong chat:  → dispatchAgentTicket
 "Ticket này         │
 đang chờ      Stream toàn bộ tiến trình NGAY
 FORGE-SCHEMA- trong cửa sổ chat hiện tại
 015 hoàn      (không chuyển UI khác)
 thành"
```

## 3. Khóa input khi ticket đang chạy

- Trong lúc `status = running`, **chặn Owner gửi thêm tin nhắn** cho ticket đó — vì Builder đang thực thi 1 round cụ thể theo `AgentRequest` đã chốt, chen ngang giữa chừng dễ tạo request mơ hồ.
- Sau khi round xong (`reviewing` / `done` / `failed`), input mở lại — tin nhắn tiếp theo của Owner tự nhiên trở thành round mới trong `transcript` (theo `conversation_mode` đã thiết kế ở FORGE-SCHEMA-014).

---

## 4. Unified Event Streaming — mọi hoạt động đều phải lên UI real-time

### 4.1. Nguyên tắc cốt lõi

Forge **không** theo mô hình agent-as-executor (như Claude Code tự gọi tool, tự đọc/ghi file). Ở Forge:

- **Agent = pure reasoner** — chỉ nhận `AgentRequest`, trả `AgentResponse` (`changes[]`, `explanation`...). Agent không tự đọc/ghi file, không tự chạy lệnh.
- **Node = executor duy nhất** — mọi hành động thật (build context, apply diff, ghi file, chạy lint/test/build) đều do Node làm qua Execution Layer.

→ Không có "agent tool trace" kiểu CLI. Nhưng **có 2 nguồn cần stream song song, đổ chung 1 kênh:**

1. **Agent side:** văn bản phản hồi của Agent, stream **token-by-token** khi model đang generate (từ `stream: true` của Anthropic/OpenAI API) — không đợi response hoàn chỉnh mới hiện.
2. **Node side:** mọi bước Node thực thi — từ build context, gửi request, tới từng bước Execution Layer, tới mọi lệnh shell (`npm run lint`, `npm test`...) — emit ngay khi bắt đầu và khi có kết quả.

### 4.2. Ví dụ luồng event xen kẽ theo thời gian thực

```
[node] Đang build context cho ticket FORGE-UI-021a...
[node] Đã gửi request tới Claude, đang chờ phản hồi...
[agent] "Tôi sẽ thêm..." (stream từng token)
[agent] "...IntersectionObserver để lazy-load ảnh..." (tiếp tục stream)
[agent] (response hoàn tất, kèm changes[] structured)
[node] Nhận response, đang verifyChecksum...
[node] checksum khớp, đang dryRunApply (search_replace_block)...
[node] apply thành công vào DocumentViewer.js
[node] đang backupFile...
[node] writeFile thành công
[node] Ran: npm run validate:schemas && npm run lint && npm run typecheck && node --test tests/unit/execution-layer.test.js
[node] ✓ exit_code 0, duration_ms 230.4
[node] đang gửi Reviewer...
[agent] (Reviewer) "Logic đúng hướng nhưng..." (stream dần)
```

### 4.3. Phân loại event type

| Loại | Ví dụ | Nguồn |
|---|---|---|
| `node.status_change` | ticket chuyển `running` → `reviewing` → `done` | Node state machine |
| `node.execution_step` | `verifyChecksum`, `applySearchReplaceBlock`, `writeFile`... | `ExecutionContext.trace[]` (đã chuẩn hóa, FORGE-EXEC-002) |
| `node.command` | Bắt đầu chạy: `npm run validate:schemas && npm run lint...` | `runLint`, `runTests`, `runBuildCheck`, mọi lệnh shell Node chạy |
| `node.command_result` | Kết quả: exit_code, stdout preview, duration | Cùng cặp với `node.command`, emit sau khi lệnh chạy xong |
| `agent.text_stream` | Text token-by-token từ Builder/Reviewer response | SSE gốc của Anthropic/OpenAI API |

### 4.4. Cấu trúc event chung

```json
{
  "event_id": "evt_00456",
  "task_id": "task_8f3a2b",
  "source": "node" | "agent",
  "type": "node.command",
  "label": "npm run validate:schemas && npm run lint && npm run typecheck && node --test tests/unit/execution-layer.test.js",
  "detail": {
    "stdout_preview": "> nodeforge@0.1.0 validate:schemas\n... +42 lines (ctrl+t to view transcript)\ni todo 0\ni duration_ms 230.411813",
    "exit_code": 0,
    "duration_ms": 230.41
  },
  "timestamp": "..."
}
```

- `stdout_preview`: giữ dạng rút gọn (`+N lines`, expand khi click) — không đẩy full stdout thô vào mỗi event nếu log dài, tốn băng thông SSE. Full log lưu vào `execution_trace_ref`, UI fetch riêng khi Owner click xem chi tiết.
- `exit_code`: bắt buộc với `node.command_result` — quyết định UI hiển thị pass (✓)/fail (✗) ngay trên dòng lệnh.

### 4.5. Quy tắc bắt buộc khi implement

- **Mọi hàm nào bên trong có gọi shell command thật** (`runLint`, `runTests`, `runBuildCheck`, hoặc bất kỳ lệnh nào tương tự) phải emit **2 event**: `node.command` (báo "đang chạy...", trước khi chạy) và `node.command_result` (báo pass/fail + stdout preview, sau khi có kết quả) — để UI hiện trạng thái "đang chạy" (spinner) rồi chuyển "đã xong" (✓/✗), giống CLI thật.
- **Mỗi bước trong `ExecutionContext.trace[]` phải emit ngay lập tức khi hàm chạy xong** — không gom hết `trace[]` rồi gửi 1 lần ở cuối pipeline. Đây là điểm cần sửa trong luồng gọi hàm hiện tại của Execution Layer: mỗi hàm (`verifyChecksum`, `writeFile`, `runLint`...) sau khi trả `ExecutionResult`, phải đồng thời push vào event stream, không chỉ append vào `trace[]` rồi thôi.
- **Thứ tự hiển thị trên UI phải đúng thời gian thực** — vì Agent trace (chậm, streaming token) và Node trace (nhanh, gần tức thời) xen kẽ nhau trong 1 task, cần giữ đúng `timestamp` để UI render đúng trình tự thật đã xảy ra.
- Không cần "Event Aggregator" hợp nhất 2 nguồn khác bản chất phức tạp — vì cả `node.*` và `agent.text_stream` đều đổ vào cùng 1 SSE channel theo `task_id`, UI chỉ cần lắng nghe 1 stream và render theo `timestamp`.

---

## 5. Vì sao không khó — hạ tầng đã có sẵn phần lớn

1. **SSE stream + batching/progress/token usage đã có** — chỉ cần thêm loại event mới (`node.command`, `node.command_result`, `node.execution_step`), không phải xây hạ tầng streaming từ đầu.
2. **`ExecutionResult`/`ExecutionContext` đã chuẩn hóa** (FORGE-EXEC-002) — là dữ liệu sẵn có để đẩy lên UI, không cần format riêng.
3. **Agent text streaming** — nếu dùng `stream: true` của Anthropic/OpenAI API (đã có trong "Chat stream qua SSE" hiện tại), phần token stream là tự nhiên có sẵn, chỉ cần forward đúng `task_id`.

Phần thật sự cần làm là **kỷ luật implement**: đảm bảo *mọi* điểm trong code (Agent gateway lẫn từng hàm Execution Layer) đều emit event ngay lập tức, không có chỗ nào "âm thầm chạy xong rồi mới báo cáo" — đây là quy tắc thiết kế, không phải rào cản kỹ thuật.

---

## 6. Việc cần làm (chưa lập ticket chi tiết, ghi nhận để phân rã sau)

- [ ] Parser `/ticket <id>` trong chat message, load ticket từ DB, check `depends_on`.
- [ ] Nối `buildAgentTicket`/`dispatchAgentTicket` vào chat pipeline hiện có, stream vào đúng cửa sổ chat.
- [ ] Cơ chế khóa input khi ticket đang `running`, mở lại khi `reviewing`/`done`/`failed`.
- [ ] Bổ sung event type `node.command`/`node.command_result` vào Execution Layer — emit trước/sau mỗi lệnh shell thật (`runLint`, `runTests`, `runBuildCheck`).
- [ ] Sửa luồng gọi hàm Execution Layer để mỗi bước trong `trace[]` emit ngay lập tức (không gom cuối pipeline).
- [ ] Đảm bảo Agent text stream (`agent.text_stream`) và Node event (`node.*`) đổ chung 1 SSE channel theo `task_id`, sắp xếp đúng theo `timestamp`.
- [ ] UI: hiển thị `stdout_preview` rút gọn + nút expand xem full log qua `execution_trace_ref`.

---

## 7. Ghi chú quan trọng

- **Ưu tiên hoàn thiện và validate qua Entry A (Chat) trước khi tin tưởng chạy hàng loạt qua Entry B (Sprint Run)** — vì Chat là môi trường quan sát 1 ticket dễ debug nhất, giúp phát hiện lỗi Core sớm trước khi orchestration nhiều ticket song song che khuất nguyên nhân.
- Việc "wire handler thật vào Execution contract" (`applyUnifiedDiff`, `applySearchReplaceBlock`, `backupFile`, `rollbackFile` thành module riêng) vẫn là điều kiện tiên quyết để cả luồng Chat lẫn Sprint Run chạy được — đây là nút thắt chung, chưa giải quyết thì cả 2 entry point đều không có gì để test thật.
