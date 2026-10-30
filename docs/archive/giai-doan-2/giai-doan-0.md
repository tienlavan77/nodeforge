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
| 0a-5b | Ghi file `payload-anthropic.schema.json` theo 0a-5a | ☐ Chưa làm | Provider adapter dùng field này để chiếu request canonical sang Anthropic format; đây không phải pipeline riêng. |
| 0a-4a | Viết schema registry: map `(type, role) → schema tương ứng` | ☐ Chưa làm | Cần 0a-1b, 0a-2, 0a-3, 0a-5b xong trước — registry chỉ là bảng tra, chưa có logic. |
| 0a-4b | Viết hàm `validateEnvelope(envelope)` — validate shape envelope + payload theo registry | ☐ Chưa làm | Giai đoạn 0 chỉ validate SHAPE (đúng field, đúng kiểu) — CHƯA validate state/protocol (vd "type này có hợp lệ ở step hiện tại không"), phần đó thêm sau khi có state machine (1d), tái dùng cùng hàm này với tham số `state` (hiện để optional/không dùng tới). |
| 0a-4c | Viết test cho `validateEnvelope` bằng chính các ví dụ JSON đã thống nhất trong thiết kế | ☐ Chưa làm | Dùng lại nguyên các payload mẫu trong `forge-node-agent-protocol.md` làm test case — không cần bịa case mới. |

### 0b — Storage layer

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 0b-1 | Quyết định backend lưu trữ | ☐ Chưa làm | MVP: file JSON trên disk theo cấu trúc `storage/<task_id>/round_<n>/request.json` \| `response.json`. Chưa cần SQLite/DB ở giai đoạn này. |
| 0b-2 | Viết `save(ref, data)` / `get(ref)` | ☐ Chưa làm | `ref` là string dạng path (`task/FORGE-UI-037/round_1/request`) — map trực tiếp sang đường dẫn file thật. |
| 0b-3 | Viết `list(task_id)` (liệt kê mọi ref thuộc 1 task) | ✅ Đã có | Trả ref hoàn chỉnh theo thứ tự round; validate task id, checksum/metadata và chỉ đọc qua File Service. |

### 0c — Git wrapper

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 0c-1 | Chọn cách gọi git: thư viện (`simple-git`) hay `exec` CLI trực tiếp | ✅ Đã chốt: Git CLI | Không thêm dependency; dùng `execFile` với args tách biệt, validate branch/path, timeout và mã lỗi rõ ràng để giữ chi phí thấp và an toàn. |
| 0c-2 | `createBranch(name)` | ☐ Chưa làm | |
| 0c-3 | `commit(message, files)` | ☐ Chưa làm | |
| 0c-4 | `merge(branch, {noFastForward: true})` — có phát hiện conflict | ☐ Chưa làm | Trả về rõ ràng `{success, hasConflict}` — không tự resolve conflict (đúng nguyên tắc đã chốt ở Giai đoạn 4). |
| 0c-5 | `discardBranch(name)` | ☐ Chưa làm | Dùng khi verify fail hẳn, huỷ toàn bộ nhánh task. |

### 0d — Ticket store

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 0d-1 | Chốt schema ticket + enum trạng thái runtime | ✅ Đã có | Trạng thái: `pending`, `blocked`, `running`, `reviewing`, `done`, `failed`, `cancelled`, `needs_human_review`. Runtime status tách khỏi roadmap/ticket data. |
| 0d-2 | Viết ticket status store: `create`, `get`, `getStatus`, `updateStatus`, history/retry | ✅ Đã có | Lưu SQLite theo `project_id`; update dùng version + `expectedCurrentStatus` để chống race, ghi lịch sử chuyển trạng thái. |
| 0d-3 | Viết `dependenciesReady(taskId, dependencyIds)` + retry | ✅ Đã có | Caller truyền dependency IDs từ roadmap; store chỉ đọc status, trả `ready/blocked_by`. Retry `failed`/`needs_human_review` đi qua `pending`, không bypass guard. |

### 0e — Provider Adapter (OpenAI/Codex)

*(một pipeline chung; adapter chọn projection theo provider)*

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 0e-1 | `resolveTranscript(payload)` | ☐ Chưa làm | Cần 0b-2 xong. |
| 0e-2 | `buildSystemParam(payload)` | ☐ Chưa làm | Cần 0a-5b xong. |
| 0e-3 | `buildMessages(payload)` | ☐ Chưa làm | Cần 0e-1. |
| 0e-4 | `buildToolConfig(payload)` | ✅ Input đã có (0a-3) | |
| 0e-5a | Offline provider smoke test | ✅ Đã có | Mock `requestFn` xác nhận compose request → tool response → Agent envelope. |
| 0e-5b | Provider smoke test thật | ✅ Đã xác nhận | Builder gateway trả `HTTP 200` + `function_call`; tool-only response được adapter chấp nhận và normalize thành envelope. Không ghi credential vào log. |
| 0e-6 | `normalizeResponse(rawResponse)` | ✅ Đã có (OpenAI) | Function/tool call được normalize và validate thành Agent envelope. |
| 0e-7 | `openaiAdapter.call(genericPayload)` | ✅ Đã có (OpenAI) | Entry point ghép transcript, request builders, gateway và normalizer. |

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

