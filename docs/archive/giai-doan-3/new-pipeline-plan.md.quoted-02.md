<!-- Preserves a quoted historical document section so engineers can read archived examples without treating them as new executable definitions; removing quote prefixes reconstructs the exact original bytes. -->
> ---
> 
> ## 4. Attempt context builder (thay round-controller)
> 
> **File mới:** `backend/src/modules/supervisor/attempt-context-builder.js`
> (thay `round-controller.js`; giữ file cũ 1 phiên bản với re-export deprecated hoặc xóa sau 1 release).
> 
> ```js
> export function createAttemptContextBuilder({ conversationStateStore, protocolStorage, codeIndexSummaryBuilder, memoryRetriever, ... } = {}) {
>   return { buildAttemptRequest, buildRepairRequest };
> }
> ```
> 
> | Attempt | Nội dung |
> |---|---|
> | 1 | Ticket (title/objective/acceptance) + context pack (index summary + relevant files) + project memory facts (L2) + conventions. 3 tầng payload (mục 7). |
> | 2+ | Giữ nguyên tầng 1+2 từ attempt trước (để hit prefix cache) + **append** failure context cuối: verifier output + `git diff` hiện tại + correction text. Không chèn giữa. |
> 
> - Persist request vào protocol storage trước enqueue (như round-controller cũ).
> - `context_revision` / `context_checksums` từ `conversationStateStore` để làm cache-validity.
> - `in_window` / transcript block logic thu gọn: attempt blocks append-only, không còn R2-repeat edge case.
> 
> ---
> 
> ## 5. Protocol storage — giữ, đổi vai
> 
> - Giữ **nguyên** `protocol-storage.js` + ref phẳng `task/{id}/round_{n}/request|response`
>   + checksum `.meta.json`.
> - Đổi vai: từ "hợp đồng điều phối" (Node đọc để rebuild context round kế) sang
>   **"bằng chứng audit"** (prompt gửi vào, response cuối, tool exchange).
> - Bắt buộc: request pack + final response. Tool exchange best-effort.
> - `round = attempt` (giữ format, tránh churn).
> 
> Không đụng `conversation-state-store.js` (đã có sẵn `prompt_cache_key`,
> `context_revision`, `context_checksums`, `last_provider_response_id`, `parent_request_id`
> cho mục 7).
> 
> ---
> 
> ## 6. Bridge terminal → ticket status + memory (ưu tiên cao)
> 
> ### 6.1 Ticket status bridge
> 
> **Vị trí:** `backend/scripts/start-control-api.mjs` (hoặc `production-runtime.js` —
> chọn 1 chỗ, mặc định `start-control-api.mjs` vì đã có `ticketStatusStore`/`roadmaps`).
> 
> Subscribe execution `eventBus`:
> 
> | Supervisor terminal | Ticket transition |
> |---|---|
> | `task.completed` (`verification.passed` → `COMPLETED`) | `running`/`reviewing` → `done` |
> | `task.failed` (`agent.response.failed` hoặc `verification` fail hết attempt) | `running`/`reviewing` → `failed` |
> | `NEEDS_HUMAN_REVIEW` | `running`/`reviewing` → `needs_human_review` |
> 
> Đồng bộ cả hai nơi: `ticketStatusStore.updateStatus` + `roadmaps.updateTicketStatus`
> (để dashboard thấy). Dùng cùng `request_id`/`correlation_id` để idempotent.
> 
> ### 6.2 Terminal hook ghi memory
> 
> Cùng subscriber trên, sau khi update ticket xong:
> 
> ```
> task.completed → build summary từ session (tool_events + git diff stat)
>               → facts = filter(summary.facts, isLongTermFact)  // giữ regex hiện có
>               → taskSummaryStore.build(taskId) → projectMemoryStore.build(projectId)
> ```
> 
> → Memory mới có nguồn sống (hiện chỉ có đường stage1 cũ ghi).
> 
> ### 6.3 DAG dispatchSprint
> 
> **File:** `backend/scripts/start-control-api.mjs:129` (`dispatchSprint`)
> 
> - Thay `Promise.all(tickets.map(dispatchTask))` bằng topological sort theo
>   `ticket.dependencies` (Kahn hoặc DFS).
> - Dispatch từng tầng (level) tuần tự; mỗi ticket chờ terminal (`task.completed`/
>   `task.failed`) rồi mới dispatch tầng kế.
> - Gate bằng `ticketStatusStore.dependenciesReady(ticketId)` trước khi dispatch
>   từng ticket (đã có sẵn, chỉ chưa được dùng).
> - Ticket `blocked` → không dispatch, chờ dependency `done` rồi retry.
> 
> ### 6.4 Consolidate 2 đường sprint
> 
> - Đặt tên rõ: `sprint-plan-generation` (SprintOrchestrationService 4 roles) vs
>   `sprint-execution` (dispatchSprint supervisor pipeline).
> - Không gộp code trong phase này — chỉ đổi tên/log để UI không nhầm đường.
> 
> ---
> 
> ## 7. Cache — 3 tầng payload
> 
> ### 7.1 Nguyên lý
> 
> HTTP LLM API stateless: client **luôn** gửi lại toàn bộ context. Prefix cache
> không giảm băng thông mà giảm **chi phí token + TTFT**. Server match cache bằng
> *nội dung prefix*, nên gửi lại chính là cách tìm cache. Muốn gửi delta thật sự
> chỉ có OpenAI Responses `store:true` + `previous_response_id` (đã có chỗ cắm
> `last_provider_response_id` trong conversation-state-store, đang ngủ).
> 
> ### 7.2 3 tầng payload cho Session Runner
> 
> ```text
> Tầng 1  system + conventions + project memory   ← byte-identical QUA CÁC TICKET
>         → breakpoint cuối tầng này
> Tầng 2  ticket + context pack (checksum index)  ← byte-identical TRONG attempt
>         → breakpoint cuối: repair attempt sau vẫn hit tầng 1+2
> Tầng 3  tool results + correction text          ← luôn append CUỐI, không chèn giữa
> ```
> 
> - Project memory (L2) chính là tầng 1 của cache — block ổn định nhất, đặt đầu prompt.
> - Repair cũ nhét errors vào block giữa → phá cache; mới correction luôn append cuối.
> - `context_checksums` / `context_revision` làm cache-validity: index đổi → đổi
>   `prompt_cache_key`.
> 
> ### 7.3 Marker theo provider
> 
> | Provider | Marker |
> |---|---|
> | Anthropic / Claude | block `cacheable` → `cache_control: {type:"ephemeral"}` (`request-builder.js`) |
> | OpenAI / Codex | `cache_config` → `prompt_cache_key` + developer block `prompt_cache_breakpoint` (`openai-request-builder.js`) |
> 
> Đường session mới hiện không set gì → **cache = 0** trên Claude raw, auto-cache
> mờ nhạt trên OpenAI. Phải đánh marker đủ cả 2 path sau khi xếp 3 tầng.
> 
> ### 7.4 Đo trước khi tối ưu
> 
> - Ghi `usage.cache_read_input_tokens` / `cache_creation_input_tokens`
>   (đã normalize trong `mapUsage`) vào project log mỗi attempt.
> - Chưa có dashboard thì log ra `projectLogger` là đủ để thấy hit-rate thật.
> 
> ### 7.5 Probe `previous_response_id` (thí nghiệm, không chặn pipeline)
> 
> - Chỉ cho Codex/OpenAI path, **opt-in theo profile** (`profile.use_previous_response_id`).
> - Probe qua `sv.devquote.shop`: gửi `store:true` + `previous_response_id` thử;
>   fallback full-resend nếu gateway strip.
> - Lưu ý retention provider (~30 ngày) — copy thứ 2 ngoài `.forge`.
> 
> ---
> 
> ## 8. Nhớ — 4 lớp
> 
> ```text
> L0 trong-session:  transcript append-only
> L1 task pack:      index.db + structural summary + ticket + plan
> L2 project memory: conventions + past decisions + facts (regex filter giữ nguyên)
> L3 codebase truth: search_code/read_code + code index (tool call, không inject)
> ```
> 
> | Việc | Mô tả | Ưu tiên |
> |---|---|---|
> | Terminal hook ghi memory | Mục 6.2 | **P0** (đi kèm bridge) |
> | Retriever scoring | `memory-retriever.js`: AND-substring → scoring (term match + recency + domain), top ~20, cap prompt | P1 |
> | Decay | Fact lâu không hit → archival | P2 |
> 
> - L2 facts inject vào **tầng 1** của 3 tầng payload (ổn định nhất).
> - Knowledge/decisions stores đã wiring nhưng chưa inject — P1 mới đưa vào L2.
> 
> ---
> 
> ## 9. Tool contract v2 — `edit_diff` + `read_file` offset/limit + `write_diff` 8 KB cap
> 
> ### 9.1 Tổng quan 3 mức theo kích thước thay đổi
> 
> ```text
> file mới hoặc <8 KB            → write_diff (full content)
> file ≥8 KB, sửa cục bộ         → read_file {offset,limit} quanh vị trí → edit_diff {anchor}
> sửa rải rác nhiều chỗ           → nhiều edit_diff (mỗi cái 1 anchor)
> ```
> 
> ### 9.2 `edit_diff` (mới)
> 
> **Schema:** `schemas/agent/tools/edit-diff.schema.json`
> 
> ```json
> {
>   "title": "Forge edit diff tool input",
>   "type": "object",
>   "additionalProperties": false,
>   "required": ["path", "before_checksum", "anchor", "replacement"],
>   "properties": {
>     "path": { "type": "string", "minLength": 1, "pattern": "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$)).+" },
>     "before_checksum": { "type": ["string","null"], "pattern": "^sha256:[a-fA-F0-9]{64}$" },
>     "anchor": { "type": "string", "minLength": 1 },
>     "replacement": { "type": "string" },
>     "occurrence": { "type": "string", "enum": ["first","all"], "default": "first" }
>   }
> }
> ```
> 
> **Behavior** (`backend/src/tools/agent-lifecycle-tools.js` — thêm `createEditDiffTool`):
> 