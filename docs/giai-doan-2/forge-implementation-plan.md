# Kế hoạch triển khai — Forge Node↔Agent Protocol

> File này là kế hoạch sống — cập nhật trực tiếp vào đây khi có thay đổi, không tạo file mới cho mỗi lần chỉnh sửa.
> Xem chi tiết thiết kế schema/luồng đầy đủ tại `forge-node-agent-protocol.md`.

**Nguyên tắc chỉ đạo:** xây 1 đường đi trọn vẹn (happy path) cho 1 ticket đơn giản trước, thêm guard sau, thêm multi-agent sau cùng. Không làm đúng toàn bộ schema/guard ngay từ đầu — sửa sau khi có dữ liệu chạy thật rẻ hơn đoán trước.

---

## Giai đoạn 0 — Nền tảng

> 4 nhóm (`0a` schema, `0b` storage, `0c` git, `0d` ticket store) **độc lập nhau, làm song song được**. `0e` (adapter) là nhóm duy nhất phụ thuộc vào các nhóm kia — xem "Thứ tự tổng thể" cuối bảng.

### 0a — Schema & validate

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 0a-1a | Liệt kê đủ giá trị `type` hợp lệ trong enum | ☐ Chưa làm | `task, code_needed, code_provide, usage_query, usage_needed, no_wiring_needed, status_check, completed, continue`. Chốt danh sách này trước — mọi schema khác tham chiếu lại nó. |
| 0a-1b | Viết `envelope.schema.json` (JSON Schema, ajv-compatible) | ☐ Chưa làm | `request_id, parent_id, type (enum 0a-1a), role (node\|agent), payload (object, mở — validate chi tiết ở 0a-4), timestamp`. |
| 0a-1c | Viết bộ test case tối thiểu cho envelope (2-3 case hợp lệ, 2-3 case sai) | ☐ Chưa làm | Vd thiếu `request_id`, `type` không nằm trong enum, `role` sai giá trị — xác nhận `ajv` bắt đúng lỗi trước khi dùng cho phần còn lại. |
| 0a-2 | Schema payload chiều **Node → Agent** | ✅ Đã có | `developer_blocks/transcript_blocks/user_blocks/expected_output/metadata`. |
| 0a-3 | Schema payload chiều **Agent → Node** (6 type, Claude + OpenAI) | ✅ Đã có | File `forge-agent-response-schemas.json`. |
| 0a-5a | Chốt danh sách field đổi tên/thêm mới cho biến thể `1.4-anthropic` | ☐ Chưa làm | `developer_blocks→system_blocks`, `cache_control` (thay `cacheable:true` rời rạc), `expected_output.delivery`, `transcript_blocks[].in_window`. |
| 0a-5b | Ghi file `payload-anthropic.schema.json` theo 0a-5a | ☐ Chưa làm | Adapter Claude (0e-2/0e-3) đọc trực tiếp field theo đúng tên ở đây. |
| 0a-4a | Viết schema registry: map `(type, role) → schema tương ứng` | ☐ Chưa làm | Cần 0a-1b, 0a-2, 0a-3, 0a-5b xong trước — registry chỉ là bảng tra, chưa có logic. |
| 0a-4b | Viết hàm `validateEnvelope(envelope)` — validate shape envelope + payload theo registry | ☐ Chưa làm | Giai đoạn 0 chỉ validate SHAPE (đúng field, đúng kiểu) — CHƯA validate state/protocol (vd "type này có hợp lệ ở step hiện tại không"), phần đó thêm sau khi có state machine (1d), tái dùng cùng hàm này với tham số `state` (hiện để optional/không dùng tới). |
| 0a-4c | Viết test cho `validateEnvelope` bằng chính các ví dụ JSON đã thống nhất trong thiết kế | ☐ Chưa làm | Dùng lại nguyên các payload mẫu trong `forge-node-agent-protocol.md` làm test case — không cần bịa case mới. |

### 0b — Storage layer

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 0b-1 | Quyết định backend lưu trữ | ☐ Chưa làm | MVP: file JSON trên disk theo cấu trúc `storage/<task_id>/round_<n>/request.json` \| `response.json`. Chưa cần SQLite/DB ở giai đoạn này. |
| 0b-2 | Viết `save(ref, data)` / `get(ref)` | ☐ Chưa làm | `ref` là string dạng path (`task/FORGE-UI-037/round_1/request`) — map trực tiếp sang đường dẫn file thật. |
| 0b-3 | Viết `list(task_id)` (liệt kê mọi ref thuộc 1 task) | ☐ Chưa làm | Dùng cho 0e-1 (resolve transcript) và sau này cho việc build report cuối (Giai đoạn 6). |

### 0c — Git wrapper

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 0c-1 | Chọn cách gọi git: thư viện (`simple-git`) hay `exec` CLI trực tiếp | ☐ Chưa làm | Thư viện dễ bắt lỗi có cấu trúc hơn — khuyến nghị dùng thư viện nếu ngôn ngữ có sẵn (Node.js: `simple-git`). |
| 0c-2 | `createBranch(name)` | ☐ Chưa làm | |
| 0c-3 | `commit(message, files)` | ☐ Chưa làm | |
| 0c-4 | `merge(branch, {noFastForward: true})` — có phát hiện conflict | ☐ Chưa làm | Trả về rõ ràng `{success, hasConflict}` — không tự resolve conflict (đúng nguyên tắc đã chốt ở Giai đoạn 4). |
| 0c-5 | `discardBranch(name)` | ☐ Chưa làm | Dùng khi verify fail hẳn, huỷ toàn bộ nhánh task. |

