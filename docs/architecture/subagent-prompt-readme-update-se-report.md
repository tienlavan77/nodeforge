<!-- Báo cáo kỹ thuật của System Engineer sau khi hoàn thành cập nhật System Prompts, Role READMEs và Ticket Runtime cho công cụ delegate_subagent trên cả 5 vai trò. -->
# Báo cáo SE: Cập nhật System Prompts, Role READMEs & Ticket Runtime (`delegate_subagent`)

- **Người thực hiện:** System Engineer (SE)
- **Người nhận bàn giao (Intended Recipient):** Architecture Manager (AM) & Project Owner
- **Tài liệu đặc tả tham chiếu:** `docs/architecture/subagent-prompt-readme-update-plan.md`

---

## 1. Tóm tắt các hạng mục đã triển khai

### 1.1. 5 File Role README (`workflows/agents/*/README.md` — đều $\le 250$ dòng)
- **`workflows/agents/coder/README.md` (55 dòng):** Đã bổ sung `delegate_subagent` vào danh sách công cụ Forge chuẩn trong mục `## Implementation and verification`, kèm hướng dẫn phối hợp song song (Parallel Co-Execution) giữa Coder cha và tối đa 3 Read-Only Explorer subagents, tái sử dụng `observed_files` (`read_file` metadata receipts + `sha256` checksums) để gọi trực tiếp `Read({file_path,symbol})` và `edit_diff`.
- **`workflows/agents/architecture/README.md` (132 dòng):** Đã bổ sung hướng dẫn gọi `delegate_subagent({tasks:[{id,objective,paths}]})` trong mục `## Forge source discovery` khi khảo sát 2–3 vùng độc lập hoặc tác động liên module song song với việc AM trực tiếp kiểm tra/soạn thảo tài liệu kiến trúc.
- **`workflows/agents/system-engineer/README.md` (23 dòng):** Đã bổ sung hướng dẫn sử dụng `delegate_subagent` trong mục `## Forge source discovery` cho `plan_critique` và điều tra/triển khai đa module, tận dụng `observed_files` và `active_file_checksums`.
- **`workflows/agents/reviewer/README.md` (58 dòng):** Đã bổ sung hướng dẫn sử dụng `delegate_subagent` trong mục `## Forge source reading` khi kiểm tra chéo callers, contracts và test files song song với việc Reviewer trực tiếp đọc các diff symbols chính.
- **`workflows/agents/sprint-leader/README.md` (156 dòng):** Đã bổ sung hướng dẫn sử dụng `delegate_subagent` trong mục `## Forge source reading` khi phân rã Architecture Outcomes thành Sprint Tickets hoặc điều tra blocker liên module.

### 1.2. Runtime Prompt Builders (`backend/src/...`)
- **`backend/src/application/owner-sdk-stream.js`:**
  - Cập nhật `fileToolInstruction` cho `system_engineer`, `architecture_manager` (cả chế độ chat và `planning_input_only`), và các role khác trong Owner Chat để nhắc rõ quy tắc gọi `delegate_subagent` song song cùng lượt tool call với `read_file`/`Read`/`edit_diff` trên file chính.
  - Cập nhật `sourceDiscoveryInstruction` (dùng chung cho mọi role ở chế độ Forge) hướng dẫn gọi `delegate_subagent({tasks:[{id,objective,paths}]})` (tối đa 3 task chỉ đọc chạy song song) và tái sử dụng biên lai `read_file` metadata + `sha256` từ `observed_files`.
- **`backend/src/modules/supervisor/nodeforge-task-prompts.js`:**
  - Cập nhật cả `buildCodexTicketPrompt` và `buildToolTicketPrompt`: thêm `delegate_subagent` vào danh sách công cụ Forge chuẩn của Coder và bổ sung hướng dẫn phối hợp song song + tái sử dụng `observed_files` (`read_file` metadata receipts & `sha256` checksums).
- **`backend/src/application/sprint-plan-leader.js` & `backend/src/application/ticket-sprint-leader.js`:**
  - Bổ sung `delegate_subagent` và hướng dẫn khảo sát song song nhiều module vào `buildPlanPrompt` và `buildPrompt`.
- **`backend/src/modules/supervisor/review/review-worker.js` & `backend/src/modules/supervisor/blocker/blocker-recovery-agent.js`:**
  - Bổ sung hướng dẫn sử dụng `delegate_subagent` khi khảo sát nhiều vùng/module độc lập và tái sử dụng `observed_files`.

