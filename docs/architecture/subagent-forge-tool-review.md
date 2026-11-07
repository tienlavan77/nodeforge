# AM Review: Báo cáo triển khai `delegate_subagent` (2026-11-07)

Tài liệu này ghi nhận kết quả kiểm tra độc lập của Architecture Manager (AM) đối với báo cáo triển khai `delegate_subagent` của System Engineer (SE), đối chiếu trực tiếp với mã nguồn thực tế trong repository.

---

## 1. Đối chiếu bằng chứng (Evidence Verification)

| Hạng mục trong báo cáo của SE | Kết quả kiểm tra thực tế |
|---|---|
| `backend/src/tools/discovery/delegate-subagent-tool.js` (`sha256:9b224718bf2e94fba38559022405581360f357d629ae1b6b49b1eac155cd1842`) | **Khớp chính xác** |
| `backend/tests/unit/delegate-subagent-tool.test.js` (`sha256:d51551416e17b08222e3eb7270c01befc58c989f4009455144fc89b51da1e16a`) | **Khớp chính xác** |
| Tạo `childExecutionId = ${parentExecutionId}:sub:${task.id}` và `child_agent_id` riêng | **Đã có trong `executeOne` (dòng 65–73)** |
| Kế thừa bản sao `allowed_file_paths`, `allowed_prefixes`, `capabilities = READ_ONLY_EXPLORER_TOOLS`, `read_only_enforced = true`, `subagent_depth = 1` | **Đã có trong `executeOne` (dòng 74–80)** |
| Validate `task.paths` (safe relative path, không chứa `..`) và `observed_files` (`path`, `sha256`, scope) | **Đã có trong `validateTasks` & `normalizeObserved` (dòng 104–135)** |
| Working tree có 13 path thay đổi (12 modified + 1 untracked), không tự ý commit/push và không đụng vào thay đổi handoff | **Khớp chính xác** |

---

## 2. Phát hiện kỹ thuật: 4 lỗ hổng cần sửa tiếp trước khi nghiệm thu

Qua đọc trực tiếp `backend/src/tools/discovery/delegate-subagent-tool.js` (dòng 37–135), `backend/src/application/owner-sdk-stream.js` (dòng 107–114), `backend/src/tools/roles/owner-conversation-tools.js` (dòng 21–94) và `backend/src/tools/governance/tool-authorization.js` (dòng 7–21), phát hiện **4 điểm chưa kín**:

### 2.1. Rơi `parent_execution_id` và `observed_at` ở `executeBatch` (`delegate-subagent-tool.js` dòng 50 vs dòng 91–98)

- Trong `executeOne` (dòng 91–98), `normalizeObserved(..., childContext)` đã kiểm tra scope và gắn đầy đủ:
  - `parent_execution_id`
  - `child_execution_id`
  - `child_agent_id`
  - `observed_at`
  - `source_tool`
- Nhưng khi lên `executeBatch` (dòng 50):
  ```js
  observed_files: normalizeObserved(result.value?.observed_files)
  ```
  Hàm `normalizeObserved` bị gọi lại **mà không truyền `context`**, đồng thời trong thân `normalizeObserved` (dòng 126–134) **không giữ lại `parent_execution_id` và `observed_at`**.
- **Hệ quả:** `parent_execution_id` và `observed_at` bị cắt mất khỏi kết quả trả về cuối cùng của `executeBatch`.
- **Cách sửa:** Trong `normalizeObserved` (dòng 126–134), giữ lại `parent_execution_id` và `observed_at` nếu hợp lệ, đồng thời truyền `context` nhất quán ở dòng 50.

### 2.2. `owner-sdk-stream.js` đang ghi đè mất `childContext` do `delegate-subagent-tool.js` chuẩn bị (`owner-sdk-stream.js` dòng 107–110)

- Trong `delegate-subagent-tool.js` (dòng 67–90), `executeOne` tạo `childContext` hoàn chỉnh rồi gọi `executeTask(task, childContext)`.
- Nhưng trong `backend/src/application/owner-sdk-stream.js` (dòng 107–110):
  ```js
  const childExecutor = delegateSubagentExecutor ?? (async (task, child) => {
    const childContext = {
      ...context,
      execution_id: `${correlationId}:sub:${task.id}`,
      correlation_id: `${correlationId}:sub:${task.id}`,
      capabilities: child.tools,
      exploration_enabled: false,
      subagent_depth: 1
    };
  ```
  Việc spread từ `...context` của parent thay vì kế thừa từ `child` làm cho:
  - `childContext.agent_identity` quay về identity của **parent** (mất `child_agent_id` và `parent_agent_id`).
  - Mất `read_only_enforced: true`, `assertToolAllowed`, `forbidden_tools`, `allowed_file_paths`, `allowed_prefixes` mà `delegate-subagent-tool.js` đã thiết lập.