### 0d — Ticket store

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 0d-1 | Chốt schema ticket + enum trạng thái | ☐ Chưa làm | Dựa theo ticket mẫu `FORGE-UI-037` đã có, thêm field `status: blocked\|in_progress\|coder_completed\|done\|needs_human_review\|merge_conflict`. |
| 0d-2 | Viết `getTicket(ticket_id)` / `getStatus(ticket_id)` / `updateStatus(ticket_id, status)` | ☐ Chưa làm | MVP: mỗi ticket 1 file JSON trong `tickets/<ticket_id>.json`. |
| 0d-3 | Viết `checkDependencies(ticket)` | ☐ Chưa làm | Dùng `getStatus` cho từng id trong `ticket.dependencies` — trả `true` nếu tất cả đều `done`. Đây chính là guard [5], nhưng bản thân hàm thuộc về 0d (ticket store biết cách tự kiểm tra), guard chỉ là nơi *gọi* hàm này ở Giai đoạn 1. |

### 0e — Adapter Claude

*(đã chi tiết hoá — giữ nguyên như bảng trước)*

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 0e-1 | `resolveTranscript(payload)` | ☐ Chưa làm | Cần 0b-2 xong. |
| 0e-2 | `buildSystemParam(payload)` | ☐ Chưa làm | Cần 0a-5b xong. |
| 0e-3 | `buildMessages(payload)` | ☐ Chưa làm | Cần 0e-1. |
| 0e-4 | `buildToolConfig(payload)` | ✅ Input đã có (0a-3) | |
| 0e-5 | `callClaude(...)` | ☐ Chưa làm | Cần 0e-2, 0e-3, 0e-4. |
| 0e-6 | `normalizeResponse(rawResponse)` | ☐ Chưa làm | Làm trước 0e-5 — test bằng response mẫu. |
| 0e-7 | `claudeAdapter.call(genericPayload)` | ☐ Chưa làm | Gộp 0e-1→0e-6. |

### Thứ tự tổng thể khuyến nghị

```
Làm song song (không phụ thuộc nhau):
  0a-1a → 0a-1b → 0a-1c        (envelope schema)
  0a-5a → 0a-5b                 (payload variant Anthropic)
  0b-1 → 0b-2 → 0b-3            (storage)
  0c-1 → 0c-2..0c-5             (git wrapper)
  0d-1 → 0d-2 → 0d-3            (ticket store)

Sau khi 0a-1b + 0a-5b xong:
  0a-4a → 0a-4b → 0a-4c         (validate function)

Sau khi 0a-5b + 0b-2 xong (0a-3 đã có sẵn):
  0e-6 → 0e-2/0e-3/0e-4 → 0e-1 → 0e-5 → 0e-7   (adapter, theo đúng thứ tự test-được-sớm đã bàn)
```

---

## Giai đoạn 1 — Happy path (không guard nặng, không retry)

