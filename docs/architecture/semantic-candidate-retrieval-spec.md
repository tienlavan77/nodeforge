# Đặc tả Kỹ thuật: Hệ thống Tìm kiếm Candidate File & Symbol theo Ngữ nghĩa (Semantic Candidate Retrieval)

## 1. Mục tiêu & Bài toán Cốt lõi

Bài toán cần giải quyết không chỉ riêng **Ticket → Code**, mà là toàn bộ luồng yêu cầu trong Forge:

> **Forge Request / Plan Outcome (`AM`) / Phản biện & Thực thi (`SE`) / Kiểm định (`RV`) / Ticket Objective + AC (`SL` & `Coder`) $\rightarrow$ Tìm ra tập nhỏ nhất các File và Symbol (hàm/class) liên quan chính xác nhất, với số lượt tìm kiếm tối thiểu nhưng đủ độ tin cậy.**

Hệ thống phục vụ thống nhất cho:
- Yêu cầu trực tiếp của Owner;
- Hạng mục (`outcomes[]`) trong Architecture Plan của `AM` (cả trong hội thoại lẫn chế độ `planning_input_only`);
- Phản biện kỹ thuật và triển khai code của `SE`;
- Kiểm định độc lập của `RV` (cả trong Handoff `AM ↔ SE ↔ RV` lẫn Ticket Review);
- Phân rã Ticket của `SL` và thực thi Ticket của `Coder`;
- Yêu cầu tiếp tục / khôi phục (`resume`) tại checkpoint.

Nguyên tắc cốt lõi:
1. **Không làm phình cơ sở dữ liệu hay thêm model nặng:** Tận dụng 100% hạ tầng **ONNX (`nomic-embed-text-v1.5`, vector 768 chiều)** và bảng SQLite `symbol_embeddings` đã có sẵn.
2. **Embedding trả về cả File lẫn `matched_symbols` kèm lý do và metadata**, không trả về toàn bộ mã nguồn thô.
3. **Tự động kết nối Kho Evidence (`subagent-evidence-store.js`) và cấp biên lai (`recordSourceMetadata`):** Sau 1 lượt gọi candidate, Agent có thể gọi thẳng `Read({ file_path, symbol })` vào đúng hàm cần đọc mà không phải gọi `search_text` hay `read_file` mò mẫm.

---

## 2. Chẩn đoán Hiện trạng Code & Các Điểm Nghẽn Cần Khắc Phục

Qua khảo sát trực tiếp mã nguồn và đối chiếu báo cáo phản biện kỹ thuật của SE (`docs/architecture/semantic-candidate-retrieval-se-critique.md`), hệ thống hiện có các điểm nghẽn sau:

1. **Điểm nghẽn 1 — Đầu vào nhúng ONNX thiếu ngữ cảnh định danh trên chu trình 5 files (`purpose-summary-input.js`, `index-record-writer.js`, `embedding-startup.js`, `embedding-worker.js`, `embedding-store.js`):**
   - Hiện chỉ băm chuỗi `summary` đơn lẻ với tiền tố `purpose-summary-v1:sha256:...` mà chưa ghép đường dẫn file và định danh symbol (`[filePath :: symbolName (symbolKind)]`).
   - Chu trình tính và đối chiếu `content_checksum` đi qua 5 files (`purpose-summary-input.js`, `index-record-writer.js`, `embedding-startup.js`, `embedding-worker.js`, `embedding-store.js`) phải được nâng cấp đồng bộ để tránh lệch checksum khiến worker đánh dấu `superseded` hoặc store bỏ qua vector.
2. **Điểm nghẽn 2 — `backend/src/modules/index/embedding-store.js` (dòng 47–64) vứt bỏ tên hàm (`symbol`) và `summary` sau khi chấm điểm ONNX:**
   - Bảng `symbol_embeddings` lưu vector theo từng hàm (`symbol_id`) và câu SQL đã `JOIN symbols s`. Tuy nhiên khi trả kết quả, hàm `search` lại gộp theo `row.path` và chỉ trả về `{ path, score }`, làm mất hoàn toàn danh sách `matched_symbols` (`symbol_id`, `name`, `kind`, `start_line`, `end_line`, `summary`).
