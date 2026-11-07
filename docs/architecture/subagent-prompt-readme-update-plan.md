# Kế hoạch Cập nhật System Prompts & Role READMEs (`delegate_subagent`) cho 5 Roles: Coder, AM, SE, RV, SL

Tài liệu này mô tả chi tiết kế hoạch cập nhật **Role READMEs** (`workflows/agents/*/README.md`) và **Runtime Prompt Builders** (`backend/src/...`) cho cả 5 vai trò (**Coder, Architecture Manager, System Engineer, Reviewer, Sprint Leader**) để các agent chủ động sử dụng công cụ **`delegate_subagent` (Read-Only Explorer)** khi khảo sát mã nguồn.

---

## 1. Bối cảnh và Nguyên nhân hiện tại các Agent ít gọi `delegate_subagent`

Qua khảo sát trực tiếp bằng `delegate_subagent` trên toàn bộ `workflows/agents/` và `backend/src/`:

1. **Tất cả 5 file Role README hiện chưa hề nhắc đến `delegate_subagent`:**
   - `workflows/agents/coder/README.md` (54 dòng)
   - `workflows/agents/architecture/README.md` (130 dòng)
   - `workflows/agents/system-engineer/README.md` (21 dòng)
   - `workflows/agents/reviewer/README.md` (56 dòng)
   - `workflows/agents/sprint-leader/README.md` (154 dòng)
   - Các mục `## Forge source discovery` / `## Forge source reading` hiện chỉ liệt kê `search_tree`, `list_files`, `search_text`, `read_file`, `Read`.
2. **Các Runtime Prompt Builders trong `backend/src/` cũng chưa hướng dẫn khi nào gọi `delegate_subagent`:**
   - `backend/src/application/owner-sdk-stream.js` (dòng 148–151: `fileToolInstruction` và `sourceDiscoveryInstruction`) chỉ hướng dẫn dùng trực tiếp `search_text`, `read_file`, `Read`.
   - `backend/src/modules/supervisor/nodeforge-task-prompts.js` (`buildCodexTicketPrompt` dòng 21–67 và `buildToolTicketPrompt` dòng 122–167) chỉ liệt kê `search_tree`, `list_files`, `search_text`, `read_file`, `Read`.
   - `backend/src/application/sprint-plan-leader.js` (`buildPlanPrompt`), `backend/src/application/ticket-sprint-leader.js` (`buildPrompt`), `backend/src/modules/supervisor/review/review-worker.js`, và `backend/src/modules/supervisor/blocker/blocker-recovery-agent.js` chưa có hướng dẫn gọi `delegate_subagent`.
3. **Ở tầng Ticket/Sprint Runtime (`nodeforge-task-executors.js`, `sprint-plan-leader.js`, `review-worker.js`):**
   - Trong Owner Chat (`owner-sdk-stream.js`), cả 5 role đã có `childExecutor` thật.
   - Nhưng trong Ticket Runtime (`nodeforge-task-executors.js` dòng 65 & 145), `delegateSubagentExecutor` cần được truyền đầy đủ từ runtime (`nodeforge-task-integration.js` / `ticket-workspace-runtime.js`) để Coder gọi `delegate_subagent` không bị `SUBAGENT_EXECUTOR_UNAVAILABLE`.

---

## 2. Nguyên tắc Chung khi Hướng dẫn Sử dụng `delegate_subagent` trong Prompt & README

Mọi Role README và System Prompt sẽ thống nhất quy tắc **Phối hợp Song song giữa Agent Cha và Subagents (Parallel Co-Execution)**:

1. **Agent Cha KHÔNG ĐƯỢC ngồi không nhìn Subagent làm:**
   - Khi gọi `delegate_subagent`, Agent Cha phải **phát đồng thời (trong cùng một lượt tool call batch)** lệnh gọi `delegate_subagent` cho các nhánh khảo sát phụ/độc lập **CÙNG LÚC** với lệnh `read_file` / `Read` / `edit_diff` của chính Agent Cha trên file mục tiêu chính!
   - Cụ thể:
     - **Agent Cha (Main Agent):** Trực tiếp đọc/sửa file trung tâm mà mình đã biết rõ đường dẫn hoặc chịu trách nhiệm chính.
     - **Subagents (1–3 Read-Only Explorers):** Chạy song song để khảo sát các nhánh phụ trợ (ví dụ: nhánh 1 tìm callers/consumers, nhánh 2 kiểm tra unit tests/contracts, nhánh 3 kiểm tra UI/routes liên quan).
   - Tuyệt đối không đẩy việc đọc 1 file đơn lẻ sang subagent rồi ngồi chờ thụ động.