> Khác Giai đoạn 0 (4 nhóm độc lập), Giai đoạn 1 là **1 luồng tuần tự duy nhất** — thứ tự trong bảng chính là thứ tự gọi hàm thật. Toàn bộ bước dưới đây chỉ dùng `format: full`, bỏ qua `unified_diff`/`patch` (đó là Giai đoạn 5); bỏ qua `usage_query`/`status_check` (đó là Giai đoạn 2) — patch xong 1 file là coi như xong.

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 1-1 | `initTask(ticket)` | ☐ Chưa làm | Gọi `checkDependencies(ticket)` (0d-3) → nếu fail, dừng, `updateStatus(blocked)`. Nếu pass: `git.createBranch('task/<ticket_id>')` (0c-2), `updateStatus(in_progress)` (0d-2), ghi log bước khởi tạo (xem 1-6). |
| 1-2 | `buildTaskRequest(ticket)` | ☐ Chưa làm | Đọc ticket → build `envelope + payload` (`type: task, role: node`) đúng schema 0a-2 (developer_blocks: convention tĩnh viết tay/đọc từ config; user_blocks: task_context + acceptance_criteria lấy trực tiếp từ field ticket). Validate bằng `validateEnvelope()` (0a-4b) TRƯỚC khi qua bước tiếp — request sai schema thì dừng ngay tại đây, không gửi đi. |
| 1-3 | `sendRequest(envelope)` | ☐ Chưa làm | Gọi `claudeAdapter.call()` (0e-7) — hoặc mock (1-7) nếu đang test. Ghi log **trước khi gửi**: `{event: "request_sent", request_id, type, role, timestamp}` (chi tiết log xem 1-6). |
| 1-4 | `receiveResponse(rawEnvelope)` | ☐ Chưa làm | Validate response bằng `validateEnvelope()` (0a-4b) — response sai schema thì dừng, coi là lỗi (chưa có retry ở giai đoạn này, chỉ log lỗi và thoát). Ghi log **sau khi nhận**: `{event: "response_received", request_id, parent_id, type, duration_ms, status}`. |
| 1-5 | `routeResponse(envelope)` — rẽ nhánh theo `envelope.type` | ☐ Chưa làm | `code_needed` → đi 1-5a. `code_response` → đi 1-5b. Type khác ở giai đoạn này coi là lỗi (chưa hỗ trợ). |
| 1-5a | Nhánh `code_needed`: đọc file thật, build `code_provide`, quay lại 1-3 | ☐ Chưa làm | `fs.readFileSync` từng path trong `files_requested`; nếu file không tồn tại → `{content: null, exists: false}` (đúng thiết kế đã chốt). Build envelope mới (`type: code_provide, role: node`), validate, quay lại 1-3. |
| 1-5b | Nhánh `code_response`: validate format, patch file, kết thúc | ☐ Chưa làm | Giai đoạn này CHỈ chấp nhận `format: "full"` — nếu agent trả `unified_diff`/`patch` thì coi là lỗi, dừng (không cần escalation logic của Giai đoạn 5 ở đây). Patch = `fs.writeFileSync` + `git.commit()` (0c-3) cho từng file trong `files[]`. Xong thì `updateStatus(coder_completed)`, ghi log kết thúc, dừng vòng lặp — **chưa merge vào main** (đó là Giai đoạn 4). |
| 1-6 | Hard-code 1 ticket đơn giản để test | ☐ Chưa làm | 1 file JSON tĩnh (dùng lại `FORGE-UI-037` rút gọn — 1-2 file cần sửa, không cần đủ 4 file như ví dụ đầy đủ) để chạy thử toàn bộ 1-1→1-5 mà không cần ticket store thật đầy đủ. |
| 1-7 | Mock response agent cho từng round | ☐ Chưa làm | Viết sẵn 2 response mẫu tĩnh: round 1 trả `code_needed` (hỏi 1 file), round 2 trả `code_response` (format `full`) — dùng thay `sendRequest` thật ở 1-3 để test toàn bộ state machine (1-1→1-5) TRƯỚC KHI gọi Claude adapter thật. |
| 1-8 | Chạy thử bằng mock (1-6 + 1-7) | ☐ Chưa làm | Xác nhận toàn bộ luồng 1-1→1-5b chạy đúng, file được patch đúng nội dung, log ghi đủ — mọi lỗi ở bước này là lỗi logic điều phối, không phải lỗi agent. |
| 1-9 | Chạy thử bằng adapter thật (0e-7) | ☐ Chưa làm | Chỉ làm SAU KHI 1-8 pass. Thay `sendRequest` mock bằng `claudeAdapter.call()` thật, giữ nguyên ticket ở 1-6 — nếu lỗi ở bước này, đã tách được là lỗi do agent/API, không phải lỗi state machine. |
| 1-10 | Logging tuần tự — chuẩn cấu trúc log dùng chung cho 1-3/1-4 | ☐ Chưa làm | `{ timestamp, task_id, step_id, type, role, request_id, parent_id, duration_ms, status }`. Đây là guard xuyên suốt (áp dụng tại 1-3 và 1-4), không phải 1 bước đứng riêng ở cuối — liệt kê ở đây để có 1 chỗ định nghĩa format log dùng chung, tránh mỗi chỗ tự ghi 1 kiểu. |

**Thứ tự làm khuyến nghị:** `1-6, 1-7` (chuẩn bị fixture) → `1-1 → 1-2 → 1-3 → 1-4 → 1-5/1-5a/1-5b` (viết luồng chính, log theo 1-10 lồng trong 1-3/1-4) → `1-8` (test bằng mock) → `1-9` (test bằng adapter thật). Không viết 1-9 trước khi 1-8 pass — mục đích chính của việc tách mock là để không phải đoán lỗi nằm ở đâu khi cả state machine lẫn agent đều mới.

---

## Giai đoạn 2 — Khép vòng lặp 9 bước đầy đủ

> Nối tiếp trực tiếp từ 1-5b (patch xong, dừng) — Giai đoạn này thay đoạn "dừng" đó bằng: kiểm tra file mồ côi → wiring nếu cần → status_check → completed/continue. `2c` (dependency graph) phải xong TRƯỚC `2a` vì usage_query cần graph để tự phát hiện file mồ côi. `2d` (code index) độc lập, không chặn phần còn lại.

### 2c — Dependency graph (làm trước 2a)

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 2c-1 | Viết parser trích `import`/`require` cơ bản (regex, chỉ JS/ESM cho MVP) | ☐ Chưa làm | Chưa cần AST đầy đủ — ticket hiện tại toàn file `.js`, đủ dùng bằng regex bắt `import ... from '...'`. |
| 2c-2 | `buildGraphForFile(path)` → `{imports: [], importedBy: []}` | ☐ Chưa làm | Quét 1 lần lúc cần (lazy), chưa cần cache toàn bộ project ở bước này. |
| 2c-3 | `isImportedAnywhere(path)` | ☐ Chưa làm | Dùng trực tiếp trong 2a để quyết định có cần `usage_query` hay không. |
| 2c-4 | `updateGraphAfterPatch(file)` | ☐ Chưa làm | Gọi ngay sau mỗi lần patch (trong 1-5b và trong nhánh wiring ở 2a) — graph tự "mọc" theo patch, không cần agent khai báo. |

