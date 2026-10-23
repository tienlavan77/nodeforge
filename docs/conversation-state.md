# NodeForge Conversation State

## Mục tiêu

NodeForge phải biết ticket đang ở round nào, response provider nào đã nhận, context file nào còn hợp lệ và round tiếp theo có thể nối context hay phải dựng lại. NodeForge là source of truth; provider conversation chỉ là context hỗ trợ.

## Identity

- `task_id`: định danh ticket.
- `conversation_id`: hội thoại của một agent với ticket.
- `request_id`: từng request của Node.
- `provider_response_id`: ID do provider cấp, ví dụ `resp_abc123`.

Không dùng `provider_response_id` thay cho `task_id` hoặc `request_id`.

## Pipeline

```text
Round 1: task + task-review -> code_needed(plan, files_requested)
Round 2: planning + source files -> planning response
Round 3: code_provide + expected_submission -> submit_code_response
```

`task_id` và `conversation_id` giữ nguyên; `request_id` và `provider_response_id` thay đổi theo round.

## State cần lưu

```text
conversation_id, task_id, project_id, agent_id
status, current_round, current_step
last_request_id, last_provider_response_id, last_provider_status
parent_request_id, prompt_cache_key
context_revision, context_checksums
created_at, updated_at
```

Các trạng thái chính: `created`, `round_1_sent`, `awaiting_code_needed`, `round_1_completed`, `round_2_sent`, `awaiting_planning`, `round_2_completed`, `round_3_sent`, `awaiting_submission`, `verifying`, `completed`, `failed`, `needs_human_review`.

## Persistence

Mỗi round lưu trong Protocol Storage:

```text
round_N/request.json
round_N/request.meta.json
round_N/response.json
round_N/response.meta.json
round_N/state.json
```

Phải lưu provider response ID và raw response (khi provider/normalization lỗi) trước khi xử lý nội dung. Raw response không được đưa vào prompt.

## Provider continuity

Nếu provider hỗ trợ chain, round sau dùng `previous_response_id`. Nếu chain mất hiệu lực hoặc context bị truncate, Node dựng transcript tối thiểu từ Protocol Storage. Không giả định Agent còn nhớ context nếu Node không xác minh được.

## File context

Mỗi file gắn với `path`, `revision`, `before_checksum`, `size_bytes`, `source_round`. Patch thành công tạo revision/checksum mới; patch thất bại không thay đổi chúng. Checksum và revision của Node là source of truth.

## Transition rules

- `parent_id` phải trỏ đúng request trước.
- `task_id` và `conversation_id` không đổi.
- `step_id` tăng hợp lệ.
- Chỉ response `completed` mới được normalize/apply.
- `queued`/`in_progress` tiếp tục polling.
- `failed`/`cancelled`/`incomplete` kết thúc round an toàn.
- Không ghi file trước validation hoặc ghi `completed` trước persistence.

## Recovery

Sau restart, Node đọc state mới nhất, tìm round chưa terminal, kiểm tra persistence/provider status/checksum, tiếp tục polling nếu còn pending hoặc dựng transcript fallback. Không tạo request mới khi task còn round chưa kết luận.

## Cache

```text
forge:<project_id>:<sprint_id>:<ticket_id>
```

Prompt cache chỉ tối ưu chi phí/thời gian; không thay thế protocol state hoặc conversation continuity.

## Ba lớp state

```text
Node Protocol State       -> round/request/response/status
Provider Conversation     -> response_id/previous_response_id/status
File Context State        -> revision/checksum/content reference
```

NodeForge điều phối cả ba; Node Protocol State và File Context State là dữ liệu chính thức.