2. **Khi nào GỌI `delegate_subagent({ tasks: [...] })`:**
   - Khi cần khảo sát **từ 2 khu vực / module / file độc lập trở lên** ngoài file chính mà Agent Cha đang trực tiếp xử lý.
   - Gom tối đa **1–3 tasks độc lập trong một lần gọi** (`tasks: [{ id, objective, paths }, ...]`), mỗi task có `id` rõ ràng, `objective` cụ thể và `paths` giới hạn phạm vi cần đọc.
3. **Tái sử dụng biên lai (Receipts & Checksums) ngay khi Subagent trả về:**
   - Subagent là **Read-Only Explorer** (`search_tree`, `list_files`, `search_text`, `read_file`, `Read`).
   - Ngay khi lượt tool call song song hoàn tất, Agent Cha đã có sẵn kết quả đọc của chính mình **cộng với** `observed_files` (`sha256` + `symbol_map` receipt) từ các subagents, và có thể lập tức gọi `Read({ file_path, symbol })` hoặc `edit_diff` mà không cần gọi lại `read_file({ path })`.

---

## 3. Chi tiết Cập nhật cho 5 File Role README (`workflows/agents/*/README.md`)

*(Đảm bảo mọi file `.md` sau khi cập nhật đều $\le 250$ dòng).*

### 3.1. `workflows/agents/coder/README.md` (`sha256:c4d2835d7cb6d652407480b8a910122e43f4724fec97e7e3d0aca32ad2801f1c`, hiện 54 dòng)
- **Vị trí cập nhật:** Mục `## Implementation and verification` (bullet 1 & 2).
- **Nội dung bổ sung:**
  - Thêm `delegate_subagent` vào danh sách công cụ Forge chuẩn của Coder.
  - Hướng dẫn: Khi ticket liên quan đến nhiều file/module hoặc cần đối chiếu implementation + callers + tests, dùng `delegate_subagent({ tasks: [...] })` (tối đa 3 task read-only song song) để khảo sát song song và nhận sẵn `observed_files` (`path`, `sha256`, `symbol_map`). Sau khi subagent trả về, dùng ngay `Read({ file_path, symbol })` và `edit_diff` trên agent cha mà không cần `read_file` lại các file đã được subagent quan sát.

### 3.2. `workflows/agents/architecture/README.md` (`sha256:e1701b1b4c431be1aba6d0a4e9858bec3b94b59d542f5a2245975c437d217a62`, hiện 130 dòng)
- **Vị trí cập nhật:** Mục `## 2. Discovery, evidence...` và `## Forge source discovery` (cuối file).
- **Nội dung bổ sung:**
  - Khi khảo sát kiến trúc, đánh giá tác động chéo (API, application, governance, UI, tests) hoặc chuẩn bị `evidence` cho Architecture Plan JSON, ưu tiên gọi `delegate_subagent({ tasks: [...] })` (1–3 task song song) để khảo sát các nhánh độc lập.
  - Dùng `observed_files` do subagent trả về làm bằng chứng đường dẫn (`evidence`) và tái sử dụng metadata/checksum đã thu thập.

### 3.3. `workflows/agents/system-engineer/README.md` (`sha256:450062e5fc59cb98364d10a28206e493cefd8370ac7efc27cd1770a3f0afc59a`, hiện 21 dòng)
- **Vị trí cập nhật:** Mục `## Forge source discovery`.
- **Nội dung bổ sung:**
  - Khi thực hiện phản biện kế hoạch (`plan_critique`), điều tra lỗi phức tạp, hoặc khảo sát nhiều khu vực trước khi sửa code, chủ động gọi `delegate_subagent({ tasks: [...] })` (tối đa 3 task read-only song song) để gom nhanh metadata, `symbol_map`, `sha256` và phân tích.
  - Tận dụng `observed_files` và `active_file_checksums` từ subagent để đọc symbol (`Read`) và sửa file (`edit_diff`) trực tiếp trên SE mà không phải đọc lặp lại.

### 3.4. `workflows/agents/reviewer/README.md` (`sha256:35bbd45d489f550d588a8d99e9ed8963795e655fe99bf1a0ce282037f8e9e410`, hiện 56 dòng)
- **Vị trí cập nhật:** Mục `## Forge source reading` (cuối file).
- **Nội dung bổ sung:**
  - Khi review nhiều file thay đổi, kiểm tra chéo contract/callers/tests hoặc đối chiếu guardrails ở nhiều thư mục, Reviewer có thể gọi `delegate_subagent({ tasks: [...] })` (1–3 task read-only song song) để kiểm tra song song trước khi đọc chi tiết symbol bằng `Read({ file_path, symbol })` và ra quyết định nghiệm thu.

