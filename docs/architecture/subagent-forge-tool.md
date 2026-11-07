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

---

## 4. Các Kiến nghị Kỹ thuật Hoàn thiện (Production-Grade Refinements)

Để `mcp__forge__delegate_subagent` vận hành nhanh, tiết kiệm token và khớp nối trơn tru với toàn bộ cơ chế bảo mật/cache sẵn có của Nodeforge, bổ sung **9 đặc tả kỹ thuật** sau:

1. **Hỗ trợ Batch Parallel ngay trong 1 lần gọi Tool (`tasks: [...]`):**
   - Cho phép truyền mảng `tasks` (tối đa 3 phần tử/lần gọi, mỗi phần tử gồm `{ id, objective, paths }`).
   - Backend chạy song song tất cả các task ngay trong 1 tool call, không phụ thuộc vào việc model/provider có tự phát nhiều `tool_use` song song hay không.

2. **Chế độ Partial Success (`Promise.allSettled`):**
   - Khi chạy song song nhiều subagents trong một batch, dùng `Promise.allSettled` thay vì `Promise.all`.
   - Nếu 1 subagent gặp lỗi/timeout, kết quả và `sha256` thu thập được từ các subagent thành công còn lại vẫn được giữ nguyên và trả về cho Agent cha (tránh mất trắng toàn bộ batch).

3. **Cấu trúc kết quả trả về (Structured Return Envelope) kèm `observed_files`:**
   - Handler của `delegate_subagent` tự động gom danh sách `{ path, sha256, symbols_read }` từ mọi lệnh `read_file`/`Read` mà Subagent đã thực thi để trả về trong `observed_files`, không phụ thuộc vào việc Subagent có nhớ chép `sha256` vào văn bản tóm tắt hay không.

4. **Chuyển giao biên lai `source-metadata-receipts.js` (`recordSourceMetadata`):**
   - Trong `backend/src/tools/discovery/source-metadata-receipts.js`, quyền gọi `Read({ file_path, symbol })` được kiểm tra qua `WeakMap` theo reference `context.agent_identity` và key `${execution_id}:${path}`.
   - Khi Subagent kết thúc, handler phải gọi `recordSourceMetadata(parentContext, metadata)` cho mọi file Subagent đã đọc để Agent cha có thể gọi tiếp `Read({ file_path, symbol })` hoặc `edit_diff` ngay lập tức mà không bị lỗi `READ_INPUT_INVALID`.

5. **Kế thừa nguyên vẹn `scopedFiles` và File Access Policy của Role cha (Zero Privilege Escalation):**
   - Subagent sử dụng chính instance `scopedFiles` (`createRoleFileService({ fileService, role, projectRoot })`) và `allowed_file_paths` / `allowed_prefixes` của Agent cha.
   - Đảm bảo Subagent của AM/SL/Coder/Reviewer không thể vượt rào đọc `.forge/` hoặc các đường dẫn ngoài phạm vi cho phép, trong khi Subagent của System Engineer vẫn đọc được `.forge/` và `node_modules/`.

6. **Tiered Model & Low Reasoning Effort cho Subagent:**
   - Mặc định đặt `effort: "low"` (hoặc `"medium"`) cho Subagent để giảm độ trễ và chi phí token.
   - Cho phép cấu hình tùy chọn `subagent_model` nhẹ hơn (ví dụ Sonnet/Haiku khi Agent cha chạy Opus) trên cùng credential/gateway, mặc định fallback về model của Agent cha.

7. **Giới hạn kích thước tóm tắt trả về (`max_summary_chars`):**
   - Giới hạn văn bản trả về của mỗi Subagent (ví dụ tối đa `4.000–6.000` ký tự) để buộc Subagent trả về báo cáo cô đọng (file, symbol, dòng/anchor, phân tích chính), ngăn việc dump nguyên file code dài làm phình context của Agent cha.