### 2a — usage_query / usage_needed / no_wiring_needed

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 2a-1 | Refactor: rút phần "gửi code_needed → nhận → patch" (1-5a/1-5b) thành 1 hàm dùng chung `handleCodeExchange(files, context)` | ☐ Chưa làm | Cần làm TRƯỚC 2a-3 vì nhánh wiring bên dưới dùng lại đúng logic này, tránh chép lại code. |
| 2a-2 | `checkUnwiredFiles(filesChanged)` — sau khi 1-5b patch xong, không dừng nữa mà gọi hàm này | ☐ Chưa làm | Dùng `isImportedAnywhere` (2c-3) cho từng file có `action: created`. Trả về danh sách file còn mồ côi. |
| 2a-3 | Nếu có file mồ côi → build + gửi `usage_query` | ☐ Chưa làm | Payload gồm `unwired_files` (path, status, imported_by rỗng) — đúng schema đã chốt trong thiết kế. |
| 2a-4 | `routeUsageResponse(envelope)` — rẽ theo `type` | ☐ Chưa làm | `usage_needed` → gọi lại `handleCodeExchange` (2a-1) cho file agent yêu cầu (thường là file cha) → patch → `updateGraphAfterPatch` (2c-4) → quay lại 2a-2 kiểm tra lại. `no_wiring_needed` → ghi nhận `reason`, coi như hết mồ côi, đi tiếp. |
| 2a-5 | Vòng lặp 2a-2 → 2a-4 cho tới khi `checkUnwiredFiles` trả rỗng | ☐ Chưa làm | Đây chính là điểm cần guard round counter thật (Giai đoạn 3) — ở Giai đoạn 2 tạm giới hạn cứng bằng 1 biến đếm đơn giản (vd tối đa 5 lần) để tránh loop test vô hạn. |

### 2b — status_check / completed / continue

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 2b-1 | `filterCriteriaForRole(criteria, role)` | ☐ Chưa làm | Lọc bỏ tiêu chí có keyword `test/build/kiểm tra` khỏi những gì gửi cho `coder` — dùng đúng logic đã thống nhất trong thiết kế. Ở Giai đoạn 2 role mặc định vẫn là `coder` (chưa có Tester/Reviewer — đó Giai đoạn 7), nhưng viết hàm tổng quát ngay để dùng lại sau. |
| 2b-2 | Sau khi 2a-5 xong (hết mồ côi) → build + gửi `status_check` | ☐ Chưa làm | Dùng `filterCriteriaForRole` (2b-1) để chọn đúng tập tiêu chí, kèm `files_changed` tổng hợp từ toàn bộ round đã patch (round patch chính + round wiring). |
| 2b-3 | `routeStatusResponse(envelope)` — rẽ theo `type` | ☐ Chưa làm | `completed` → lưu `report` (0b-2 `save`), `updateStatus(coder_completed)`, dừng vòng lặp — CHƯA verify/merge (đó Giai đoạn 4). `continue` → lấy `next_task`, quay lại 1-2 (`buildTaskRequest`) với mô tả mới, **giữ nguyên `task_id`**, tăng `step_id`. |
| 2b-4 | Giới hạn tạm số lần `continue` liên tiếp | ☐ Chưa làm | Biến đếm đơn giản (vd tối đa 3 lần) — bản đầy đủ là guard [3] Round counter ở Giai đoạn 3, ở đây chỉ cần đủ để không loop vô hạn khi test. |

### 2d — Code index (độc lập, không chặn 2a/2b)

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 2d-1 | Chọn phương án MVP: grep/keyword search (`ripgrep` hoặc quét `fs.readdir` + string match) | ☐ Chưa làm | Chưa cần embedding/semantic search ở giai đoạn này. |
| 2d-2 | `searchSimilarFile(keyword)` → path gần nghĩa nhất | ☐ Chưa làm | Dùng để tự động điền `reference_pattern` — ở Giai đoạn 1 việc này đang viết tay trong ticket test. |
| 2d-3 | Tích hợp vào `buildTaskRequest` (1-2) | ☐ Chưa làm | Optional ở Giai đoạn 2 — nối lại chỗ đã làm thủ công ở Giai đoạn 1, không bắt buộc phải xong mới qua Giai đoạn 3. |

**Thứ tự làm khuyến nghị:** `2c-1→2c-4` (graph) trước tiên vì 2a phụ thuộc trực tiếp → `2a-1` (refactor dùng chung với 1-5a/1-5b) → `2a-2→2a-5` (vòng wiring) → `2b-1→2b-4` (status check) → `2d` làm song song bất cứ lúc nào, không nằm trên đường găng.

---

## Giai đoạn 3 — Guard rẻ, ROI cao

