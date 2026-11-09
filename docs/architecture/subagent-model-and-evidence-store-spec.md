# Đặc tả Kiến trúc: Subagent Model Failover (`claude-haiku-4-5` ↔ `Claude-luna`) & Hệ thống Kho Evidence Đa Tầng (Per-Agent + Cross-Share `AM ↔ SE ↔ RV`)

- **Ngày lập:** 2026-11-09
- **Người lập:** Architecture Manager (AM)
- **Tài liệu liên quan:** `docs/architecture/subagent-forge-tool.md`

---

## 1. Chính sách 2 Model Subagent Cố định & Cross-Provider Failover (3 Tầng)

Vì nhiệm vụ của Subagent (`delegate_subagent`) là **Read-Only Explorer** (chỉ tìm kiếm và đọc hiểu cấu trúc file/code), hệ thống sử dụng cố định **2 model tốc độ cao, chi phí thấp** với `effort: "low"`:

1. **`claude-haiku-4-5`** (Claude Haiku 4.5 — thực thi qua `claudeSdkGateway`)
2. **`Claude-luna`** (GPT-6 Luna — thực thi qua `codexSdkGateway`)

### 1.1. Quy tắc Ưu tiên và Chuyển đổi Dự phòng (Failover Chain)

| Provider của Parent (`AM`, `SE`, `RV`, `SL`, `Coder`) | Ưu tiên 1 (Primary) | Dự phòng 2 (Khi Ưu tiên 1 trả về lỗi) | Dự phòng 3 (Khi cả 2 model đều lỗi) |
|---|---|---|---|
| **`anthropic` / `claude`** | Gọi **`claude-haiku-4-5`** | Tự động chuyển sang gọi **`Claude-luna`** | Không làm gãy turn của Parent; lưu phần evidence đã đọc được vào Kho, trả trạng thái `fallback_to_parent: true` để **Parent tự làm** |
| **`openai` / `codex`** | Gọi **`Claude-luna`** | Tự động chuyển sang gọi **`claude-haiku-4-5`** | Không làm gãy turn của Parent; lưu phần evidence đã đọc được vào Kho, trả trạng thái `fallback_to_parent: true` để **Parent tự làm** |

### 1.2. Chi tiết Kỹ thuật trong Code cho Chuỗi Failover
1. **Trong `backend/src/modules/agent/claude-sdk-gateway.js` (dòng 77 & 105):**
   - Khi `subagentId` có mặt: mặc định `model = config.subagent_model ?? options.subagentModel ?? "claude-haiku-4-5"`, `effort = "low"`.
   - Truyền đúng biến `model` đã phân giải vào `createSdkTerminalLog` (dòng 105).
2. **Trong `backend/src/modules/agent/codex-sdk-gateway.js` (dòng 74 & 142):**
   - Khi `subagentId` có mặt: mặc định `model = profile.subagent_model ?? options.subagentModel ?? "Claude-luna"`, `modelReasoningEffort = "low"`.
   - Trong `backend/src/modules/supervisor/nodeforge-task-executors.js` (dòng 157): bỏ `model: selected.model` khỏi `options` của `childExecutor` để không ghi đè mất `"Claude-luna"`.
3. **Bộ điều phối `executeSubagentWithFailover` (dùng chung cho `owner-sdk-stream.js` và `nodeforge-task-executors.js`):**
   - Xác định thứ tự ứng viên:
     - Nếu `["claude", "anthropic"].includes(parentProvider)` $\rightarrow$ `candidates = [{ provider: "anthropic", model: "claude-haiku-4-5" }, { provider: "codex", model: "Claude-luna" }]`.
     - Nếu `["codex", "openai"].includes(parentProvider)` $\rightarrow$ `candidates = [{ provider: "codex", model: "Claude-luna" }, { provider: "anthropic", model: "claude-haiku-4-5" }]`.
   - Khi ứng viên 1 ném lỗi (timeout, 429/503, lỗi kênh model, hoặc thiếu credential), ghi log cảnh báo `subagent.model_failover` và tự động chạy ứng viên 2 (sử dụng profile/credential hợp lệ của provider thứ 2 trong `agentConfiguration` nếu có).
   - Nếu cả 2 ứng viên đều lỗi:
     - Không throw làm hỏng batch hoặc làm dừng turn của Parent.
     - Vẫn giữ nguyên mọi `childContext.observed_files` đã kịp đọc trước khi lỗi, ghi vào Kho với `status: "fallback_to_parent"`, và trả về `{ status: "fallback_to_parent", fallback_to_parent: true, summary: "Both subagent models (claude-haiku-4-5 and Claude-luna) failed; parent agent must inspect the remaining paths directly.", observed_files: childContext.observed_files ?? [] }`.

---

## 2. Kiến trúc Kho Evidence Riêng Cho Từng Agent (`AM`, `SE`, `RV`, `Coder`) & Chia Sẻ Chéo Trong Luồng `AM ↔ SE ↔ RV`

