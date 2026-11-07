# Đặc tả Kỹ thuật Giao SE Triển khai (Đã tích hợp phản biện SE): Quy tắc Kế hoạch `r1` Duy nhất, Tự động Giao việc (`SE`/`SL`) và Luồng Handoff AM ↔ SE ↔ RV

Tài liệu này là bản đặc tả thống nhất sau khi Architecture Manager (AM) tích hợp toàn bộ 5 Blocker và 8 câu hỏi làm rõ từ `docs/architecture/plan-r1-auto-handoff-spec-feedback.md` của System Engineer (SE).

---

## 1. Bốn Quyết định Bắt buộc của Project Owner

1. **Không tạo `r2` trong lúc phản biện kế hoạch (Cập nhật in-place vào `r1`):**
   - Trong giai đoạn `plan_critique` (AM ↔ SE), mọi chỉnh sửa JSON Merge Patch của AM đều cập nhật **trực tiếp vào bản `r1`** của cùng `plan_id` (chỉ khi `r1` chưa có decision). Kết thúc phản biện chỉ có **1 kế hoạch thống nhất duy nhất ở `r1`** với `sha256` cuối cùng.
2. **Mọi thay đổi hoặc cập nhật về sau luôn tạo 1 kế hoạch mới (`Plan ID` mới, `r1`):**
   - Không dùng `r2`, `r3` cho việc sửa đổi kế hoạch. Khi Owner yêu cầu cập nhật/thay đổi kế hoạch, hệ thống tạo **`plan_id` mới hoàn toàn ở `revision = 1` (`r1`)**; kế hoạch cũ giữ nguyên bất biến (`immutable`).
3. **Khi Owner ra lệnh *"tạo kế hoạch xxx, giao việc cho SE"* hoặc *"giao việc cho SL"* $\rightarrow$ Tự động Approve và chạy luôn:**
   - Lệnh tạo kế hoạch của Owner có `deliveryTarget = "se" | "sl"` là ủy quyền phê duyệt trực tiếp (`approval_mode: "explicit_owner_command"`).
   - Ngay khi AM ↔ SE phản biện đạt `ALIGNED`, hệ thống tự động ghi decision `approved` cho bản `r1` (theo `sha256` cuối cùng sau critique) và giao thẳng cho `SL` (tạo Sprint/Tickets) hoặc `SE` (chạy chu trình `SE → RV → AM` có durable checkpoint), không dừng ở `PLAN_APPROVAL_REQUIRED`.
4. **Handoff Panel & Safe-Point Recovery sau Crash / Stop:**
   - Mọi bước thực thi đều hiển thị trên Handoff Panel với `capabilities: { run, resume, stop, reconcile }` do server quyết định.
   - Khi bấm `Run` / `Resume` sau crash/stop, hệ thống dò ngược về Safe Point gần nhất dựa trên durable receipt: không chạy lại bước đã `completed`, không retry mù khi trạng thái là `unknown`.

---

## 2. Chốt 5 Blocker và 8 Câu hỏi Kỹ thuật từ SE Feedback

### 2.1. Chốt Blocker 1 — Revision, Transaction Identity & Audit Snapshot
| Tình huống | Hành vi Store & Identity |
|---|---|
| **AM–SE critique trước approval** (`r1` chưa có dòng trong `markdown_plan_decisions`) | Giữ nguyên `plan_id` và `revision = 1`. Ghi đè có kiểm soát qua `updateDraftRevision`. |
| **Critique khi `r1` đã có decision** | Từ chối ngay lập tức với mã lỗi `PLAN_DECISION_EXISTS` (fail-closed). |
| **Owner update kế hoạch trong hội thoại** (`updateFromConversation`) | Sinh `plan_id` mới (`PLAN-${projectId}-${randomUUID()}`), `expectedRevision: 0` $\rightarrow$ tạo bản `r1` mới. Bản kế hoạch cũ giữ nguyên 100% không đổi. |

