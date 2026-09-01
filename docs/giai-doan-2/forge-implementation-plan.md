# Kế hoạch triển khai — Forge Node↔Agent Protocol

> File này là kế hoạch sống — cập nhật trực tiếp vào đây khi có thay đổi, không tạo file mới cho mỗi lần chỉnh sửa.
> Xem chi tiết thiết kế schema/luồng đầy đủ tại `forge-node-agent-protocol.md`.

**Nguyên tắc chỉ đạo:** xây 1 đường đi trọn vẹn (happy path) cho 1 ticket đơn giản trước, thêm guard sau, thêm multi-agent sau cùng. Không làm đúng toàn bộ schema/guard ngay từ đầu — sửa sau khi có dữ liệu chạy thật rẻ hơn đoán trước.

**Quyết định kiến trúc pipeline:** chỉ có một pipeline Node↔Agent. Provider adapter (OpenAI/Claude/...) chỉ chuyển request canonical sang format riêng và đưa response về cùng Agent envelope; state machine không biết chi tiết provider.

**Quyết định canonical response type:** `submit_code_response` là tên chuẩn trong pipeline mới. `code_response` chỉ là alias tương thích tạm thời trong validator/registry; không dùng làm type mới. Chỉ xoá alias sau khi runtime cũ đã migrate hoàn toàn.

**Phân tầng Code Graph/Search:** 2c/2d trước mắt chỉ cung cấp dependency graph và keyword/symbol search tối thiểu để không chặn happy path. Bản mở rộng (FTS, caller/callee graph, relevance ranking, relevant tree và context planner) là lớp nâng cấp xây sau, không thay thế thứ tự Giai đoạn 1. `1e` dùng explicit-path happy path độc lập, không phụ thuộc discovery tự động.

**Chính sách context stale:** nếu checksum của file khác Code Index, Context Planner không trả nội dung cũ. Node trả lỗi `CONTEXT_STALE`, kích hoạt re-index, rồi yêu cầu truy vấn lại sau khi index ổn định.

**Bảo vệ nội dung nhạy cảm:** ignore-list của Code Index/Search độc lập với protected-path của guard ghi file. Indexer không đọc/index/đưa vào FTS các file như `.env`, `.env.*`, private key, credential/secret config, cùng `.git`, `.forge/runtime`, `.next`, file tạm và binary.

**Checksum và worktree:** File Service, Code Index và Protocol Storage dùng chung chuẩn `sha256:<64 hex>`. Bảng `files` chuẩn bị cột `worktree_id`/`branch` nullable cho multi-agent tương lai; Giai đoạn 1–2 chưa dùng để phân luồng.

---