> Cả 2 guard đều là "chặn ở 1 điểm trung tâm" — không sửa nhiều nơi trong state machine, chỉ thêm 1 lớp kiểm tra trước hành động đã có sẵn (gửi request / đọc file / ghi file).

### 3a — Round counter (guard [3])

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 3a-1 | Thêm field lưu số round đã dùng theo `task_id` | ☐ Chưa làm | Không thêm vào schema ticket (0d-1) — đây là runtime state, không phải thuộc tính ticket. Lưu riêng, vd `storage.save('task/<id>/round_count', n)` (dùng lại 0b-2), hoặc field tạm trong bộ nhớ nếu chưa cần bền vững qua restart. |
| 3a-2 | `incrementRoundCount(task_id)` | ☐ Chưa làm | Đọc giá trị hiện tại, +1, ghi lại. |
| 3a-3 | `checkRoundLimit(task_id, maxRounds)` | ☐ Chưa làm | Trả `true/false`. Ngưỡng `maxRounds` để config, không hard-code (vd biến môi trường hoặc file config, mặc định 15). |
| 3a-4 | Gắn `incrementRoundCount` + `checkRoundLimit` vào `sendRequest` (1-3) | ☐ Chưa làm | Đây là **điểm trung tâm duy nhất** mọi request đi qua (task, code_needed, code_provide, usage_query...) — chặn ở đây, không chặn rải rác ở từng nhánh. Vượt ngưỡng → `updateStatus(task_id, 'needs_human_review')` (0d-2), ghi log, **không gọi** `claudeAdapter.call()`. |
| 3a-5 | Dọn 2 biến đếm tạm ở Giai đoạn 2 | ☐ Chưa làm | Xoá giới hạn thô ở 2a-5 (tối đa 5 lần) và 2b-4 (tối đa 3 lần continue) — thay bằng guard thật này, vì `checkRoundLimit` đã bao trùm mọi loại round, không cần đếm riêng từng loại. |

### 3b — Protected path (guard [4])

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 3b-1 | Định nghĩa `PROTECTED_PATTERNS` (danh sách regex) | ☐ Chưa làm | `.env`, `.env.*`, `wp-config.php`, `config/secrets/**`, `.git/**` — để trong file config riêng, không hard-code trong logic, dễ thêm bớt sau. |
| 3b-2 | `isProtectedPath(path)` | ☐ Chưa làm | Hàm thuần, test độc lập được (không phụ thuộc fs/git) — input path, output boolean. |
| 3b-3 | Viết `guardedRead(path)` — wrap quanh `fs.readFileSync`, chặn bằng 3b-2 | ☐ Chưa làm | Trả `{content: null, exists: false, denied: true, reason: "..."}` nếu path bị chặn, thay vì đọc thật. |
| 3b-4 | Viết `guardedWrite(path, content)` — wrap quanh `fs.writeFileSync` + `git.commit`, chặn bằng 3b-2 | ☐ Chưa làm | Nếu bị chặn → throw lỗi rõ ràng, KHÔNG ghi, KHÔNG commit — patch dừng lại, không được âm thầm bỏ qua file đó rồi patch tiếp phần còn lại. |
| 3b-5 | Thay `fs.readFileSync` trực tiếp trong 1-5a và 2a-4 bằng `guardedRead` | ☐ Chưa làm | Đây là chỗ đổi thật trong code đã viết ở Giai đoạn 1/2 — không phải thêm mới, mà thay hàm đọc file cũ bằng bản có guard. |
| 3b-6 | Thay `fs.writeFileSync` trực tiếp trong 1-5b bằng `guardedWrite` | ☐ Chưa làm | Tương tự 3b-5, áp cho nhánh patch. |
| 3b-7 | Test case: agent (qua mock 1-7) yêu cầu đọc `.env` | ☐ Chưa làm | Xác nhận `code_provide` trả về `denied: true`, không lộ nội dung thật — test bằng mock, không cần gọi Claude thật. |

> **Ghi chú tích hợp với File Service (thiết kế riêng, chưa nối vào pipeline):** khi File Service (đường đọc filesystem duy nhất theo thiết kế Code Index 12 bước) được nối vào pipeline sau này, `readForIndex()` của nó nên gọi lại đúng `isProtectedPath()` (3b-2) thay vì tự viết lại danh sách chặn — tránh 2 nơi định nghĩa "vùng cấm" khác nhau rồi lệch nhau theo thời gian.

**Thứ tự làm khuyến nghị:** `3a` và `3b` độc lập nhau, làm song song được. Trong `3b`, làm `3b-1→3b-4` (viết hàm guard) trước, rồi mới `3b-5/3b-6` (thay thế trong code cũ) — tách rõ "viết guard" và "áp guard vào chỗ đang dùng" để dễ test riêng từng phần.

---

## Giai đoạn 4 — Guard nặng, cần hạ tầng

> Ở Giai đoạn 1, `1-1` đã tạo branch và `1-5b` đã commit từng round (dùng 0c-3) — Giai đoạn này KHÔNG viết lại phần đó, chỉ bổ sung 2 việc còn thiếu: **merge/discard cuối cùng** (4a) và **verify thật trước khi merge** (4b). 2 nhóm này phụ thuộc lẫn nhau ở đúng 1 điểm: merge chỉ được gọi SAU KHI verify pass — cần sửa lại `2b-3` (routeStatusResponse, nhánh `completed`) để chèn verify vào giữa.