**Thứ tự ghi nguyên tử và Recovery Authority trong `updateDraftRevision`:**
1. Lấy file lock `${statePath()}/nf/plans/${planId}/markdown.lock`.
2. Kiểm tra trong SQLite: `revision === 1` tồn tại và chưa có decision trong `markdown_plan_decisions`.
3. Lưu snapshot lịch sử critique vào `sources.retain({ plan_id: planId, revision: 1, source_sha256: summarySha256 }, summary)` (bảng `markdown_plan_sources` lưu theo `(plan_id, revision, source_sha256)` nên giữ được đầy đủ audit trail của từng lần critique overwrite mà không mất snapshot cũ).
4. Ghi nguyên tử (`fileService.atomicWrite`) file `plan-source-r1.json` và `ke-hoach-r1.md`.
5. Cập nhật dòng `revision = 1` trong `markdown_plan_revisions` (`SET sha256=?, summary_path=?, summary_sha256=?, created_at=?`).
6. **Recovery Authority:** Database row (`markdown_plan_revisions.sha256` & `summary_sha256`) kết hợp với `markdown_plan_sources` là authority; nếu crash giữa bước 4 và 5, `restoreSourceSnapshot` hoặc lần retry critique tiếp theo có thể khôi phục từ `markdown_plan_sources`.
7. **Invariant bắt buộc trước khi vào phase `implementation` / `sl_handoff`:**
   ```text
   handoff.plan_revision === 1
   handoff.plan_sha256 === currentPlan.sha256 === markdownRevision.sha256
   checkpoint.plan_revision === handoff.plan_revision
   checkpoint.plan_sha256 === handoff.plan_sha256
   decision.sha256 === handoff.plan_sha256
   ```

### 2.2. Chốt Blocker 2 — Approval Authority & Idempotent Server-Owned `approval_mode`
- Không truyền cờ `autoApprove` tự do từ client. Chỉ sử dụng chế độ do server kiểm soát:
  - `approval_mode = "explicit_owner_command"`: Khi luồng được kích hoạt trực tiếp từ lệnh chat của Owner có `deliveryTarget` là `"se"` hoặc `"sl"` và có `approvedOwnerId` hợp lệ.
  - `approval_mode = "existing_decision"`: Khi plan đã có decision `approved` khớp `plan_id + revision (1) + sha256`.
  - `approval_mode = "manual_panel_approval"`: Khi Owner bấm `Approve / Run` trên UI kèm `ownerToken` đã qua `planOwnerAuth.verify(headers)`.
- **Tính Idempotent khi gọi `markdownPlanStore.decide`:**
  - Nếu `plan.decision` đã tồn tại với cùng `decision === "approved"`, cùng `sha256` và cùng `approver_id === approvedOwnerId`, `decide()` trả về luôn `plan.decision` hiện có (idempotent, không ném `PLAN_DECISION_EXISTS` khi replay cùng command). Chỉ ném `PLAN_DECISION_EXISTS` nếu khác `sha256`, khác `decision`, hoặc khác `approver_id`.