- **Cách sửa:** Trong `owner-sdk-stream.js`, khởi tạo `childContext` dựa trên `...child` (hoặc `...context, ...child`) để giữ nguyên toàn bộ thuộc tính cô lập và bảo mật của child.

### 2.3. `assertToolAllowed()` chưa được gọi ở bất kỳ runtime enforcement gate nào (`tool-authorization.js` dòng 7–21)

- Tìm kiếm trên toàn bộ `backend/src` cho thấy `assertToolAllowed` hiện chỉ tồn tại tại nơi định nghĩa trong `delegate-subagent-tool.js` (dòng 84).
- Hàm `authorizeTool(toolName, context)` trong `backend/src/tools/governance/tool-authorization.js` (dòng 7–21) mới chỉ kiểm tra `context.capabilities`, chưa gọi `context.assertToolAllowed?.(toolName)` và chưa kiểm tra `context.read_only_enforced` / `context.forbidden_tools` / `context.subagent_depth`.
- **Hệ quả:** `assertToolAllowed()` hiện mới được kiểm tra bởi unit test gọi trực tiếp hàm đó, chưa trở thành cổng chặn runtime thực tế khi tool được invoke.
- **Cách sửa:** Bổ sung kiểm tra `if (typeof context.assertToolAllowed === "function") context.assertToolAllowed(toolName);` (hoặc kiểm tra `read_only_enforced` & `forbidden_tools`) ngay trong `authorizeTool()`.

### 2.4. Provenance của `observed_files` vẫn cần gắn với collector thực tế của `read_file` / `Read`

- Ở `delegate-subagent-tool.js` (dòng 91):
  ```js
  const observed = normalizeObserved(result?.observed_files ?? childContext.observed_files, childContext)
  ```
- Trong `owner-conversation-tools.js` (dòng 67–87), khi child chạy với `readOnlyExplorer: true` (`conversationStateStore: undefined`), kết quả của `read_file` và `Read` chưa tự động push vào `toolContext.observed_files`.
- **Hệ quả:** Khi chạy qua `owner-sdk-stream.js` (dòng 113 trả về `observed_files: childContext.observed_files ?? []`), mảng `childContext.observed_files` sẽ luôn rỗng nếu `owner-conversation-tools.js` không ghi nhận file đã đọc vào `toolContext.observed_files`.
- **Cách sửa:**
  1. Trong `owner-conversation-tools.js`, sau khi `read_file` hoặc `Read` chạy thành công, tự động ghi nhận `{ path, sha256, symbols_read, symbol_map, source_tool: definition.name }` vào `toolContext.observed_files`.
  2. Trong `delegate-subagent-tool.js`, ưu tiên lấy từ collector `childContext.observed_files` (chỉ fallback sang `result?.observed_files` khi `childContext.observed_files` chưa có trong môi trường unit test mock).

---

## 3. Kết luận Review của AM

- **Quyết định vòng 1:** `REVISE` (Cần sửa 4 điểm ở Mục 2).

---

## 4. AM Review Vòng 2 — Đối chiếu báo cáo bổ sung `docs/architecture/subagent-forge-tool-se-report.md` (2026-11-07)

Đã đọc `docs/architecture/subagent-forge-tool-se-report.md` (`sha256:e5521c1488161727b713d6eb2f7f77367e23757e64f6f1003887009c29fe4b3d`) và kiểm tra trực tiếp 5 file mã nguồn SE đã cập nhật:

### 4.1. Kết quả kiểm tra từng điểm trong 4 yêu cầu của Vòng 1