3. **Điểm nghẽn 3 — `backend/src/modules/index/relevant-tree.js` (dòng 33) bỏ quên `acceptance_criteria` (`AC`) và `guardrails` khi gọi ONNX:**
   - Trong khi `relevant-tree-scoring.js` (lexical) có nối `acceptance_criteria`, thì `selectWithEmbeddings` lại chỉ lấy `[args.title, args.objective]` để tạo chuỗi truy vấn `search_query:` cho ONNX, làm mất toàn bộ yêu cầu chi tiết trong AC và guardrails.
4. **Điểm nghẽn 4 — `select-code-graph-candidates.js` chặn cứng `task_id` và chưa tự cấp biên lai / đồng bộ Kho Evidence:**
   - Dòng 15–17 của `select-code-graph-candidates.js` bắt buộc `context.task_id`, làm gãy các phiên hội thoại của `AM`, `SE`, `RV`, `SL` (vốn dùng `conversation_id` / `correlation_id`).
   - Kết quả candidate chưa tự động gọi `recordSourceMetadata`, chưa cập nhật `active_file_checksums` vào `conversationStateStore`, và chưa đồng bộ vào `subagent-evidence-store.js`.
5. **Điểm nghẽn 5 — Quyền gọi `select_code_graph_candidates` bị chặn ở nhiều tầng (Conversation, Catalog, Supervisor, Reviewer, Coder):**
   - Chưa có trong `ENGINEERING_TOOL_NAMES` / `CODER_TOOL_NAMES` (`engineering-tool-names.js`) và `engineeringToolDefinitions()` (`engineering-tool-catalog.js`).
   - Chưa khởi tạo implementation và chưa mở trong `planningTools` của `owner-conversation-tools.js` và `owner-role-tool-policy.js`.
   - Đang bị chặn cho `coder` và `reviewer` tại `nodeforge-task-executors.js`, `sender-worker.js`, `production-runtime.js`, `function-calling-task-executor.js`, và `reviewer-forge-tools.js`.

---

## 3. Kiến trúc Tổng quát & Hợp đồng Đầu vào

### 3.1. Luồng xử lý tổng quát

```text
Forge Request / Plan Outcome / Ticket (title + objective + AC + guardrails + scope)
        │
        ▼
Bước 0: Kho Evidence Bền Vững (read_subagent_evidence / subagent-evidence-store)
        │  (Tái sử dụng ngay các file/symbol có SHA-256 fresh)
        ▼
Semantic Query Builder (title + objective + acceptance_criteria[] + guardrails[] + query)
        │
        ▼
Hybrid Candidate Retrieval (relevant-tree + embedding-store + code-search)
  ├─ 1. ONNX Semantic Similarity (768d symbol_embeddings: file + matched_symbols)
  ├─ 2. Lexical & Identifier Match (error codes, symbol names, routes, schemas)
  ├─ 3. 1-Hop Code Graph Expansion (imports, imported_by, calls, direct tests)
  └─ 4. Evidence Cache & Scope Filtering (allowed_file_paths / allowed_prefixes)
        │
        ▼
Auto-Receipt & Evidence Sync (recordSourceMetadata + active_file_checksums + conversationStateStore)
        │
        ▼
Agent gọi trực tiếp Read({ file_path, symbol }) cho đúng matched_symbols
```

### 3.2. Hợp đồng Đầu vào (`select_code_graph_candidates`)

Tool `select_code_graph_candidates` nhận đầu vào thống nhất cho mọi Role (hợp nhất với `context.task_context` khi chạy trong Ticket Runtime):

```js
{
  query: "string (tùy chọn - câu truy vấn hoặc mô tả yêu cầu)",
  title: "string (tùy chọn - tiêu đề Plan/Outcome/Ticket)",
  objective: "string (tùy chọn - mục tiêu cần đạt)",
  acceptance_criteria: ["string (danh sách tiêu chí nghiệm thu AC)"],
  guardrails: ["string (danh sách ràng buộc / guardrails)"],
  limit: 8 // mặc định 8 file candidates (tối đa 12)
}
```

---

## 4. Đặc tả Kỹ thuật 4 Hạng mục Nâng cấp (`O1` – `O4`)

