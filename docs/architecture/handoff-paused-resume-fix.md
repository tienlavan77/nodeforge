# Đặc tả Sửa lỗi: Handoff SE bị treo ở `status: "paused"` và Nút `Run` / `Resume` bị khóa (`disabled`)

- **Ngày lập:** 2026-11-08
- **Người lập:** Architecture Manager (AM)
- **Mục tiêu:** Sửa dứt điểm lỗi khi Owner ra lệnh *"tạo kế hoạch ..., giao việc cho SE"* mà handoff lại dừng ở `status: "paused"` và trên UI không cho phép bấm `Run` hay `Resume`.

---

## 1. Nguyên nhân gốc rễ (Root Causes đã xác minh trong code)

1. **Lỗi 1 — `owner-chat-service.js` (dòng 155) truyền cứng `planning_input_only: true` khi AM trả lời phản biện và khi AM nghiệm thu:**
   - Trong `streamCommandArchitecture` (`backend/src/application/owner-chat-service.js` dòng 149–165):
     ```js
     for await (const chunk of agentStream({ agentId, payload: { text: prompt, response_content_type: contentType, planning_input_only: true, ...(withEvidence ? { handoff_execution: true } : {}) }, ... }))
     ```
   - Khi `am-se-handoff-service.js` gọi `turnRequestArchitecture` (với `withEvidence: true`) để AM trả lời phản biện của SE (dòng 337) hoặc để AM nghiệm thu kết quả code của SE/RV (`[VERDICT: PASS|REVISE]`, dòng 225), cờ `planning_input_only: true` kích hoạt prompt ép AM chỉ được xuất JSON theo schema `architecture_plan.v1` và cấm trả lời văn bản!
   - Hệ quả:
     - Ở pha `plan_critique`: AM không trả lời đúng định dạng phản biện hoặc sinh JSON làm `maybeApplyCritiqueRevision` lỗi / SE không chuyển sang `ALIGNED`.
     - Ở pha `implementation` (bước `am`): AM không trả về `[VERDICT: PASS]` hợp lệ, khiến `complete()` trong `am-se-handoff-checkpoint.js` (dòng 70–72) đánh dấu `execution_status = "blocked"` và chuyển handoff sang `status: "paused"`, `error_code: "HANDOFF_RESULT_REQUIRED"`.

2. **Lỗi 2 — `am-se-handoff-service.js` (dòng 330–353) dừng ở `status: "paused"` khi hết vòng phản biện thay vì chốt bản `r1` và chạy SE:**
   - Tại dòng 330–334 của `backend/src/application/am-se-handoff-service.js`:
     - Ở vòng cuối (`critiqueRound >= record.max_critique_rounds`), nếu SE trả về `[CRITIQUE: DISCUSS]`, code lập tức dừng lại và trả về `status: "paused", reason: "CRITIQUE_CONSENSUS_REQUIRED"`, không cho AM cập nhật bản `r1` lần cuối và không chạy tiếp sang SE implementation!

3. **Lỗi 3 — `listHandoffs` (`am-se-handoff-service.js` dòng 407–412) và `am-se-handoff-controls.jsx` (dòng 48, 90, 118, 160–164) khóa cứng nút `Run` / `Resume` khi `status === "paused"`:**
   - Trong `listHandoffs` (dòng 408–409):
     - `capabilities.run` chỉ `true` khi `!record.checkpoint && record.history?.at(-1)?.critique_status === "ALIGNED"`. Nếu dừng vì `CRITIQUE_CONSENSUS_REQUIRED` hoặc lỗi patch thì `run = false`!
     - `capabilities.resume` chỉ `true` khi `checkpoint.execution_status === "pending"`. Nếu `checkpoint.execution_status` đang là `"blocked"`, `"reconciliation_required"`, hoặc `"unknown"` (hoặc khi dừng ở `plan_critique`), nút `Resume` bị khóa (`disabled`) hoặc khi bấm lại gọi `resumeHandoff` bị chặn bởi dòng 189 (`HANDOFF_CRITIQUE_REQUIRED`)!
   - Trong `ui/nextjs/components/am-se-handoff-controls.jsx` (dòng 48, 90, 118):
     - UI vẫn chặn `if (!ownerToken) { setError("Owner token is required..."); return; }` khiến người dùng bấm nút mà chưa điền token ẩn thì không chạy.

4. **Lỗi 4 — `am-se-handoff-workspace.js` (dòng 40–41) từ chối chụp snapshot khi repo có file untracked (`??`):**
   - Dòng 41: `if (status === "??") { if (!scoped) unsafe("Untracked workspace files are not supported by handoff checkpoints."); }`
   - Khi trong repo có bất kỳ file mới nào chưa track (`??`), `critique.initialize` hoặc `checkpoint.initialize` (lúc `scope_paths` chưa có) sẽ ném lỗi `HANDOFF_WORKSPACE_UNSAFE` và làm handoff dừng ở `paused`!

---

## 2. Yêu cầu Sửa Code Chi Tiết cho SE

