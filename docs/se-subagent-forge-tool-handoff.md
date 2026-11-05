<!--
Kế hoạch kỹ thuật bàn giao trực tiếp cho System Engineer (SE) để triển khai công cụ Subagent Explorer (`delegate_subagent` / `mcp__forge__delegate_subagent`) trên toàn hệ thống Forge.
Mục đích nghiệp vụ là cho phép các agent đang chạy ở chế độ Forge ủy quyền song song việc đọc hiểu và khảo sát mã nguồn cho các subagent read-only, đồng bộ liền mạch checksum và biên lai metadata về agent cha.
Về mặt kỹ thuật, kế hoạch chia thành 5 hạng mục (W1–W5) bao phủ từ cô lập runtime trong SDK gateways, xây dựng tool handler + đồng bộ biên lai, tích hợp vào registry/policy của các role, định dạng hiển thị UI transcript, cho đến bộ kiểm thử nghiệm thu.
-->
# Kế hoạch Triển khai & Bàn giao cho System Engineer (SE): Subagent Forge Tool (`delegate_subagent`)

- **Người lập:** Architecture Manager (AM) | **Người thực thi:** System Engineer (SE)
- **Ngày ban hành:** 2026-11-05
- **Tài liệu kiến trúc cơ sở:** [`docs/architecture/subagent-forge-tool.md`](architecture/subagent-forge-tool.md) (`sha256:c1a86f1aa9228de594870d9da2c49fc48d706ef0de12a62d49f60fb0d79d2113` / `sha256:c1a86842ce38a7e6a18bd906bdc496f6a18bd906bdc496f6a2e8b5a2154ead449d3f25bfa0890c77`)

---

## 0. Nguyên tắc và Ràng buộc Bắt buộc cho SE

1. **Ranh giới quyền của Subagent (100% Read-Only Explorer):**
   - Subagent **chỉ** được cấp bộ công cụ đọc/khảo sát của Forge: `search_tree`, `list_files`, `search_text`, `read_file`, `Read` (và `read_file_binary` nếu role cha là `architecture_manager` hoặc `system_engineer`).
   - **Tuyệt đối không cấp** cho Subagent: `edit_diff`, `write_diff`, `delete_file`, `move_file`, `run_check`, `run_test`, `check_test`, `commit_changes`, `push_commit`, `report_done`, `respond_to_review`, và **không cấp** chính `delegate_subagent` (khóa cứng độ sâu đệ quy ở **1 cấp**: Agent cha $\rightarrow$ Subagent).
2. **Không áp `discovery_budget` cho Subagent:**
   - Subagent chạy với `exploration_enabled: false` (không giới hạn cứng số lượt gọi `search_text`, `read_file`, `Read`).
   - Dọn sạch thông báo giả `discovery_budget: { used: 0, limit: 8, remaining: 8 }` khi phiên không bật quota khám phá (`context.exploration_state` không tồn tại hoặc `exploration_enabled === false`).
3. **Quy chuẩn mã nguồn (`CLAUDE.md`):**
   - Mọi file tạo mới hoặc chỉnh sửa phải $\le 250$ `code_lines` (và $\le 400$ `code_lines` giới hạn cứng của `write_diff`).
   - Chỉ thêm comment mục đích cho file mới hoặc hàm/symbol mới tạo.
   - Bảo toàn mọi thay đổi không liên quan trên working tree; chỉ chạy các bài test/lint hẹp liên quan trực tiếp tới các file thay đổi.

---

## 1. Hạng mục W1 — Cô lập Runtime cho Subagent trong `claude-sdk-gateway.js` và `codex-sdk-gateway.js`

### 1.1. `backend/src/modules/agent/claude-sdk-gateway.js`
- Hỗ trợ tùy chọn `subagentId` (trong tham số `execute({ agentId, subagentId, ... })` hoặc `options.subagentId`):
  1. **Tra cứu cấu hình & Credential:** Vẫn gọi `getEnabledConfig(agentId)` theo `agentId` của Agent cha để dùng chung profile, provider, `credential_ref` và `gateway_url`.
  2. **Khóa theo dõi tiến trình (`active` Set):**
     - Đặt `const activeKey = subagentId ? `${agentId}:sub:${subagentId}` : agentId;`.
     - Dùng `active.add(activeKey)` và `active.delete(activeKey)` trong `finally` để khi Subagent kết thúc **không xóa nhầm trạng thái `active.has(agentId)` của Agent cha đang chạy**.
  3. **Cô lập thư mục `claudeHome` & Tự động dọn rác:**
     - Khi có `subagentId`, đặt `claudeHome = join(claudeHomeRoot ?? resolveRuntimePath(workingDirectory, ".forge/runtime/nf/claude-homes"), config.agent_id, "subagents", subagentId)`.
     - Trong khối `finally`, nếu có `subagentId`, xóa thư mục tạm `claudeHome` bằng `rmSync(claudeHome, { recursive: true, force: true })` (bọc `try/catch` best-effort) để các subagent chạy song song không đụng file lock và không để lại rác trên đĩa.
  4. **Không kế thừa Session của Agent cha:** Đảm bảo khi có `subagentId`, `resumeSessionId` luôn là `undefined`.

