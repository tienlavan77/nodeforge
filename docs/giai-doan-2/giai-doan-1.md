## Giai đoạn 1 — Happy path OpenAI (nền tảng cho pipeline 9 bước)

> Giai đoạn 1 triển khai happy path đầu tiên bằng provider OpenAI. Đây là một pipeline Node↔Agent duy nhất; adapter OpenAI chỉ chiếu request và chuẩn hóa response theo provider. Luồng đầu tiên chỉ chấp nhận `format: full` cho file cần tạo/sửa; các format `unified_diff`/`patch` sẽ mở rộng ở giai đoạn sau. Mục tiêu là xây state machine có thể mở rộng thành đầy đủ 9 bước của sơ đồ A, nhưng trước mắt chỉ chạy nhánh code cơ bản.

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 1-1 | `initTask(ticket)` | ✅ Đã có | `stage1-task-initializer.js` tạo status `pending` idempotent, kiểm tra dependency, tạo/giữ branch task, chuyển `running` hoặc `blocked`, và ghi protocol log. |
| 1-2 | `buildTaskRequest(ticket)` | ✅ Đã có | `stage1-task-request-builder.js` dựng và validate envelope `node:task` theo request schema; fixture OpenAI yêu cầu `submit_code` + `full_content`. |
| 1-3 | `sendRequest(envelope)` | ✅ Đã có | `stage1-request-sender.js` chọn adapter theo profile (OpenAI ở fixture), log trước gửi, lưu request/response đầy đủ qua Protocol Storage và log/ném lỗi provider. |
| 1-4 | `receiveResponse(rawEnvelope)` | ✅ Đã có | `stage1-response-receiver.js` validate Agent envelope/payload, kiểm tra `parent_id` khớp request, ghi `response_received` hoặc failure kèm `duration_ms`. |
| 1-5 | `routeResponse(envelope)` — rẽ nhánh theo `envelope.type` | ✅ Đã có | `stage1-response-router.js` chỉ route `code_needed` và `submit_code_response`; type khác trả `RESPONSE_TYPE_UNSUPPORTED`, không side effect. |
| 1-5a | Nhánh `code_needed`: đọc file thật, build `code_provide`, quay lại 1-3 | ✅ Đã có | `stage1-code-needed-handler.js` tra Code Index trước, đọc indexed path qua File Service, file thiếu trả `exists:false/content:null`, tạo request ID mới và parent tới Agent response. |
| 1-5b | Nhánh `submit_code_response`: validate format, patch file, kết thúc | ✅ Đã có | `stage1-submit-code-handler.js` chỉ nhận `format=full`, validate toàn bộ trước khi ghi, dùng File Service atomicCreate/atomicWrite, Git Service commit explicit paths, rồi chuyển `running→reviewing`; lỗi format/ghi/commit không chuyển status. |
| 1-6 | Hard-code 1 ticket đơn giản để test | ✅ Đã có | `backend/tests/fixtures/stage1-openai-fixture.js` cung cấp ticket, Builder/OpenAI profile và target file cho mock flow. | 1 ticket đơn giản có 1 file cần tạo/sửa, chạy qua status store mới và provider OpenAI mock; fixture phải có request_id/task_id/project_id hợp lệ. |
| 1-7 | Mock response agent cho từng round | ✅ Đã có | `createStage1MockAgent()` trả `code_needed` rồi `submit_code_response(full)` và lưu nguyên request envelopes trong `agent.requests` để inspect. Nội dung request thật sau này xem ở Protocol Storage theo `full_request_ref`. | Viết sẵn 2 response mẫu tĩnh: round 1 trả `code_needed` (hỏi 1 file), round 2 trả `submit_code_response` (format `full`) — dùng thay `sendRequest` thật ở 1-3 để test toàn bộ state machine (1-1→1-5) TRƯỚC KHI gọi OpenAI adapter thật. |
| 1-8 | Chạy thử bằng mock (1-6 + 1-7) | ✅ Đã có | `backend/tests/integration/stage1-mock-flow.test.js` chạy task→code_needed→code_provide→submit_code_response→reviewing với Protocol Storage/File Service thật; cover blocked, unsupported type, non-full format và không commit khi lỗi. |
| 1-9 | Chạy thử bằng OpenAI adapter thật (0e-7) | ☐ Chưa làm | Chỉ làm SAU KHI 1-8 pass. Thay `sendRequest` mock bằng `openaiAdapter.call()` thật, giữ nguyên ticket ở 1-6 — nếu lỗi ở bước này, đã tách được là lỗi do agent/API, không phải lỗi state machine. |
| 1-10 | Logging tuần tự — chuẩn cấu trúc log dùng chung cho 1-3/1-4 | ✅ Đã có | `protocol-step-logger.js` ghi `{ event, timestamp, task_id, step_id, type, role, request_id, parent_id, duration_ms, status }`; chỉ nhận metadata, payload đầy đủ lưu Protocol Storage. |

**Thứ tự triển khai đã chốt:**

```text
1-10 logging contract/helper
→ 1-6 fixture ticket + OpenAI agent profile
→ 1-7 mock responses
→ 1-1 init/status/dependency guard
→ 1-2 build canonical task envelope
→ 1-3 resolve provider adapter + send
→ 1-4 receive normalized Agent envelope + validate
→ 1-5 route response
→ 1-5a code_needed qua Code Index + File Service
→ `stage1-request-sender.js` gửi round 2 `code_provide` qua OpenAI, lưu full content + request/response refs
→ 1-5b submit_code_response(format=full) qua File Service + Git Service
→ 1-8 full mock integration + failure paths
→ 1-9 một ticket thật qua OpenAI adapter
```

Không làm 1-9 trước khi 1-8 pass. State machine chỉ phụ thuộc adapter contract; việc chọn OpenAI nằm ở agent profile của Giai đoạn 1, không hard-code provider vào workflow.


### Chuẩn bị mở rộng thành vòng 9 bước

State machine Giai đoạn 1 phải giữ context (`request_id`, `parent_id`, `task_id`, `step_id`) và route theo envelope type để các bước sau có thể nối thêm mà không đổi contract:

```text
task → code_needed → code_provide → submit_code_response
→ usage_query → usage_needed/no_wiring_needed
→ wiring code_needed/code_provide/submit_code_response
→ status_check → completed/continue
```

Giai đoạn 1 chỉ thực thi nhánh code đầu tiên đến `reviewing`; không giả lập `usage_query`, wiring hoặc `status_check`, nhưng không được thiết kế API khiến các nhánh này không thể bổ sung.