### Hạng mục O1: Giàu hóa ngữ cảnh đầu vào ONNX đồng bộ trên toàn chu trình 5 files (`purpose-summary-v2`)
- **File tác động:**
  1. `backend/src/modules/index/purpose-summary-input.js`
  2. `backend/src/modules/index/index-record-writer.js`
  3. `backend/src/modules/index/embedding-startup.js`
  4. `backend/src/modules/index/embedding-worker.js`
  5. `backend/src/modules/index/embedding-store.js`
- **Chi tiết thiết kế:**
  - Giữ nguyên **1 vector 768 chiều duy nhất cho mỗi symbol** trong bảng `symbol_embeddings`.
  - Thiết kế `purposeSummaryInput(summaryOrMeta, meta = {})` hỗ trợ cả truyền chuỗi lẫn truyền object `{ summary, path, name, kind }`:
    - Khi có ngữ cảnh định danh (`path`, `name`, `kind`), chuẩn hóa chuỗi đầu vào cho `search_document:` của ONNX theo định dạng:
      ```text
      [${filePath} :: ${symbolName} (${symbolKind})] ${summary}
      ```
    - Cập nhật tiền tố checksum sang `purpose-summary-v2:sha256:...`.
  - Cập nhật đồng bộ câu truy vấn SQL (`JOIN files f ON f.file_id = s.file_id` lấy đủ `f.path, s.name, s.kind, s.summary`) và lời gọi `purposeSummaryInput({ summary, path, name, kind })` tại cả **5 module**:
    - `index-record-writer.js` (khi trích xuất symbol lúc index file và đẩy vào `embeddingJobs.enqueue`),
    - `embedding-startup.js` (`prepareEmbeddingQueue` khi quét các symbol chưa có vector hoặc lệch checksum lúc khởi động),
    - `embedding-worker.js` (khi kiểm tra `activeJob.content_checksum` trước và sau khi nhúng ONNX),
    - `embedding-store.js` (khi kiểm tra `row.content_checksum` lúc tìm kiếm vector).

### Hạng mục O2: Truy vấn ONNX theo đầy đủ `AC`/`Guardrails` & Trả về `matched_symbols`
- **File tác động:**
  1. `backend/src/modules/index/embedding-store.js`
  2. `backend/src/modules/index/relevant-tree.js`
  3. `backend/src/modules/index/relevant-tree-scoring.js`
  4. `backend/src/modules/index/code-search.js`
- **Chi tiết thiết kế:**
  1. **Xây dựng Query ONNX đầy đủ (`relevant-tree.js`):**
     - Ghép đầy đủ `title`, `objective`, `query`, `acceptance_criteria[]`, và `guardrails[]` vào văn bản truy vấn `search_query:`.
     - Khi `acceptance_criteria` có nhiều mục riêng biệt, ngoài vector tổng hợp, cho phép nhúng các cụm AC/intent chính và lấy `max(cosine_similarity)` trên tập `symbol_embeddings` trong bộ nhớ.
  2. **Giữ lại `matched_symbols` từ `embedding-store.js` (`search`):**
     - Truy vấn SQL lấy đầy đủ `e.symbol_id, e.vector, e.content_checksum, s.name, s.kind, s.start_line, s.end_line, s.summary, f.path`.
     - Với mỗi file (`row.path`), tính điểm cấp file (`score = maxSim`) đồng thời giữ lại **Top 3 `matched_symbols`** có điểm cosine similarity cao nhất:
       ```js
       {
         path: row.path,
         score: bestScore,
         matched_symbols: [
           {
             symbol_id: row.symbol_id,
             name: row.name,
             kind: row.kind,
             start_line: row.start_line,
             end_line: row.end_line,
             score: sim,
             summary: row.summary
           }
         ]
       }
       ```
  3. **Chấm điểm Hybrid & Giải thích Lý do (`relevant-tree-scoring.js`, `relevant-tree.js`, `code-search.js`):**
     - Kết hợp điểm số từ 4 nguồn: `semantic_similarity` (ONNX 768d), `lexical_match` (từ khóa, tên hàm, mã lỗi, schema, route), `dependency_graph_relevance` (1-hop `imports`/`imported_by`/`calls` và file test trực tiếp), và `evidence_reuse` (file `fresh` trong Kho Evidence).
     - Áp dụng bộ lọc phạm vi (`allowed_file_paths`, `allowed_prefixes`) khi chạy trong Ticket Runtime của Coder, và loại bỏ các đường dẫn runtime `.forge/`.
     - Trả về kèm `confidence` (`high` / `medium` / `low`), `reasons`, `matched_ac`, và `matched_symbols`.

