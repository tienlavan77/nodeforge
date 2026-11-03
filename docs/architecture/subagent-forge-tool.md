# Ghi chú Kiến trúc: Subagent Explorer trong Nodeforge (`mcp__forge__delegate_subagent`)

Tài liệu này tổng hợp toàn bộ kết quả khảo sát mã nguồn và các quyết định kiến trúc đã trao đổi giữa Project Owner và Architecture Manager (AM) về cơ chế gọi Subagent trong Nodeforge.

---

## 1. Bản chất cơ chế Subagent giữa các SDK / API

1. **Claude Code / `@anthropic-ai/claude-agent-sdk`:**
   - Hỗ trợ gọi subagent qua built-in tool **`Agent`** (hoặc tên tương đương **`Task`** ở một số phiên bản CLI/SDK).
   - Khi khởi tạo session, SDK nhận cấu hình `agents` (định nghĩa từng loại subagent kèm `description`, `prompt`, `tools` được phép dùng, `model`) cùng với việc bật `"Agent"` trong `tools` / `allowedTools`.
   - Khi agent cha gọi tool này, SDK runtime tự động spawn một vòng lặp context riêng cho subagent và trả kết quả về `tool_result` của agent cha.

2. **Anthropic Messages API thuần (`@anthropic-ai/sdk`):**
   - Là stateless HTTP API (`POST /v1/messages`), không có lệnh subagent tích hợp sẵn.
   - Muốn có subagent, backend phải tự định nghĩa một custom tool (ví dụ `delegate_subagent`), bắt `tool_use`, khởi tạo một lượt gọi SDK/API mới với context + bộ tool giới hạn cho agent con, rồi trả kết quả về `tool_result` của agent cha.

3. **Hiện trạng trong Nodeforge (`backend/src/...`):**
   - **Chế độ Forge MCP (`tool_mode = "forge"` — mặc định cho AM, SL, Coder, Reviewer, SE):**
     - Tại `backend/src/tools/roles/claude-forge-options.js` (`createClaudeForgeOptions`), hệ thống truyền `tools: []` (tắt toàn bộ built-in tools của Claude SDK) và chỉ cho phép `mcp__forge__*` (cùng `"WebSearch"` khi được bật).
     - Vì vậy, ở chế độ `forge` hiện tại, agent chưa thể tự gọi subagent.
   - **Chế độ `builtin` của System Engineer (`backend/src/application/owner-builtin-tools.js`):**
     - Hàm `ownerBuiltinOptions` đã cấu hình `CLAUDE_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "WebSearch", "Agent"]` và đăng ký `agents: SYSTEM_ENGINEER_AGENTS` với subagent `explorer` chỉ đọc (`SUBAGENT_TOOLS = ["Read", "Glob", "Grep"]`).

---

## 2. Nguyên nhân chạy chế độ `builtin` nhưng không thấy Agent gọi Subagent

Qua khảo sát trực tiếp `owner-builtin-tools.js`, `owner-sdk-stream.js`, `claude-sdk-gateway.js` và `system-engineer-sdk-transcript.js`, có **4 nguyên nhân trực tiếp**:

1. **Nếu System Engineer chạy bằng provider `codex`:**
   - Trong `owner-builtin-tools.js` (dòng 54–58), nhánh `profile.provider === "codex"` chỉ cấu hình quyền `command_execution`, `file_change`, `web_search`. Định nghĩa `agents: SYSTEM_ENGINEER_AGENTS` và tool `"Agent"` chỉ tồn tại ở nhánh Claude SDK (dòng 76).
2. **Prompt hệ thống ở chế độ `builtin` không nhắc tới Subagent:**
   - Trong `owner-sdk-stream.js` (dòng 119, 129), prompt hướng dẫn System Engineer: *"Work directly with the supplied SDK built-in tools. Explore, edit, and verify the project autonomously."*
   - Khi đã có sẵn `Grep`, `Glob`, `Read` trực tiếp và prompt không nhắc tới `explorer`, model ưu tiên gọi thẳng `Grep`/`Read` thay vì spawn subagent.
3. **Hook `PreToolUse` chặn nghiêm ngặt tên tool và `subagent_type`:**
   - Trong `owner-builtin-tools.js` (dòng 63–68), hook `guard` chỉ cho phép đúng `tool_name === "Agent"` và `args.subagent_type === "explorer"`. Nếu SDK/model gọi bằng tên `Task` hoặc `subagent_type: "Explore"` / `"general-purpose"`, lệnh sẽ bị `deny`.
4. **UI Transcript đang lọc bỏ hiển thị của Subagent:**
   - Trong `backend/src/application/system-engineer-sdk-transcript.js`:
     - Dòng 33: `if (!event || event.parent_tool_use_id) return false;` — Mọi tool call bên trong subagent đều có `parent_tool_use_id` nên bị ẩn hoàn toàn khỏi khung chat transcript.
     - Dòng 113 (`formatForgeToolCommand`): Chỉ cho qua các tool có prefix `mcp__forge__*` hoặc nằm trong `FORGE_TOOLS` (`"Read"`). Lệnh gọi `"Agent"` trả về chuỗi rỗng `""` nên không hiển thị thành command block trên khung chat.

---

## 3. Quyết định Kiến trúc: Mở Subagent qua Forge Tool (`mcp__forge__delegate_subagent`)

Thay vì phụ thuộc vào built-in tool `Agent` của riêng Claude SDK, kiến trúc chọn hướng **xây dựng Forge MCP Tool riêng** (ví dụ `mcp__forge__delegate_subagent` / `mcp__forge__explore_subagent`) để hoạt động đồng nhất trên mọi provider (cả **Claude SDK** lẫn **Codex SDK**) và hiển thị tự nhiên trên UI Transcript.

