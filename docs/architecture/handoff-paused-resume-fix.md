# Đặc tả Sửa Dứt Điểm (1 Lần Duy Nhất): Resume An Toàn cho Handoff AM ↔ SE ↔ RV

- **Ngày lập:** 2026-11-08
- **Người lập:** Architecture Manager (AM)
- **Mục tiêu:** Sửa dứt điểm toàn bộ 5 lỗi chí mạng trong luồng `Resume` từ UI (`am-se-handoff-controls.jsx`) $\rightarrow$ HTTP Router (`control-api-http.mjs`) $\rightarrow$ `am-se-handoff-service.js` $\rightarrow$ `am-se-handoff-checkpoint.js` & `am-se-critique-checkpoint.js` $\rightarrow$ `owner-sdk-stream.js` & `owner-execution-checkpoint.js`.

---

## 1. 5 LỖI CHÍ MẠNG ĐÃ TÌM RA TRONG CODE HIỆN TẠI (TẠI SAO BẤM RESUME VẪN KHÔNG CHẠY!)

Sau khi đọc từng dòng code từ UI xuống tận `control-api-http.mjs`, `owner-sdk-stream.js` và `owner-execution-checkpoint.js`, đây là **5 thủ phạm thực sự** đang giết chết nút **Resume**:

### Thủ phạm 1 (Nặng nhất — chết ngay khi bấm Resume trên UI!): `handoffAdapter` trong `backend/scripts/control-api-http.mjs` (dòng 49) trả về **AsyncGenerator chưa chạy** thay vì `{ text, execution_id, terminal_status, result_evidence }`!
Hãy nhìn dòng 49–57 của `backend/scripts/control-api-http.mjs`:
```js
const handoffAdapter = ({ agentId, prompt, conversationId, linkedConversationId, correlationId, withEvidence }) =>
  sdkStream({ agentId, payload: { text: prompt, response_content_type: "text/markdown", linked_conversation_id: linkedConversationId ?? null, ...(withEvidence ? { handoff_execution: true } : {}) }, correlationId, conversationId, eventSink: publishUnifiedStreamEvent });
```
- `sdkStream` (`createOwnerSdkStream` trong `owner-sdk-stream.js` dòng 38) là một hàm **`async function* stream(...)` (AsyncGenerator)**!
- Khi tạo plan qua chat, `owner-chat-service.js` truyền `streamHandoffSystemEngineer` / `streamHandoffReviewer` / `streamCommandArchitecture` (có vòng lặp `for await (const chunk of agentStream(...))` để tiêu thụ generator và trả về `{ text, ...terminal }`).
- **NHƯNG khi bạn bấm nút `Run` hoặc `Resume` trên UI**, request đi qua `forge-v1-conversation-routes.js` $\rightarrow$ gọi trực tiếp `amSeHandoffService.resumeHandoff(...)` được khởi tạo trong `control-api-http.mjs` (dòng 50–58)!
- Ở đó, `requestSystemEngineer`, `requestReviewer`, `requestArchitecture` lại chính là `handoffAdapter`!
- Khi `invoke` gọi `raw = await se(...)` (tức `await handoffAdapter(...)`), vì `sdkStream(...)` là `async function*`, **`await sdkStream(...)` KHÔNG HỀ CHẠY BẤT KỲ DÒNG NÀO BÊN TRONG `sdkStream`**, mà trả về ngay lập tức một object `AsyncGenerator {}` rỗng!
- Thế là `raw.text` là `undefined`, `raw.execution_id` là `undefined`, không một agent nào được gọi, và `complete()` lập tức đánh dấu `execution_status = "reconciliation_required"` / `"blocked"` với `error_code = "HANDOFF_RESULT_REQUIRED"`! **Đó là lý do vì sao bạn bấm Resume trên UI bao nhiêu lần nó cũng không chạy!**

---

