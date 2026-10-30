<!-- Preserves a quoted historical document section so engineers can read archived examples without treating them as new executable definitions; removing quote prefixes reconstructs the exact original bytes. -->
> {
>   "tool_context": {
>     "task_id": "FORGE-UI-052",
>     "execution_scope": { "task_id": "FORGE-UI-052", "supervisor_id": "...", "round": 4 },
>     "capabilities": ["read_transcript_blocks", "select_code_graph_candidates", "search_code", "read_code"],
>     "transcript_blocks": [],
>     "allowed_file_paths": [],
>     "context_budget": { "max_bytes": 200000, "max_calls": 20, "used_bytes": 0, "used_calls": 0 }
>   }
> }
> ```
> 
> `allowed_file_paths` là biên bảo mật — lấy từ `approvedPlan` (path có action `NEW` / `MODIFY` / `READ_ONLY`). Ngoài danh sách đó, `read-transcript-blocks.js:27` tự chặn.
> 
> `capabilities` là chỗ Node cấp quyền theo round — R1/R2 có thể không cấp `read_code`, R3/R4 cấp đủ. Đây là policy, không hardcode.
> 
> ### Governance đã có sẵn
> 
> ```text
> backend/src/tools/tool-authorization.js:4      authorizeTool — capability + task_id
> backend/src/tools/retrieval-governance.js:8    assertExecutionScope — TOOL_SCOPE_INVALID
> backend/src/tools/retrieval-governance.js:13   checkRetrievalBudget — CONTEXT_BUDGET_EXCEEDED
> backend/src/tools/retrieval-governance.js:25   recordRetrieval — audit_retrieval callback
> ```
> 
> Mặc định `DEFAULT_MAX_CALLS = 20`, `DEFAULT_MAX_BYTES = 200000`.
> 
> ### Bốn chỗ phải nối khi tool xong
> 
> ```text
> 1. production-runtime.js:35   → truyền codeSearch, enableReadCode: true
> 2. round-controller.js:5      → nhận toolRegistry, emit tools[] + tool_context
> 3. stage1-agent-tools.js / sender-worker.js:33 → code_provide gửi submit_code_response + retrieval tools
> 4. sender-worker.js:15        → thêm tool loop quanh adapter.send; adapter nhận messages[]
> ```
> 
> ### Budget ba lớp
> 
> ```text
> Lớp 1 — retrieval budget (đã có)
>   checkRetrievalBudget: max_bytes 200000, max_calls 20
> 
> Lớp 2 — turn budget (chưa có)
>   max_tool_turns mỗi round, ví dụ 12
>   vượt → agent.response.failed với code TOOL_TURN_LIMIT
> 
> Lớp 3 — round budget (chưa có)
>   max_repair_rounds, ví dụ 2
>   vượt → Supervisor chuyển NEEDS_HUMAN_REVIEW (state đã có trong SUPERVISOR_STATES)
> ```
> 
> Nối `recordRetrieval`'s `context.audit_retrieval` vào `projectLogger` để mỗi lần Agent đọc gì đều có log — đúng nguyên tắc không âm thầm.
> 
> ### Tool turn không được vô hình
> 
> Nếu chỉ lưu `round_4/response` cuối cùng, ta mất dấu Agent đã đọc gì, mấy lần, tốn bao nhiêu byte. Lưu thêm:
> 
> ```text
> task/{task_id}/round_4/turns          (hoặc event log)
>   ├─ turn 1: tool_use read_code + tool_result summary
>   ├─ turn 2: tool_use read_transcript_blocks + summary
>   └─ turn 3: submit_code_response
> ```
> 
> Chỉ lưu tóm tắt + ref, không lưu full `tool_result` (đã nằm trong Protocol Storage/disk).
> 
> ## Hệ quả lên repair round R4/R5
> 
> ### Khi Agent CÓ working memory
> 
> ```text
> current_content của MODIFY invalid
>   → Agent gọi read_code(path), lấy bản fresh hơn cả push
> 
> READ_ONLY content
>   → Agent gọi read_code, nếu path nằm trong allowed_file_paths
> 
> locked_new_files content
>   → Agent gọi read_transcript_blocks({ rounds: [3], include: "response" })
>   → RS3 đã được SW ghi ở task/{id}/round_3/response
>   → với NEW valid, submitted_content === proposed_content
>   → khôi phục được, không cần push
> ```
> 
> R4 chỉ còn push những gì Agent không tự lấy được:
> 
> ```json
> {
>   "type": "code_provide",
>   "step_id": 4,
>   "round_kind": "repair",
>   "repair_round": 1,
>   "origin_round": 3,
>   "source_round": 3,
>   "approved_plan": [],
>   "valid_paths": [],
>   "invalid_paths": [],
>   "repair_context": {},
>   "failed_operations": {},
>   "before_checksums": { "frontend/src/components/Header.jsx": "sha256:..." },
>   "tool_context": {},
>   "transcript_blocks": [],
>   "instruction_blocks": [],
>   "expected_output": { "type": "submit_code_response", "transport": "function_tool" }
> }
> ```
> 
> ### Ranh giới — ba thứ vẫn phải push
> 
> ```text
> 1. before_checksum
>    → giá trị contract Agent phải echo lại
>    → Node phải ấn định; nếu Agent read_code rồi tự tính sẽ race với lúc MW verify
> 
> 2. errors + failed_operations
>    → Agent không suy ra được MW đã reject vì sao
>    → read_transcript_blocks cho thấy patch cũ, không cho thấy lý do hỏng
> 
> 3. valid_paths (lock list)
>    → policy của Supervisor, không phải dữ liệu trên disk
> ```
> 
> Nguyên tắc: **push fact nhỏ và ràng buộc, pull content lớn.**
> 
> ### Rủi ro của pull
> 
> Agent có thể *không* gọi tool. `repair-correction` phải ra lệnh rõ:
> 
> ```text
> Before submitting, call read_code for every path in invalid_paths to obtain
> the current source. Do not reuse content from memory of previous rounds.
> ```
> 
> MW vẫn là cổng chặn cuối: Agent submit mà không đọc → `before_checksum` sai → `CHECKSUM_MISMATCH` → repair tiếp. Hệ thống tự bảo vệ, không cần tin Agent.
> 
> ### Khi Agent CHƯA có working memory (hiện tại)
> 
> R4 phải self-contained, push full content. Ma trận theo `action × error code`:
> 
> **MODIFY invalid** — luôn gửi:
> 
> ```json
> {
>   "path": "frontend/src/components/Header.jsx",
>   "action": "MODIFY",
>   "format": "structured_patch",
>   "exists": true,
>   "content": "<current_content đầy đủ, đọc lại lúc build R4>",
>   "current_content": "<như trên>",
>   "before_checksum": "sha256:...",
>   "repair_reason": "CHECKSUM_MISMATCH",
>   "errors": [],
>   "failed_operations": []
> }
> ```
> 
> `before_checksum` phải tính từ **chính chuỗi `content` đó**, cùng một lần đọc. Copy `current_content` của MW rồi tính checksum riêng có thể làm hai giá trị lệch nhau.
> 
> `failed_operations` — chỉ operation hỏng, không phải cả patch:
> 
> ```json
> {
>   "failed_operations": [
>     { "operation_index": 2, "op": "replace_range", "expected_content": "đoạn agent đã gửi", "code": "EXPECTED_CONTENT_NOT_FOUND", "message": "..." }
>   ]
> }
> ```
> 
> `submitted_content` đầy đủ chỉ gửi khi lỗi là cấu trúc: `PATCH_STRUCTURE_INVALID`, `SUBMISSION_FORMAT_UNSUPPORTED`, `MISSING_BEFORE_CHECKSUM`, `INVALID_NEW_FILE_CHECKSUM`.
> 
> **NEW invalid**
> 
> ```text
> MISSING_SUBMISSION        → content: null; chỉ cần plan entry + instruction
> NEW_FILE_ALREADY_EXISTS   → BẮT BUỘC gửi current_content của file đang tồn tại
> PATCH_STRUCTURE_INVALID   → gửi submitted_content đầy đủ (không có current_content)
> ```
> 
> **READ_ONLY** — phải gửi lại toàn bộ tập READ_ONLY, vì Agent không còn nội dung nó thấy ở R3. Giống cách R3 làm tại `round-controller.js:58`.
> 
> **`locked_new_files`** — bắt buộc kèm `content`. MW chạy `filesystem_write: false` (`materializer-worker.js`), nên NEW valid ở R3 chưa được ghi disk; `fullContextProvider` đọc từ disk sẽ trả ENOENT. Nội dung đó không tồn tại ở đâu khác.
> 
> **Không gửi**: `valid` full object, `proposed_content` của valid (trừ `locked_new_files`), `verification` flags, `patch_id`, `valid_patches` / `invalid_patches` legacy.
> 
> **Size guard** — `current_content` của MODIFY invalid **không bao giờ truncate**. Cắt là Agent không build được patch, sinh repair loop vô nghĩa. Vượt ngưỡng thì set `escalation: "REPAIR_CONTEXT_TOO_LARGE"` và Supervisor chuyển `NEEDS_HUMAN_REVIEW` — không âm thầm cắt.
> 
> Thứ tự ưu tiên khi buộc phải cắt:
> 
> ```text
> 1. READ_ONLY không liên quan                → cắt trước
> 