### 2.1. Hạn chế của Code Hiện Tại (`subagent-evidence-store.js` & `subagent-evidence-tool.js`)
Qua khảo sát `backend/src/tools/discovery/subagent-evidence-store.js` (dòng 10–65) và `subagent-evidence-tool.js` (dòng 24–38):
1. **Chỉ lưu tạm trên RAM và bị khóa hẹp theo từng `delegationId` đơn lẻ:**
   - `const delegations = new Map()` chỉ sống trong bộ nhớ theo khóa `${conversationId}:${delegationId}`.
   - Sang turn tiếp theo (khi `correlationId` / `execution_id` đổi mới), `delegationId` thay đổi nên Agent gọi `read_subagent_evidence` chỉ nhận được mảng rỗng `[]`!
2. **Chưa lưu kết quả đọc trực tiếp của Parent (`read_file` / `Read`) vào kho:**
   - Hiện tại chỉ khi gọi `delegate_subagent` thì mới ghi vào `evidenceStore`. Khi chính `AM`, `SE`, `RV`, `Coder` gọi `read_file` hoặc `Read`, kết quả chưa được lưu vào kho để tái sử dụng ở các lượt sau.
3. **Chưa cho phép Share Chéo giữa `AM ↔ SE ↔ RV` và chưa mở cho `Coder`:**
   - Trong `subagent-evidence-tool.js` (dòng 27): chặn cứng nếu khác `conversationId` hoặc `delegationId`.
   - Trong `am-se-handoff-service.js` (dòng 222–224, 311–314, 336–338): `AM` chạy trên `amConversationId`, `SE` chạy trên `CONV-SE-<planId>`, `RV` chạy trên `CONV-RV-<planId>`, và mỗi bước (`se`, `rv`, `am`) lại tạo một `executionId` mới (`CORR-HANDOFF-...`), dẫn đến **`AM`, `SE`, `RV` không nhìn thấy kho của nhau** và phải tìm kiếm lại từ đầu ở mỗi bước!
   - Trong `nodeforge-task-executors.js` & `engineering-tool-catalog.js`: `Coder` chưa được cấp tool `read_subagent_evidence`.

---

### 2.2. Thiết kế Kho Mới: Per-Agent Durable Evidence Store + Cross-Share `AM ↔ SE ↔ RV`

#### A. Cấu trúc Kho Riêng cho Từng Agent (`AM`, `SE`, `RV`, `Coder`)
Trong `backend/src/tools/discovery/subagent-evidence-store.js`:
1. **Mỗi Agent Role có Kho Bền Vững Riêng (`roleStore`):**
   - Lưu trữ theo project tại `.forge/runtime/nf/evidence-stores/<projectId>/` (kết hợp bộ đệm in-memory + ghi bền vững qua `fileService` hoặc runtime state):
     - Kho của **AM (`architecture_manager`)**: lưu theo `conversationId` và `planId`.
     - Kho của **SE (`system_engineer`)**: lưu theo `conversationId` / `seConversationId` và `handoffId` / `planId`.
     - Kho của **RV (`reviewer`)**: lưu theo `rvConversationId` và `handoffId` / `planId`.
     - Kho của **Coder (`coder`)**: lưu theo `ticketId` / `sprintId` (kèm liên kết tới `planId` của Sprint).
2. **Tự động Nạp vào Kho từ CẢ Subagent LẪN Parent:**
   - **Nguồn 1 (`delegate_subagent`):** Khi Subagent hoàn thành (hoặc `fallback_to_parent`), mọi `observed_files` (`path`, `sha256`, `total_lines`, `symbol_map`, `code_graph`, `symbols_read`) và bản tóm tắt `summary` của worker được ghi vào kho của Agent gọi nó.
   - **Nguồn 2 (Trực tiếp từ Parent khi gọi `read_file` / `Read`):** Khi chính `AM`, `SE`, `RV`, `Coder` gọi `read_file({ path })` hoặc `Read({ file_path, symbol })`, wrapper trong `owner-conversation-tools.js` và `engineering-tool-binding.js` tự động cập nhật `{ path, sha256, total_lines, symbol_map, code_graph, symbols_read, source_role, updated_at }` vào kho của Agent đó!
   - **Tự động cập nhật khi sửa file (`edit_diff`, `write_diff`, `delete_file`, `move_file`, `run_command`, `git_*`):**
     - Khi `SE` hoặc `Coder` sửa file làm đổi `sha256`, kho tự động cập nhật `sha256` mới (hoặc đánh dấu cần làm mới `symbol_map` nếu cấu trúc hàm thay đổi) để không bao giờ dùng nhầm `sha256` cũ.