### 3.5. `workflows/agents/sprint-leader/README.md` (`sha256:63d482dfccc137005ceccecc3e16faf88fddb64bad63c142577bf07e39943a50`, hiện 154 dòng)
- **Vị trí cập nhật:** Mục `## Forge source reading` (cuối file).
- **Nội dung bổ sung:**
  - Khi phân rã outcomes của Architecture Plan thành Sprint Plan / Tickets hoặc khi điều tra blocker liên quan đến nhiều module, SL dùng `delegate_subagent({ tasks: [...] })` (tối đa 3 task read-only song song) để khảo sát nhanh cấu trúc file, dependency graph và xác định phạm vi ticket chính xác.

---

## 4. Chi tiết Cập nhật cho các File Runtime Prompt Builders trong `backend/src/`

### 4.1. `backend/src/application/owner-sdk-stream.js` (Áp dụng cho AM, SE, SL, Coder, RV trong Owner Chat & Handoff)
- **Tại `fileToolInstruction` & `sourceDiscoveryInstruction` (dòng 148–151):**
  - Bổ sung hướng dẫn rõ ràng về `delegate_subagent`:
    - Trong `fileToolInstruction` của `systemEngineer` (dòng 148) và `architecture_manager` (dòng 150): Nhắc công cụ `delegate_subagent` để ủy quyền tối đa 3 tác vụ khảo sát chỉ đọc (`tasks: [{ id, objective, paths }]`) chạy song song khi cần tìm hiểu nhiều file/module.
    - Trong `sourceDiscoveryInstruction` (dòng 151 — dùng chung cho mọi role ở chế độ Forge): Bổ sung câu hướng dẫn:
      > *"For multi-file or cross-module exploration, use `delegate_subagent({tasks:[{id,objective,paths}]})` (up to 3 parallel read-only tasks) to inspect independent areas concurrently; files observed by subagents automatically register `read_file` metadata receipts and checksums on the parent context so you can call `Read({file_path,symbol})` or `edit_diff` directly without re-reading unchanged files."*

### 4.2. `backend/src/modules/supervisor/nodeforge-task-prompts.js` (Áp dụng cho Coder trong Ticket Runtime)
- **Tại `buildCodexTicketPrompt` (dòng 24, 56–59) và `buildToolTicketPrompt` (dòng 125, 156–158):**
  - Thêm `delegate_subagent` vào danh sách công cụ discovery của Coder.
  - Hướng dẫn Coder: Khi ticket cần khảo sát từ 2 file/khu vực trở lên, có thể gọi `delegate_subagent` để khảo sát song song và nhận sẵn `read_file` metadata receipts + `sha256` trước khi gọi `Read({ file_path, symbol })` và `edit_diff`.

### 4.3. Đồng bộ `delegateSubagentExecutor` cho Ticket Runtime của Coder (`backend/src/modules/supervisor/nodeforge-task-executors.js` & nơi khởi tạo)
- Kiểm tra và nối `delegateSubagentExecutor` vào `createNodeforgeTaskExecutors` (trong `nodeforge-task-integration.js` / `ticket-workspace-runtime.js`) dùng read-only child registry (`search_tree`, `list_files`, `search_text`, `read_file`, `Read`) tương tự `owner-sdk-stream.js` để khi Coder trong Ticket Runtime gọi `delegate_subagent` theo prompt mới thì thực thi thành công trên cả Claude SDK và Codex SDK.

---

## 5. Kiểm thử & Nghiệm thu (Verification Criteria)

1. **Kiểm tra giới hạn dòng và tính toàn vẹn của 5 file Role README:**
   - Cả 5 file `workflows/agents/{coder,architecture,system-engineer,reviewer,sprint-leader}/README.md` đều chứa hướng dẫn `delegate_subagent` và đều $\le 250$ dòng.
2. **Unit Tests cho Prompt & Tool Surface:**
   - Cập nhật/chạy pass:
     - `backend/tests/unit/owner-source-discovery-prompt.test.js`
     - `backend/tests/unit/system-engineer-sdk-tools.test.js`
     - `backend/tests/unit/owner-sdk-tools.test.js`
     - `backend/tests/unit/coder-unified-forge-tools.test.js`
     - `backend/tests/unit/delegate-subagent-tool.test.js`
   - Đảm bảo không có test nào bị gãy khi chuỗi prompt (`sourceDiscoveryInstruction`, `fileToolInstruction`, `buildToolTicketPrompt`, `buildCodexTicketPrompt`) được bổ sung hướng dẫn `delegate_subagent`.