### 3.1. Phân quyền Subagent: Read-Only Explorer (Chỉ đọc hiểu code, Agent cha giữ quyền sửa)
- **Quyết định:** Subagent **chỉ được phép đọc hiểu, khảo sát code (Read-Only Explorer)** với bộ công cụ:
  - `search_tree`, `list_files`, `search_text`, `read_file`, `Read` (và `read_file_binary` nếu role cho phép).
- **Không cấp cho Subagent:**
  - Các tool sửa/xóa file (`edit_diff`, `write_diff`, `delete_file`, `move_file`).
  - Các tool chạy kiểm thử và Git (`run_check`, `run_test`, `commit_changes`, `push_commit`).
  - Chính tool `delegate_subagent` (khóa độ sâu đệ quy ở **1 cấp**: Agent cha $\rightarrow$ Subagent; subagent không thể gọi tiếp subagent con).
- **Lý do cốt lõi:**
  1. **Nút thắt thực sự nằm ở bước đọc hiểu:** 80–90% thời gian và context window tốn ở bước tìm file, đọc `code_graph` và đọc `symbol`. Khi Subagent trả về đúng `file_path` + `sha256` + `symbol` + đoạn `anchor`, Agent cha chỉ mất 1 tool call `edit_diff` để sửa.
  2. **Bảo toàn Checkpoint Recovery (`owner-execution-checkpoint.js`):** Giữ Subagent 100% Read-Only giúp working tree không bao giờ bị sửa dở dang (partial mutation) khi 1 trong các subagent chạy song song gặp lỗi hoặc khi người dùng bấm Pause/Stop.
  3. **Tránh xung đột `before_checksum` (`sha256`) và lệch ngữ cảnh:** Chỉ có một mình Agent cha cầm quyền sửa file và kết nối logic giữa các file.
  4. **Dùng chung an toàn cho mọi Role:** Vì Read-Only nên có thể mở cho cả **System Engineer, Architecture Manager, Sprint Leader, Coder, Reviewer** mà không phá vỡ ranh giới quyền hạn của từng role.

### 3.2. Đồng bộ `codeCache` và `active_file_checksums` về Agent cha
- Khi Subagent gọi `read_file` và `Read`, dữ liệu file và symbol đi qua cùng `codeCache` của project.
- Khi Subagent kết thúc, handler của `delegate_subagent` tự động đồng bộ các `sha256` (`active_file_checksums`) mà Subagent đã đọc về state/checkpoint của Agent cha.
- Nhờ đó, **Agent cha có thể gọi `edit_diff` ngay lập tức** dựa trên kết quả khảo sát của Subagent mà không cần đọc lại file đó.

### 3.3. Quản lý định danh `agentId` và cô lập Runtime trong `claude-sdk-gateway.js`
- Trong `backend/src/modules/agent/claude-sdk-gateway.js` hiện tại:
  - `getEnabledConfig(agentId)` dùng `agentId` để lấy profile, model, `credential_ref`, `gateway_url`.
  - Nhưng `active.add(agentId)` / `active.delete(agentId)` và `claudeHome` (`.forge/runtime/nf/claude-homes/<agentId>`) cũng đang gắn trực tiếp vào `agentId`.
- **Thiết kế khi gọi Subagent từ `sdk.execute(...)`:**
  1. **Config & Credential:** Vẫn truyền `agentId` của Agent cha để dùng chung cấu hình, provider, model và API key (`credential_ref`, `gateway_url`) mà không cần tạo thêm Agent mới trong DB.
  2. **Runtime Instance ID (`subagentId`):** Bổ sung định danh phiên con (ví dụ `${agentId}:sub:${subagentId}`) cho tập `active` và thư mục `claudeHome` riêng biệt (`.forge/runtime/nf/claude-homes/${agentId}/subagents/${subagentId}`).
  3. Nhờ vậy, khi Subagent kết thúc và vào khối `finally`, nó chỉ xóa `active` của chính nó, **không xóa nhầm trạng thái `active` của Agent cha**, đồng thời nhiều Subagent chạy song song không tranh chấp lock file trong `CLAUDE_CONFIG_DIR`.
  4. Không truyền `resumeSessionId` / `resumeThreadId` của Agent cha vào Subagent để Subagent luôn chạy trên một context mới, gọn nhẹ.

### 3.4. Chính sách `discovery_budget` và Hạn mức tiến trình (Process Guardrails)
- **Không áp `discovery_budget` (No Exploration Quota):**
  - Theo định hướng của Owner đã bỏ các giới hạn `discovery_budget` (tương tự `exploration_enabled: false` của Coder trong `runtime-tool-governance.js`), Subagent **không bị chặn bởi `discovery_budget`** (không giới hạn cứng số lượt `search_text`, `read_file`, `Read`).
  - Lưu ý dọn dẹp kỹ thuật: Hiện tại trong `exploration-state.js` (`discoveryNotice`) và `ticket-complexity.js` vẫn còn sót thông báo tĩnh `discovery_budget: { used: 0, limit: 8, remaining: 8 }` khi `context.exploration_state` không được khởi tạo — có thể dọn sạch để tránh gây hiểu nhầm.
- **Guardrails cấp độ tiến trình cho Subagent:**
  - **Số lượng Subagent chạy song song tối đa:** `3` subagents / lần gọi (và tối đa `3–4` subagents trong 1 turn của Agent cha) để tránh nghẽn rate limit API.
  - **Độ sâu lồng nhau (Nesting depth):** Tối đa `1` cấp (Subagent không được gọi tiếp Subagent).
  - **Lifecycle & Abort:** Gắn trực tiếp `abortSignal` của Agent cha vào mọi Subagent đang chạy để khi Owner bấm Stop/Pause, toàn bộ Subagent dừng ngay lập tức.
