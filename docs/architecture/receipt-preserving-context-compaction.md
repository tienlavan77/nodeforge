<!--
Mục đích nghiệp vụ: Tài liệu thiết kế kỹ thuật trực tiếp dành cho System Engineer (SE) để triển khai cơ chế nén ngữ cảnh bảo toàn biên nhận (Receipt-Preserving Context Compaction) kết hợp tiêm chỉ thị giữa chừng tại ranh giới lượt chạy (Mid-Flight Directive Injection) trong luồng điều phối phiên làm việc của Coder. Giải pháp này triệt tiêu xung đột giữa bộ chặn đọc lặp (READ_REPEATED) và trôi ngữ cảnh ở các phiên chạy dài, giảm chi phí token, cho phép xoay vòng phiên (Session Rollover) an toàn theo ngưỡng token, đồng thời hỗ trợ điều hướng hoặc tạm dừng Coder an toàn ngay tại ranh giới turn mà không phải hủy phiên đang chạy.
Mô tả kỹ thuật: Đặc tả chi tiết 4 mảnh ghép kiến trúc trong tầng backend/src/modules/supervisor/ gồm: (A) Bảng tổng hợp Active Checksum & Receipt Digest trong ticket-read-cache.js, ticket-work-progress.js và ticket-resume.js; (B) Bộ thu gọn lịch sử trong bộ nhớ cho function-calling-task-executor.js; (C) Cơ chế xoay vòng sessionId/threadId bảo toàn biên nhận tại ranh giới work_progress trong ticket-sdk-turns.js; và (D) Hòm thư chỉ thị bền vững theo từng ticket (ticket-directive-inbox.js) được rút và tiêm tại ranh giới turn của runTicketSdkTurns.
-->
# Kế hoạch Triển khai SE: Receipt-Preserving Context Compaction & Mid-Flight Directive Injection

Tài liệu này đặc tả thiết kế kỹ thuật chi tiết cho **4 Mảnh ghép (A + B + C + D)** xoay quanh vòng lặp điều phối `runTicketSdkTurns` để **System Engineer (SE)** triển khai trực tiếp vào mã nguồn `backend/src/modules/supervisor/` và bộ kiểm thử đơn vị tương ứng.

---

## 1. Bối cảnh và vấn đề kỹ thuật cần giải quyết

1. **Xung đột giữa `READ_REPEATED` và mất dấu `before_checksum` (`ticket-read-cache.js` & `ticket-work-progress.js`)**:
   - `assertReadNotRepeated` (`backend/src/modules/supervisor/ticket-read-cache.js`, `L39-L45`) từ chối lệnh `read_file` lặp lại trên cùng `path#offset:limit` nếu file chưa thay đổi và yêu cầu Coder tái sử dụng `sha256` đã có.
   - Tuy nhiên, khi chuyển pha qua `ticketWorkContinuationPrompt` (`backend/src/modules/supervisor/ticket-work-progress.js`, `L31-L34`) hoặc khi khôi phục phiên qua `buildResumePrompt` (`backend/src/modules/supervisor/ticket-resume.js`, `L177-L211`), prompt hiện chỉ đính kèm tên 8 tool gần nhất (`completedTools.slice(-8)`) mà không cung cấp bảng ánh xạ `path -> sha256`.
   - Khi ngữ cảnh dài bị nén hoặc phiên bị xoay vòng/khôi phục, Coder mất `before_checksum` để gọi `edit_diff`/`write_diff`/`delete_file`/`move_file`, nhưng gọi lại `read_file` thì bị chặn bởi `READ_REPEATED`.
2. **Tích tụ raw payload trong bộ nhớ của Function-Calling Executor (`function-calling-task-executor.js`)**:
   - Trong `createFunctionCallingTaskExecutor` (`backend/src/modules/supervisor/function-calling-task-executor.js`, `L61-L84`), biến `let history;` giữ nguyên toàn bộ kết quả JSON thô của mọi lần gọi tool qua nhiều pha (`discovery_complete` -> `implementation_complete` -> `verification_complete`), bao gồm cả nội dung file cũ đã bị ghi đè bởi `edit_diff`/`write_diff`.