### Thủ phạm 2: `owner-execution-checkpoint.js` (dòng 76) ném lỗi `EXECUTION_DECISION_REQUIRED` chặn không cho lần chạy sau bắt đầu nếu lần chạy trước bị ngắt!
Hãy nhìn dòng 70–76 của `backend/src/application/owner-execution-checkpoint.js`:
```js
async function start({ conversationId, executionId, ... }) {
  ...
  const previous = await inspect(conversationId);
  const live = previous.find((entry) => entry.status === "running" && Date.now() - Date.parse(entry.heartbeat_at) < LEASE_MS);
  if (live) throw Object.assign(new ConfigurationError(`A ${displayName} execution is already running in this conversation.`), { code: "EXECUTION_BUSY", statusCode: 409 });
  if (!continueAttempt && !resumeOf && previous.some((entry) => ["interrupted", "manual_required"].includes(entry.status)))
    throw Object.assign(new ConfigurationError("Choose Continue, Restart, or Discard for the interrupted execution first."), { code: "EXECUTION_DECISION_REQUIRED", statusCode: 409 });
```
- Khi một bước handoff của SE hoặc AM (trong `CONV-SE-...` hoặc conversation của AM) bị lỗi/ngắt giữa chừng ở lần trước, `owner-sdk-stream.js` (dòng 209) lưu một bản ghi `status: "interrupted"` hoặc `"manual_required"` vào `executionCheckpoint` / `architectureCheckpoint`.
- Khi bạn bấm **Resume** handoff, `am-se-handoff-checkpoint.js` tạo một `executionId` mới (`CORR-HANDOFF-...`) và gọi `sdkStream` (với `continueAttempt: false, resumeOf: null`).
- Dòng 76 của `owner-execution-checkpoint.js` thấy trong `CONV-SE-...` (hoặc AM conversation) có bản ghi cũ đang ở `"interrupted"` / `"manual_required"`, thế là nó **ném thẳng lỗi `EXECUTION_DECISION_REQUIRED`**, rơi vào `catch` ở dòng 235 của `am-se-handoff-checkpoint.js` và biến handoff thành `HANDOFF_EXECUTION_UNKNOWN`!

---

### Thủ phạm 3: Khi Handoff bị dừng ở pha `plan_critique` (`!record.checkpoint`), bấm Resume bị lỗi hoặc chỉ chạy 1 nửa!
Hãy nhìn `resumeHandoff` trong `backend/src/application/am-se-handoff-service.js` (dòng 182–194) và `am-se-critique-checkpoint.js` (dòng 43–48):
1. Nếu handoff bị dừng ở pha `plan_critique` (ví dụ SE hoặc AM đang phản biện vòng 1 thì bị ngắt nên `critique_checkpoint.execution_status === "unknown"` hoặc `"running"`, và `record.history` còn rỗng):
   - Trong `am-se-handoff-controls.jsx` (dòng 122–125):
     - UI gọi `resumeCritique` (chỉ chạy đúng 1 bước `se` hoặc `am`, **chưa chạy hết vòng phản biện và chưa chuyển sang `ALIGNED`**), rồi dòng 125 gọi tiếp `resumeHandoff`!
     - Hoặc nếu `critique_checkpoint.execution_status` đang bị kẹt, `safeToRetry` trong `am-se-critique-checkpoint.js` (dòng 31) đòi `!evidence.completed_tool_calls.some(call => call.mutating) && evidence.last_completed_step === 0` — nhưng trong lúc phản biện, SE đã dùng tool đọc file (`read_file` / `Read`) nên **`evidence.last_completed_step > 0`**! Thế là `safeToRetry` trả về `false` và ném lỗi **`HANDOFF_CRITIQUE_RECOVERY_REQUIRED`**!
2. Chưa hết, ở dòng 184 của `am-se-handoff-service.js`:
   ```js
   if (record.approval_mode !== "explicit_owner_command" && (!record.history?.length || record.history.at(-1)?.critique_status !== "ALIGNED" ...))
     throw ... { code: "HANDOFF_CRITIQUE_REQUIRED" }
   ```
   Nếu handoff có `approval_mode !== "explicit_owner_command"` (hoặc critique chưa xong), `resumeHandoff` ném lỗi `HANDOFF_CRITIQUE_REQUIRED` thay vì tự động hoàn tất nốt phần critique rồi chạy tiếp sang implementation!