### 4b — Verify tầng 1+2 (làm trước 4a vì 4a-4 phụ thuộc kết quả của 4b)

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 4b-1 | Thêm `getChangedFiles(branch)` vào git wrapper (0c) | ☐ Chưa làm | Bổ sung cho 0c — chưa có ở Giai đoạn 0, cần để biết verify file nào. |
| 4b-2 | `verifySyntax(task_id)` | ☐ Chưa làm | Lấy `getChangedFiles` (4b-1), với mỗi file: `.php` → `php -l`, `.scss` → `sass --check`, `.js` → parser cơ bản (vd `@babel/parser`). Fail bất kỳ file nào → dừng, trả lỗi ngay, không chạy tiếp các file còn lại. |
| 4b-3 | `verifyBuild(task_id)` | ☐ Chưa làm | Checkout đúng branch `task/<id>`, chạy `npm run build` (hoặc lệnh build thật của project), bắt `exitCode` + `stderr`. |
| 4b-4 | `runVerification(task_id)` — gộp 4b-2 → 4b-3 | ☐ Chưa làm | Chạy tuần tự, dừng ngay khi tầng nào fail, trả `{pass, tier, error}`. Đây là hàm DUY NHẤT các phần khác gọi tới, không gọi thẳng `verifySyntax`/`verifyBuild` riêng lẻ ở nơi khác. |

### 4a — Git branch/rollback đầy đủ

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 4a-1 | Thêm `merge(branch, opts)` có phát hiện conflict vào git wrapper (0c) | ☐ Chưa làm | Đã liệt kê ở 0c-4 nhưng chưa viết — làm ở đây. Trả `{success, hasConflict}`, KHÔNG tự resolve conflict. |
| 4a-2 | `mergeToMain(task_id)` | ☐ Chưa làm | Gọi 4a-1 với `{noFastForward: true}` (giữ lịch sử round dưới dạng 1 merge commit riêng). |
| 4a-3 | Xử lý khi `hasConflict: true` | ☐ Chưa làm | `updateStatus(task_id, 'merge_conflict')` (0d-2), ghi log, dừng — KHÔNG tự sửa. Đây là input cho guard [6] (báo owner) ở Giai đoạn 6. |
| 4a-4 | `discardTask(task_id)` | ☐ Chưa làm | Gọi `git.discardBranch` (0c-5) — dùng khi verify (4b) fail sau khi đã hết số lần retry cho phép (retry thật thuộc Giai đoạn 5/8, ở đây chỉ cần hàm sẵn sàng để gọi). |
| 4a-5 | **Sửa lại `2b-3`** (routeStatusResponse, nhánh `completed`) — chèn verify + merge vào giữa | ☐ Chưa làm | Luồng mới: agent báo `completed` → gọi `runVerification` (4b-4) → **fail**: build lại request `type: task` kèm `metadata.previous_error`, quay lại `1-2` (retry, tái dùng đúng state machine cũ, chưa cần logic escalation phức tạp của Giai đoạn 5/8 ở đây) → **pass**: gọi `mergeToMain` (4a-2) → conflict thì 4a-3, thành công thì `updateStatus(done)` + `git.deleteBranch` + dừng thật sự. |

### 4c — Verify tầng 3 (test hành vi)

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 4c | Verify hành vi thật (vd Puppeteer đo `scrollWidth` theo viewport) | ☐ Để sau | Chỉ làm nếu thực sự cần cho loại ticket UI/visual lặp lại nhiều — chưa đưa vào `runVerification` (4b-4) mặc định, chỉ chạy khi ticket có tag riêng (vd `responsive`). |

**Thứ tự làm khuyến nghị:** `4b-1→4b-4` trước (verify độc lập, test được bằng cách gọi tay trên 1 nhánh git có sẵn, chưa cần đụng tới state machine) → `4a-1→4a-4` (viết các hàm git, cũng test độc lập được) → `4a-5` làm SAU CÙNG, vì đây là bước nối 2 nhóm lại vào state machine đã có — sai sót ở bước này dễ ảnh hưởng luồng đang chạy ổn từ Giai đoạn 1-3, nên chỉ sửa khi cả `4a-1→4a-4` và `4b-1→4b-4` đã test riêng lẻ chắc chắn.

---

## Giai đoạn 5 — Format code nâng cao

> `5a` (chỉ `full`) thực chất đã xong từ `1-5b` (Giai đoạn 1 chỉ chấp nhận `full`, coi format khác là lỗi) — không có việc mới, giữ dòng này chỉ để đánh dấu mốc đã qua. Việc thật của Giai đoạn 5 là `5b`/`5c`/`5d`.

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 5a | Chỉ hỗ trợ `format: full` | ✅ Đã có (từ 1-5b) | Không cần làm gì thêm — chỉ chuyển trạng thái để phản ánh đúng thực tế. |

