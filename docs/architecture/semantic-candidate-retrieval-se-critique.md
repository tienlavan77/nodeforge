<!-- Báo cáo phản biện và góp ý kỹ thuật của System Engineer cho kế hoạch PLAN-PROJECT-NODEFORGE-d69fa8ff-8eb9-4a57-9ddf-e5bdb2d497cd (r1) về Hệ thống Tìm kiếm Candidate File & Symbol theo Ngữ nghĩa. -->
# Báo cáo Góp ý Kỹ thuật (SE Critique): Hệ thống Tìm kiếm Candidate File & Symbol theo Ngữ nghĩa

- **Mã kế hoạch:** `PLAN-PROJECT-NODEFORGE-d69fa8ff-8eb9-4a57-9ddf-e5bdb2d497cd` (Revision `r1`)
- **File kế hoạch gốc:** `.forge/runtime/nf/planning/plans/PLAN-PROJECT-NODEFORGE-d69fa8ff-8eb9-4a57-9ddf-e5bdb2d497cd/plan-source-r1.json`
- **Người thực hiện rà soát:** System Engineer (SE)
- **Ngày lập báo cáo:** 2026-11-09

---

## 1. Đánh giá Tổng quan & Điểm mạnh của Bản Kế hoạch `r1`

Bản kế hoạch `r1` đã xác định chính xác 4 điểm nghẽn kiến trúc hiện hữu trong mã nguồn:
1. **Đầu vào nhúng thiếu ngữ cảnh định danh (`purpose-summary-input.js`):** Hiện chỉ băm chuỗi `summary` đơn lẻ với tiền tố `purpose-summary-v1:sha256:...` mà chưa ghép đường dẫn file và định danh symbol (`[filePath :: symbolName (symbolKind)]`).
2. **Mất thông tin cấp symbol khi truy vấn (`embedding-store.js`, dòng 47–64):** Hàm `search` truy vấn `symbol_embeddings` nối với `symbols` và `files` nhưng khi gom kết quả theo `row.path` lại chỉ giữ `{ path, score }`, làm mất hoàn toàn danh sách `matched_symbols` (`symbol_id`, `name`, `kind`, `start_line`, `end_line`, `summary`).
3. **Truy vấn ngữ nghĩa bỏ sót tiêu chí nghiệm thu (`relevant-tree.js`, dòng 33):** Hàm `selectWithEmbeddings` mới chỉ ghép `[args.title, args.objective]` để nhúng vector truy vấn ONNX mà bỏ qua toàn bộ `acceptance_criteria` và `guardrails`.
4. **Chưa khép kín luồng khám phá 1 chạm (`select-code-graph-candidates.js`):** Công cụ `select_code_graph_candidates` chưa tự động đăng ký biên lai `recordSourceMetadata` + `active_file_checksums`, chưa đồng bộ vào `subagent-evidence-store.js`, và đang bị khóa quyền ở nhiều role.

---

## 2. Các Điểm Thiếu Sót Kỹ Thuật Cần Bổ Sung (Critical Gaps)

Qua đối chiếu trực tiếp với đồ thị phụ thuộc (`code_graph`) và mã nguồn thực tế, nếu triển khai y nguyên danh sách file trong `plan-source-r1.json` sẽ phát sinh **4 lỗi gãy luồng thực thi**. Cần bổ sung các điểm sau vào kế hoạch:

### 2.1. [Hạng mục O1] Thiếu 2 file cốt lõi cùng gọi `purposeSummaryInput`: `index-record-writer.js` và `embedding-startup.js`

- **Hiện trạng trong `plan-source-r1.json` (O1):** Kế hoạch mới chỉ liệt kê sửa `backend/src/modules/index/purpose-summary-input.js` và `backend/src/modules/index/embedding-worker.js` (dòng 40–43).
- **Thực tế trong mã nguồn:** Hàm `purposeSummaryInput` đang được gọi tại **5 module** tạo thành chu trình khép kín:
  1. `backend/src/modules/index/purpose-summary-input.js` (hàm gốc tạo `{ content, checksum }`).
  2. `backend/src/modules/index/index-record-writer.js` (dòng 54, 71, 81, 108 — nơi trích xuất symbol khi index file và gọi `embeddingJobs.enqueue({ symbolId, contentChecksum: checksum, model })`).
  3. `backend/src/modules/index/embedding-startup.js` (dòng 48–54 — hàm `prepareEmbeddingQueue` chạy lúc khởi động server để quét `SELECT s.symbol_id, s.summary ...` và đẩy các symbol chưa có vector/lệch checksum vào hàng đợi).
  4. `backend/src/modules/index/embedding-worker.js` (dòng 43, 62 — đối chiếu `purposeSummaryInput(...)?.checksum !== activeJob.content_checksum` trước và sau khi gọi ONNX).
  5. `backend/src/modules/index/embedding-store.js` (dòng 54 — kiểm tra `row.content_checksum !== purposeSummaryInput(...)?.checksum` khi tìm kiếm vector).