| # | Yêu cầu từ Vòng 1 | Bằng chứng trong code hiện tại | Kết quả |
|---|---|---|---|
| 1 | Giữ nguyên `parent_execution_id` và `observed_at` qua `executeBatch` (`delegate-subagent-tool.js` `sha256:5638ea79d2ba5a89b4e7d6379fafd254070b1240c5d5c30a4c61dbc333b86ace`) | Dòng 50 truyền `normalizeObserved(result.value?.observed_files, context)`; dòng 131–135 giữ đủ `source_tool`, `parent_execution_id`, `child_execution_id`, `child_agent_id`, `observed_at`. *(Nit nhỏ: dòng 134 và 136 lặp lại key `child_agent_id` — không ảnh hưởng runtime nhưng có thể dọn khi tiện).* | **ĐẠT (PASS)** |
| 2 | `owner-sdk-stream.js` (`sha256:93bae6507db17838a9f14864a4a12b8eb14dda8e79ca996df88274554de66315`) không ghi đè mất `childContext` | Dòng 108 đã đổi thành `{ ...context, ...child, execution_id: child.execution_id ?? ..., correlation_id: child.correlation_id ?? ..., capabilities: child.capabilities ?? child.tools, exploration_enabled: false, subagent_depth: child.subagent_depth ?? 1 }`, bảo toàn `agent_identity` của child, `read_only_enforced: true`, `assertToolAllowed`, `allowed_file_paths`, `allowed_prefixes`. | **ĐẠT (PASS)** |
| 3 | `authorizeTool()` (`tool-authorization.js` `sha256:80a64988a8a0af080020c6a014122602b274145a7803115bf3fba5c7b337dcc7`) gọi `assertToolAllowed` ở runtime gate | Dòng 8 đã thêm `if (typeof context.assertToolAllowed === "function") context.assertToolAllowed(toolName);` ngay đầu `authorizeTool()`. | **ĐẠT (PASS)** |
| 4 | Collector thực tế của `read_file` và `Read` ghi nhận `observed_files` kèm `source_tool` (`agent-lifecycle-tools.js` `sha256:5b2f71d4f35e79189dc088fc8b1cddac4a220db5c567562d81909ce3659bc5e0` & `source-read.js` `sha256:f4e17a1354d009a465405114492f94c06632584fd2bbcb5e8a9442db98186a34`) | `agent-lifecycle-tools.js` (dòng 20–30, 82, 88) đã ghi `recordObservedFile(..., { ..., source_tool: "read_file" })` cho cả Markdown và code; `source-read.js` (dòng 49–53) đã ghi `source_tool: "Read"` và gộp `symbols_read`. | **ĐẠT (PASS)** |

### 4.2. Ghi chú nhỏ không chặn nghiệm thu (Minor / Non-blocking)

1. Trong `delegate-subagent-tool.js`:
   - Dòng 91 hiện viết `result?.observed_files ?? childContext.observed_files`. Trong runtime thật (`owner-sdk-stream.js` dòng 113), `result.observed_files` chính là `childContext.observed_files ?? []` nên provenance đã đi từ collector thật. Tuy nhiên nếu sau này muốn khóa chặt hơn đối với custom executor bên ngoài, có thể đổi thứ tự thành `childContext.observed_files ?? result?.observed_files`.
   - Dòng 134 và 136 lặp lại dòng `...(typeof file.child_agent_id === "string" ? { child_agent_id: file.child_agent_id } : {})`.
2. Đúng như mục `Limitations` trong báo cáo SE đã nêu rõ: kết quả hiện tại (`VERIFY-RUN-8ca7cba2-e16d-48d0-b4c6-53f3a61927a8`, pass `delegate-subagent-tool.test.js` và `source-read-policy.test.js`) xác nhận hoàn tất **hardening cho phạm vi `delegate_subagent` read-only explorer**, không tuyên bố thay cho full provider matrix hay crash-recovery của luồng handoff AM–SE–RV.

### 4.3. Quyết định cho phạm vi `delegate_subagent` unit hardening

- **Trạng thái:** **`PASS` cho tầng unit hardening (`delegate-subagent-tool.js`)**, nhưng **CẦN SỬA TIẾP (`REVISE`) ở tầng wiring `owner-sdk-stream.js`** sau khi kiểm tra báo cáo cập nhật lần 3.

---

## 5. AM Review Vòng 3 — Kiểm tra bản cập nhật `docs/architecture/subagent-forge-tool-se-report.md` (`sha256:08dee12bbc14bbc7c94f14a006938985832ff3a7a55f23bc32e3ada04cc6a542`)

### 5.1. Những điểm SE đã cập nhật thêm và đã khớp code

1. **`delegate-subagent-tool.js` (`sha256:ec2c92148a3275be663f1f36eff71f1fd4e02860027629c7a7dc54ed4947e315`):**
   - Đã xóa dòng `child_agent_id` bị lặp ở `normalizeObserved` (dòng 134–136).
   - Đã đổi dòng 91 thành `normalizeObserved(childContext.observed_files ?? result?.observed_files, childContext)` để ưu tiên dữ liệu từ collector nội bộ (`childContext.observed_files`) trước dữ liệu tự trả về của executor, kèm unit test kiểm chứng (`VERIFY-RUN-c88104f0-80dd-46ee-a255-91c32c65a00f`, exit 0).