---

### Thủ phạm 4: Khi `checkpoint.execution_status === "running"` (do tiến trình crash hoặc lần chạy trước bị ngắt mà chưa có `runner_stopped_at`), bấm Resume bị chặn bởi `HANDOFF_BUSY` hoặc dừng lại sau khi chuyển sang `unknown`!
Hãy nhìn `am-se-handoff-service.js` (dòng 205) và `am-se-handoff-checkpoint.js` (dòng 185–201):
1. Nếu lần trước tiến trình crash hoặc `executionCheckpoint` không tìm thấy receipt (`receipt === null`) hoặc `receipt.runner_stopped_at` chưa kịp ghi:
   - Ở `am-se-handoff-service.js` dòng 205: điều kiện `(record.checkpoint.execution_status !== "running" || !executionCheckpoint || receipt?.runner_stopped_at && receipt.status !== "running")` là **`false`**!
   - Thế là nó đi thẳng vào `checkpoint.resume()` dòng 185–200 và nổ ngay lỗi **`HANDOFF_BUSY`**!
2. Ngược lại, nếu `receipt?.runner_stopped_at` có tồn tại nhưng bước trước bị lỗi (`receipt.status === "interrupted"`), nếu lọt vào dòng 192–198 của `am-se-handoff-checkpoint.js`:
   - Nó chuyển `execution_status` sang `"reconciliation_required"` / `"unknown"` rồi **`return uncertain;` kết thúc luôn hàm `resume`** mà không chạy bước đó!

---

### Thủ phạm 5: Lệch `scopePaths` giữa `am-se-handoff-service.js` và `am-se-handoff-checkpoint.js` gây `HANDOFF_WORKSPACE_MISMATCH`!
- Trong `am-se-handoff-service.js` (dòng 207):
  `scopePaths: Array.isArray(record.checkpoint.workspace?.scope_paths) ? record.checkpoint.workspace.scope_paths : record.workspace_scope_paths`
  Khi `record.workspace_scope_paths` là `[]` (mảng rỗng do `store.create` dòng 77 khởi tạo `[]`), dòng 207 truyền `scopePaths = []` $\rightarrow$ tạo snapshot có `scope_paths: []` (`index_hash: null`).
- Nhưng trong `am-se-handoff-checkpoint.js` (dòng 31):
  `same(a, b)` kiểm tra `Array.isArray(a.scope_paths) && Array.isArray(b.scope_paths)`. Nếu một nơi truyền `undefined` (khi `workspace_scope_paths` rỗng) còn nơi kia truyền `[]`, hoặc giữa các bước trong vòng lặp `do ... while` có file thay đổi, dòng 221 của `am-se-handoff-checkpoint.js` sẽ ném lỗi `HANDOFF_WORKSPACE_MISMATCH`!

---

## 2. BẢN SỬA CODE TRIỆT ĐỂ (5 FILE — FIX 1 LẦN CHẠY NGAY)

### 2.1. Sửa `backend/scripts/control-api-http.mjs` (dòng 49–58) — Tiêu thụ `sdkStream` AsyncGenerator trong `handoffAdapter`
Thay `handoffAdapter` ở dòng 49–57 bằng hàm `async` tiêu thụ hết generator `sdkStream` (giống hệt `streamHandoffSystemEngineer` / `streamCommandArchitecture` trong `owner-chat-service.js`):
```js
const handoffAdapter = async ({ agentId, prompt, conversationId, linkedConversationId, correlationId, withEvidence, planningInputOnly = false }) => {
  let text = "";
  let terminal;
  for await (const chunk of sdkStream({
    agentId,
    payload: {
      text: prompt,
      response_content_type: "text/markdown",
      planning_input_only: Boolean(planningInputOnly),
      linked_conversation_id: linkedConversationId ?? null,
      ...(withEvidence ? { handoff_execution: true } : {})
    },
    correlationId,
    conversationId,
    eventSink: publishUnifiedStreamEvent
  })) {
    if (typeof chunk?.text === "string" && chunk.text) text += chunk.text;
    if (chunk?.handoff_terminal) terminal = chunk.handoff_terminal;
  }
  return withEvidence ? { text, ...terminal } : text;
};
```
Và tại dòng 55 (`requestArchitecture` của `createAmSeHandoffService`):
```js
requestArchitecture: (prompt, conversationId, options = {}) => handoffAdapter({
  agentId: services.agentRoleResolver?.resolveProfile?.("architecture_manager")?.agent_id ?? "architecture-manager",
  prompt,
  conversationId,
  correlationId: options.correlationId,
  withEvidence: options.withEvidence !== false,
  planningInputOnly: Boolean(options.planningInputOnly)
}),
```

