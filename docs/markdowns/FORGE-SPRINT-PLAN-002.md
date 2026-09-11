# Forge — Sprint Plan Tiếp Tục (Post Builder Report)

**Doc ID:** FORGE-SPRINT-PLAN-002
**Dựa trên:** Báo cáo trạng thái Builder (22/8), FORGE-UI-CHAT-001, FORGE-EXEC-001/002, FORGE-SCHEMA-014/014-OAI
**Nguyên tắc:** Forge chỉ nhận **ticket**, không nhận "phase" — phase chỉ là nhãn phân nhóm hiển thị. Mỗi ticket = 1 trách nhiệm, giao được trong 1 vòng Builder↔Reviewer.

---

## 0. Tình trạng hiện tại (từ báo cáo Builder)

### Đã hoàn thành và đang được nối
- Node Control API (port 3100), Agent Gateway (Claude/OpenAI), Owner chat gửi đúng agent, lưu history, stream SSE.
- Builder có agent tool loop cơ bản: `request_info → context → submit_code`.
- UI có đủ tab: Architecture Manager, Sprint Leader, Builder, Reviewer.
- File/DB pipeline: FileService (project-root guard, secret/path protection, queue), Watcher (polling), Indexer (`wc/index.db`, `nf/index.db`), DatabaseService.
- Verification: check tuần tự, timeout theo loại check, `verification.result` persist/event stream.
- Schema: 49 schema, 72 fixture — bao gồm Agent tool schema, Agent request/response v1.4, Claude cache context, OpenAI Responses v1.4-OAI, Execution schema (`execution-result`, `execution-context`).
- Execution Layer skeleton: `src/application/execution-layer.js` — `createExecutionResult`, `createExecutionContext`, `withExecutionResult`, `evaluateApplyResult`, `logExecutionTrace`, 9 error code chuẩn hóa.
- Test pass: `validate:schemas`, `lint`, `typecheck`, `build:web`, `git diff --check`.

### Khoảng trống/rủi ro đã xác nhận
1. Execution contract **chưa wire vào handler thật** — `applyUnifiedDiff`, `applySearchReplaceBlock`, `backupFile`, `rollbackFile` chưa tồn tại thành module riêng. **Đây là nút thắt lớn nhất.**
2. Watcher/Control API chạy trên VPS — PID trên macOS không phản ánh đúng process VPS (vấn đề vận hành, không phải kiến trúc).
3. `.node-control` cũ cần dọn, tránh nhầm database legacy.
4. Worktree nhiều thay đổi chưa commit, nhiều file sprint/untracked.
5. Chưa có smoke test end-to-end duy nhất: UI chat/Run → gateway → FileService → watcher → wc/index.db → verification → history/SSE.

### Quyết định đã chốt
- **Không rollback** về mốc "sau UI sprint" — kiến trúc cốt lõi đã đúng hướng, test pass. Rollback sẽ phá hủy toàn bộ Phase 1-2 đã làm đúng.
- Chiến lược ưu tiên: **hoàn thiện Core qua Entry A (Chat trực tiếp) trước**, vì dễ quan sát/debug 1 ticket. Entry B (Sprint Run) đã đấu nối sẵn vào Core nên tự động hưởng lợi khi Core ổn định, không cần sửa riêng.

---

## 1. Sơ đồ phụ thuộc tổng thể

```
[Nhóm A] Wire Execution Handlers  ──┐
                                     ├──► [Nhóm C] Unified Event Streaming ──► [Nhóm D] Chat Entry Point
[Nhóm B] Dọn vệ sinh Ops           ──┘                                              │
                                                                                     ▼
                                                                          [Nhóm E] Validate qua Chat (chạy thử thật)
                                                                                     │
                                                                                     ▼
                                                                    [Nhóm F] Quality Layer (Reviewer, Test)
                                                                                     │
                                                                                     ▼
                                                                    [Nhóm G] Shared Infra (Project Map)
                                                                                     │
                                                                                     ▼
                                                                    [Nhóm H] Sprint Leader Agent + E2E Smoke Test
```

---

## 2. Backlog phẳng theo nhóm ưu tiên

### [Nhóm A — Wire Execution Handlers] — ƯU TIÊN CAO NHẤT