### 1.3. Đồng bộ `delegateSubagentExecutor` & Tool Catalog cho Ticket Runtime của Coder
- **`backend/src/tools/engineering-tool-names.js` & `backend/src/tools/roles/claude-sdk-forge-tools.js`:**
  - Đồng bộ `"delegate_subagent"` vào `ENGINEERING_TOOL_NAMES` (và `CODER_TOOL_NAMES`) cũng như `forgeSdkToolNames` để danh sách tên công cụ khớp 100% với `engineeringToolDefinitions()` và `coderToolDefinitions()`.
- **`backend/src/modules/supervisor/nodeforge-task-executors.js`:**
  - Trang bị `childExecutor` mặc định cho cả `runToolTicket` (Claude SDK) và `runCodexTask` (Codex SDK) dùng read-only explorer binding (`search_tree`, `list_files`, `search_text`, `read_file`, `Read`) để Coder trong Ticket Runtime gọi `delegate_subagent` thực thi thành công mà không bị `SUBAGENT_EXECUTOR_UNAVAILABLE`.
  - Sửa lỗi lọc nhầm `mcp__forge__Read` khỏi `allowedTools` của Coder trên Claude SDK và loại bỏ việc gắn trùng `delegateSubagentDefinition` trong `runCodexTask`.
- **`backend/src/tools/engineering-tool-binding.js` & `backend/src/modules/supervisor/ticket/ticket-resume.js`:**
  - Tự động ghi nhận `observed_files` trả về từ `delegate_subagent` vào `context.observed_files` và `state.readCache` (`rememberRead`) để Coder dùng ngay `before_checksum` cho `edit_diff` trên các file subagent đã đọc.

---

## 2. Kết quả Kiểm thử (Checks Executed)

Đã chạy lệnh kiểm thử tập trung qua `run_check`:

```text
node --test backend/tests/unit/coder-unified-forge-tools.test.js backend/tests/unit/owner-source-discovery-prompt.test.js backend/tests/unit/system-engineer-sdk-tools.test.js backend/tests/unit/owner-sdk-tools.test.js backend/tests/unit/delegate-subagent-tool.test.js backend/tests/unit/engineering-tool-catalog.test.js backend/tests/unit/sprint-plan-leader.test.js backend/tests/unit/ticket-sprint-leader.test.js backend/tests/unit/review-worker.test.js backend/tests/unit/blocker-recovery-agent.test.js
```

- **Trạng thái:** `PASSED` (`exit_code: 0`, Run ID: `VERIFY-RUN-923e44aa-6a2e-4626-8c41-8ee26eb28291`).

---

## 3. Danh sách File Thay đổi & Bằng chứng (Evidence Paths)

- `workflows/agents/coder/README.md`
- `workflows/agents/architecture/README.md`
- `workflows/agents/system-engineer/README.md`
- `workflows/agents/reviewer/README.md`
- `workflows/agents/sprint-leader/README.md`
- `backend/src/application/owner-sdk-stream.js`
- `backend/src/modules/supervisor/nodeforge-task-prompts.js`
- `backend/src/application/sprint-plan-leader.js`
- `backend/src/application/ticket-sprint-leader.js`
- `backend/src/modules/supervisor/review/review-worker.js`
- `backend/src/modules/supervisor/blocker/blocker-recovery-agent.js`
- `backend/src/modules/supervisor/nodeforge-task-executors.js`
- `backend/src/modules/supervisor/ticket/ticket-resume.js`
- `backend/src/tools/engineering-tool-binding.js`
- `backend/src/tools/engineering-tool-names.js`
- `backend/src/tools/roles/claude-sdk-forge-tools.js`
- `backend/tests/unit/owner-source-discovery-prompt.test.js`
- `backend/tests/unit/coder-unified-forge-tools.test.js`
- `backend/tests/unit/owner-sdk-tools.test.js`
- `backend/tests/unit/engineering-tool-catalog.test.js`
- `backend/tests/unit/sprint-plan-leader.test.js`
- `backend/tests/unit/review-worker.test.js`
- `backend/tests/unit/blocker-recovery-agent.test.js`

---

## 4. Giới hạn còn lại (Remaining Limitations)

- Các unit test kiểm tra cấu trúc prompt, tool definitions và luồng ủy quyền subagent với gateway giả lập; hiệu quả phân tách task thực tế của từng model phụ thuộc vào khả năng lập luận của provider khi chạy phiên thật.
- Chưa thực hiện `git commit` hay `git push` theo quy tắc chỉ commit/push khi được Owner yêu cầu rõ ràng.