- **Hệ quả nếu thiếu `index-record-writer.js` và `embedding-startup.js`:**
  - Lúc index hoặc lúc khởi động, job được tạo với checksum tính từ `summary` đơn lẻ (hoặc thiếu `path, name, kind`), trong khi `embedding-worker.js` và `embedding-store.js` lại tính checksum có ghép `[filePath :: symbolName (symbolKind)]`.
  - Hai mã băm `checksum` sẽ **luôn khác nhau** $\rightarrow$ `embedding-worker.js` sẽ đánh dấu mọi job là `superseded` (không tạo vector), còn `embedding-store.js` (dòng 54) sẽ `continue` bỏ qua 100% các dòng trong bảng `symbol_embeddings`!
- **Giải pháp đề xuất cho O1:**
  - Thiết kế `purposeSummaryInput(summaryOrMeta, meta = {})` hỗ trợ cả truyền chuỗi lẫn truyền ngữ cảnh `{ summary, path, name, kind }`.
  - Cập nhật đồng bộ câu truy vấn SQL (`JOIN files f ON f.file_id = s.file_id` lấy đủ `f.path, s.name, s.kind, s.summary`) và lời gọi `purposeSummaryInput` tại cả **5 file**:
    - `backend/src/modules/index/purpose-summary-input.js`
    - `backend/src/modules/index/index-record-writer.js`
    - `backend/src/modules/index/embedding-startup.js`
    - `backend/src/modules/index/embedding-worker.js`
    - `backend/src/modules/index/embedding-store.js`

---

### 2.2. [Hạng mục O3] Thiếu khởi tạo tool và đồng bộ `active_file_checksums` trong `owner-conversation-tools.js`

- **Hiện trạng trong `plan-source-r1.json` (O3 & O4):** Yêu cầu mở `select_code_graph_candidates` cho AM, SE, RV, SL trong `owner-conversation-tools.js`.
- **Thực tế trong mã nguồn (`backend/src/tools/roles/owner-conversation-tools.js`):**
  1. Dòng 34–45 (`implementations`) và `createAgentCommandTools` hiện **chưa khởi tạo** `select_code_graph_candidates`. Do dòng 62 lọc `typeof implementations[name]?.execute === "function"`, nếu chỉ thêm tên tool vào `owner-role-tool-policy.js` mà không gắn implementation (`createSelectCodeGraphCandidatesTool`) vào `implementations` của `owner-conversation-tools.js` (cùng `relevantTreeSelector` / `freshnessChecker` từ `codeSearch`), tool sẽ bị lọc bỏ.
  2. Dòng 25 (`planningTools`): khi AM chạy ở chế độ lập kế hoạch (`context.planning_input_only === true`), danh sách tool bị chặn bởi mảng `planningTools`. Cần thêm `"select_code_graph_candidates"` vào `planningTools` (và `explorerTools` nếu muốn subagent dùng được).
  3. Dòng 80–100: Sau khi gọi `select_code_graph_candidates`, cần cập nhật `active_file_checksums` và `discovery_receipts` vào `conversationStateStore.update(conversationId, ...)` tương tự như nhánh `delegate_subagent` và `read_subagent_evidence` (dòng 85–89) để phiên hội thoại lưu bền vững checksum của các candidate files.

---

### 2.3. [Hạng mục O3] Ràng buộc `task_id` trong `select-code-graph-candidates.js` sẽ chặn AM/SE/RV/SL trong hội thoại

- **Thực tế trong mã nguồn (`backend/src/tools/discovery/select-code-graph-candidates.js`, dòng 15–17):**
  ```js
  const taskId = context.task_id ?? context.taskId;
  if (typeof taskId !== "string" || !taskId) throw scopedError("TOOL_SCOPE_INVALID", "Candidate selection requires the current task_id.");
  assertExecutionScope(context, taskId);
  ```