### Hạng mục O3: Kết nối `select_code_graph_candidates` với Kho Evidence, Hỗ trợ Hội thoại & Tự Động Cấp Biên Lai
- **File tác động:**
  1. `backend/src/tools/discovery/select-code-graph-candidates.js`
  2. `backend/src/tools/discovery/subagent-evidence-store.js`
  3. `backend/src/tools/discovery/source-metadata-receipts.js`
  4. `backend/src/tools/roles/owner-conversation-tools.js`
- **Chi tiết thiết kế:**
  1. **Hỗ trợ cả Ticket Runtime lẫn Conversation / Handoff Runtime (`select-code-graph-candidates.js`):**
     - Thay vì bắt buộc `context.task_id`, cho phép fallback định danh:
       `const taskId = context.task_id ?? context.taskId ?? context.conversation_id ?? context.correlation_id ?? "owner-discovery";`
     - Chỉ gọi `assertExecutionScope(context, taskId)` khi `context.task_id` hoặc `context.taskId` được định nghĩa trong Ticket execution.
     - Mở rộng `input` của `select_code_graph_candidates` để nhận trực tiếp `{ query, title, objective, acceptance_criteria, guardrails, limit }` và hợp nhất với `context.task_context`.
  2. **Tự động cấp biên lai (`recordSourceMetadata`) & Đồng bộ Kho Evidence:**
     - Với mỗi candidate file nằm trong kết quả trả về:
       - Đọc metadata thực tế từ `codeCache` / `fileService` / SQLite index để lấy `sha256` hiện hành trên đĩa, `total_lines`, `symbol_map` và `code_graph` rút gọn.
       - Tự động gọi `recordSourceMetadata(context, { path, sha256, symbol_map })` và cập nhật `context.active_file_checksums[path] = sha256`.
       - Tự động gọi `subagentEvidenceStore.recordDirectEvidence(...)` để chia sẻ chéo giữa `AM ↔ SE ↔ RV` và lưu vào kho riêng của từng Agent.
     - Trong `owner-conversation-tools.js` (dòng 80–100): sau khi thực thi `select_code_graph_candidates`, lưu bền vững `active_file_checksums` và `discovery_receipts` vào `conversationStateStore.update(conversationId, ...)` tương tự như `delegate_subagent` và `read_subagent_evidence`.
  3. **Cấu trúc kết quả trả về:**
     - Mỗi candidate chứa `{ path, sha256, score, confidence, reasons, matched_ac, matched_symbols, symbol_map, receipt_registered: true, next_action: "Read({ file_path, symbol })" }` cùng `search_plan`.

### Hạng mục O4: Mở quyền Tool Toàn Luồng & Quy tắc Dừng Tìm kiếm (Retrieval Stop Policy) cho `AM`, `SE`, `RV`, `SL`, `Coder`
- **File tác động:**
  1. `backend/src/tools/engineering-tool-names.js` & `backend/src/tools/engineering-tool-catalog.js`
  2. `backend/src/tools/roles/owner-role-tool-policy.js` & `backend/src/tools/roles/owner-conversation-tools.js`
  3. `backend/src/modules/governance/runtime-tool-governance.js`
  4. `backend/src/modules/supervisor/nodeforge-task-executors.js`, `backend/src/modules/supervisor/sender-worker.js`, `backend/src/modules/supervisor/production-runtime.js`, `backend/src/modules/supervisor/function-calling-task-executor.js`
  5. `backend/src/modules/supervisor/review/reviewer-forge-tools.js`
  6. `backend/src/application/owner-sdk-stream.js` & `backend/src/modules/supervisor/nodeforge-task-prompts.js`
  7. `workflows/agents/{architecture,system-engineer,reviewer,sprint-leader,coder}/README.md`