### 5b — Thêm `unified_diff`

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 5b-1 | `decideFormat(filePath, retryCount)` | ☐ Chưa làm | File mới hoặc ≤50 dòng hoặc `retryCount ≥ 2` → `full`; còn lại → `unified_diff`. |
| 5b-2 | Gắn `decideFormat` vào nơi build `code_provide` (1-5a / `handleCodeExchange` 2a-1) | ☐ Chưa làm | Thêm field `required_output_format` cho từng file trong payload gửi agent — schema đã có sẵn (0a-3), chỉ cần Node điền đúng giá trị. |
| 5b-3 | `validateFull(file)` | ☐ Chưa làm | Kiểm tra `content` không rỗng, trả `{valid, finalContent}`. |
| 5b-4 | `validateDiff(file)` | ☐ Chưa làm | Dùng thư viện diff (`applyPatch`) thử áp lên nội dung file thật (đọc qua `guardedRead` 3b-3) — trả `{valid, finalContent, error}`. |
| 5b-5 | `validateSyntax(language, content)` | ☐ Chưa làm (tái dùng) | Đây chính là phần trong `verifySyntax` (4b-2) — tách ra thành hàm dùng chung `validateSyntax(language, content)`, để cả `verifySyntax` (verify cấp task) lẫn `validateFile` (validate cấp file, ở đây) gọi cùng 1 hàm, không viết 2 lần. |
| 5b-6 | `validateFile(file)` — điều phối theo `format` | ☐ Chưa làm | `full` → 5b-3, `unified_diff` → 5b-4; case `patch` tạm để `throw "chưa hỗ trợ"` (bổ sung ở 5c). Sau bước format-specific, luôn chạy tiếp `validateSyntax` (5b-5) trên `finalContent`. |
| 5b-7 | Gắn `validateFile` vào nhánh patch (1-5b và trong `handleCodeExchange`) — validate TRƯỚC KHI ghi | ☐ Chưa làm | Validate hết toàn bộ file trong response trước, fail bất kỳ file nào → **reject cả round** (atomic), không ghi file nào — build request retry mới (`metadata.previous_error`) quay lại state machine, không tự sửa diff giùm agent. |
| 5b-8 | Test case: agent trả diff không áp được (context lines lệch) | ☐ Chưa làm | Xác nhận: không file nào bị ghi, round retry được tạo đúng với lỗi cụ thể kèm `current_file_state` (nội dung file thật) gửi lại. |

### 5c — Thêm `patch` (structured operations)

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 5c-1 | Chốt schema `operations[]` cụ thể | ☐ Chưa làm | Tối thiểu: `insert_after` (anchor_line, new_content), `replace_range` (start_line, end_line, new_content), `insert_at_end` (new_content) — đã phác thảo trong thiết kế, giờ cố định lại thành field chuẩn. |
| 5c-2 | `validatePatch(file)` | ☐ Chưa làm | Với mỗi operation: check `anchor_line` có tồn tại trong file thật / `end_line` không vượt số dòng — fail 1 operation thì fail cả file, không áp phần còn lại. Áp toàn bộ operations atomic mới trả `finalContent`. |
| 5c-3 | Bỏ stub trong `validateFile` (5b-6), thêm case `patch` → 5c-2 | ☐ Chưa làm | |
| 5c-4 | Xác nhận adapter parse đúng field `content` khi `format: patch` | ☐ Chưa làm | Với OpenAI: `content` là string đã `JSON.stringify` (đã ghi chú trong `forge-agent-response-schemas.json`) — adapter phải `JSON.parse()` lại trước khi đưa vào `validatePatch`. Với Claude: `content` đã là object sẵn, không cần parse. |

### 5d — Escalation tự động

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 5d-1 | Track `retryCountPerFile` (theo `task_id + path`, KHÁC round counter theo task ở Giai đoạn 3) | ☐ Chưa làm | Tăng mỗi khi 1 file cụ thể fail `validateFile` và cần agent tạo lại — không liên quan số round tổng của cả task. |
| 5d-2 | Xác nhận `decideFormat` (5b-1) đọc đúng `retryCountPerFile` này | ☐ Chưa làm | Điều kiện `retryCount ≥ 2 → full` đã viết sẵn ở 5b-1 — chỉ cần đảm bảo nguồn dữ liệu đếm đúng theo từng file, không lẫn giữa các file khác nhau trong cùng task. |
| 5d-3 | Thêm `format_escalation_notice` vào request retry khi ép về `full` | ☐ Chưa làm | Câu text rõ ràng ("diff đã fail N lần, từ giờ bắt buộc format full cho file này") — tránh agent hiểu nhầm là yêu cầu tuỳ hứng. |

**Thứ tự làm khuyến nghị:** `5b-3→5b-6` (viết các hàm validate, test độc lập bằng file mẫu + diff mẫu, chưa cần agent thật) → `5b-1/5b-2` (Node quyết định format, gắn vào request) → `5b-7/5b-8` (nối vào nhánh patch, test bằng mock trả diff cố ý sai) → `5c` (thêm patch, làm sau vì phụ thuộc cấu trúc `validateFile` đã ổn định từ 5b) → `5d` (escalation, phụ thuộc 5b-1 đã có sẵn điều kiện, chỉ cần nối đúng nguồn đếm).