## Giai đoạn 0 — Nền tảng

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 0a-1 | `envelope.schema.json` (request_id, parent_id, type, role, payload, timestamp) | ☐ Chưa làm | Discriminator: dùng `type` + `role` để chọn schema con của `payload`, không đổi tên field `payload`. |
| 0a-2 | Schema payload chiều **Node → Agent** | ✅ Đã có | Chính là schema `developer_blocks/transcript_blocks/user_blocks/expected_output/metadata` đã thống nhất. |
| 0a-3 | Schema payload chiều **Agent → Node**, tách theo từng `type` | ✅ Đã có | 6 tool/function schema cho cả Claude (tool_use) và OpenAI (function calling, strict mode) — file `forge-agent-response-schemas.json`. Lưu ý: format `patch` bên OpenAI phải JSON.stringify content do strict mode không hỗ trợ union type. |
| 0a-4 | Hàm `validate(envelope)` — route theo `type`+`role` tới đúng schema con | ☐ Chưa làm | Dùng chung 1 hàm cho mọi nơi cần validate (trước khi gửi, sau khi nhận). |
| 0a-5 | Ghi lại thành file: biến thể payload `1.4-anthropic` (system_blocks, cache_control theo prefix, expected_output.delivery, transcript_blocks.in_window) | ☐ Chưa làm | Hiện mới là quyết định thiết kế, chưa có file — cần làm TRƯỚC 0e-2/0e-3 vì adapter đọc trực tiếp field theo tên đã chốt ở đây. |
| 0b | Storage layer: `save(ref, data)` / `get(ref)` | ☐ Chưa làm | Tạm dùng file JSON hoặc SQLite, chưa cần DB phức tạp. |
| 0c | Git wrapper: `createBranch`, `commit`, `merge`, `discardBranch` | ☐ Chưa làm | Bọc `simple-git` hoặc gọi CLI trực tiếp. |
| 0d | Ticket store: nơi lưu trạng thái từng ticket (`blocked/in_progress/done`) | ☐ Chưa làm | Cần có trước khi làm guard "Check dependencies" ở Giai đoạn 1. |
| 0e-1 | `resolveTranscript(payload)` — expand transcript_blocks theo hybrid_window | ☐ Chưa làm | Cần 0b xong trước (gọi `storage.get(full_request_ref/full_response_ref)`). Block `in_window:true` → resolve full; `in_window:false` → gộp `response_summary` thành 1 dòng text. |
| 0e-2 | `buildSystemParam(payload)` — dựng `system[]` + gắn `cache_control` | ☐ Chưa làm | Cần 0a-5 xong. `cache_control` chỉ gắn vào block CUỐI của chuỗi block liên tiếp cacheable, không phải mọi block `cacheable:true`. |
| 0e-3 | `buildMessages(payload)` — nối transcript đã resolve + user_blocks cuối | ☐ Chưa làm | Cần 0e-1. Message cuối (user_blocks) luôn không cacheable. |
| 0e-4 | `buildToolConfig(payload)` — chọn tool + tool_choice từ `forge-agent-response-schemas.json` | ✅ Input đã có (0a-3) | Nếu `expected_output.type` cho nhiều khả năng → đưa nhiều tool vào `tools[]`, `tool_choice: {type:"any"}` thay vì ép 1 tool. |
| 0e-5a | Offline provider smoke test | ✅ Đã có | Mock `requestFn` xác nhận compose request → tool response → Agent envelope. |
| 0e-5b | Provider smoke test thật | ✅ Đã xác nhận | Builder gateway trả `HTTP 200` + `function_call`; tool-only response được adapter chấp nhận và normalize thành envelope. Không ghi credential vào log. |
| 0e-6 | `normalizeResponse(rawResponse)` — map provider tool/function call → envelope chuẩn | ✅ Đã có (OpenAI) | `openai-response-normalizer.js` hỗ trợ Responses API, Chat Completions tool calls và aliases; validate envelope + payload sau khi normalize. |
| 0e-7 | `openaiAdapter.call(genericPayload)` — gộp resolver, request builders, gateway và normalizer | ✅ Đã có (OpenAI) | `createOpenAIAdapter().call()` là adapter provider hiện đã nối vào pipeline chung; Claude/Anthropic sẽ dùng cùng contract Node↔Agent, chỉ khác projection request và response normalization theo provider. Gateway thật được inject qua `requestFn`, test không gọi mạng. |

---

## Giai đoạn 1 — Happy path (không guard nặng, không retry)

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 1a | Guard **[5] Check dependencies** | ☐ Chưa làm | Cần 0d xong trước. Logic đơn giản: ticket có `dependencies` chưa `done` → `blocked`, dừng. |
| 1b | **Nhận ticket → chọn agent → build request đúng schema** | ☐ Chưa làm | Node đọc ticket JSON (từ ticket store 0d) → xác định `agent_role` cần dùng (mặc định `coder` ở giai đoạn này) → xác định provider/model (từ config, chưa cần logic chọn động) → build `envelope + payload` đầy đủ theo schema (0a-2) → validate bằng `validate(envelope)` (0a-4) TRƯỚC KHI gửi, không gửi request chưa qua validate. |
| 1c | **Tạo git branch trước khi patch** | ☐ Chưa làm | Gọi `git.createBranch('task/<ticket_id>')` (dùng hàm wrapper đã viết ở 0c) ngay sau khi ticket qua guard dependency (1a), trước khi patch file đầu tiên. Ở giai đoạn này CHƯA cần merge/rollback tự động (đó là 4a) — chỉ cần patch luôn nằm trên branch riêng, không đụng `main` trực tiếp, dù còn thủ công merge bằng tay sau khi xem kết quả. |
| 1d | State machine tối giản: `task → code_needed → code_provide → submit_code_response → patch` | ☐ Chưa làm | Bỏ qua `usage_query`, `status_check` ở bước này — patch xong thì dừng. |
| 1e | Explicit-path happy path: 1 ticket đơn giản có sẵn danh sách file | ☐ Chưa làm | Không phải hard-code logic production và không phụ thuộc Code Graph/Search. Node dùng `ticket.files` để tra Code Index, đọc qua File Service, rồi chạy end-to-end 1 lần; mục tiêu là cô lập lỗi pipeline Node↔Agent. |
| 1f | Mock response agent để test state machine trước khi gọi API thật | ☐ Chưa làm | Tách lỗi "logic điều phối sai" khỏi lỗi "agent trả lời sai" — 2 loại dễ lẫn nếu test chung. |
| 1g | **Logging tuần tự cho mỗi bước trong chu trình** | ☐ Chưa làm | Ghi log có cấu trúc (không phải console.log tự do) tại mỗi lần chuyển bước: `{ timestamp, task_id, step_id, type, role, request_id, parent_id, duration_ms, status }`. Ghi cả lúc gửi request lẫn lúc nhận response. Mục đích: đọc lại được toàn bộ trình tự 1 task đã đi qua mà không cần lục transcript_blocks trong storage — log là góc nhìn "theo dõi vận hành", storage/transcript là góc nhìn "nội dung để agent dùng lại". 2 thứ khác mục đích, không dùng chung 1 nơi lưu. |