### 2.3. Chốt Blocker 3 — Bảng State Machine & Safe-Point Recovery
| Phase | Status / Checkpoint | Capabilities bật trên Panel | Hành vi khi kích hoạt |
|---|---|---|---|
| `plan_critique` | `status: "paused"`, `critique_checkpoint.execution_status` $\in \{ \text{"pending"}, \text{"unknown"} \}$ | `critique_can_resume: true` | `resumeCritique` chạy tiếp đúng bước critique (`se` hoặc `am`) đang dở. |
| `plan_critique` | `status: "paused"`, `!checkpoint`, bước cuối `ALIGNED` (khi tạo plan chưa giao việc ngay) | `run: true, resume: false, stop: false, reconcile: false` | Owner bấm `Run` $\rightarrow$ xác thực `ownerToken` $\rightarrow$ `decide("approved")` $\rightarrow$ `checkpoint.initialize` $\rightarrow$ chạy SE. |
| `implementation` | `checkpoint.execution_status === "pending"` (`next_step` $\in \{ \text{"se"}, \text{"rv"}, \text{"am"} \}$) | `run: (round===1 && !current_step && next_step==="se")`, `resume: true`, `stop: false`, `reconcile: false` | Chạy bước `next_step` tiếp theo (bỏ qua mọi predecessor đã có trong `checkpoint.results`). |
| `implementation` | `checkpoint.execution_status === "running"` | `run: false, resume: false, stop: true, reconcile: true` | Cho phép bấm `Stop` (`pauseHandoff`) hoặc `Reconcile` sau khi runner đã dừng. |
| `implementation` | `checkpoint.execution_status` $\in \{ \text{"unknown"}, \text{"reconciliation_required"} \}$ | `run: false, resume: false, stop: false, reconcile: true` | Khóa `Run`/`Resume`; bắt buộc `Reconcile` kiểm tra terminal receipt / workspace trước khi mở lại `pending`. |
| `completed` / `sl_handoff` | `status === "completed"` | Tất cả `false` | Trạng thái kết thúc (terminal), chỉ hiển thị kết quả بعد khi có terminal receipt. |

### 2.4. Chốt Blocker 4 — Critique Consensus & Fail-Closed khi Patch lỗi
1. **Không đánh đồng hết vòng (`max_critique_rounds`) với `ALIGNED`:**
   - Trong `startHandoff` (dòng 314): Nếu `critiqueStatus !== "ALIGNED"` và `critiqueRound >= record.max_critique_rounds`, sau khi AM trả lời và cập nhật `r1` ở vòng cuối, cho SE xác nhận thêm 1 lượt ngắn hoặc nếu kết thúc mà vẫn `critiqueStatus !== "ALIGNED"` thì chuyển handoff sang `status: "paused", reason: "CRITIQUE_CONSENSUS_REQUIRED"` (không tự động auto-approve một kế hoạch đang còn xung đột `DISCUSS`).
2. **Không nuốt lỗi (`void err`) trong `maybeApplyCritiqueRevision`:**
   - Nếu AM không gắn khối ```` ```json ```` (chỉ trả lời bằng lời): giữ nguyên `currentPlan` là hợp lệ.
   - Nhưng nếu AM **có** xuất khối ```` ```json ```` mà JSON không parse được, vi phạm schema `architecture_plan.v1`, hoặc lỗi ghi store: không được nuốt lỗi và chạy tiếp với plan cũ! Phải phân loại lỗi rõ ràng (`PLAN_PATCH_INVALID`, `PLAN_REVISION_CONFLICT`, `PLAN_SOURCE_MISMATCH`) và dừng handoff ở `status: "paused"` kèm `error_code` tương ứng để đảm bảo fail-closed.

### 2.5. Chốt Blocker 5 — Fail-Fast Readiness Check trước khi Auto-Approve
- Trước khi `startHandoff` bắt đầu critique hoặc trước khi auto-approve cho `target === "se"`:
  - Kiểm tra bắt buộc: `checkpoint` phải tồn tại và cả 3 adapter (`turnRequestArchitecture`, `turnRequestSystemEngineer`, `turnRequestReviewer`) phải là `function`.
  - Nếu thiếu `checkpoint` hoặc thiếu bất kỳ adapter nào: ném lỗi ngay lập tức (`HANDOFF_CHECKPOINT_UNAVAILABLE` hoặc `HANDOFF_ADAPTER_UNAVAILABLE`) và giữ nguyên trạng thái, **tuyệt đối không approve plan hay chuyển handoff sang `running` khi thiếu dependency**.
- Trong `control-api-http.mjs` và `owner-chat-command-service.js`: khởi tạo và dùng chung duy nhất 1 `amSeHandoffService` có đủ adapter cho cả chat, HTTP routes và Handoff Panel.