#### B. Cơ chế Share Chéo Kho trong Luồng `AM ↔ SE ↔ RV` (Cross-Role Shared Handoff Pool)
Khi chạy trong luồng `AM ↔ SE ↔ RV` (hoặc khi truy vấn `read_subagent_evidence`):
1. **Liên kết Kho Chung (`handoff_id` / `plan_id` / `linked_conversation_id`):**
   - Trong `am-se-handoff-service.js` (`startHandoff`, `resumeCritique`, `resumeHandoff`) và `owner-sdk-stream.js`: truyền `handoff_id` và `plan_id` (hoặc suy ra từ `CONV-SE-<planId>`, `CONV-RV-<planId>`, `linked_conversation_id`) vào `context.evidence_scope`:
     ```js
     evidence_scope: {
       projectId,
       role: profile.role,
       agentId,
       conversationId,
       linkedConversationId: payload.linked_conversation_id ?? null,
       handoffId: payload.handoff_id ?? null,
       planId: payload.plan_id ?? null
     }
     ```
2. **Hợp nhất Kho Chéo (`snapshotWithCrossShare`) khi `AM`, `SE`, hoặc `RV` đọc kho:**
   - Khi **`AM`** gọi `read_subagent_evidence`: đọc kho của chính `AM` + hợp nhất (merge) kho của `SE` và `RV` thuộc cùng `handoffId` / `planId` / `conversationId`.
   - Khi **`SE`** gọi `read_subagent_evidence`: đọc kho của chính `SE` + **tự động share chéo toàn bộ kho của `AM` (từ bước lập plan/critique) và kho của `RV` (từ các vòng review trước)**!
   - Khi **`RV`** gọi `read_subagent_evidence`: đọc kho của chính `RV` + **tự động share chéo toàn bộ kho của `AM` và kho của `SE` (bao gồm các file `SE` vừa đọc và sửa trong vòng hiện tại)**!
   - Khi **`Coder`** gọi `read_subagent_evidence`: đọc kho riêng của `Coder` trên `ticket_id` hiện tại + kế thừa các entry trong kho của `AM`/`SL` thuộc phạm vi `allowed_file_paths` / `allowed_prefixes` của ticket đó.

#### C. Tự động Xác thực `sha256` Thực tế & Cấp Biên lai `recordSourceMetadata` Ngay Khi Đọc Kho
Khi bất kỳ Agent nào (`AM`, `SE`, `RV`, `Coder`) gọi `read_subagent_evidence`:
1. Tool kiểm tra nhanh `sha256` của từng file trong kho so với file hiện tại trên đĩa (hoặc `codeCache`):
   - Giữ lại các entry có `sha256` **khớp tuyệt đối** với trạng thái hiện tại trên đĩa (`fresh: true`).
   - Đánh dấu `stale: true` nếu file đã bị thay đổi bên ngoài mà chưa kịp đồng bộ.
2. **Tự động gọi `recordSourceMetadata(context, { path, sha256, symbol_map })` và điền `active_file_checksums`** cho mọi file `fresh: true` trong kết quả trả về!
   - Nhờ vậy, ngay sau 1 lệnh `read_subagent_evidence({})`, `SE`, `RV`, `AM` hoặc `Coder` **có sẵn toàn bộ `sha256` và `symbol_map` hợp lệ** để gọi thẳng `Read({ file_path, symbol })` hoặc `edit_diff` mà **không cần gọi lại `read_file` hay `search_text`**!

---

## 3. Quy trình Bắt buộc cho Mọi Parent Agent (`AM`, `SE`, `RV`, `Coder`)

Cập nhật vào System Prompt (`owner-sdk-stream.js`, `nodeforge-task-prompts.js`) và `workflows/agents/{architecture,system-engineer,reviewer,coder}/README.md`:
1. **Bước 1 — Luôn đọc Kho (`read_subagent_evidence`) đầu tiên:**
   - Trước khi gọi `search_text`, `search_tree`, `list_files`, `read_file` hoặc `delegate_subagent`, Agent phải kiểm tra kho evidence (`read_subagent_evidence({})`) để lấy danh sách file, `sha256`, `symbol_map` và tóm tắt đã có sẵn từ các lượt trước hoặc được share chéo từ `AM ↔ SE ↔ RV`.
2. **Bước 2 — Tái sử dụng trực tiếp không tìm lại:**
   - Với mọi file đã có trong kho và còn `fresh: true`, dùng ngay `Read({ file_path, symbol })` (hoặc `edit_diff` với `sha256` trong kho), tuyệt đối không tìm kiếm lại hay gọi lại `read_file` cho các file đó.
3. **Bước 3 — Khảo sát bổ sung (nếu còn thiếu):**
   - Chỉ những module/file chưa có trong kho mới gọi `delegate_subagent` (tự động chạy `claude-haiku-4-5` $\leftrightarrow$ `Claude-luna` failover) hoặc tự đọc nếu chỉ có 1 file / khi cả 2 model subagent đều lỗi (`fallback_to_parent`).
