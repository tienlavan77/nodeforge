# Sprint 3 — "Bridge" (Agent Protocol)


> Tên mã: **Bridge** (Cầu) — nối Agent (bất kỳ provider nào) với Node qua 1 giao thức chuẩn,
> không lệ thuộc model cụ thể. Trích từ `SPRINT_PLAN.md`, kèm tài liệu tham khảo riêng
> `ARCHITECTURE_SPRINT3.md`.

**Mục tiêu:** chốt "Agent ↔ Node nói chuyện bằng gì" (mục 58.1) — hợp đồng quan trọng nhất về
mặt thiết kế trong 5 thứ cần chốt trước khi code Node. Tài liệu tham khảo đầy đủ:
`ARCHITECTURE_SPRINT3.md` (bản trích riêng từ `ARCHITECTURE.md`, chỉ gồm mục
3/4/5/6/29/40/41/42/44/45/52/58.1).

**Nền đã có sẵn từ Sprint 0–2 (không làm lại):**
- `core/agent.schema.json` (NF-007) — `capability_scopes`, phân biệt Node/AI profile.
- `core/envelope.schema.json` (NF-003) — bọc Event/Command, có `$defs.id`/`timestamp`/`version`.
- `core/event.schema.json` + `core/command.schema.json` (NF-005/006) — enum `type`, nguồn sự
  thật duy nhất, convention `domain.action` snake_case.
- `project/session.schema.json` + `session-store.js` (NF-039/044, Sprint 2) — persistence, chưa
  gắn Agent thật (cố ý thu hẹp phạm vi lúc đó).
- `internalBus` (NF-023, Sprint 1) — EventEmitter nội bộ watcher↔index, **tái dùng** cho
  Agent↔Index, không tạo cơ chế mới.

### Bảng phụ thuộc trong-sprint

```
NF-007, NF-003, NF-005, NF-006 (Sprint 0, Done)
NF-044 (Session module, Sprint 2, Done)
NF-023 (internalBus, Sprint 1, Done)
   │
   ├─▶ NF-047 (review baseline event/command enum vs mục 40 — có gap không?)
   │        │
   │        ▼
   │      NF-047b (nếu có gap: bổ sung type còn thiếu)
   │        │
   │        ▼
   ├─▶ NF-048 (Agent process module: spawn, wire format — quyết định thiết kế)
   │        │
   │        ▼
   │      NF-049 (Session linkage: sessions.start/sessions.finish ↔ session-store.js)
   │        │
   │        ├─▶ NF-050 (Request/Event identity + idempotency MVP)
   │        ├─▶ NF-051 (Stream stdout/stderr → internalBus)
   │        ├─▶ NF-052 (Timeout/kill cơ bản)
   │        └─▶ NF-053 (Capability declaration lúc sessions.start)
   │                 │
   │                 ▼
   │       NF-049+050+051+052+053 hội tụ ──▶ NF-054 (integration test end-to-end)
   │                                                  │
   └─▶ NF-055 (Concurrent modification — nhận diện, MVP) ─┘
                                                            │
                                                            ▼
                                                  NF-056 (exit check tổng hợp)
```

### Backlog