2. **`owner-sdk-stream.js` (`sha256:81ec53d416a1b3edaad558e7cd9c33c485c3548adfe8513a717251072af900b2`):**
   - Dòng 112 đã bổ sung `correlationId: child.correlation_id ?? child.execution_id` vào lệnh `childSdk.execute(...)`.

### 5.2. Giải thích vì sao SE gọi lại `delegate_subagent` trong cùng turn vẫn gặp lỗi cũ `Claude SDK correlation_id is required.`

- Khi SE sửa file `backend/src/application/owner-sdk-stream.js` trên đĩa rồi gọi `delegate_subagent` ngay trong cùng turn đang chạy, tiến trình Node server đang giữ closure `childExecutor` cũ trong RAM (được tạo ở đầu turn tại dòng 107 trước khi file được sửa). Node không hot-reload ESM module giữa chừng một turn đang chạy.

### 5.3. Phát hiện Blocker mới ở `owner-sdk-stream.js` (dòng 112): Claude child subagent chưa được gắn `mcpServers` (`createOwnerClaudeMcpTools` + `createClaudeForgeOptions`)

Khi kiểm tra kỹ `owner-sdk-stream.js` (dòng 107–114) đối chiếu với `claude-sdk-gateway.js` (dòng 74–95):

- Trong `owner-sdk-stream.js` (dòng 112), `childExecutor` chỉ truyền:
  ```js
  options: {
    effort: "low",
    forgeTools: { registry: childTools.registry, definitions: childTools.definitions, context: childContext }
  }
  ```
- Trong khi đó:
  - `codex-sdk-gateway.js` (dòng 77) đọc `options.forgeTools` để tạo MCP session.
  - **Nhưng `claude-sdk-gateway.js` (dòng 75–76) xóa `cloneableOptions.forgeTools` và chỉ đọc `options.mcpServers`, `options.allowedTools`, `options.tools`!**
- Ở luồng agent cha (`owner-sdk-stream.js` dòng 121 và 147–150), code chuyển đổi `forgeTools` sang `mcpServers` thông qua:
  ```js
  const claudeTools = ["claude", "anthropic"].includes(profile.provider) ? createOwnerClaudeMcpTools(forgeTools) : null;
  const claudeOptions = claudeTools ? createClaudeForgeOptions(claudeTools) : {};
  ```
- **Nhưng ở `childExecutor` (dòng 107–114), bước chuyển đổi `createOwnerClaudeMcpTools` + `createClaudeForgeOptions` (và `sandboxMode: "read-only"` cho Codex) đang bị thiếu hoàn toàn.**
- **Hệ quả:** Khi chạy với provider `claude` / `anthropic`, child subagent sẽ không nhận được `mcpServers.forge` và `allowedTools`, dẫn đến không gọi được bất kỳ tool đọc nào (`search_tree`, `list_files`, `search_text`, `read_file`, `Read`).

### 5.4. Yêu cầu sửa dứt điểm cho SE

1. **Trong `backend/src/application/owner-sdk-stream.js` (dòng 107–114):**
   - Tạo `childForgeTools = { registry: childTools.registry, definitions: childTools.definitions, context: childContext }`.
   - Nếu `["claude", "anthropic"].includes(profile.provider)`: tạo `childClaudeOptions = createClaudeForgeOptions(createOwnerClaudeMcpTools(childForgeTools))` và spread vào `options` của `childSdk.execute(...)`.
   - Nếu `sdk.conversationMode === "thread"` (Codex): truyền `sandboxMode: "read-only"`, `approvalPolicy: "on-request"`, `networkAccessEnabled: false`, `webSearchMode: "disabled"`.
   - Truyền `conversationId` vào `childSdk.execute(...)` để `claudeHome` / `codexHome` của subagent cô lập theo đúng conversation.
2. **Trong `backend/tests/unit/system-engineer-sdk-tools.test.js`:**
   - Cập nhật fixture test cho khớp danh sách tool hiện hành (`Read`, `read_file_binary`, `delegate_subagent`) và truyền `claudeHomeRoot` / `projectRoot` vào thư mục tạm (`os.tmpdir()`) thay vì `"/project"` để không bị lỗi `EACCES`.
   - Thêm 1 unit test trong `owner-sdk-tools.test.js` (hoặc `delegate-subagent-tool.test.js`) chứng minh khi parent chạy provider `claude`/`anthropic` và gọi `delegate_subagent`, `childSdk.execute` nhận được đủ `correlationId`, `subagentId`, `options.mcpServers.forge`, `options.tools: []` và `options.allowedTools` chỉ gồm 5 tool read-only `mcp__forge__*`.