---

## Giai đoạn 2 — Khép vòng lặp 9 bước đầy đủ

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 2a | Thêm `usage_query` / `usage_needed` / `no_wiring_needed` | ☐ Chưa làm | |
| 2b | Thêm `status_check` / `completed` / `continue` | ☐ Chưa làm | `acceptance_criteria` gửi cho agent phải lọc theo phạm vi role (xem Giai đoạn 7). |
| 2c | Dependency graph tối thiểu (parse import/require) | ✅ Đã làm | Milestone đầu: regex/AST cơ bản, đủ truy vấn file → dependencies và file → importers, chưa cần hoàn hảo. Bản mở rộng sau gồm symbols/calls, caller/callee, line number, member-call và graph traversal có giới hạn. |
| 2d | Code index/search tối thiểu | ✅ Đã làm | Milestone đầu: path/filename/symbol và keyword search/grep, chưa cần embedding/FTS. Bản mở rộng sau gồm content index (FTS), symbol-content search, relevance ranking, relevant tree và Context Planner; không được chặn Giai đoạn 1. Indexer phải bỏ qua secret files độc lập với protected-path ghi file. |
| 2d-a | Context freshness và metadata mở rộng | ✅ Đã làm | Khi checksum lệch: `CONTEXT_STALE` → re-index → truy vấn lại, không trả context cũ. Dùng chung SHA-256 với File Service/Protocol Storage; chuẩn bị `worktree_id`/`branch` nullable cho multi-agent tương lai. |

---

## Giai đoạn 3 — Guard rẻ, ROI cao

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 3a | Guard **[3] Round counter** | ☐ Chưa làm | Đếm tổng round theo `task_id` (không phải per-file), vượt ngưỡng → `needs_human_review`. |
| 3b | Guard **[4] Protected path** | ☐ Chưa làm | Danh sách regex chặn (`.env`, `wp-config.php`, `.git/`...) — chặn cả đọc lẫn ghi. |

---

## Giai đoạn 4 — Guard nặng, cần hạ tầng

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 4a | Guard **[2] Git branch/rollback** đầy đủ | ☐ Chưa làm | Commit từng round, merge cuối khi verify pass, xử lý merge conflict (dừng, báo owner — không tự resolve). |
| 4b | Guard **[1] Verify — tầng 1+2** (syntax + build) | ☐ Chưa làm | ROI cao nhất trong 3 tầng verify, nên làm trước tầng 3. |
| 4c | Guard **[1] Verify — tầng 3** (test hành vi, vd Puppeteer) | ☐ Để sau | Chỉ làm nếu thực sự cần cho loại ticket UI/visual lặp lại nhiều. |

---

## Giai đoạn 5 — Format code nâng cao

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 5a | Chỉ hỗ trợ `format: full` | ☐ Chưa làm | Bắt đầu đơn giản nhất, rủi ro thấp nhất. |
| 5b | Thêm `unified_diff` | ☐ Để sau | Chỉ thêm khi đo được token cost thật sự là vấn đề — không đoán trước. |
| 5c | Thêm `patch` (structured operations) | ☐ Để sau | Chỉ làm nếu `unified_diff` fail thường xuyên trong thực tế. |
| 5d | Escalation tự động: fail `unified_diff` ≥2 lần → ép `full` | ☐ Để sau | Đi kèm 5b. |

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
- 2026-08-30: Chi tiết hoá 0e thành 0e-1→0e-7 (provider adapter dùng chung pipeline), thêm 0a-5 (ghi file biến thể payload 1.4-anthropic — hiện mới là quyết định, chưa có file, là phụ thuộc bắt buộc trước 0e-2/0e-3). Thứ tự làm khuyến nghị: 0e-6 (normalize, test bằng response mẫu) → 0e-2/0e-3/0e-4 (build request, test bằng so sánh JSON tay) → 0e-1 (cần 0b) → 0e-5 (gọi API thật) → 0e-7 (gộp lại).