| ID | Ticket | Thư mục | Phụ thuộc | Est. | Acceptance criteria | Trạng thái |
|---|---|---|---|---|---|---|
| NF-047 | Review baseline `core/event.schema.json`/`core/command.schema.json` (Sprint 0) đối chiếu đúng 12 verb ở mục 40 (`sessions.start/context.request/task.status/test.request/review.request/sessions.finish` là Command; `context.ready/file.changed/test.started/test.finished/review.requested/workflow.changed` là Event). Không sửa nếu đã đúng, chỉ báo cáo gap cụ thể (verb nào thiếu, tên khác gì) | `schemas/core/` (review only) | NF-005, NF-006 | S | Báo cáo dứt khoát 12/12 verb: có trong enum hay thiếu, tên khớp hay lệch convention `domain.action` | ✅ Done — 8/12 có tương đương (tên lệch, chấp nhận không đổi — xem quyết định NF-047b); 4/12 thiếu thật: `context.request`, `task.status`, `test.started`, `review.requested` |
| NF-047b | Bổ sung đúng 4 type còn thiếu thật (không đổi tên 8 type đã có). **Tên đã chốt (không để Builder tự đặt):** Command `context.request`, Command `tasks.report_status` (domain số nhiều khớp `tasks.start`/`tasks.cancel` đã có), Event `verification.test_started` (khớp domain `verification.test_completed` đã có), Event `review.requested` (phân biệt với `review.started` đã có — đánh dấu lúc request được nhận, không phải lúc Reviewer bắt đầu làm) | `schemas/core/` | NF-047 | S | 4 type mới thêm đúng tên đã chốt; `validate:schemas` vẫn xanh; thêm fixture cho từng type mới; **không đổi bất kỳ type nào trong 8 type đã có** | ✅ Done — 2 Command vào `command.schema.json`, 2 Event vào `event.schema.json` + `node-event.schema.json` (đúng hướng Node→Agent); `node-command.schema.json` không cần sửa (Agent→Node, ngoài phạm vi Node phát). 34→38 fixture, 33 schema không đổi. 55/55 test |
| NF-048 | Agent process module (`src/modules/agents/`): spawn Agent như child process độc lập (provider-neutral — không biết bên trong là Codex/Claude/local LLM). **Quyết định thiết kế (đã chốt, không để Builder tự chọn):** wire format là newline-delimited JSON qua stdin (Node→Agent, Command) và stdout (Agent→Node, Command ngược + Event thông báo), mỗi dòng là 1 object khớp `core/envelope.schema.json`; stderr **không** parse structured, chỉ log thô | `src/modules/agents/` | NF-047 (hoặc NF-047b) | M | Spawn 1 script giả lập (fixture, không phải AI thật) → gửi được 1 Command qua stdin, nhận đúng 1 Event qua stdout, cả 2 đều validate qua Ajv với `core/envelope.schema.json` | ✅ Done — `agent-process.js`, ghép stdout theo newline trước khi parse (test riêng cho case JSON bị chia 2 chunk), stderr raw qua event riêng. 56/56 test |
| NF-049 | Session linkage: `sessions.start` (Command từ Agent) → Node tạo/liên kết `session_id` qua `session-store.js` (NF-044, Sprint 2) — dùng field `agents: string[]` đã có sẵn, KHÔNG đổi schema. `sessions.finish` → đóng session | `src/modules/agents/`, `src/modules/projects/` | NF-048, NF-044 | S | `sessions.start` → session record có `agents` chứa đúng agent id; `sessions.finish` → session đóng, dữ liệu vẫn còn (đọc lại được, đúng hành vi NF-044 đã kiểm) | ✅ Done — `agent-session-link.js`, `sessions.stop` fallback theo agent hoặc `session_id`, test qua agent fixture thật (NDJSON), 57/57 test |
| NF-050 | Request/Event identity + idempotency MVP (mục 41/42): mọi Command từ Agent phải có `request_id` (dùng `$defs.id` có sẵn từ `common.schema.json`, không tạo field mới). Node lưu `request_id` đã xử lý trong phạm vi 1 session (in-memory Map hoặc bảng SQLite riêng — Builder chọn, báo lại lý do); nhận trùng `request_id` cho request cần idempotent (`verification.run_test` — tên thật đã xác nhận ở NF-047, không phải `test.request`) → trả lại kết quả cũ, không chạy lại | `src/modules/agents/` | NF-049 | M | Gửi `verification.run_test` với cùng `request_id` 2 lần → chỉ 1 lần xử lý thật, lần 2 trả cached result; khác `request_id` → xử lý bình thường. **MVP — không cần persist qua restart Node (đó là Sprint 9 crash recovery)** | ✅ Done — `Map<session_id, Map<request_id, result>>` in-memory; từ chối request thiếu `request_id`/`session_id`; test qua agent fixture thật. 58/58 test |
| NF-051 | Agent stream → `internalBus` (mục 29, phạm vi thu hẹp — xem `ARCHITECTURE_SPRINT3.md`): capture stdout (đã parse structured ở NF-048) + stderr (raw text) theo thời gian thực, publish lên `internalBus` đã có từ Sprint 1 (NF-023) — **không** tạo Event Store thật, **không** làm WebSocket/UI (đó là Sprint 8) | `src/modules/agents/`, `src/bootstrap/` | NF-048, NF-023 (Sprint 1, Done) | S | Agent fixture in ra 5 dòng stdout → `internalBus` nhận đúng 5 message theo đúng thứ tự, không rớt, không trộn lẫn với event của watcher/index | ✅ Done — channel `agent.stream` riêng (`agent.stdout`/`agent.stderr`), tách biệt hoàn toàn kênh watcher/index. 59/59 test |
| NF-052 | Timeout/kill cơ bản (mục 44, phạm vi thu hẹp): Node set timeout khi spawn Agent (config được); vượt ngưỡng → kill process, phát **`agent.error`** (payload có `reason: "timeout"`) rồi **`agent.stopped`** — dùng lại 2 type đã có sẵn trong enum `agents` domain, **không thêm type mới** | `src/modules/agents/` | NF-048 | S | Agent fixture chạy quá timeout (giả lập bằng `sleep`) → Node kill đúng lúc, phát đúng thứ tự `agent.error`(reason=timeout) → `agent.stopped`, process không còn zombie (kiểm bằng PID) | ✅ Done — SIGTERM→SIGKILL với `terminateGraceMs` cấu hình được; đúng enum `agents.error`/`agents.stopped`; PID xác nhận biến mất (ESRCH). 60/60 test |
| NF-053b | Thêm `capability_scopes` (optional) vào `project/session.schema.json`, validate qua `oneOf` tới `core/agent.schema.json#/$defs/ai_capability_scopes` + `.../node_capability_scopes` — **không** định nghĩa lại shape (gap phát hiện khi Builder review trước NF-053, đúng quy trình đã dùng ở NF-039). Quyết định đã chốt: optional ở schema (Session record có thể tạo qua đường nội bộ/khôi phục, không chỉ Agent Protocol), bắt buộc ở tầng nghiệp vụ (handler `sessions.start`) | `schemas/project/session.schema.json` | NF-007 (Sprint 0, Done) | S | Fixture AI/Node profile hợp lệ → pass; không có field → vẫn pass (optional); sai shape (không khớp 2 `$defs`) → reject; `validate:schemas` số liệu thật; grep xác nhận không có code/schema nào khác giả định thiếu field này | ✅ Done — field tại `session.schema.json:55`, `oneOf` trực tiếp tới 2 profile `agent.schema.json` (không định nghĩa lại shape); `session-store.js:11` chỉ sửa để nạp `agent.schema.json` cho AJV resolve `$ref`, không đổi persistence/behavior khác. 2 test mới: `accepts AI and Node session capability profiles while keeping the field optional`, `rejects a session capability declaration that matches neither Agent profile`. Xác nhận test cũ NF-044 (`creates a schema-valid session...`, `rejects session records that violate...`) vẫn nguyên, không bị ảnh hưởng bởi việc sửa `session-store.js`. `validate:schemas`: 33 schema (không đổi)/41 fixture (+3). 62/62 test, lint/typecheck/`git diff --check` pass |
| NF-053 | Capability declaration lúc `sessions.start` (tên thật, không phải `session.start`): Agent gửi kèm `capability_scopes` (đúng shape `core/agent.schema.json`, NF-007) trong payload, Node validate qua Ajv rồi lưu vào session record. **Trước khi code:** kiểm tra `project/session.schema.json` (NF-039, Sprint 2) đã có field chứa capability chưa — nếu chưa, báo lại trước khi tự ý thêm field (đúng nguyên tắc review-trước-khi-sửa đã dùng ở NF-039/039b Sprint 2, không tự quyết một mình). **CHƯA enforce permission thật** (Rule Engine — Sprint 5), chỉ lưu để dùng sau | `src/modules/agents/` | NF-049, NF-007 (Sprint 0, Done), NF-053b (Done) | S | `sessions.start` thiếu `capability_scopes` hoặc sai shape → reject (Ajv), không tạo session; đúng shape → lưu nguyên vào session record; nếu cần sửa `session.schema.json`, báo cáo rõ trước khi sửa | ✅ Done — `agent-session-link.js:12` validate `capability_scopes` qua đúng 2 `$defs` AI/Node trước khi tạo Session; thiếu/sai shape → `protocol_error`, không gọi `sessionStore.create()`. Hợp lệ → lưu nguyên qua `session-store.js:35`, comment rõ *"capability declared, not yet enforced"*. **Tự phát hiện + xoá scope creep:** ban đầu có phát thêm event `capability_declared` (tự đặt, không có trong `core/event.schema.json`/`node-event.schema.json`/`internalBus`) — đã tự xoá trước khi báo cáo cuối, giữ đúng phạm vi ticket. 3 test mới: `rejects sessions.start without capability_scopes...`, `rejects sessions.start with capability_scopes outside both Agent profiles...`, `stores a Node capability profile unchanged without enforcing it`; coverage AI profile nằm trong test đã có sẵn từ NF-049 (mở rộng assertion, không tạo test trùng). 65/65 (62+3, khớp đúng số học). Gate: lint/typecheck/`validate:schemas` (33/41)/`git diff --check` đều pass |
| NF-054 | Integration test end-to-end — **2 luồng, không chỉ 1 (bổ sung sau đối chiếu mục 66.8):** (a) luồng Builder — Agent fixture `sessions.start` (kèm capability) → ghi file thật vào project fixture → Node watcher thấy (tái dùng pipeline Sprint 1 nguyên vẹn, không sửa) → `sessions.finish`; (b) luồng Reviewer — Agent fixture khác đọc file Builder vừa ghi (qua Code Index, không viết file trung gian) → gửi verdict về Node dưới dạng Command/Event có cấu trúc (không tạo file `review.md` hay tương đương). Xác nhận toàn chuỗi thật, đo được, không mock ở tầng nào | `tests/integration/` | NF-049, NF-050, NF-051, NF-052, NF-053 | M | Luồng (a): session tạo đúng, file được index (kiểm `index.db`), stream có đủ log, session đóng sạch — không leak process/handle; **luồng (b) mới:** Reviewer fixture nhận đúng nội dung file qua Code Index (không phải file trung gian tự chế), verdict tới Node dưới dạng Event có cấu trúc, `git status`/filesystem xác nhận **không có file `review.md` hay bất kỳ file "handoff" nào** được tạo ra trong quá trình này | ⚪ Backlog |
| NF-055 | Concurrent modification — nhận diện MVP (mục 45, phạm vi thu hẹp): ghi nhận file nào đang được task/session hiện tại "động vào" (đơn giản: bảng ánh xạ `session_id → path[]` trong SQLite, cập nhật khi Agent ghi file qua watcher event). 2 session khác nhau cùng lúc động vào 1 file → Node phát warning Event, **không khoá file vật lý, không throw, không chặn ghi** | `src/modules/agents/` | NF-049 | S | 2 fixture agent (2 session khác nhau) cùng ghi 1 file trong cửa sổ ngắn → Node phát đúng 1 warning Event, cả 2 lần ghi vẫn thành công (không bị chặn) | ⚪ Backlog |
| NF-056 | Exit check Sprint 3 tổng hợp | Tất cả trên | — | S | `npm test` xanh 100%, `npm run lint`, `npm run typecheck`, `npm run validate:schemas`, `npm run bootstrap:smoke`, `git diff --check` đều xanh — đúng format Gate đã dùng từ Sprint 0 | ⚪ Backlog |