### 2.2. Sửa `backend/src/application/owner-execution-checkpoint.js` (dòng 70–77) & `backend/src/application/owner-sdk-stream.js` (dòng 62) — Không chặn Handoff Execution bởi `EXECUTION_DECISION_REQUIRED`
1. Trong `backend/src/application/owner-sdk-stream.js` (dòng 62):
   Truyền `handoffExecution: payload.handoff_execution === true` vào `checkpointStore.start({...})`:
   ```js
   checkpoint = await checkpointStore.start({
     conversationId,
     executionId: correlationId,
     messageId: payload.source_message_id ?? payload.message_id,
     provider: profile.provider,
     toolMode,
     promptHash: executionDigest(payload.text),
     resumeOf: payload.resume_of ?? null,
     continueAttempt: payload.continue_execution === true,
     handoffExecution: payload.handoff_execution === true
   });
   ```
2. Trong `backend/src/application/owner-execution-checkpoint.js` (dòng 70–77):
   - Khi `handoffExecution === true` (hoặc `String(executionId).startsWith("CORR-HANDOFF-")`), nếu có các bản ghi cũ đang ở `["interrupted", "manual_required"]` (hoặc `"running"` nhưng đã hết lease), tự động đóng/chuyển chúng sang `"restarted"` thay vì ném lỗi `EXECUTION_DECISION_REQUIRED`!

### 2.3. Sửa `backend/src/application/am-se-critique-checkpoint.js` (dòng 29–48) — Cho phép Critique Resume an toàn kể cả khi SE đã gọi tool đọc file (`last_completed_step > 0`)
- Trong `safeToRetry(record, cp)` (dòng 29–33):
  - Bỏ điều kiện vô lý `evidence.last_completed_step !== 0` (vì SE đọc file bằng `read_file`/`Read` không sửa đổi gì nhưng vẫn tăng `last_completed_step`).
  - Nếu `!evidence` (chưa kịp tạo checkpoint) hoặc runner đã dừng / hết lease và không có `completed_tool_calls` nào có `mutating === true`, cho phép retry!
  - Trong `run()` (dòng 48): đồng bộ lại `cp.workspace = await snapshot()` khi resume từ trạng thái bị ngắt để không bị lỗi `HANDOFF_CRITIQUE_STALE` do workspace thay đổi.

### 2.4. Sửa `backend/src/application/am-se-handoff-service.js` (`resumeHandoff` dòng 162–235 & `resumeCritique` dòng 239–260) — Tự động hoàn tất Critique (nếu đang ở `plan_critique`) rồi chạy thẳng `SE → RV → AM`
Khi người dùng bấm **Resume** (gọi `resumeHandoff`):
1. **Nếu handoff chưa có `record.checkpoint` (`record.phase === "plan_critique"`):**
   - Nếu `record.critique_checkpoint` chưa hoàn tất (`execution_status !== "completed"`), tự động chạy vòng lặp hoàn tất các bước phản biện còn lại (`se` $\rightarrow$ `am`), áp dụng `maybeApplyCritiqueRevision` vào `r1`, và chốt `critique_checkpoint.execution_status = "completed"`.
   - Tự động approve bản `r1` với `approvedOwnerId` nếu chưa có decision `"approved"` khớp `plan_sha256` (vì chính Owner vừa bấm nút **Resume** đã xác thực `approvedOwnerId` qua `planOwnerAuth`).
   - Chuyển sang `phase: "implementation"`, khởi tạo `checkpoint.initialize(handoffId, approvedOwnerId)` và chạy tiếp xuống bước thực thi `SE → RV → AM`!