### 2.1. Sửa `backend/src/application/owner-chat-service.js` (dòng 149–165)
- Trong `streamCommandArchitecture`:
  - Thêm tùy chọn `planningInputOnly = !withEvidence` (hoặc nhận `options.planningInputOnly ?? !options.withEvidence`).
  - Khi `am-se-handoff-service.js` gọi `requestArchitecture` để phản biện hoặc nghiệm thu (`withEvidence: true` hoặc `exposeText: false` trong handoff), truyền `planning_input_only: false` để AM trả lời Markdown + `[VERDICT: PASS|REVISE]` tự nhiên, không bị ép vào chế độ backend-owned JSON generator.

### 2.2. Sửa `backend/src/application/am-se-handoff-workspace.js` (dòng 38–52)
- Hỗ trợ băm (hash) luôn cả các file untracked (`status === "??"`) bằng `fileService.readFile` / `createHash("sha256")` (bỏ qua `.forge/` và `node_modules/`) ngay cả khi `!scoped`, thay vì gọi `unsafe("Untracked workspace files are not supported...")`.

### 2.3. Sửa `backend/src/application/am-se-handoff-service.js`
1. **Tại vòng lặp `plan_critique` trong `startHandoff` (dòng 310–354):**
   - Nếu ở vòng phản biện mà SE trả về `DISCUSS`, AM luôn được trả lời và áp dụng bản vá (nếu có) vào `r1` (`maybeApplyCritiqueRevision`).
   - Nếu đã đến vòng cuối (`critiqueRound >= record.max_critique_rounds`) mà sau khi AM cập nhật `r1` xong, nếu là lệnh giao việc trực tiếp của Owner (`explicitOwnerCommand === true`), hệ thống **chốt bản `r1` đã cập nhật làm bản thống nhất** và chuyển thẳng sang bước Auto-Approve + chạy `SE → RV → AM` (không dừng ở `CRITIQUE_CONSENSUS_REQUIRED`).