---

## 6. AM Review Vòng 4 — Kiểm tra bản cập nhật `docs/architecture/subagent-forge-tool-se-report.md` (`sha256:3d79ca21d1ed2f8fbf2db1546218cb944f17da46788cae1d2c5f430bc589d480`)

Đã đọc bản cập nhật mới nhất của `docs/architecture/subagent-forge-tool-se-report.md` và đối chiếu trực tiếp với `backend/src/application/owner-sdk-stream.js` (`sha256:751b9c6c6e8ede0ee85fe2648b7bb28195f852aef35fdeb6b1f4a2a34b9efb30`) cùng `backend/tests/unit/system-engineer-sdk-tools.test.js` (`sha256:c69e9c45dae4ce7cac370ca7d596160fa9bfd23c135ceb34e19a3b942f87809d`).

### 6.1. Kết quả đối chiếu toàn bộ yêu cầu của Vòng 3

| # | Yêu cầu từ Vòng 3 | Kiểm tra thực tế trong code | Kết quả |
|---|---|---|---|
| **1** | Gắn `createOwnerClaudeMcpTools` + `createClaudeForgeOptions` cho Claude child và `sandboxMode: "read-only"` cho Codex child trong `owner-sdk-stream.js` | Tại dòng 110–118 của `owner-sdk-stream.js`: đã tạo `childForgeTools`, gọi `createOwnerClaudeMcpTools(childForgeTools)` và `createClaudeForgeOptions(childClaudeTools)` cho `claude`/`anthropic`, cấu hình `{ sandboxMode: "read-only", approvalPolicy: "on-request", networkAccessEnabled: false, webSearchMode: "disabled" }` cho `thread` (Codex), đồng thời truyền `conversationId` và `correlationId: child.correlation_id ?? child.execution_id` vào `childSdk.execute(...)`. | **ĐẠT (PASS)** |
| **2** | Sửa fixture `system-engineer-sdk-tools.test.js` và thêm test kiểm chứng parent/child Claude MCP composition | Tại `backend/tests/unit/system-engineer-sdk-tools.test.js` (dòng 163–170): đã cập nhật sang surface mới (`Read`, `read_file_binary`, `delegate_subagent`), dùng thư mục tạm ghi được và bổ sung test kiểm tra `childRequest` nhận đúng `subagentId`, `conversationId`, `correlationId`, `options.mcpServers.forge`, `options.tools: []` và `options.allowedTools` 5 tool read-only. | **ĐẠT (PASS)** |
| **3** | Chạy lại kiểm thử và gọi thật `delegate_subagent` (Live revalidation) | Test suite `delegate-subagent-tool.test.js` + `system-engineer-sdk-tools.test.js` đã pass (`VERIFY-RUN-3914299f-a01d-438f-b2b4-b8455eb2964f`, exit 0). Lần gọi thật `delegate_subagent` với 2 task song song đã trả về `status: "completed"`, `tasks_completed: 2`, `observed_files` có đầy đủ `parent_execution_id`, `child_execution_id`, `child_agent_id`, `observed_at`, `source_tool`. | **ĐẠT (PASS)** |

### 6.2. Ghi chú nhỏ từ Live Audit (Non-blocking)

- Khi nhiều child trong cùng 1 batch đọc trùng 1 file `path`, `mergeObserved` hợp nhất `symbols_read` và giữ `sha256` mới nhất cùng provenance của child đầu tiên. Đây là hành vi hoàn toàn hợp lệ cho mục đích cấp receipt/checksum về parent và không chặn nghiệm thu.

### 6.3. Kết luận nghiệm thu cuối cùng của AM cho `delegate_subagent`

- **Quyết định:** **`PASS` (Hoàn tất nghiệm thu toàn bộ phạm vi `delegate_subagent` Read-Only Explorer)**
- **Cơ sở nghiệm thu:**
  1. Unit hardening (`delegate-subagent-tool.js`) + Runtime authorization gate (`tool-authorization.js`) + Read observation collectors (`agent-lifecycle-tools.js`, `source-read.js`) + Owner SDK child composition (`owner-sdk-stream.js`) đã khép kín.
  2. Cả kiểm thử tự động (`VERIFY-RUN-3914299f-a01d-438f-b2b4-b8455eb2964f`) lẫn kiểm thử gọi thật (`delegate_subagent` live execution với 2 task song song) đều đã thành công.