3. **Chi phí ngữ cảnh dài trên Claude SDK và Codex SDK (`ticket-sdk-turns.js`)**:
   - Claude SDK (`claudeCacheUsage` trong `backend/src/modules/agent/anthropic-prompt-cache.js`, `L22-L33`) và Codex SDK (`event.usage` trong `backend/src/modules/agent/codex-sdk-gateway.js`, `L161-L180`) trả về thống kê `usage.input_tokens` sau mỗi turn.
   - Cần cơ chế giữ nguyên `sessionId`/`threadId` khi dưới ngưỡng token để tận dụng Prompt Cache 1 giờ, nhưng chủ động xoay vòng (`rollover`) sang phiên mới tại ranh giới chuyển pha `work_progress` khi `input_tokens` vượt ngưỡng, đồng thời truyền sang phiên mới bảng tổng hợp Checksum & Receipt Digest đầy đủ.
4. **Điểm nghẽn điều hướng giữa chừng khi Ticket đang `running` (`owner-chat-service.js` & `ticket-sdk-turns.js`)**:
   - Trong `backend/src/application/owner-chat-service.js` (`L45-L50`), khi hội thoại đang bị khóa bởi ticket `"running"`, mọi thông điệp bổ sung bị chặn cứng (`ticket.input_rejected` / `code: "ticket_input_locked"`).
   - Tại `backend/src/modules/supervisor/ticket-sdk-turns.js` (`L46-L55`), vòng lặp `for (;;)` đã có ranh giới tự nhiên sau mỗi turn SDK (ngay khi lưu `saveProgressCheckpoint` và trước khi tạo `nextPrompt`), nhưng hiện chưa có bước rút chỉ thị từ hòm thư (Inbox Drain) để tiêm hướng dẫn bổ sung hoặc tạm dừng an toàn tại ranh giới turn.

---

## 2. Ranh giới an toàn và quy tắc bất biến (Guardrails)

- **Không phá vỡ Governance, Immutable Scope & Manifest Gate**:
  - Mọi kiểm tra quyền file, `CODER_RULES_REQUIRED`, `COMMIT_MISSING`, `assertTicketExecutionCompleted`, và Reviewer gate phải giữ nguyên 100%.
  - Chỉ thị giữa chừng (Mid-Flight Directive) **không bao giờ** tự động mở rộng `allowed_file_paths`, `allowed_prefixes`, `mutable_file_budget`, hay `approved_baseline`. Nếu chỉ thị yêu cầu chạm file ngoài manifest đã khóa, Coder vẫn phải gọi `report_done(status="blocked")`.
- **Cô lập tuyệt đối theo Multi-Project**: Hòm thư chỉ thị phải gắn chặt với `(projectId, taskId)` thông qua `fileService` của đúng `projectRoot` và khóa `acquireTicketFileLock` (tương tự `ticket-execution-context.js`), tuyệt đối không dùng biến toàn cục trong bộ nhớ tiến trình.
- **Không lưu nội dung file vào Checkpoint**: `read_cache` và `delivered_directives` trong checkpoint chỉ lưu metadata/chỉ thị ngắn gọn (`<= 2000` ký tự), tuyệt đối không lưu nội dung mã nguồn (`content`).
- **Tôn trọng giới hạn 250 `code_lines` và quy tắc Comment của `CLAUDE.md`**:
  - Mọi file mới và hàm mới do SE tạo phải có comment mô tả rõ mục đích nghiệp vụ (business purpose) và mô tả kỹ thuật (technical description) bằng một ngôn ngữ thống nhất.
  - `backend/src/modules/supervisor/ticket-resume.js` (`198 code_lines`) và `backend/src/modules/supervisor/nodeforge-task-executors.js` (`187 code_lines`) phải giữ dưới trần 250 `code_lines` bằng cách tách logic sang `ticket-context-compaction.js` và `ticket-directive-inbox.js`.

---

## 3. Thiết kế chi tiết 4 mảnh ghép cho System Engineer

### Mảnh ghép A — Active Checksum & Receipt Digest (`ticket-read-cache.js`, `ticket-resume.js`, `ticket-work-progress.js`)