| Ticket | Nội dung | Input cần trước |
|---|---|---|
| FORGE-EXEC-001a | Module `applyUnifiedDiff` — parse + dry-run + apply unified diff | — |
| FORGE-EXEC-001b | Module `applySearchReplaceBlock` — tìm `oldStr` unique match, thay `newStr` | — |
| FORGE-EXEC-001c | Module `applyFullFileReplace` — ghi đè toàn bộ nội dung | — |
| FORGE-EXEC-001d | Module `applyStructuredPatch` — áp dụng theo `operations[]` | — |
| FORGE-EXEC-001e | Module `backupFile`/`rollbackFile` — snapshot trước ghi, khôi phục khi fail | — |
| FORGE-EXEC-001f | Wire 5 module trên vào `dispatchChange` trong `execution-layer.js`, đảm bảo mỗi module trả đúng `ExecutionResult` (FORGE-EXEC-002) | 001a→e |

### [Nhóm B — Dọn vệ sinh Ops]

| Ticket | Nội dung | Input cần trước |
|---|---|---|
| FORGE-OPS-001a | Dọn thư mục `.node-control` cũ, xác nhận không còn tham chiếu database legacy | — |
| FORGE-OPS-001b | Commit/dọn worktree hiện tại — phân loại file sprint/untracked, commit có ý nghĩa hoặc `.gitignore` | — |
| FORGE-OPS-001c | Xác nhận cơ chế Watcher/Control API chạy đúng trên VPS, tài liệu hóa cách kiểm tra process (không dùng PID macOS) | — |

### [Nhóm C — Unified Event Streaming] (theo FORGE-UI-CHAT-001)

| Ticket | Nội dung | Input cần trước |
|---|---|---|
| FORGE-STREAM-001a | Định nghĩa event schema chung: `node.status_change`, `node.execution_step`, `node.command`, `node.command_result`, `agent.text_stream` | Nhóm A (001f) |
| FORGE-STREAM-001b | Sửa mỗi hàm Execution Layer để emit `node.execution_step` ngay khi có `ExecutionResult`, không gom cuối pipeline | FORGE-STREAM-001a |
| FORGE-STREAM-001c | Bổ sung emit `node.command`/`node.command_result` quanh mọi lệnh shell thật (`runLint`, `runTests`, `runBuildCheck`) — 2 event/lệnh (bắt đầu + kết quả) | FORGE-STREAM-001a |
| FORGE-STREAM-001d | Forward `agent.text_stream` từ SSE gốc Anthropic/OpenAI (`stream:true`) vào cùng kênh theo `task_id` | FORGE-STREAM-001a |
| FORGE-STREAM-001e | Đảm bảo tất cả event cùng `task_id` sắp đúng thứ tự theo `timestamp` khi UI render | FORGE-STREAM-001b→d |

### [Nhóm D — Chat Entry Point] (theo FORGE-UI-CHAT-001)

| Ticket | Nội dung | Input cần trước |
|---|---|---|
| FORGE-UI-031-CHAT | Parser `/ticket <id>` trong chat, tra DB, check `depends_on`, báo `blocked` nếu chưa đủ điều kiện | Nhóm A |
| FORGE-UI-032-CHAT | Nối `buildAgentTicket`/`dispatchAgentTicket` vào chat pipeline hiện có, stream vào đúng cửa sổ chat qua kênh Nhóm C | FORGE-UI-031-CHAT, Nhóm C |
| FORGE-UI-034 | Khóa input khi ticket `running`, mở lại khi `reviewing`/`done`/`failed`; tin nhắn tiếp theo tự thành round mới trong `transcript` | FORGE-UI-032-CHAT |

### [Nhóm E — Validate qua Chat]

| Ticket | Nội dung | Input cần trước |
|---|---|---|
| FORGE-VALIDATE-001 | Chạy thử 2-3 ticket thật qua Chat, quan sát toàn bộ event stream, ghi nhận lỗi Core (nếu có) để vá ngược lại Nhóm A | Nhóm D |
| FORGE-VALIDATE-002 | Xác nhận Sprint Run (Entry B, đã đấu nối sẵn) hoạt động đúng với cùng Core đã validate — không sửa gì thêm, chỉ kiểm chứng | FORGE-VALIDATE-001 |

### [Nhóm F — Quality Layer]

| Ticket | Nội dung | Input cần trước |
|---|---|---|
| FORGE-SCHEMA-015 | Schema Request/Response Reviewer Agent (`review_context`, `verdict`, `issues[]`) | Nhóm E |
| FORGE-QUALITY-001 | Logic route `review_status` (approved/needs_revision/rejected), giới hạn 3 vòng Builder↔Reviewer | FORGE-SCHEMA-015 |
| FORGE-TEST-001a | Field `include_tests` trong Builder request (Builder tự sinh test) | Nhóm E |
| FORGE-TEST-001b | Schema Test Writer Agent riêng (task rủi ro cao, tránh self-review bias) | Nhóm E |
| FORGE-TEST-002a→d | Test scope: naming convention + dependency graph + coverage map → `resolved_test_files` | Nhóm G (Project Map) |