8. **Hiển thị gọn trên UI Transcript & Activity Stream:**
   - Không stream text thô của các Subagent chồng chéo lên khung chat chính của Agent cha.
   - Chỉ hiển thị command block `delegate_subagent` của Agent cha và phát sự kiện tiến độ gọn qua `agent.activity`.

9. **Tách bạch Token Usage và Dọn dẹp thư mục tạm `claudeHome`:**
   - Cộng token của Subagent vào thống kê chi phí (`subagent_usage`), nhưng **không cộng** `input_tokens` của Subagent vào `last_turn_input_tokens` dùng để tính ngưỡng Context Rollover/Compaction của Agent cha (vì context của Subagent đã được giải phóng ngay khi kết thúc).
   - Xóa sạch thư mục tạm `.forge/runtime/nf/claude-homes/${agentId}/subagents/${subagentId}` trong khối `finally` ngay sau khi Subagent đóng phiên.

---

## 5. Tổng hợp quyết định về luồng AM–SE–RV, Owner approval và Run

### 5.1. Luồng sản phẩm bắt buộc

Luồng hoàn chỉnh phải là:

```text
AM tạo plan
  → Node lưu canonical plan ở trạng thái pending_owner_approval
  → Architecture Workspace hiển thị Pending plans
  → Owner mở Plan Review
  → Owner kiểm tra plan và bấm Approve
  → Node kiểm tra plan_id + revision + SHA hiện hành
  → Node ghi approval bất biến
  → UI hiện Create handoff
  → Node tự sinh handoff_id và checkpoint ban đầu
  → Handoff Panel hiển thị projection + capabilities
  → Owner bấm Run/Resume
  → AM điều phối adapter SE
  → SE dùng Forge để khảo sát/sửa code
  → checkpoint
  → RV review read-only
  → AM xử lý PASS hoặc REVISE
```

**Approve plan không đồng nghĩa với Run handoff.** Owner không phải tự nhập hoặc đoán `plan_id`/`handoff_id`; các định danh phải được Node tạo và hiển thị.

### 5.2. Owner approval flow

Plan Review phải hiển thị tối thiểu:

- plan ID, revision, SHA-256 và trạng thái;
- objective/background, scope in/out;
- outcomes, acceptance criteria và guardrails;
- assumptions, risks, evidence/provenance;
- approval status và lỗi stale plan nếu có.

Nút Approve phải gọi server, không chỉ cập nhật state ở client. Server phải load canonical plan, so khớp plan ID/revision/SHA, xác thực Owner, ghi approval atomically và trả approval identity. Approval của một plan không được dùng cho plan khác hoặc SHA khác.

### 5.3. Handoff và checkpoint

Handoff được tạo chỉ từ plan đã approved đúng identity và phải lưu:

- plan ID, revision, SHA và project identity;
- approval identity;
- delivery target SE;
- checkpoint ban đầu trước khi gọi agent.

Mỗi Run/Resume chỉ thực hiện **một guarded role step**. Không dùng `drain: true` để chạy xuyên SE → RV → AM. Trước invocation phải ghi intent; sau invocation chỉ ghi receipt/result khi handoff, execution, plan identity, generation, role và terminal status khớp.

Resolver phải xét execution boundary mới nhất trước khi fallback. Receipt terminal hợp lệ có thể được recover mà không replay; execution unknown, pending tool call hoặc workspace mutation chưa rõ phải bị chặn và đưa vào reconciliation. Không replay predecessor đã completed, không rollback workspace tự động và không retry mù.

### 5.4. Runtime và API guardrails

- Compose một `amSeHandoffService` dùng chung ở application boundary cho chat, HTTP, recovery và panel.
- Adapter AM/SE/RV phải tái tạo được sau restart, không giữ request closure hoặc owner identity từ request trước.
- Thiếu adapter phải fail-fast; GET/list không được tạo service lazy thiếu dependency.
- Route canonical là `/forge/v1/handoffs/:handoffId/...`; project isolation và actor authorization do server kiểm tra.
- Projection phải trả capability server-side:

```js
capabilities: {
  run: true,
  resume: false,
  stop: false,
  reconcile: false
}
```

UI chỉ render theo capabilities, không suy luận từ `status`, `approval_required` hoặc `next_step`. SE là role duy nhất được mutation qua Forge; RV phải có bằng chứng `read_only_enforced`.

### 5.5. Các blocker đã nhận diện ở luồng Run

Các vấn đề không được xem là đã hoàn tất nếu chưa có evidence thực thi:

1. UI có thể disable Run dựa trên `approval_required` dù handoff chưa chạy.
2. Client/runtime còn có thể đi qua route cũ thay vì route canonical.
3. HTTP/recovery có thể lazy-create service thiếu adapter SE/RV/AM.
4. `drain: true` có thể chạy nhiều role step trong một lần Run.
5. Chưa có bằng chứng end-to-end từ UI GET → Run → adapter SE → checkpoint → projection mới, đặc biệt sau restart.

Verification tối thiểu phải đi qua runtime composition thật, durable store, HTTP route và UI projection; bao gồm stale SHA, approval sai revision, GET trước Run, restart, concurrent Run, crash sau intent, receipt recovery, unknown mutation, RV REVISE và RV PASS.

### 5.6. Quy tắc kế hoạch — quyết định mới nhất

Không tạo `r2`, `r3` cho việc phản biện hoặc cập nhật kế hoạch. Mỗi kế hoạch mới luôn có **plan ID mới và revision r1**; kế hoạch cũ giữ nguyên.

```text
Plan A / r1
  → SE phản biện hoặc Owner bổ sung yêu cầu
  → tạo Plan B / r1 tích hợp thay đổi
  → review/approve Plan B độc lập
```

Nếu tiếp tục thay đổi thì tạo Plan C / r1. Mỗi plan có canonical SHA và approval riêng; không ghi đè plan cũ, không dùng approval của plan cũ cho plan mới. Việc thống nhất nội dung trong một kế hoạch mới là một quá trình nội bộ của plan đó, không tạo r2.

### 5.7. Ranh giới trách nhiệm

- **AM:** orchestration, architecture decision và plan; không trực tiếp sửa code.
- **SE:** khảo sát và implementation trong boundary được giao, qua Forge tools.
- **RV:** review độc lập, read-only.
- **SL:** phân rã delivery, ticket, dependency và verification trong boundary đã duyệt.
- **Owner:** quyết định/approve mục tiêu, scope, contract, guardrails và plan identity.

Chỉ tuyên bố luồng crash-safe hoặc Run hoạt động khi có evidence end-to-end tương ứng; kế hoạch, fixture hoặc lời hướng dẫn không thay thế bằng chứng runtime.

## 6. Phản biện và góp ý triển khai (SE review — 2026-11-07)

Phần trên là thiết kế mục tiêu tốt, nhưng cần tách dứt khoát giữa **đặc tả phải đạt** và **invariant đã được runtime bảo đảm**. Qua đối chiếu với implementation hiện có, các điểm sau chưa nên được coi là đã hoàn tất:

1. **`tools: READ_ONLY_EXPLORER_TOOLS` chưa phải enforcement.**
   `delegate-subagent-tool.js` chỉ truyền danh sách `search_tree`, `list_files`, `search_text`, `read_file`, `Read` vào `executeTask`. Một child executor có thể bỏ qua danh sách này nếu không tự dựng registry/allow-list từ nó. Contract phải yêu cầu server tạo child execution context và registry mới, trong đó mọi tool không thuộc allow-list bị từ chối ở boundary; không được dựa vào prompt, tên tool hoặc lời hứa của provider. Cần test gọi trực tiếp executor với ý định `edit_diff`, `run_check`, `commit_changes`, `delegate_subagent` và chứng minh bị deny.