1. **Nâng cấp `backend/src/modules/supervisor/ticket-read-cache.js`**:
   - Mở rộng `rememberRead(cache, input, result)` để chấp nhận cả kết quả từ `read_file` và `read_lines` (`sed_lines`) khi có `sha256` hợp lệ (`/^sha256:[a-fA-F0-9]{64}$/`), lưu các trường gọn: `{ path, sha256, total_lines, size_bytes, offset, limit }`.
   - Bổ sung hàm `recordMutationChecksum(cache, { path, from_path, to_path, sha256, tool })`:
     - Khi `edit_diff` hoặc `write_diff` thực thi thành công:
       - `edit_diff` trả về `{ path, sha256: "sha256:..." }`.
       - `write_diff` trả về `textResult("Written '<path>' (sha256:...).")` — trích xuất mã `sha256:...` từ kết quả hoặc tính trực tiếp.
       - Xóa các mục đọc theo cửa sổ cũ (`path#offset:limit`) để Coder được phép đọc lại cửa sổ mới nếu cần, nhưng ghi nhận một mục digest cấp file (`cache[`${path}#0:0`]` hoặc bảng `fileChecksums`) với `{ path, sha256, updated_by: tool, window_invalidated: true }` (chỉ dùng để hiển thị `before_checksum` mới nhất trong Digest mà không chặn `assertReadNotRepeated` nếu Coder cần đọc lại nội dung sau khi sửa!).
     - Khi `delete_file` chạy: xóa mọi mục của `path`.
     - Khi `move_file` chạy: xóa mọi mục của `from_path` và cập nhật `sha256` sang `to_path` với `window_invalidated: true`.
   - Trong `assertReadNotRepeated(cache, input)`:
     - Nếu mục cache có `window_invalidated === true`, **không** ném lỗi `READ_REPEATED` (cho phép đọc lại cửa sổ dòng sau khi sửa), và khi đọc xong `rememberRead` sẽ ghi đè bằng cửa sổ mới.
   - Bổ sung hàm `formatActiveReceiptDigest(state)`:
     - Trích xuất danh sách `path -> sha256` mới nhất từ `state.readCache` (gộp theo `path`, lấy `sha256` hiện hành, `total_lines` nếu có, và trạng thái `read` hoặc `mutated`).
     - Kết hợp với `state.changedPaths`, `state.sdkTurnProgress?.receipt_position`, và kết quả `turnHistory` gần nhất để tạo chuỗi JSON/bảng ngắn gọn (`<= 2000` ký tự).

2. **Tích hợp vào `ticket-work-progress.js` và `ticket-resume.js`**:
   - Trong `ticketWorkContinuationPrompt(progress, state)` (`backend/src/modules/supervisor/ticket-work-progress.js`):
     - Đính kèm dòng: `Active file checksums (reuse as before_checksum for edit_diff/write_diff/delete_file/move_file without re-reading unchanged windows): ${JSON.stringify(activeFileChecksums(state.readCache))}.`
   - Trong `buildResumePrompt(prompt, state, meta)` (`backend/src/modules/supervisor/ticket-resume.js`):
     - Đính kèm bảng `Active file checksums` ngay dưới danh sách `Completed turns` và `Files already changed in the worktree` để khi Resume hoặc Rollover, Coder có ngay `before_checksum` chuẩn xác.

---

### Mảnh ghép B — Thu gọn `history` In-Memory cho Function-Calling Executor (`ticket-context-compaction.js` & `function-calling-task-executor.js`)

1. **Tạo module mới `backend/src/modules/supervisor/ticket-context-compaction.js`**:
   - Cung cấp hàm `compactFunctionCallingHistory(history, { readCache, changedPaths, maxHistoryBytes = 65536, preserveRecentItems = 6 } = {})`:
     - Nếu `!Array.isArray(history)` hoặc tổng kích thước `Buffer.byteLength(JSON.stringify(history)) <= maxHistoryBytes` và không có mục đọc bị lỗi thời do sửa file, giữ nguyên `history`.
     - Khi thực hiện thu gọn tại ranh giới chuyển turn (`runTicketSdkTurns`):
       - Giữ nguyên phần tử mở đầu (initial assignment prompt) và `preserveRecentItems` phần tử cuối cùng của `history` để bảo toàn ngữ cảnh tức thời của turn vừa chạy.
       - Với các phần tử cũ hơn ở giữa lịch sử (đặc biệt là các kết quả trả về của tool `function_call_output` / `tool` hoặc nội dung JSON dài):
         - Nếu là kết quả đọc file (`read_file`, `read_lines`), tìm kiếm (`search_text`, `list_files`, `search_tree`), hoặc kiểm tra (`run_check`, `git_diff`) có chuỗi nội dung lớn (`> 1200` ký tự):
         - Thay thế trường `content`/`output`/`stdout` dài bằng **Structured Receipt Stub** dạng chuỗi JSON gọn:
           ```json
           {
             "compacted_receipt": true,
             "tool": "read_file",
             "path": "backend/src/...",
             "sha256": "sha256:...",
             "total_lines": 120,
             "status": "retained_in_active_checksum_digest"
           }
           ```
       - Trả về `{ history: compactedHistory, compacted: true, beforeBytes, afterBytes, compactedItems }`.

2. **Kết nối vào `backend/src/modules/supervisor/function-calling-task-executor.js`**:
   - Giữa các turn trong `runTicketSdkTurns`, trước khi gọi `gateway.execute(...)` cho turn tiếp theo (khi `history` đã tồn tại), gọi `compactFunctionCallingHistory(history, { readCache: resumeState.readCache, changedPaths: resumeState.changedPaths })`.
   - Nếu `compacted === true`, ghi log sự kiện `supervisor.sdk_context_compacted` qua `projectLogger` với `{ agent_id, provider, mode: "in_memory_history", before_bytes, after_bytes, compacted_items }`.

---

### Mảnh ghép C — Session Rollover bảo toàn Receipt tại ranh giới pha cho Claude & Codex (`ticket-sdk-turns.js` & `nodeforge-task-executors.js`)

1. **Cơ chế đánh giá ngưỡng Token (`shouldRolloverSdkSession`) trong `ticket-context-compaction.js`**:
   - Định nghĩa ngưỡng mặc định có thể cấu hình: `DEFAULT_ROLLOVER_INPUT_TOKENS = 120000` (hoặc truyền qua `request.payload?.compaction_token_threshold` / cấu hình thực thi).
   - Hàm `extractTurnInputTokens(result)` đọc tổng input tokens của turn vừa kết thúc:
     - Với Claude SDK (`result.usage`): tính `Number(result.usage.input_tokens ?? 0) + Number(result.usage.cache_creation_input_tokens ?? 0) + Number(result.usage.cache_read_input_tokens ?? 0)`.
     - Với Codex SDK (`result.usage`): tính `Number(result.usage.input_tokens ?? result.usage.inputTokens ?? 0)`.
   - Hàm `shouldRolloverSdkSession({ result, progress, resumeState, threshold = DEFAULT_ROLLOVER_INPUT_TOKENS })`:
     - Chỉ kích hoạt khi:
       1. Turn vừa kết thúc bằng một `work_progress` hợp lệ (`progress !== undefined`, ví dụ `discovery_complete`, `implementation_complete`, `verification_complete`) — **không** rollover khi đang sửa lỗi schema (`correction`) để tránh mất ngữ cảnh câu trả lời vừa lỗi.
       2. Có `sessionId` hoặc `threadId` đang hoạt động.
       3. `extractTurnInputTokens(result) >= threshold`.

2. **Xoay vòng phiên và tái tạo Prompt nén trong `backend/src/modules/supervisor/ticket-sdk-turns.js`**:
   - Trong `runTicketSdkTurns`, lưu lại `const basePrompt = prompt;` (prompt gốc chứa đầy đủ Ticket + Resume context ban đầu).
   - Sau khi xác thực `progress` hợp lệ và cập nhật `resumeState.sdkTurnProgress`:
     - Kiểm tra `shouldRolloverSdkSession({ result, progress, resumeState, threshold: request?.payload?.compaction_token_threshold })`.
     - **Nếu dưới ngưỡng token (mặc định phần lớn các turn)**:
       - Giữ nguyên `resumeState.sessionId` / `resumeState.threadId` để tận dụng tối đa Prompt Cache 1 giờ của Claude/Codex.
       - Tạo `nextPrompt = ticketWorkContinuationPrompt(progress, resumeState)` (đã có bảng `Active file checksums` từ Mảnh ghép A).
     - **Nếu đạt/vượt ngưỡng token (Rollover Triggered)**:
       - Lưu vết phiên cũ vào `resumeState.sdkTurnProgress.rolled_over_from = resumeState.sessionId ?? resumeState.threadId` và tăng bộ đếm `compaction_rollover_count`.
       - Đặt `resumeState.sessionId = null;` (với Claude) hoặc `resumeState.threadId = null;` (với Codex) trước khi lưu `saveProgressCheckpoint` để turn kế tiếp khởi tạo phiên SDK mới tinh, giải phóng toàn bộ token lịch sử cũ.
       - Xây dựng `nextPrompt` cho phiên mới bằng `buildCompactedRolloverPrompt({ basePrompt, progress, resumeState })`:
         - Ghép `basePrompt` (nhiệm vụ gốc của ticket) + khối `COMPACTED SESSION HANDOFF` chứa:
           - Kết quả `work_progress` vừa chốt (`status`, `next_action`, `summary`, `remaining_work`).
           - Bảng `Active file checksums (before_checksum)` từ `resumeState.readCache`.
           - Lịch sử tóm tắt `turnHistory` (`turn`, `tool`, `target`, `outcome`) và danh sách `changedPaths`.
           - `TICKET_WORK_PROGRESS_PROMPT`.
       - Ghi log sự kiện `supervisor.sdk_context_compacted` với `{ mode: "session_rollover", previous_session_id, input_tokens, receipt_position: receipts }`.

---

### Mảnh ghép D — Inbox / Mid-Flight Directive Injection tại ranh giới Turn (`ticket-directive-inbox.js`, `ticket-sdk-turns.js`, `ticket-work-progress.js`, `ticket-resume.js`)

1. **Tạo module mới `backend/src/modules/supervisor/ticket-directive-inbox.js`**:
   - **Lưu trữ bền vững & cô lập Multi-Project**:
     - Sử dụng `statePath("ticket-directives")` từ `backend/src/infrastructure/filesystem/forge-paths.js` và băm `projectId` (`sha256(projectId).slice(7)`) giống hệt `createTicketExecutionContextStore` trong `backend/src/modules/supervisor/ticket-execution-context.js` (`L19-L26`).
     - Mỗi hòm thư lưu tại `.forge/runtime/ticket-directives/<projectHash>/<taskId>.json` thông qua `fileService` của đúng `projectRoot`, đồng bộ hóa truy cập đa tiến trình bằng `acquireTicketFileLock(fileService, "${pathFor(taskId)}.lock")`.
   - **Cấu trúc bản ghi `directive_entry` và kiểm tra hợp lệ**:
     - `directive_id`: `DIR-${sha256}` (content-addressed từ `projectId + taskId + sender.role + kind + instruction` hoặc ID truyền vào) để đảm bảo tính idempotent khi gửi lặp.
     - `project_id`: khớp với `projectId` của store.
     - `task_id`: khớp với `taskId` (`SAFE_ID = /^[A-Za-z0-9._:-]+$/`).
     - `execution_id`: tùy chọn (`string | null`), nếu có thì chỉ khớp với lần thực thi hiện hành hoặc khi `allow_across_resume !== false`.
     - `sender`: `{ id, role }` — chỉ chấp nhận `role` thuộc tập `ALLOWED_DIRECTIVE_ROLES = new Set(["project_owner", "sprint_leader", "architecture_manager", "node"])`. Mọi role khác bị từ chối với lỗi `DIRECTIVE_SENDER_UNAUTHORIZED`.
     - `kind`: thuộc tập `ALLOWED_DIRECTIVE_KINDS = new Set(["implementation_guidance", "focus_constraint", "pause_after_turn"])`.
     - `instruction`: chuỗi văn bản đã trim, độ dài `1..2000` ký tự (`DIRECTIVE_INSTRUCTION_INVALID` nếu rỗng hoặc vượt 2000 ký tự).
     - `status`: `"pending"` | `"delivered"` | `"superseded"`.
     - `created_at`, `delivered_at`, `delivered_at_turn`, `delivered_receipt_position`.
   - **Các hàm API của `createTicketDirectiveInbox({ fileService, projectId, projectRoot, projectLogger = () => {} })`**:
     - `enqueue({ taskId, executionId = null, sender, kind = "implementation_guidance", instruction, supersedePending = false })`:
       - Kiểm tra hợp lệ `taskId`, `sender`, `kind`, `instruction`.
       - Nếu `supersedePending === true`, chuyển các mục `"pending"` cùng `kind` trước đó sang `"superseded"`.
       - Lưu atomic vào file `.json` và phát log `ticket.directive_enqueued`.
     - `list(taskId, { status = null } = {})`: đọc danh sách chỉ thị của `taskId`.
     - `drainPending({ taskId, executionId = null, turnCount = 0, receiptPosition = 0 })`:
       - Chạy trong `locked(taskId, ...)`: lọc các mục `status === "pending"` (khớp `executionId` nếu mục đó khóa cứng `execution_id`).
       - Nếu không có mục nào `"pending"`, trả về `{ directives: [], pauseRequested: false }` mà không ghi đĩa.
       - Nếu có: cập nhật trạng thái các mục đó sang `"delivered"` kèm `delivered_at: new Date().toISOString()`, `delivered_at_turn: turnCount`, `delivered_receipt_position: receiptPosition`, ghi đĩa atomic, phát log `ticket.directives_drained`, và trả về `{ directives: deliveredList, pauseRequested: deliveredList.some((d) => d.kind === "pause_after_turn") }`.
   - **Hàm định dạng `formatMidFlightDirectives(directives)`**:
     - Tạo khối văn bản chuẩn hóa (chỉ gồm `directive_id`, `sender.role`, `kind`, `instruction`) kèm cảnh báo bất biến:
       `MID-FLIGHT DIRECTIVES (Validated turn-boundary instructions — apply within existing approved ticket scope and manifest; never bypass tool governance, commit, verification, or report_done): ...`

2. **Tích hợp bảo toàn qua Checkpoint & Session Rollover (`ticket-resume.js` & `ticket-context-compaction.js`)**:
   - Trong `createResumeState(resume)` và `checkpointPayload(state, extra)` (`backend/src/modules/supervisor/ticket-resume.js`):
     - Bổ sung trường `deliveredDirectives: sanitizeDeliveredDirectives(clean?.delivered_directives)` (giữ tối đa 8 chỉ thị gần nhất, mỗi chỉ thị chỉ lưu `{ directive_id, role, kind, instruction, delivered_at_turn }`) và xuất ra `delivered_directives` trong `checkpointPayload`.
   - Trong `buildResumePrompt` (`ticket-resume.js`) và `buildCompactedRolloverPrompt` (`ticket-context-compaction.js`):
     - Nếu `state.deliveredDirectives.length > 0`, đính kèm danh sách các chỉ thị đang hiệu lực để khi phiên bị xoay vòng (Mảnh ghép C) hoặc Resume sau sự cố, Coder vẫn nhớ các hướng dẫn đã nhận ở turn trước.

3. **Điểm tiêm tại ranh giới Turn trong `backend/src/modules/supervisor/ticket-sdk-turns.js` và `ticket-work-progress.js`**:
   - Trong `runTicketSdkTurns`:
     - Nhận thêm tùy chọn `directiveInbox = null` (hoặc tự khởi tạo qua `createTicketDirectiveInbox` khi `projectRoot` và `request?.project_id` hiện diện).
     - Ngay sau khi turn SDK kết thúc và trước khi kiểm tra `AGENT_PROGRESS_STALLED`:
       - Gọi `const drained = directiveInbox ? await directiveInbox.drainPending({ taskId: request.task_id, executionId: request.payload?.execution_id ?? null, turnCount: resumeState.turnCount, receiptPosition: receipts }) : { directives: [], pauseRequested: false };`.
       - Nếu `drained.directives.length > 0`:
         - Ghi nối vào `resumeState.deliveredDirectives` (giữ tối đa 8 mục gần nhất).
         - **Xử lý `pause_after_turn`**: Nếu `drained.pauseRequested === true`, cập nhật `resumeState.sdkTurnProgress` với `status: "paused_by_directive"`, lưu `saveProgressCheckpoint(checkpoints, resumeState, { ..., status: "paused_by_directive" })`, phát log `supervisor.sdk_turn_paused_by_directive`, và ném lỗi điều phối `Object.assign(new ConfigurationError("Ticket execution gracefully paused at turn boundary by directive."), { code: "DIRECTIVE_PAUSE_REQUESTED" })` để giữ nguyên checkpoint sạch cho lần Resume sau.
         - **Tương tác với `AGENT_PROGRESS_STALLED`**: Nếu turn vừa rồi không tạo thêm tool receipt mới (`receipts <= lastValid`) nhưng **có directive mới vừa được rút ra (`drained.directives.length > 0`)**, cho phép miễn trừ `AGENT_PROGRESS_STALLED` ở đúng nhịp giao thời này để Coder được phép chuyển hướng theo chỉ thị mới ở turn kế tiếp.
     - Khi tạo `nextPrompt` cho turn kế tiếp (`ticketWorkContinuationPrompt(progress, resumeState, drained.directives)` hoặc `buildCompactedRolloverPrompt`):
       - Nhúng khối `formatMidFlightDirectives` để Coder thực thi ngay trong turn tiếp theo.

---

## 4. Danh sách file SE dự kiến chạm và kế hoạch kiểm thử

| File | Thao tác | Mô tả |
| :--- | :---: | :--- |
| `backend/src/modules/supervisor/ticket-context-compaction.js` | **Tạo mới** | Chứa `activeFileChecksums`, `compactFunctionCallingHistory`, `extractTurnInputTokens`, `shouldRolloverSdkSession`, và `buildCompactedRolloverPrompt` (giữ dưới 250 `code_lines`). |
| `backend/src/modules/supervisor/ticket-directive-inbox.js` | **Tạo mới** | Chứa `createTicketDirectiveInbox` (`enqueue`, `list`, `drainPending`), `sanitizeDeliveredDirectives`, và `formatMidFlightDirectives` với khóa file cô lập theo `(projectId, taskId)` (giữ dưới 250 `code_lines`). |
| `backend/src/modules/supervisor/ticket-read-cache.js` | **Cập nhật** | Hỗ trợ `recordMutationChecksum`, cờ `window_invalidated` (không chặn đọc lại cửa sổ sau khi sửa file nhưng vẫn giữ `sha256` mới nhất cho Digest), và lưu trữ an toàn qua `sanitizeReadCache`. |
| `backend/src/modules/supervisor/ticket-resume.js` | **Cập nhật** | Gọi `recordMutationChecksum` sau `write_diff`/`edit_diff`/`delete_file`/`move_file`, lưu `delivered_directives` trong `checkpointPayload`, và nhúng `Active file checksums` + `deliveredDirectives` vào `buildResumePrompt`. |
| `backend/src/modules/supervisor/ticket-work-progress.js` | **Cập nhật** | Nhúng `Active file checksums` và `formatMidFlightDirectives` vào `ticketWorkContinuationPrompt`. |
| `backend/src/modules/supervisor/ticket-sdk-turns.js` | **Cập nhật** | Rút chỉ thị từ `directiveInbox` tại ranh giới turn, xử lý `pause_after_turn` (`DIRECTIVE_PAUSE_REQUESTED`), miễn trừ stall một nhịp khi có chỉ thị mới, và kiểm tra `shouldRolloverSdkSession`. |
| `backend/src/modules/supervisor/function-calling-task-executor.js` | **Cập nhật** | Gọi `compactFunctionCallingHistory` giữa các turn trước khi truyền `history` vào `gateway.execute`. |
| `backend/tests/unit/ticket-context-compaction.test.js` | **Tạo mới** | Kiểm thử đơn vị toàn diện cho Mảnh ghép A, B, C. |
| `backend/tests/unit/ticket-directive-inbox.test.js` | **Tạo mới** | Kiểm thử đơn vị cho Mảnh ghép D: cô lập `(projectId, taskId)`, lọc role trái phép, rút chỉ thị tại ranh giới `runTicketSdkTurns`, miễn trừ stall khi có chỉ thị mới, và dừng an toàn với `pause_after_turn`. |

### Lệnh kiểm chứng dành cho SE sau khi code

```sh
TMPDIR=/tmp node --test \
  backend/tests/unit/ticket-context-compaction.test.js \
  backend/tests/unit/ticket-directive-inbox.test.js \
  backend/tests/unit/ticket-sdk-turns.test.js \
  backend/tests/unit/ticket-work-progress.test.js \
  backend/tests/unit/function-calling-task-executor.test.js
```