### 1.2. `backend/src/modules/agent/codex-sdk-gateway.js`
- Hỗ trợ tùy chọn `subagentId` tương đương:
  1. Khi có `subagentId`, đặt `codexHome = join(codexHomeRoot ?? resolveRuntimePath(workingDirectory, ".forge/runtime/nf/codex-homes"), profile.agent_id, "subagents", subagentId)` và dọn sạch thư mục tạm này trong khối `finally`.
  2. Tăng `tool_timeout_sec` của MCP server `forge` (dòng 101–102) lên phù hợp (ví dụ `Math.ceil(Math.min(timeoutMs, 660_000) / 1000)`) khi danh sách `mcpSession.tools` có chứa `delegate_subagent` để Codex CLI không ngắt sớm khi chờ Subagent chạy xong.

---

## 2. Hạng mục W2 — Xây dựng Tool `delegate_subagent` và Đồng bộ Biên lai (`source-metadata-receipts.js` + `active_file_checksums`)

Tạo module mới (ví dụ `backend/src/tools/discovery/delegate-subagent-tool.js`) và định nghĩa schema trong catalog:

### 2.1. Hợp đồng đầu vào (Input Schema) của `delegate_subagent`
- Tên tool: `delegate_subagent` (khi qua Claude MCP sẽ là `mcp__forge__delegate_subagent`).
- Input schema hỗ trợ chạy **Batch Parallel** ngay trong 1 lần gọi:
  ```json
  {
    "type": "object",
    "additionalProperties": false,
    "required": ["tasks"],
    "properties": {
      "tasks": {
        "type": "array",
        "minItems": 1,
        "maxItems": 3,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["objective"],
          "properties": {
            "id": { "type": "string", "minLength": 1, "maxLength": 64 },
            "objective": { "type": "string", "minLength": 1, "maxLength": 2000 },
            "paths": {
              "type": "array",
              "items": { "type": "string", "minLength": 1 }
            }
          }
        }
      }
    }
  }
  ```

### 2.2. Guardrails & Thực thi Song song (`Promise.allSettled`)
1. **Giới hạn số lượng:**
   - Tối đa **3 subagents / lần gọi** (`tasks.length <= 3`) và tối đa **4 subagents / turn** của Agent cha (theo dõi bộ đếm trên `toolContext`). Nếu vượt quá, trả lỗi `ConfigurationError` rõ ràng.
2. **Kế thừa bảo mật File Access Policy (Zero Privilege Escalation):**
   - Subagent dùng lại chính `scopedFiles` (`createRoleFileService`), `scopedCache`, `allowed_file_paths`, `allowed_prefixes` và `file_access_policy` của Agent cha.
   - Tuyệt đối không gắn `delegate_subagent` hoặc bất kỳ tool ghi/xóa/test/git nào vào registry của Subagent.
3. **Cấu hình Model & Reasoning Effort của Subagent:**
   - Mặc định gọi gateway với `effort: "low"` (hoặc `"medium"`), `model: profile.subagent_model ?? profile.model`, và gắn chung `abortSignal` của Agent cha.
4. **Chạy song song với `Promise.allSettled`:**
   - Chạy đồng thời tất cả các phần tử trong `input.tasks`.
   - Nếu 1 subagent lỗi hoặc timeout, các subagent thành công còn lại vẫn trả về đầy đủ `summary` và `observed_files`.
   - Giới hạn độ dài `summary` của mỗi subagent ở mức tối đa `6000` ký tự để bảo vệ context window của Agent cha.

### 2.3. Đồng bộ `observed_files`, `active_file_checksums` và `recordSourceMetadata` về Agent cha
- Trong quá trình mỗi Subagent gọi `read_file` và `Read`:
  1. Ghi nhận mọi file và symbol mà Subagent đã đọc vào danh sách `observed_files`:
     ```json
     {
       "path": "backend/src/...",
       "sha256": "sha256:...",
       "symbols_read": ["..."]
     }
     ```
  2. **Đồng bộ `source-metadata-receipts.js`:** Gọi `recordSourceMetadata(parentToolContext, metadata)` cho từng file mà Subagent đã `read_file` để Agent cha có thể gọi tiếp `Read({ file_path, symbol })` ngay ở lượt sau mà không bị chặn bởi `READ_INPUT_INVALID`.
  3. **Đồng bộ `active_file_checksums`:** Cập nhật các `{ path, sha256, total_lines, status: "read" }` mà Subagent đã đọc vào `conversationStateStore` / `checkpoint` của Agent cha để Agent cha có thể gọi `edit_diff` ngay lập tức.

---

## 3. Hạng mục W3 — Tích hợp vào Role Tool Policy, Owner Stream, Supervisor & Prompt Hướng dẫn