- **Chi tiết thiết kế:**
  1. **Mở khóa đồng bộ tại mọi cổng kiểm soát tool:**
     - Thêm `"select_code_graph_candidates"` vào `ENGINEERING_TOOL_NAMES`, `CODER_TOOL_NAMES` (`engineering-tool-names.js`) và xuất định nghĩa schema trong `engineeringToolDefinitions()` (`engineering-tool-catalog.js`).
     - Khởi tạo implementation `select_code_graph_candidates` trong `owner-conversation-tools.js`, thêm vào `planningTools` (để AM gọi được khi lập kế hoạch) và `owner-role-tool-policy.js` cho `architecture_manager`, `system_engineer`, `reviewer`, `sprint_leader`.
     - Bỏ chặn `coder` và `reviewer` tại `nodeforge-task-executors.js` (bỏ `selected.role !== "coder"`), `sender-worker.js` (bỏ `&& !coderRequest`), `production-runtime.js` (cấp `"select_code_graph_candidates"` cho cả `coder`), `function-calling-task-executor.js` và `reviewer-forge-tools.js`.
  2. **Retrieval Stop Policy (Quy trình tìm kiếm tối thiểu trong Prompt & README):**
     - **Bước 0 — Đọc kho:** Gọi `read_subagent_evidence({})` đầu tiên.
     - **Bước 1 — Hybrid Candidate Retrieval 1 lần:** Gọi `select_code_graph_candidates({ title, objective, acceptance_criteria, guardrails })`.
     - **Bước 2 — Đọc trực tiếp Symbol:** Dùng `matched_symbols` và biên lai đã cấp sẵn (`receipt_registered: true`) để gọi thẳng `Read({ file_path, symbol })` mà không gọi lại `read_file`.
     - **Bước 3 — Dừng tìm kiếm khi đủ Coverage:** Khi mọi AC đã có candidate logic + test và `confidence` đạt `high`/`medium` (`additional_search_recommended: false`), dừng tìm kiếm ngay để thực thi nhiệm vụ.

---

## 5. Bảng Tổng Hợp Danh Sách File Cần Cập Nhật Theo Từng Hạng Mục

| Hạng mục | Danh sách File trong phạm vi thực thi |
| --- | --- |
| **O1 (ONNX Input v2 - 5 files)** | `backend/src/modules/index/purpose-summary-input.js`, `backend/src/modules/index/index-record-writer.js`, `backend/src/modules/index/embedding-startup.js`, `backend/src/modules/index/embedding-worker.js`, `backend/src/modules/index/embedding-store.js` |
| **O2 (Hybrid Retrieval & Matched Symbols)** | `backend/src/modules/index/embedding-store.js`, `backend/src/modules/index/relevant-tree.js`, `backend/src/modules/index/relevant-tree-scoring.js`, `backend/src/modules/index/code-search.js` |
| **O3 (Evidence Store, Receipts & Conversation Sync)** | `backend/src/tools/discovery/select-code-graph-candidates.js`, `backend/src/tools/discovery/subagent-evidence-store.js`, `backend/src/tools/discovery/source-metadata-receipts.js`, `backend/src/tools/roles/owner-conversation-tools.js` |
| **O4 (Role Permissions, Catalog, Runtime & Prompts)** | `backend/src/tools/engineering-tool-names.js`, `backend/src/tools/engineering-tool-catalog.js`, `backend/src/tools/roles/owner-role-tool-policy.js`, `backend/src/tools/roles/owner-conversation-tools.js`, `backend/src/modules/governance/runtime-tool-governance.js`, `backend/src/modules/supervisor/nodeforge-task-executors.js`, `backend/src/modules/supervisor/sender-worker.js`, `backend/src/modules/supervisor/production-runtime.js`, `backend/src/modules/supervisor/function-calling-task-executor.js`, `backend/src/modules/supervisor/review/reviewer-forge-tools.js`, `backend/src/application/owner-sdk-stream.js`, `backend/src/modules/supervisor/nodeforge-task-prompts.js`, `workflows/agents/{architecture,system-engineer,reviewer,sprint-leader,coder}/README.md` |