2. **Nếu handoff đã có `record.checkpoint`:**
   - Tự động kiểm tra và approve plan nếu `verifyPlan` báo `PLAN_APPROVAL_REQUIRED` (vì `approvedOwnerId` đã được xác thực khi bấm nút Resume).
   - Nếu `record.checkpoint.execution_status === "running"`:
     - Kiểm tra xem conversation hiện tại có thực sự đang chạy trong `sdkStream` không. Nếu có `receipt.handoff_result` đã xong thì gọi `checkpoint.complete(...)`. Nếu không còn active runner (hoặc crash), **không báo `HANDOFF_BUSY`**, mà chuyển thẳng vào `resolveSafeResumeState` để dò ngược về bước an toàn (`"se"`, `"rv"`, hoặc `"am"`) và chạy lại!
   - Đặt khối chuẩn hóa `resolveSafeResumeState` + cập nhật `freshWorkspace` ở cả `am-se-handoff-service.js` và đầu hàm `checkpoint.resume()` trong `am-se-handoff-checkpoint.js` để mọi vòng lặp trong `do ... while (runToCompletion)` đều tự động đồng bộ workspace và chạy một mạch đến `status === "completed"`.

### 2.5. Sửa `backend/src/application/am-se-handoff-checkpoint.js` (dòng 176–224) — Tự động Self-Heal trong `checkpoint.resume()`
- Ở dòng 185–204 của `am-se-handoff-checkpoint.js`:
  - Khi `cp.execution_status === "running"`:
    - Nếu `receipt` có `handoff_result` hoàn chỉnh $\rightarrow$ `complete(...)`.
    - Nếu `receipt` đã dừng (`runner_stopped_at`) hoặc `!receipt` hoặc hết lease $\rightarrow$ **không return sớm với `HANDOFF_EXECUTION_UNKNOWN` và không ném `HANDOFF_BUSY`**, mà rơi thẳng xuống `resolveSafeResumeState(record, cp)` để reset về `execution_status: "pending"`, `next_step: safeNextStep`, cập nhật `workspace: observed`, rồi thực thi luôn `invoke(...)`!
  - Ở dòng 203: Bỏ lệnh `if (["reconciliation_required", "unknown", "blocked"].includes(cp.execution_status)) fail("HANDOFF_RECONCILIATION_REQUIRED");` khi gọi `resume()`, thay bằng việc tự động chuẩn hóa qua `resolveSafeResumeState(record, cp)` và cập nhật `freshWorkspace` để chạy tiếp từ checkpoint an toàn!

### 2.6. Sửa `ui/nextjs/components/am-se-handoff-controls.jsx` (dòng 121–126)
- Khi bấm **Resume** (`action === "resume"`), chỉ cần gọi duy nhất `await client.resumeHandoff(projectId, handoff, token)` (vì `resumeHandoff` ở backend đã tự động xử lý cả trường hợp đang dừng ở `plan_critique` lẫn `implementation`), không gọi kép `resumeCritique` + `resumeHandoff` gây xung đột generation.

---

## 3. Kiểm thử Bắt buộc cho SE

Sau khi sửa 5 điểm trên, SE bắt buộc viết thêm test giả lập đúng `control-api-http.mjs` (`handoffAdapter` bọc `async function* sdkStream`) và chạy `run_check`:
1. `backend/tests/integration/am-se-handoff-run-route.test.js`
2. `backend/tests/unit/am-se-handoff-service-resume.test.js`
3. `backend/tests/unit/am-se-handoff-checkpoint.test.js`
4. `backend/tests/unit/owner-execution-checkpoint.test.js`