**Ước tính:** S=nhỏ, M=vừa, L=lớn.

### Rủi ro cần Builder lưu ý khi code

| Rủi ro | Ảnh hưởng | Hướng xử lý đề xuất |
|---|---|---|
| NF-048 tự ý đổi wire format (vd. dùng length-prefixed thay vì newline-delimited) mà không báo | Sprint 8 (Transport thật qua WebSocket/API) phải viết lại adapter parse | Wire format đã chốt cứng trong ticket — nếu Builder thấy cần đổi, phải báo lại trước khi code, không tự quyết như đã cho phép ở `external`/`capability_scope` trước đây (lần này quyết định đã có sẵn) |
| `internalBus` (NF-051) bị dùng làm nơi lưu trữ lâu dài thay vì chỉ pass-through | Lặp lại đúng rủi ro đã ghi từ Sprint 1: "`internalBus` dễ bị lạm dụng thành Event Store tạm thời" | Nhắc lại rào chắn cũ: `internalBus` không export ra `src/application/`/`src/transport/`, chỉ nội bộ `src/bootstrap/` |
| NF-050 idempotency MVP dễ bị hiểu nhầm là đã "chống crash" hoàn chỉnh | Sprint 9 tưởng nhầm việc này đã xong, bỏ sót khi làm crash recovery thật | Ghi rõ trong Definition of Done: MVP không persist qua restart Node — đây là giới hạn cố ý, không phải thiếu sót |
| Agent fixture (script giả lập) khác hành vi Agent AI thật quá nhiều (vd. không bao giờ ghi file lỗi cú pháp, không bao giờ timeout thật) | NF-054 pass nhưng không phản ánh rủi ro thật khi có AI thật cắm vào (Sprint 8+) | Fixture nên cố tình có ít nhất 1 kịch bản "xấu" (ghi file dở dang, hoặc chạy quá timeout) để NF-052/debounce Sprint 1 được test chung, không chỉ happy path |
| NF-053 lưu `capability_scopes` nhưng chưa enforce — dễ tạo cảm giác an toàn giả | Task/Rule Engine (Sprint 5) enforce sai nếu tưởng nhầm Sprint 3 đã chặn theo capability | Ghi rõ trong session record hoặc log: "capability declared, not yet enforced" — tránh nhầm lẫn khi review Sprint 5 |

