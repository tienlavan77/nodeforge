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

### 4.3. Quyết định cuối cùng của AM cho hạng mục `delegate_subagent` hardening

- **Trạng thái:** **`PASS` (Đồng ý nghiệm thu phạm vi `delegate_subagent` hardening)**
- Tất cả 4 điểm kỹ thuật trong Vòng 1 đã được SE khắc phục đầy đủ, khớp mã nguồn và pass kiểm thử mục tiêu.