1. **Catalog & Role Policy:**
   - Khai báo `delegateSubagentDefinition` trong `backend/src/tools/engineering-tool-catalog.js` (và `engineering-tool-names.js` nếu áp dụng).
   - Mở quyền `delegate_subagent` trong `backend/src/tools/roles/owner-role-tool-policy.js` (`ownerRoleTools`) cho các role: `system_engineer`, `architecture_manager`, `sprint_leader`, `coder`, `reviewer` (bao gồm cả khi `planning_input_only` đang bật ở bước discovery).
   - Đăng ký `delegate_subagent` trong `backend/src/tools/roles/owner-conversation-tools.js` (truyền `sdk` / `sdkGateways` vào để tool có thể khởi chạy phiên con).
   - Nếu mở cho ticket runtime (`nodeforge-task-executors.js`), thêm `delegate_subagent` vào danh sách tool cho phép và loại trừ nó khỏi subagent con.
2. **Tách bạch Token Usage trong `owner-sdk-stream.js`:**
   - Token tiêu thụ bên trong `delegate_subagent` có thể được ghi nhận vào `subagent_usage` để thống kê, nhưng **không cộng dồn** vào `last_turn_input_tokens` của Agent cha để tránh kích hoạt nhầm Session Rollover/Compaction.
3. **Cập nhật Prompt hướng dẫn trong `owner-sdk-stream.js`:**
   - Bổ sung hướng dẫn ngắn gọn trong `fileToolInstruction` / `sourceDiscoveryInstruction`: khuyến khích gọi `delegate_subagent` khi cần khảo sát song song nhiều thư mục/nhánh mã nguồn độc lập để giữ sạch context chính, và tận dụng ngay `sha256` từ `observed_files` trả về khi cần `edit_diff`.

---

## 4. Hạng mục W4 — Hiển thị trên UI Transcript (`system-engineer-sdk-transcript.js`)

Trong `backend/src/application/system-engineer-sdk-transcript.js`:
1. **`formatForgeToolCommand`:**
   - Bổ sung nhánh định dạng cho `name === "delegate_subagent"`:
     - Hiển thị ngắn gọn số lượng task và phạm vi/mục tiêu, ví dụ:
       `delegate_subagent (2 tasks: backend/src/application, backend/src/modules/agent)`
2. **`formatForgeToolActivitySummary`:**
   - Trong `summarizeResult` (`owner-conversation-tools.js`) và `formatForgeToolActivitySummary` (`system-engineer-sdk-transcript.js`), trích xuất số lượng `tasks_completed` và tổng số `observed_files` để hiển thị dòng tóm tắt rõ ràng trên bảng **Agent Activity** (ví dụ: `delegate_subagent -> 2/2 tasks, 5 files observed (3.2s)`).
3. **Không làm nhiễu khung chat chính:**
   - Không truyền `onTextDelta` hoặc `onEvent` của khung chat chính vào bên trong lượt `sdk.execute` của Subagent để văn bản trung gian của Subagent không in đè lên câu trả lời của Agent cha.

---

## 5. Hạng mục W5 — Kiểm thử Nghiệm thu & Báo cáo Handoff của SE

SE viết/cập nhật unit tests kiểm chứng đầy đủ các kịch bản sau và chạy bằng `node --test`:
1. **Test thực thi song song & Partial Success (`delegate-subagent-tool.test.js`):**
   - Gọi `delegate_subagent` với 2–3 tasks chạy song song.
   - Kiểm chứng Subagent chỉ có các tool read-only (`search_tree`, `list_files`, `search_text`, `read_file`, `Read`) và **không có** `edit_diff`, `write_diff`, `delete_file`, `run_check`, `commit_changes`, hay `delegate_subagent`.
   - Kiểm chứng khi 1 task bị lỗi, các task còn lại vẫn trả về kết quả và `observed_files` (`Promise.allSettled`).
2. **Test đồng bộ biên lai & Checksum:**
   - Sau khi Subagent đọc một file qua `read_file`, kiểm chứng Agent cha có thể gọi ngay `Read({ file_path, symbol })` trên file đó mà không bị lỗi `READ_INPUT_INVALID` (`recordSourceMetadata` đã được đồng bộ), và `active_file_checksums` của cuộc hội thoại đã có `sha256` của file đó.
3. **Test cô lập Runtime trong Gateway:**
   - Kiểm chứng khi Subagent chạy với `subagentId` và kết thúc trước Agent cha, `active.has(parentAgentId)` vẫn giữ nguyên là `true`, và thư mục tạm `claudeHome` / `codexHome` của Subagent được dọn sạch.
4. **Test hiển thị Transcript:**
   - Kiểm chứng `formatForgeToolCommand("mcp__forge__delegate_subagent", ...)` và `formatForgeToolActivitySummary("delegate_subagent", ...)` trả về chuỗi hiển thị chuẩn.

Sau khi hoàn tất, SE gửi báo cáo theo hợp đồng `system_engineer.handoff.v1` nêu rõ danh sách file đã tạo/sửa (kèm `sha256`), kết quả chạy các bài test hẹp liên quan, và các giới hạn còn lại (nếu có).