### 2.6. Trả lời tóm tắt 8 câu hỏi làm rõ của SE
1. **Audit snapshot khi overwrite `r1`:** Có, giữ qua `sources.retain({ plan_id, revision: 1, source_sha256 }, summary)` trong bảng `markdown_plan_sources`.
2. **Recovery authority khi crash giữa chừng:** SQLite (`markdown_plan_revisions` + `markdown_plan_sources`) là authority; file `.md` / `.json` được đối chiếu bằng `sha256`.
3. **Owner update sau khi plan đã approved:** Luôn tạo `plan_id` mới ở `r1`; plan cũ không bao giờ bị sửa.
4. **Khác biệt giữa Critique Patch và Owner Update:** Critique Patch do AM sinh trong `startHandoff`/`resumeCritique` trước approval $\rightarrow$ overwrite `r1` của cùng `plan_id`. Owner Update do Owner gọi qua hội thoại (`updateFromConversation`) $\rightarrow$ tạo `plan_id` mới ở `r1`.
5. **Target SL vs Target SE:** Cùng dùng `approval_mode: "explicit_owner_command"` để approve `r1` sau khi `ALIGNED`; khác nhau ở bước thực thi sau approval (`SL` gọi `turnApprovePlan` tạo Sprint, `SE` chạy vòng lặp `checkpoint` `SE → RV → AM`).
6. **Multi-idea batch:** Chạy tuần tự từng plan; kết quả từng plan độc lập trong mảng `plans[]`, nếu 1 plan dừng ở `paused` thì các plan đã `completed` giữ nguyên trạng thái của mình và báo cáo rõ từng plan trong `text`.
7. **Hiển thị `completed` trên UI:** Chỉ hiển thị `completed` sau khi bước cuối (`AM` `[VERDICT: PASS]` hoặc `SL` sprint creation) đã ghi nhận terminal receipt vào durable store.
8. **Sau khi server restart:** `listHandoffs` tính `capabilities` từ durable store/checkpoint; nếu một bước đang `running` lúc crash thì khi gọi `reconcileHandoff` sẽ kiểm tra runner stop evidence + terminal receipt của `executionCheckpoint` để recover hoặc đưa về `pending` / `reconciliation_required`.

---

## 3. Danh sách File Cần Sửa và Bộ Test Bắt Buộc

1. **Files cần sửa:**
   - `backend/src/modules/governance/conversation-plan-source.js` (hỗ trợ `overwriteUnapproved: true` trong `retainConversationPlanSource`).
   - `backend/src/modules/governance/markdown-plan-store.js` (thêm `updateDraftRevision` cho `r1` chưa có decision; idempotent `decide` khi cùng `decision + sha256 + approver_id`).
   - `backend/src/application/conversation-planning-service.js` (`updateFromConversation` tạo `plan_id` mới ở `r1` thay vì tăng revision).
   - `backend/src/application/am-se-handoff-service.js` (`maybeApplyCritiqueRevision` cập nhật in-place `r1` fail-closed; `startHandoff` kiểm tra readiness, chỉ auto-approve khi `ALIGNED`, và chạy chu trình `SE → RV → AM` qua durable checkpoint; cập nhật `listHandoffs` `capabilities`).
   - `backend/scripts/control-api-http.mjs` & `backend/src/application/owner-chat-command-service.js` (dùng chung `amSeHandoffService` đủ adapter).
2. **Verification bắt buộc:**
   - Chạy pass toàn bộ các bài test hiện có và bổ sung các test case trong Mục `Verification bổ sung bắt buộc` của `docs/architecture/plan-r1-auto-handoff-spec-feedback.md` (`conversation-plan-handoff.test.js`, `conversation-plan-update.test.js`, `markdown-plan-approval.test.js`, `am-se-handoff-service-resume.test.js`, `am-se-handoff-run-route.test.js`).