- Khi AM, SE, RV hoặc SL gọi tool trong phiên hội thoại (`owner-conversation-tools.js`), `context` có thể chỉ có `conversation_id` hoặc `correlation_id` chứ không có `task_id` của Ticket.
- **Giải pháp đề xuất cho O3:**
  - Cho phép fallback định danh: `const taskId = context.task_id ?? context.taskId ?? context.conversation_id ?? context.correlation_id ?? "owner-discovery";` và chỉ gọi `assertExecutionScope(context, taskId)` khi `context.task_id` / `context.taskId` được định nghĩa trong Ticket execution.
  - Mở rộng `input` của `select_code_graph_candidates` để nhận trực tiếp `{ query, title, objective, acceptance_criteria, guardrails, limit }` (hợp nhất với `context.task_context` nếu đang chạy trong Ticket).

---

### 2.4. [Hạng mục O4] Còn 4 điểm chặn quyền của `coder` và `reviewer` ngoài `nodeforge-task-executors.js`

- **Hiện trạng trong `plan-source-r1.json` (O4):** Chỉ nêu sửa `owner-role-tool-policy.js`, `owner-conversation-tools.js`, `runtime-tool-governance.js` và `nodeforge-task-executors.js` (dòng 42, 124).
- **Thực tế trong mã nguồn còn 4 chốt chặn khác phải mở đồng bộ:**
  1. **`backend/src/tools/engineering-tool-names.js` & `backend/src/tools/engineering-tool-catalog.js`:**
     - `ENGINEERING_TOOL_NAMES` và `CODER_TOOL_NAMES` hiện chưa chứa `"select_code_graph_candidates"`, và `engineeringToolDefinitions()` chưa xuất schema của `select_code_graph_candidates`.
     - Vì cả `owner-conversation-tools.js` (dòng 60), `nodeforge-task-executors.js` (`CODER_TOOL_NAMES`, `CODER_FORGE_TOOL_NAMES`, `coderToolDefinitions()`), `function-calling-task-executor.js` (dòng 35) và `reviewer-forge-tools.js` (dòng 24) đều lấy danh sách tool từ `engineeringToolDefinitions()` / `CODER_TOOL_NAMES`, nên **bắt buộc phải thêm `"select_code_graph_candidates"` vào `ENGINEERING_TOOL_NAMES` và `engineeringToolDefinitions()`**.
  2. **`backend/src/modules/supervisor/sender-worker.js` (dòng 50):**
     - Đang có điều kiện `[capabilities.has("select_code_graph_candidates") && !coderRequest, selectCodeGraphCandidatesDefinition]` chặn cứng `coderRequest`. Cần bỏ `&& !coderRequest`.
  3. **`backend/src/modules/supervisor/production-runtime.js` (dòng 24):**
     - Đang có `const candidate = role === "coder" ? [] : ["select_code_graph_candidates"];` chặn cứng role `coder`. Cần cấp `"select_code_graph_candidates"` cho cả `coder`.
  4. **`backend/src/modules/supervisor/review/reviewer-forge-tools.js`:**
     - Reviewer trong ticket pipeline khởi tạo tool qua `reviewer-forge-tools.js`, cần bổ sung `select_code_graph_candidates` vào `implementations` tại đây để RV gọi được trong lúc review ticket.

---

## 3. Bảng Tổng Hợp Danh Sách File Cần Cập Nhật Trong Kế Hoạch

| Hạng mục | File trong `plan-source-r1.json` | File cần bổ sung thêm vào Kế hoạch |
| --- | --- | --- |
| **O1 (ONNX Input v2)** | `purpose-summary-input.js`, `embedding-worker.js` | `index-record-writer.js`, `embedding-startup.js`, `embedding-store.js` |
| **O2 (Hybrid Retrieval & Matched Symbols)** | `embedding-store.js`, `relevant-tree.js`, `relevant-tree-scoring.js` | `code-search.js` (đảm bảo expose method/selector xuống tầng tool) |
| **O3 (Evidence Store & Metadata Receipts)** | `select-code-graph-candidates.js`, `subagent-evidence-store.js`, `source-metadata-receipts.js` | `owner-conversation-tools.js` (đồng bộ `active_file_checksums` vào `conversationStateStore`) |
| **O4 (Role Permissions & Stop Policy)** | `owner-role-tool-policy.js`, `owner-conversation-tools.js`, `runtime-tool-governance.js`, `nodeforge-task-executors.js`, Role READMEs | `engineering-tool-names.js`, `engineering-tool-catalog.js`, `sender-worker.js`, `production-runtime.js`, `function-calling-task-executor.js`, `reviewer-forge-tools.js` |