2. **Scoped access chưa được truyền một cách đầy đủ trong tool handler.**
   Handler hiện chuyển `parentContext`, `abortSignal` và `subagentId`, nhưng không tự tạo `scopedFiles`, `codeCache`, `codeSearch` hay child `agent_identity`. Vì vậy câu “kế thừa nguyên vẹn `scopedFiles`/File Access Policy” mới là yêu cầu cho executor phía dưới, chưa phải guarantee của `delegate_subagent`. Child phải có identity/execution ID riêng, kế thừa đúng `allowed_file_paths`/`allowed_prefixes` đã được normalize, và bị chặn khi thiếu bất kỳ dependency bắt buộc nào; tuyệt đối không fallback sang project-root file service.

3. **Provenance của `observed_files` đang có nguy cơ bị tin từ prose/return value.**
   Handler nhận `result.value.observed_files`, normalize rồi gọi `recordSourceMetadata` trên context cha. Receipt này chỉ có giá trị nếu metadata được tạo bởi các tool đọc thật sự trong child, không phải do child tự khai báo. Cần gắn observation với child `execution_id`, lấy từ một collector nội bộ của `read_file`/`Read`, kiểm tra path thuộc scope và checksum có định dạng hợp lệ, sau đó chuyển giao một envelope có nguồn gốc (child ID, execution ID, path, SHA, symbol metadata). Không nên cho phép child executor tùy ý “phát hành” `observed_files`.

4. **`active_file_checksums` và source receipt là hai cơ chế khác nhau.**
   Việc owner conversation cập nhật `active_file_checksums` từ `result.observed_files` không đồng nghĩa `sourceMetadataSymbol` đã được ủy quyền đúng cho `Read` trên context cha, và cũng không chứng minh checksum còn đúng sau mutation/concurrent write. Tài liệu nên chỉ rõ: receipt dùng để authorize symbol selection; checksum dùng để guard mutation; cả hai phải được kiểm tra lại tại thời điểm sử dụng. Test cần bao gồm child đọc file, parent `Read` theo symbol, file bị đổi, rồi parent `edit_diff` bị từ chối với stale SHA.

5. **“Không có discovery quota” cần đổi tên thành “không có quota khám phá theo số lượt”, nhưng vẫn có process quota.**
   Implementation hiện có batch tối đa 3 và reservation theo turn; tài liệu cũng nêu tối đa 3 child song song. Đây là quota có chủ đích và nên được ghi trong contract cùng với timeout, tổng thời gian, tổng bytes/context, abort và rate-limit. Nếu không giới hạn bytes hoặc thời lượng, `max_summary_chars` chỉ giới hạn đầu ra, không ngăn child tiêu thụ tài nguyên vô hạn.

6. **Phạm vi provider/đường chạy chưa khớp với tuyên bố “đồng nhất mọi provider”.**
   Forge owner conversation có thể đăng ký `delegate_subagent` cho nhiều role khi có executor, nhưng supervisor ticket runtime hiện chỉ bind tool này cho Coder. Cần lập ma trận rõ ràng: role × provider × entry point (owner chat, HTTP/recovery, ticket runtime), tool có mặt hay không, và executor nào chịu trách nhiệm. Nếu một ô chưa hỗ trợ, phải fail-fast hoặc ghi rõ “unsupported”, không mô tả là provider-neutral đã hoàn chỉnh.

7. **Usage và cleanup mới là yêu cầu, chưa phải evidence.**
   `subagent_usage` được gom từ kết quả child, nhưng cần định nghĩa nguồn token/chi phí và chống double-count khi retry/recovery. Tương tự, yêu cầu xóa `claudeHome` trong `finally` cần test cả success, rejection, abort và process crash/restart; nếu runtime cần giữ artifact để forensic thì phải dùng retention policy thay vì xóa vô điều kiện.

8. **Batch semantics cần thêm idempotency và retry policy.**
   `Promise.allSettled` bảo toàn partial success nhưng không trả lời việc gọi lại cùng `task.id` sau timeout hoặc crash. Mỗi task nên có execution/attempt ID, trạng thái durable (`started`, `completed`, `failed`, `aborted`), và quy tắc retry rõ ràng. Không retry mù một child có thể đã đọc/ghi ngoài hệ thống; read-only không loại bỏ nguy cơ chi phí, rate-limit hoặc kết quả không nhất quán.