---

## Giai đoạn 6 — Report & thông báo owner

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 6a | Guard **[6]**: ghi report ra `reports/<task_id>.md` | ☐ Chưa làm | Đơn giản nhất, đủ dùng ban đầu. |
| 6b | Nâng cấp: webhook/Slack | ☐ Để sau | Chỉ làm nếu cần chủ động báo hơn là tự vào xem file. |

---

## Giai đoạn 7 — Multi-agent (Coder / Tester / Reviewer)

> Chỉ bắt đầu **sau khi Giai đoạn 1–6 chạy ổn định cho Coder một mình**.

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 7a | Lọc `acceptance_criteria` theo `agent_role` trước khi đưa vào `status_check` | ☐ Chưa làm | Không gửi tiêu chí thuộc phạm vi Tester/Reviewer cho Coder. |
| 7b | Thêm Tester agent | ☐ Chưa làm | Làm trước Reviewer — đơn giản hơn (chỉ sinh test, không ra verdict). |
| 7c | Thêm Reviewer agent | ☐ Chưa làm | Verdict: `approve` / `request_changes` (đẩy lại Coder) / `reject` (dừng, cần người). |
| 7d | File lock hoặc serialize theo dependency graph khi 2 agent cùng đụng 1 file | ☐ Chưa làm | Tránh race condition khi chạy nhiều agent. |

---

## Giai đoạn 8 — Để sau cùng (chỉ làm khi có tín hiệu thật)

| # | Việc | Ghi chú |
|---|---|---|
| 8a | Timeout streaming (idle timeout) hoặc timeout theo `complexity_hint` | Idle timeout ưu tiên nếu adapter hỗ trợ streaming — tránh cắt oan model đang suy luận lâu nhưng hợp lệ. |
| 8b | Ngân sách token/cost per task | Cộng dồn token đã dùng, vượt ngưỡng dừng bất kể round count còn dư. |
| 8c | Phòng chống prompt injection từ nội dung file | Luôn coi nội dung file là *data*, không phải *instruction*. |
| 8d | Verify sau khi merge để bắt semantic conflict giữa các task song song | Git merge sạch về text không đảm bảo logic không vỡ. |
| 8e | Planner agent — chuẩn hoá ticket từ mô tả thô | Luôn cần người xác nhận `acceptance_criteria` trước khi vào chu trình chính. |

---

## Nhật ký cập nhật

- 2026-08-30: Tạo kế hoạch lần đầu, sau khi chốt xong thiết kế schema/guard trong `forge-node-agent-protocol.md`.
- 2026-08-30: Bổ sung 1b (Node nhận ticket → chọn agent → build request đúng schema, validate trước khi gửi) và 1f (logging tuần tự có cấu trúc cho mỗi bước — tách riêng khỏi transcript_blocks trong storage, vì 2 thứ phục vụ mục đích khác nhau: log để theo dõi vận hành, storage để agent dùng lại context).
- 2026-08-30: Hoàn thành 0a-3 — 6 schema Agent→Node dạng tool/function definition thực thi được cho Claude và OpenAI, lưu tại `forge-agent-response-schemas.json`.
- 2026-08-30: Chi tiết hoá 0e thành 0e-1→0e-7 (adapter cho Claude), thêm 0a-5 (ghi file biến thể payload 1.4-anthropic — hiện mới là quyết định, chưa có file, là phụ thuộc bắt buộc trước 0e-2/0e-3). Thứ tự làm khuyến nghị: 0e-6 (normalize, test bằng response mẫu) → 0e-2/0e-3/0e-4 (build request, test bằng so sánh JSON tay) → 0e-1 (cần 0b) → 0e-5 (gọi API thật) → 0e-7 (gộp lại).
- 2026-08-30: Chi tiết hoá toàn bộ Giai đoạn 0 (0a/0b/0c/0d) thành các bước con — xác nhận 0a/0b/0c/0d độc lập nhau, làm song song được; chỉ 0e phụ thuộc các nhóm kia. Thêm bảng "Thứ tự tổng thể khuyến nghị" cuối Giai đoạn 0.
- 2026-08-30: Chi tiết hoá Giai đoạn 1 thành luồng hàm tuần tự 1-1→1-10 (initTask → buildTaskRequest → sendRequest → receiveResponse → routeResponse với 2 nhánh code_needed/code_response), tách riêng fixture test (1-6 ticket, 1-7 mock response) khỏi luồng chính, và chốt thứ tự test: chạy bằng mock (1-8) trước, adapter thật (1-9) sau.
- 2026-08-30: Chi tiết hoá Giai đoạn 2 thành 4 nhóm: 2c (dependency graph, làm trước vì 2a phụ thuộc), 2a (usage_query loop, refactor dùng chung hàm handleCodeExchange với 1-5a/1-5b), 2b (status_check/completed/continue, dùng filterCriteriaForRole), 2d (code index, độc lập không nằm trên đường găng). Thêm giới hạn tạm (round counter thô) ở 2a-5 và 2b-4 để tránh loop vô hạn khi test trước khi có guard [3] thật ở Giai đoạn 3.