### Exit criteria

- [ ] NF-047(b): enum Command/Event khớp đủ 12 verb mục 40, không có gap ẩn
- [ ] NF-054: agent fixture chạy hết chuỗi sessions.start → ghi file → index cập nhật → sessions.finish, đo được, không mock
- [ ] check-result (lint/typecheck) PASS cho toàn bộ code Sprint 3
- [ ] NF-056 tổng hợp: toàn bộ gate xanh (test/lint/typecheck/schema/smoke/diff-check)

### Đề xuất thứ tự giao việc

1. **Ngay:** NF-047 (rủi ro cao nhất nếu bỏ qua — đúng bài học NF-039 ở Sprint 2: review trước,
   đừng giả định baseline đã đủ).
2. **Sau đó:** NF-047b (nếu có gap) → NF-048 (nền tảng cho cả nhánh còn lại).
3. **Song song sau NF-048+NF-049:** NF-050, NF-051, NF-052, NF-053 — 4 nhánh độc lập, không phụ
   thuộc lẫn nhau, chỉ cùng phụ thuộc NF-049.
4. **Riêng:** NF-055 chỉ cần NF-049, có thể làm song song với nhóm trên.
5. **Hội tụ:** NF-054 (integration, cần cả 5 nhánh) → NF-056 (exit check).

---