9. **Transcript không được là nguồn sự thật.**
   Activity summary chỉ là projection để UI; audit phải lưu structured envelope tối thiểu gồm parent execution, child execution, role, scope fingerprint, start/end, terminal status, observed file metadata và usage. Không stream source text vào activity, nhưng cũng không được làm mất correlation ID cần cho recovery và điều tra.

### Điều kiện chấp nhận đề xuất

Trước khi gọi tính năng production-ready, nên có integration test chạy composition thật chứng minh: (a) parent tạo batch 1–3 task; (b) child chỉ thấy đúng read-only registry và đúng file scope; (c) abort dừng toàn bộ child; (d) một child fail vẫn giữ partial success; (e) parent dùng receipt hợp lệ cho `Read` nhưng stale SHA bị chặn khi mutation; (f) concurrent/repeated invocation không vượt quota; (g) restart không làm mất trạng thái hoặc replay child đã completed; và (h) mọi entry point/provider được nêu trong ma trận đều either pass hoặc fail-fast có mã lỗi rõ ràng.

Cho tới khi có các bằng chứng này, nên dùng ngôn ngữ “proposed”, “implemented skeleton” hoặc “verified for [entry point]”, thay vì “đồng nhất mọi provider”, “100% read-only”, “crash-safe” hoặc “production-grade”.

---

## 7. Góp ý bổ sung và điều chỉnh bắt buộc sau rà soát

Phần này chuẩn hóa các điểm cần phân biệt giữa thiết kế mục tiêu, implementation skeleton và invariant đã được runtime chứng minh. Các nội dung dưới đây **không được hiểu là bằng chứng tính năng đã hoàn tất**.

### 7.1. Read-only phải được enforce ở tool boundary

Việc truyền `READ_ONLY_EXPLORER_TOOLS` hoặc hướng dẫn trong prompt chưa đủ để bảo đảm child chỉ đọc. Server phải tạo child execution context riêng, gồm `child_agent_identity`, `child_execution_id`, tool registry riêng và allow-list được dựng ở server. Mọi tool ngoài allow-list phải bị deny mặc định; không fallback sang registry hoặc file service của parent.

Tối thiểu phải từ chối trực tiếp các ý định gọi:

```text
edit_diff, write_diff, delete_file,
run_check, run_test, commit_changes, push_commit,
delegate_subagent
```

và phải có test chứng minh các lệnh trên bị deny, trong khi `read_file`/`Read` chỉ được phép trong file scope hợp lệ.

### 7.2. Child scope, identity và provenance của observed files

Handler `delegate_subagent` không được coi `result.value.observed_files` do child tự khai báo là authority. Observation phải được collector nội bộ ghi nhận từ các lần `read_file`/`Read` thực sự thành công, sau đó kiểm tra scope và checksum trước khi chuyển giao cho parent.

Envelope provenance tối thiểu gồm:

```text
parent_execution_id
child_execution_id
child_agent_id
path
sha256
symbols_read
observed_at
scope_fingerprint
source_tool
```

Nếu thiếu scoped file service, code cache, code search, child identity hoặc execution identity bắt buộc, child phải fail-fast; tuyệt đối không fallback về project-root service.

### 7.3. Source receipt không thay thế checksum

Hai cơ chế có mục đích khác nhau:

- **Source receipt:** cấp quyền cho parent dùng `Read` với symbol đã được child quan sát.
- **Checksum:** bảo vệ mutation và phải được kiểm tra lại tại thời điểm `edit_diff`/ghi file.

Luồng bắt buộc là child đọc → tạo receipt → parent đọc symbol → Node kiểm tra checksum hiện tại → mutation hoặc từ chối stale SHA. Receipt không khóa file và `active_file_checksums` không chứng minh nội dung vẫn chưa đổi. Phải có test file đổi sau khi child đọc, khiến parent mutation với SHA cũ bị từ chối.

