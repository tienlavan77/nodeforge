<!-- Preserves a quoted historical document section so engineers can read archived examples without treating them as new executable definitions; removing quote prefixes reconstructs the exact original bytes. -->
> 
> ```
> read current content (fileService.readFile)
> → verify before_checksum (giữ nguyên guard như write_diff)
> → tìm anchor (exact string match)
>   → không tìm thấy → ANCHOR_NOT_FOUND
>   → tìm thấy >1 với occurrence=first → ANCHOR_NOT_UNIQUE (bắt agent thu hẹp anchor)
>   → occurrence=all → replace tất cả
> → replace → atomicWrite
> → trả về { path, sha256: newChecksum, replaced_count }
> ```
> 
> - Governance: `safePath` + `assertAllowed` y như `write_diff`.
> - `MAX_CONTENT` cho `anchor`+`replacement` cộng lại ≤ 200KB (giữ cap hiện có).
> - Không cần `allowed_file_paths` mới — dùng chung với `write_diff`.
> 
> **Registry:** `backend/src/tools/index.js` — thêm `editDiffDefinition` + `lifecycle.edit_diff`.
> 
> **MCP bridge:** `backend/src/tools/claude-sdk-forge-tools.js` — thêm `edit_diff` vào tool list
> (Claude SDK path).
> 
> **Capability:** thêm `"edit_diff"` vào `capabilitiesForRound` / `createExecutionContext`
> và `nodeforge-task-integration.js` capability list.
> 
> ### 9.3 `read_file` offset/limit (mở rộng, không phá contract)
> 
> **Schema:** `schemas/agent/tools/read-file.schema.json` — thêm optional:
> 
> ```json
> "offset": { "type": "integer", "minimum": 1, "description": "1-based start line, inclusive" },
> "limit":  { "type": "integer", "minimum": 1, "maximum": 500, "description": "max lines to return" }
> ```
> 
> - Không có offset/limit → behavior cũ (trả full, slice 200KB).
> - Có offset/limit → `lines.slice(offset-1, offset-1+limit).join("\n")`, trả kèm
>   `offset`, `limit`, `total_lines`, `truncated`.
> - `sha256` vẫn là hash của **toàn file** (để `before_checksum` cho `edit_diff`/`write_diff`
>   dùng), không phải hash của slice.
> 
> **File:** `backend/src/tools/agent-lifecycle-tools.js` — `createReadFileTool` nhận thêm
> `offset`/`limit` từ input.
> 
> ### 9.4 `write_diff` 8 KB cap
> 
> **File:** `backend/src/tools/agent-lifecycle-tools.js` — `createWriteDiffTool`
> 
> ```js
> const WRITE_DIFF_MAX_BYTES = 8192; // 8 KB — Owner duyệt
> // trong execute, sau safePath/assertAllowed:
> const byteLength = Buffer.byteLength(input.content, "utf8");
> if (byteLength > WRITE_DIFF_MAX_BYTES) {
>   throw error("CONTENT_TOO_LARGE",
>     `write_diff content is ${byteLength} bytes, limit is ${WRITE_DIFF_MAX_BYTES}. ` +
>     `For existing files use edit_diff with an anchor; for new files split into smaller writes.`,
>     { byte_length: byteLength, limit: WRITE_DIFF_MAX_BYTES });
> }
> ```
> 
> - File **mới** (`current === null`) vượt 8 KB cũng bị chặn — agent phải chia nhỏ
>   (nhiều `write_diff` cho file mới lớn không khả thi trong 1 lần; thực tế file mới
>   lớn hiếm — nếu gặp, agent tạo file rỗng rồi `edit_diff` append, hoặc Node nới cap
>   theo ticket).
> - Error code `CONTENT_TOO_LARGE` để agent tự retry bằng `edit_diff`.
> - `MAX_CONTENT` (200KB) giữ nguyên cho `edit_diff` anchor/replacement — chỉ `write_diff`
>   bị siết 8 KB.
> 
> **Schema:** `schemas/agent/tools/write-diff.schema.json` — không cần thêm field;
> cap là runtime guard (không đưa vào JSON schema để không phải version schema).
> 
> ### 9.5 Prompt hướng dẫn Session Runner
> 
> Đưa vào system prompt của attempt:
> 
> ```text
> File write rules:
> - New file or file <8 KB: use write_diff with full content.
> - Existing file ≥8 KB, local change: read_file {offset,limit} around the target,
>   then edit_diff {anchor, replacement}. Anchor must be unique exact string.
> - Multiple scattered changes: multiple edit_diff calls.
> - write_diff over 8 KB will be rejected with CONTENT_TOO_LARGE — retry with edit_diff.
> ```
> 
> ### 9.6 Tương thích & migration
> 
> - Ticket cũ đang chạy dở với `write_diff` full content >8 KB: sẽ nhận
>   `CONTENT_TOO_LARGE` ở attempt kế → agent tự chuyển `edit_diff` (không cần migrate data).
> - Test cũ mock `write_diff` với content nhỏ (<8 KB) không ảnh hưởng.
> 
> ---
> 
> ## 10. Thứ tự thực hiện (6 phase)
> 
> | Phase | Việc | File chính | Phụ thuộc |
> |---|---|---|---|
> | **1** | Bridge terminal → ticket status + terminal hook ghi memory + đo cache hit-rate | `start-control-api.mjs`, `task-summary-store.js`, `project-memory-store.js` | Không |
> | **2** | State machine 12→8 + Session Runner + Collector + Verifier + attempt-context-builder | `supervisor-runtime.js`, `supervisor-loop.js`, `sender-worker.js`, `materializer-worker.js`, `verification-worker.js`, `production-runtime.js`, `attempt-context-builder.js` (mới) | Phase 1 (bridge là nền cho terminal mới) |
> | **3** | 3 tầng payload + marker cache (Anthropic + OpenAI) | `attempt-context-builder.js`, `request-builder.js`, `openai-request-builder.js` | Phase 2 |
> | **4** | Tool contract v2: `edit_diff` + `read_file` offset/limit + `write_diff` 8KB cap | `agent-lifecycle-tools.js`, `tools/index.js`, `claude-sdk-forge-tools.js`, `schemas/agent/tools/*.json`, `production-runtime.js` (capabilities) | Độc lập, có thể song song với Phase 2 |
> | **5** | Probe `previous_response_id` (thí nghiệm) | `codex-adapter.js`/`openai-adapter.js`, `conversation-state-store.js` | Phase 3 |
> | **6** | dispatchSprint DAG + consolidate sprint paths | `start-control-api.mjs` | Phase 1 |
> 
> Phase 4 có thể làm song song với Phase 2 vì không đụng state machine.
> 
> ---
> 
> ## 11. Kiểm thử
> 
> ### Unit (mock, không gọi gateway thật)
> 
> | Test | Cover |
> |---|---|
> | `supervisor-runtime.test.js` | 8-state transitions, invalid transition = ConfigurationError, migration map cũ→mới |
> | `supervisor-loop.test.js` | `RUNNING`→`VERIFYING`→`COMPLETED`, `RUNNING`→`REPAIRING`→`RUNNING`, `NEEDS_HUMAN_REVIEW` |
> | `attempt-context-builder.test.js` (mới) | attempt 1 build, attempt 2+ append correction cuối, protocol persist |
> | `edit-diff.test.js` (mới) | anchor unique → success, not found → ANCHOR_NOT_FOUND, duplicate → ANCHOR_NOT_UNIQUE, checksum mismatch → CHECKSUM_MISMATCH, PATH_FORBIDDEN |
> | `read-file-offset.test.js` (mới) | offset/limit slice, sha vẫn hash full file, total_lines/truncated |
> | `write-diff-cap.test.js` (mới) | ≤8KB pass, >8KB CONTENT_TOO_LARGE, error message gợi ý edit_diff |
> | `terminal-bridge.test.js` (mới) | task.completed→ticket done, task.failed→failed, idempotent với duplicate event |
> | `dispatch-dag.test.js` (mới) | topological sort, dependenciesReady gate, blocked→pending khi dependency done |
> | `cache-marker.test.js` (mới) | 3 tầng payload → marker đúng vị trí Anthropic + OpenAI |
> 
> ### Regression (giữ xanh)
> 
> - `supervisor-execution.test.js`, `sender-worker-tool-loop.test.js`,
>   `codex-forge-tool-loop.test.js`, `runtime-tool-governance.test.js`,
>   `terminal-tool-bridge.test.js`, `openai-sdk-supervisor-hello.test.js`
> 
> ### Lint & schema
> 
> - `pnpm lint`, `pnpm typecheck`, `pnpm validate:schemas` (sau khi thêm `edit-diff.schema.json`
>   và mở rộng `read-file.schema.json`).
> 
> ### Smoke thủ công (không commit, user bấm `r` để restart API)
> 
> 1. Tạo ticket nhỏ với file <8KB → `write_diff` pass.
> 2. Tạo ticket sửa file lớn (>8KB) → `write_diff` trả `CONTENT_TOO_LARGE` → agent tự
>    `read_file {offset,limit}` + `edit_diff` → pass.
> 3. `read_file {offset: 50, limit: 20}` → slice đúng, sha là hash full file.
> 4. Ticket fail verification → repair attempt 2 với correction append cuối → pass.
> 5. Sprint 3 tickets có dependencies A→B→C → dispatch theo DAG, B chờ A done.
> 6. Check `.forge/runtime/nf/logs/node.log` không chứa plaintext credential;
>    `forge.tool_*` events có `edit_diff` + `cache_read_input_tokens`.
> 
> ---
> 
> ## 12. Rủi ro & giảm thiểu
> 
> | Rủi ro | Giảm thiểu |
> |---|---|
> | `write_diff` 8KB cap làm ticket tạo file mới lớn bị kẹt | Hiếm (file mới lớn thường là scaffold — agent tạo file rỗng rồi `edit_diff` append). Nếu gặp, Node có thể nới cap theo ticket `allowed_file_paths` (follow-up). |
> | `edit_diff` anchor không unique → agent loop | Error `ANCHOR_NOT_UNIQUE` kèm hint "include more surrounding lines"; prompt hướng dẫn anchor nên dài 3–5 dòng. |
> | Gateway strip `previous_response_id` (như từng strip `tools`) | Phase 5 là probe, fallback full-resend luôn sẵn; opt-in theo profile. |
> | State migration cũ→mới làm resume sai | Migration map explicit trong `supervisor-runtime.js`; test cover `REQUESTING`/`WAITING_AGENT`→`RUNNING`. |
> | Collector `git diff` miss file chưa tracked | Dùng `git status --porcelain` (bao gồm `??` untracked) + `git diff --cached` nếu cần. |
> 
> ---
> 
> ## 13. Ngoài phạm vi phase này
> 
> - Không cài `@openai/codex` CLI, không sửa MCP bridge/session.
> - Không đụng `ARCHITECTURE.md` (cập nhật sau khi pipeline mới ổn).
> - Không đổi `claude-sdk-forge-tools.js` ngoài thêm `edit_diff`.
> - Không commit/push tự động — Owner duyệt từng phase mới code.
> 