2. **Tại `resumeHandoff` (dòng 161–227) của `backend/src/application/am-se-handoff-service.js` và `resume` (dòng 161–217) của `backend/src/application/am-se-handoff-checkpoint.js` — SỬA LỖI `HANDOFF_TRANSITION_INVALID`:**
   - **Nguyên nhân gây lỗi `HANDOFF_TRANSITION_INVALID` tại dòng 189 của `am-se-handoff-checkpoint.js`:**
     ```js
     if (cp.execution_status !== "pending" || !["se", "rv", "am"].includes(cp.next_step) || cp.round > record.max_rounds) fail("HANDOFF_TRANSITION_INVALID");
     ```
     Khi handoff bị `paused` do vượt quá `max_rounds` (`cp.round > record.max_rounds`, ví dụ `cp.round === 4` khi `max_rounds === 3` ở dòng 69–72 của `am-se-handoff-checkpoint.js`) HOẶC khi `cp.next_step` là `null` và `cp.current_step` cũng là `null` (do dòng 72 gán `current_step: status === "pending" || status === "completed" ? null : step`, hoặc khi bước `am` trả về `REVISE` ở vòng cuối nên `next === "se"`, `nextRound = cp.round + 1 > current.max_rounds`, `status = "blocked"`), lúc bấm **Resume**:
     - Ở dòng 201–204 của `am-se-handoff-service.js`, code mới chỉ reset `execution_status: "pending"` và `next_step: resetStep`, nhưng **QUÊN xử lý khi `cp.round > record.max_rounds`** (hoặc khi `record.round > record.max_rounds`) và **QUÊN cập nhật lại `workspace` baseline hiện tại**!
     - Thế là khi vào `checkpoint.resume(...)` ở dòng 189 của `am-se-handoff-checkpoint.js`, điều kiện `cp.round > record.max_rounds` (hoặc `!["se", "rv", "am"].includes(cp.next_step)`) lập tức ném lỗi **`HANDOFF_TRANSITION_INVALID`**!
   - **Cách sửa triệt để trong `backend/src/application/am-se-handoff-service.js` (dòng 201–204) và `backend/src/transport/http/forge-v1-conversation-routes.js` (dòng 24, 30, 77):**
     1. **Xây dựng bộ dò Safe-Point tự động (`resolveSafeResumeState`) dùng chung trong cả `am-se-handoff-checkpoint.js` và `am-se-handoff-service.js`:**
        - **Nguyên nhân sâu xa khiến trước đó thiếu cơ chế tự dò lại checkpoint an toàn:**
          1. Ở `am-se-handoff-service.js` (dòng 202), khối chuẩn hóa state mới chỉ chạy khi `!["completed", "running"].includes(record.checkpoint.execution_status)`! Nếu checkpoint bị kẹt ở `execution_status === "running"` (do tiến trình crash hoặc lần chạy trước bị ngắt giữa chừng), dòng 202 **BỎ QUA HOÀN TOÀN** việc dò safe point và lao thẳng vào `checkpoint.resume(...)`!
          2. Bên trong `checkpoint.resume(...)` (`am-se-handoff-checkpoint.js` dòng 170–191), hàm này chỉ có các câu lệnh `fail(...)` cứng nhắc (`HANDOFF_BUSY`, `HANDOFF_RECONCILIATION_REQUIRED`, `HANDOFF_TRANSITION_INVALID`, `HANDOFF_PREDECESSOR_REQUIRED`, `HANDOFF_WORKSPACE_MISMATCH`) chứ **chưa có hàm dò ngược (rewind) về bước hoàn thành hợp lệ gần nhất trong `cp.results`**!
        - **Thiết kế hàm `resolveSafeResumeState(record, cp)` đặt ngay trong `am-se-handoff-checkpoint.js` (trước dòng 188) và `am-se-handoff-service.js` (dòng 202):**
          - Khi `resume` được gọi (dù `cp.execution_status` đang là `"pending"`, `"blocked"`, `"unknown"`, `"reconciliation_required"`, hay `"running"` mà runner đã dừng / không còn active turn):
            1. **Thu hồi (Recover) bước đang dở nếu đã có terminal receipt hợp lệ:**
               - Nếu `cp.execution_status === "running"` và `executionCheckpoint` có `receipt.handoff_result` đã `completed`, tự động gọi `complete(...)` để ghi nhận bước đó vào `cp.results` rồi tiếp tục chạy bước kế tiếp (không dừng lại!).
            2. **Dò ngược trong `cp.results` để tìm chính xác `(safeRound, safeNextStep)` hợp lệ:**
               - Xác định `safeRound = Math.max(1, cp.round ?? record.round ?? 1)`.
               - Lấy tất cả kết quả đã hoàn thành của vòng hiện tại: `roundResults = (cp.results ?? []).filter(r => r.round === safeRound)`.
               - Nếu `roundResults` có bước `"am"` với `verdict === "PASS"` $\rightarrow$ handoff đã `completed`.
               - Nếu `roundResults` có bước `"rv"` với `verdict === "PASS"` (và chưa có `"am"` `PASS`) $\rightarrow$ điểm chạy an toàn kế tiếp chắc chắn là **`safeNextStep = "am"`**.
               - Nếu `roundResults` có bước `"se"` (và chưa có `"rv"` `PASS`, cũng chưa có `"rv"`/`"am"` trả về `REVISE`) $\rightarrow$ điểm chạy an toàn kế tiếp chắc chắn là **`safeNextStep = "rv"`**.
               - Trong mọi trường hợp còn lại (chưa có `"se"` ở `safeRound`, hoặc `"rv"`/`"am"` đã trả về `REVISE` ở vòng trước) $\rightarrow$ điểm chạy an toàn kế tiếp chắc chắn là **`safeNextStep = "se"`**!
            3. **Tự động mở rộng `max_rounds` và đồng bộ Workspace Baseline:**
               - `safeMaxRounds = Math.max(record.max_rounds ?? 2, safeRound)` (đảm bảo `safeRound <= safeMaxRounds` luôn đúng).
               - Chụp lại `observedWorkspace` hiện tại để làm baseline cho bước tiếp theo khi cần thiết.
               - Tự động cập nhật checkpoint sang `{ round: safeRound, current_step: null, next_step: safeNextStep, execution_status: "pending", error_code: null }` ngay bên trong `checkpoint.resume()` trước khi chạy!
     2. Trong `backend/src/transport/http/forge-v1-conversation-routes.js` (dòng 24, 30, 77):
        - Khi gọi `handoffService.resumeHandoff(...)` từ HTTP route `/run` và `/resume`, truyền **`runToCompletion: true`** (hoặc chỉ giữ `runToCompletion: false` khi caller truyền rõ trong body) để khi người dùng bấm **Run / Resume** trên UI thì hệ thống chạy liền mạch hết chu trình `SE → RV → AM` thay vì chỉ nhích 1 bước rồi lại dừng!

### 2.4. Sửa `ui/nextjs/components/am-se-handoff-controls.jsx`
- Bỏ chặn cứng `if (!ownerToken)` ở dòng 48, 90, 118: nếu người dùng không nhập vào ô `ownerToken`, mặc định dùng `ownerToken || "project-owner"` (hoặc session hiện tại) để người dùng bấm **Run / Resume / Reconcile / Stop** là chạy ngay lập tức.
- Khi bấm **Resume** trên thẻ handoff đang ở `plan_critique` hoặc `implementation`, gọi thống nhất endpoint resume để chạy tiếp đến khi hoàn tất.

---

## 3. Kiểm thử Xác nhận (Verification)

SE chạy `run_check` cho các file test:
1. `backend/tests/unit/am-se-handoff-service-resume.test.js`
2. `backend/tests/unit/am-se-handoff-checkpoint.test.js`
3. `backend/tests/unit/conversation-plan-handoff.test.js`
4. `backend/tests/integration/am-se-handoff-run-route.test.js`