### 7.4. Resource guardrails và batch retry

Cụm “không có discovery quota” chỉ có nghĩa là không áp quota theo số lượt gọi khám phá. Vẫn phải có process/resource guardrails: tối đa 3 child/batch, độ sâu tối đa 1, timeout child, timeout batch, abort propagation, giới hạn output và tổng bytes/context, concurrency/rate limit và retry limit.

`Promise.allSettled` chỉ bảo toàn partial success; mỗi task vẫn cần `batch_id`, `task_id`, `child_execution_id`, `attempt`, trạng thái durable, thời gian bắt đầu/kết thúc và terminal status. Task `completed` không được chạy lại khi resume; task `unknown` không được retry mù và phải chuyển reconciliation nếu không chứng minh được child chưa bắt đầu.

### 7.5. Ma trận provider, role và entry point

Không tuyên bố provider-neutral khi chưa có evidence. Cần duy trì ma trận tối thiểu:

| Role | Provider | Entry point | Tool/Executor | Trạng thái |
|---|---|---|---|---|
| AM/SE/RV/SL/Coder | Claude/Codex | owner chat | đã đăng ký? | verified/proposed/unsupported |
| AM/SE/RV | Claude/Codex | HTTP/recovery | đã đăng ký? | verified/proposed/unsupported |
| Coder | Claude/Codex | ticket runtime | đã đăng ký? | verified/proposed/unsupported |

Ô chưa hỗ trợ phải fail-fast với mã lỗi rõ ràng hoặc ghi `unsupported`; không fallback âm thầm.

### 7.6. Usage, cleanup và retention

Usage phải gắn với child execution/task/attempt, nêu rõ nguồn token/chi phí và chống double-count khi retry hoặc recovery. Usage của child có thể được cộng vào thống kê tổng, nhưng không tự động cộng vào bộ đếm context rollover của parent nếu policy không yêu cầu.

Cleanup `claudeHome` trong `finally` chưa đủ cho process crash. Cần policy phân biệt success, failure, abort và unknown/crash; artifact unknown có thể cần retention TTL phục vụ forensic, kèm startup sweep orphan. Không tuyên bố cleanup hoàn tất chỉ vì có nhánh `finally`.

### 7.7. Audit envelope và quan hệ với handoff

Transcript/activity chỉ là projection, không phải nguồn sự thật và không được dùng để resume. Durable audit envelope phải giữ correlation ID, role, provider, scope fingerprint, thời gian, terminal status, observed files, usage, abort reason và error code; không đưa prompt, credential hoặc source riêng tư vào UI.

`delegate_subagent` chỉ là công cụ discovery/read-only hỗ trợ execution hiện tại. Nó không tạo approval, không tự chuyển checkpoint, không bypass plan identity, ticket, mutable-file budget hoặc Reviewer gate. Kết quả child là evidence đầu vào; completion vẫn do role và workflow authority quyết định.

### 7.8. Trạng thái tuyên bố

Cho tới khi có integration test qua composition thật chứng minh các invariant trên, chỉ dùng các nhãn:

- `proposed`;
- `implemented skeleton`;
- `verified for <entry point>`;
- `read-only intended by policy`.

Không dùng các khẳng định tuyệt đối như `100% read-only`, `provider-neutral`, `crash-safe` hoặc `production-grade` nếu chưa có evidence tương ứng.

### 7.9. Bộ điều kiện nghiệm thu tối thiểu

Trước khi gọi tính năng production-ready, cần integration test chứng minh: batch 1–3 task; child chỉ thấy registry read-only và file scope đúng; abort dừng toàn bộ child; partial success được giữ; receipt hợp lệ cho phép parent `Read`; stale SHA chặn mutation; repeated invocation không vượt quota; restart không replay child đã completed; và từng ô trong ma trận provider/role/entry point либо pass, либо fail-fast với mã lỗi rõ ràng.
