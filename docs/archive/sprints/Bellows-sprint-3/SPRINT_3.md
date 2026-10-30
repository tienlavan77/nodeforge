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
   │      NF-049 (Session linkage: session.start/finish ↔ session-store.js)
   │        │
   │        ├─▶ NF-050 (Request/Event identity + idempotency MVP)
   │        ├─▶ NF-051 (Stream stdout/stderr → internalBus)
   │        ├─▶ NF-052 (Timeout/kill cơ bản)
   │        └─▶ NF-053 (Capability declaration lúc session.start)
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
| NF-047 | Review baseline `core/event.schema.json`/`core/command.schema.json` (Sprint 0) đối chiếu đúng 12 verb ở mục 40 (`session.start/context.request/task.status/test.request/review.request/session.finish` là Command; `context.ready/file.changed/test.started/test.finished/review.requested/workflow.changed` là Event). Không sửa nếu đã đúng, chỉ báo cáo gap cụ thể (verb nào thiếu, tên khác gì) | `schemas/core/` (review only) | NF-005, NF-006 | S | Báo cáo dứt khoát 12/12 verb: có trong enum hay thiếu, tên khớp hay lệch convention `domain.action` | ✅ Done — 8/12 có tương đương (tên lệch, chấp nhận không đổi — xem quyết định NF-047b); 4/12 thiếu thật: `context.request`, `task.status`, `test.started`, `review.requested` |
| NF-047b | Bổ sung đúng 4 type còn thiếu thật (không đổi tên 8 type đã có). **Tên đã chốt (không để Builder tự đặt):** Command `context.request`, Command `tasks.report_status` (domain số nhiều khớp `tasks.start`/`tasks.cancel` đã có), Event `verification.test_started` (khớp domain `verification.test_completed` đã có), Event `review.requested` (phân biệt với `review.started` đã có — đánh dấu lúc request được nhận, không phải lúc Reviewer bắt đầu làm) | `schemas/core/` | NF-047 | S | 4 type mới thêm đúng tên đã chốt; `validate:schemas` vẫn xanh; thêm fixture cho từng type mới; **không đổi bất kỳ type nào trong 8 type đã có** | ✅ Done — 2 Command vào `command.schema.json`, 2 Event vào `event.schema.json` + `node-event.schema.json` (đúng hướng Node→Agent); `node-command.schema.json` không cần sửa (Agent→Node, ngoài phạm vi Node phát). 34→38 fixture, 33 schema không đổi. 55/55 test |
| NF-048 | Agent process module (`src/modules/agents/`): spawn Agent như child process độc lập (provider-neutral — không biết bên trong là Codex/Claude/local LLM). **Quyết định thiết kế (đã chốt, không để Builder tự chọn):** wire format là newline-delimited JSON qua stdin (Node→Agent, Command) và stdout (Agent→Node, Command ngược + Event thông báo), mỗi dòng là 1 object khớp `core/envelope.schema.json`; stderr **không** parse structured, chỉ log thô | `src/modules/agents/` | NF-047 (hoặc NF-047b) | M | Spawn 1 script giả lập (fixture, không phải AI thật) → gửi được 1 Command qua stdin, nhận đúng 1 Event qua stdout, cả 2 đều validate qua Ajv với `core/envelope.schema.json` | ✅ Done — `agent-process.js`, ghép stdout theo newline trước khi parse (test riêng cho case JSON bị chia 2 chunk), stderr raw qua event riêng. 56/56 test |
| NF-049 | Session linkage: `session.start` (Command từ Agent) → Node tạo/liên kết `session_id` qua `session-store.js` (NF-044, Sprint 2) — dùng field `agents: string[]` đã có sẵn, KHÔNG đổi schema. `session.finish` → đóng session | `src/modules/agents/`, `src/modules/projects/` | NF-048, NF-044 | S | `session.start` → session record có `agents` chứa đúng agent id; `session.finish` → session đóng, dữ liệu vẫn còn (đọc lại được, đúng hành vi NF-044 đã kiểm) | ✅ Done — `agent-session-link.js`, `sessions.stop` fallback theo agent hoặc `session_id`, test qua agent fixture thật (NDJSON), 57/57 test |
| NF-050 | Request/Event identity + idempotency MVP (mục 41/42): mọi Command từ Agent phải có `request_id` (dùng `$defs.id` có sẵn từ `common.schema.json`, không tạo field mới). Node lưu `request_id` đã xử lý trong phạm vi 1 session (in-memory Map hoặc bảng SQLite riêng — Builder chọn, báo lại lý do); nhận trùng `request_id` cho request cần idempotent (`verification.run_test` — tên thật đã xác nhận ở NF-047, không phải `test.request`) → trả lại kết quả cũ, không chạy lại | `src/modules/agents/` | NF-049 | M | Gửi `verification.run_test` với cùng `request_id` 2 lần → chỉ 1 lần xử lý thật, lần 2 trả cached result; khác `request_id` → xử lý bình thường. **MVP — không cần persist qua restart Node (đó là Sprint 9 crash recovery)** | ✅ Done — `Map<session_id, Map<request_id, result>>` in-memory; từ chối request thiếu `request_id`/`session_id`; test qua agent fixture thật. 58/58 test |
| NF-051 | Agent stream → `internalBus` (mục 29, phạm vi thu hẹp — xem `ARCHITECTURE_SPRINT3.md`): capture stdout (đã parse structured ở NF-048) + stderr (raw text) theo thời gian thực, publish lên `internalBus` đã có từ Sprint 1 (NF-023) — **không** tạo Event Store thật, **không** làm WebSocket/UI (đó là Sprint 8) | `src/modules/agents/`, `src/bootstrap/` | NF-048, NF-023 (Sprint 1, Done) | S | Agent fixture in ra 5 dòng stdout → `internalBus` nhận đúng 5 message theo đúng thứ tự, không rớt, không trộn lẫn với event của watcher/index | ✅ Done — channel `agent.stream` riêng (`agent.stdout`/`agent.stderr`), tách biệt hoàn toàn kênh watcher/index. 59/59 test |
| NF-052 | Timeout/kill cơ bản (mục 44, phạm vi thu hẹp): Node set timeout khi spawn Agent (config được); vượt ngưỡng → kill process, phát **`agent.error`** (payload có `reason: "timeout"`) rồi **`agent.stopped`** — dùng lại 2 type đã có sẵn trong enum `agents` domain, **không thêm type mới** | `src/modules/agents/` | NF-048 | S | Agent fixture chạy quá timeout (giả lập bằng `sleep`) → Node kill đúng lúc, phát đúng thứ tự `agent.error`(reason=timeout) → `agent.stopped`, process không còn zombie (kiểm bằng PID) | ✅ Done — SIGTERM→SIGKILL với `terminateGraceMs` cấu hình được; đúng enum `agents.error`/`agents.stopped`; PID xác nhận biến mất (ESRCH). 60/60 test |
| NF-053b | Thêm field optional `capability_scopes` vào `project/session.schema.json` (NF-039, Sprint 2). Validate bằng `oneOf` trỏ tới `core/agent.schema.json#/$defs/ai_capability_scopes` và `#/$defs/node_capability_scopes` (đã chốt shape từ NF-007) — **không định nghĩa lại shape**, chỉ tham chiếu | `schemas/project/` | NF-007 (Sprint 0, Done) | S | Field optional (không phá session cũ thiếu field này); `oneOf` reject payload không khớp cả 2 profile; fixture mới cho cả AI và Node profile; `validate:schemas` vẫn xanh | 🔵 Đã giao cho Builder |
| NF-053 | Capability declaration lúc `sessions.start` (tên thật, không phải `session.start`): Agent gửi kèm `capability_scopes` (đúng shape `core/agent.schema.json`, NF-007) trong payload, Node validate qua Ajv rồi lưu vào session record. **CHƯA enforce permission thật** (Rule Engine — Sprint 5), chỉ lưu để dùng sau | `src/modules/agents/` | NF-049, NF-053b | S | `sessions.start` thiếu `capability_scopes` hoặc sai shape → reject (Ajv), không tạo session; đúng shape → lưu nguyên vào session record | ✅ Done — reject qua callback nội bộ `protocol_error` (không phải Event schema); AI + Node profile đều test qua SQLite thật, đọc lại nguyên vẹn; comment "declared, not yet enforced" có trong code. 73/73 test |
| NF-054 | Integration test end-to-end: Agent fixture (không phải AI thật) — `session.start` (kèm capability) → ghi file thật vào project fixture → Node watcher thấy (tái dùng pipeline Sprint 1 nguyên vẹn, không sửa) → `session.finish`. Xác nhận toàn chuỗi thật, đo được, không mock ở tầng nào | `tests/integration/` | NF-049, NF-050, NF-051, NF-052, NF-053 | M | Chạy hết chuỗi 1 lần: session tạo đúng, file được index (kiểm `index.db`), stream có đủ log, session đóng sạch — không leak process/handle (đúng chuẩn `bootstrap:smoke` đã dùng từ Sprint 0) | ✅ Done — copy fixture ra temp project (không làm bẩn repo); tự sửa giả định sai (3 row DB, không phải 1); toàn chuỗi 6 bước xác nhận thật. 73/73 test |
| NF-055a | Schema cho detector tự-khai-báo (thay hoàn toàn cách suy đoán qua watcher event ban đầu): thêm Command **`agents.report_touch`** `{ path }` và Event **`agents.concurrent_modification_detected`** `{ path, session_ids: [a, b] }` vào enum `agents` domain đã có (không tạo domain mới) | `schemas/core/` | NF-047b | S | 2 type mới đúng convention `domain.action`; `validate:schemas` xanh; fixture cho cả 2 | ✅ Done — cả 2 type xác nhận có trong `event.schema.json:68`/`node-event.schema.json:49`/`command.schema.json:45`, fixture đăng ký đủ. 33 schemas/44 fixtures, 72/72 test |
| NF-055 | Concurrent modification — detector tự-khai-báo (**thiết kế lại, đã duyệt** — thay hoàn toàn cách suy đoán qua watcher event ban đầu, xem lý do ở ghi chú dưới bảng): Agent gửi `agents.report_touch{path}` ngay trước/sau khi ghi file → Node ghi `(session_id, path, touched_at)` vào SQLite dùng chung với `session-store.js`; mỗi lần ghi, query row cùng `path` khác `session_id` trong cửa sổ 2000ms (config được) → có match → phát `agents.concurrent_modification_detected` qua `internalBus`; dedup theo cặp `(session_id_a, session_id_b, path)` | `src/modules/agents/` | NF-049, NF-055a | S | 2 fixture agent (2 session khác nhau) cùng `report_touch` 1 path trong cửa sổ ngắn → đúng 1 Event, đúng 2 `session_id`; touch path khác nhau → không warning; 1 session touch nhiều lần không có session 2 → không warning; ghi file thật vẫn thành công bình thường (không throw, không khoá) | ✅ Done — `session_file_touches` (SQLite dùng chung), dọn row khi session đóng/hết hạn; comment rõ chỉ là self-declaration, không enforce. 3/3 test riêng, 72/72 tổng |
| NF-056 | Exit check Sprint 3 tổng hợp | Tất cả trên | — | S | `npm test` xanh 100%, `npm run lint`, `npm run typecheck`, `npm run validate:schemas`, `npm run bootstrap:smoke`, `git diff --check` đều xanh — đúng format Gate đã dùng từ Sprint 0 | ✅ Done — 73/73 test, toàn bộ gate xanh |

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
- [ ] NF-054: agent fixture chạy hết chuỗi session.start → ghi file → index cập nhật → session.finish, đo được, không mock
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