### [Nhóm G — Shared Infra: Project Map]

| Ticket | Nội dung | Input cần trước |
|---|---|---|
| FORGE-INFRA-001a | Định nghĩa cấu trúc Project Map (`imports`, `imported_by`, `test_files`, `module_role`) | — |
| FORGE-INFRA-001b | Module quét toàn bộ project lần đầu (full build), tận dụng Indexer (`wc/index.db`) đã có | FORGE-INFRA-001a |
| FORGE-INFRA-001c | Cập nhật incremental sau mỗi commit từ Execution Layer | FORGE-INFRA-001b, Nhóm A |
| FORGE-INFRA-001d | Cơ chế rebuild định kỳ chống drift | FORGE-INFRA-001c |

### [Nhóm H — Sprint Leader Agent + E2E]

| Ticket | Nội dung | Input cần trước |
|---|---|---|
| FORGE-SPRINT-001 | Schema Request/Response Sprint Leader Agent (sinh ticket phẳng, không trả ở mức phase) | Nhóm G |
| FORGE-SPRINT-002 | Validate layer: circular dependency check, `estimated_scope: large` warning, duplicate `ticket_id` | FORGE-SPRINT-001 |
| FORGE-SPRINT-003 | Tích hợp UI: form `sprint_description` → gọi Sprint Leader qua Agent Gateway → hiển thị ticket + dependency graph | FORGE-SPRINT-002 |
| FORGE-QA-001 | Smoke test E2E: UI chat/Run → gateway → FileService → watcher → wc/index.db → verification → history/SSE | Nhóm D, E, F |

---

## 3. Thứ tự triển khai đề xuất (Sprint tiếp theo)

```
Sprint N (ngay bây giờ):
  Nhóm A (wire handlers)  ──┐  chạy song song
  Nhóm B (dọn vệ sinh)     ──┘

Sprint N+1:
  Nhóm C (event streaming)
  Nhóm D (chat entry point)

Sprint N+2:
  Nhóm E (validate qua chat — vòng phản hồi vá lại Nhóm A nếu lộ lỗi)

Sprint N+3:
  Nhóm F (Reviewer + Test) // Nhóm G (Project Map)  ── có thể song song,
                                                          Nhóm F phần schema không phụ thuộc Nhóm G,
                                                          chỉ FORGE-TEST-002 mới cần Project Map

Sprint N+4:
  Nhóm H (Sprint Leader Agent + E2E smoke test) — chốt vòng lặp toàn hệ thống
```

## 4. Lý do thứ tự này

- **Nhóm A đứng đầu tuyệt đối** — đây là nút thắt duy nhất khiến cả Entry A (Chat) lẫn Entry B (Sprint Run) chưa chạy được thật. Không có gì phía sau có thể validate nếu Nhóm A chưa xong.
- **Nhóm B chạy song song Nhóm A** — không phụ thuộc kỹ thuật, chỉ là dọn dẹp, không lý do gì trì hoãn.
- **Nhóm C trước Nhóm D** — Chat entry point cần có kênh stream sẵn sàng trước khi nối vào, tránh phải sửa lại 2 lần.
- **Nhóm E là bước validate bắt buộc** trước khi tin tưởng mở rộng — đúng chiến lược đã chốt: xác nhận Core đúng qua 1 ticket đơn lẻ trước khi ký hợp đồng "hàng loạt" ở Sprint Run.
- **Nhóm F/G có thể song song** vì phần lớn là schema/thiết kế độc lập; chỉ điểm giao nhau (`FORGE-TEST-002`) cần chờ Project Map.
- **Nhóm H đặt cuối** — Sprint Leader Agent chỉ có giá trị khi toàn bộ chuỗi Ticket → Builder → Execution → Reviewer đã chạy ổn định; sinh ticket tự động sớm khi Core chưa vững sẽ tạo ra ticket không thể hoàn thành được.

---

## 5. Ghi chú cho người lập kế hoạch tiếp theo

- Mọi ticket trong bảng trên đã ở **mức giao được trực tiếp cho Builder** — không còn "phase" nào đứng làm đơn vị giao việc.
- Khi 1 nhóm phát sinh ticket con mới trong quá trình làm (VD Nhóm A lộ ra cần thêm 1 module phụ), đặt tên theo hậu tố chữ cái tiếp theo, giữ nguyên tiền tố ticket gốc để dễ trace.
- File này nên được nạp làm `stable_context.project_structure` bổ sung khi gọi Sprint Leader Agent (Nhóm H) sau này, để Agent hiểu đúng quy ước đặt tên và trạng thái hiện tại của dự án khi sinh ticket mới.
