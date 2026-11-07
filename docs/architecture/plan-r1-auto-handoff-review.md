# AM Review: Báo cáo triển khai Plan `r1` & Auto-Handoff (`plan-r1-auto-handoff-se-report.md`)

- **Ngày review:** 2026-11-07
- **Người review:** Architecture Manager (AM)
- **Tài liệu đặc tả gốc:** `docs/architecture/plan-r1-auto-handoff-spec.md` (`sha256:826288005fb601d360f25e92cb5427fbb4c3d31ad29e4b67c9fd21f3f2340d97`)
- **Báo cáo SE được kiểm tra:** `docs/architecture/plan-r1-auto-handoff-se-report.md` (`sha256:fbb3d5f0e5c5742df396b478fb5ddac905ca356f73643dc2b3ceb9837cac7745`)
- **Kết luận Vòng 1:** **`REVISE`** (Đã đạt 5/7 hạng mục cốt lõi; còn 2 hạng mục cần hoàn thiện nốt để luồng tự động `SE → RV → AM` chạy liền mạch đến `completed` và đồng bộ test suite).

---

## 1. Bảng đối chiếu bằng chứng mã nguồn (Evidence Verification)

| # | Hạng mục đặc tả | File & SHA-256 kiểm tra thực tế | Đánh giá chi tiết | Kết quả |
|---|---|---|---|---|
| **1** | Không tạo `r2` khi SE phản biện (`plan_critique`), cập nhật trực tiếp vào `r1` kèm audit snapshot | - `backend/src/application/am-se-handoff-service.js` (`sha256:45b906cd54c4620d109fe9c7e465326a41b84e7917b6fdd3f5d8e7e6bfd15a29`)<br>- `backend/src/modules/governance/markdown-plan-store.js` (`sha256:555f52af7491698fa2c25c00b8770c42284f38cad3fbad66767b136e688c0477`)<br>- `backend/src/modules/governance/conversation-plan-source.js` (`sha256:d6ee42c2f5a4001087b1a484ce7485d2a5a663eb1fb740427e2982e1f4ef13b1`)<br>- `backend/src/modules/governance/markdown-plan-source.js` (`sha256:6f4524b69a3dca7c147d30e403a366a158213629d919e34d5ccb83571abbde3e`) | - `maybeApplyCritiqueRevision` (dòng 142–163) gọi `markdownPlanStore.updateDraftRevision({ planId, expectedRevision: 1, expectedSha256, ... })`.<br>- `updateDraftRevision` (dòng 51–70) giữ lock file, chặn nếu `r1` đã có decision (`PLAN_DECISION_EXISTS`) hoặc `revision !== 1`, lưu audit snapshot vào `markdown_plan_sources` và ghi đè nguyên tử `plan-source-r1.json` + `ke-hoach-r1.md`. | **ĐẠT (`PASS`)** |
| **2** | Mọi thay đổi/cập nhật kế hoạch về sau đều tạo `Plan ID` mới ở `r1`, giữ plan cũ bất biến | `backend/src/application/conversation-planning-service.js` (`sha256:6b75610425d6210106f1fae0ea9885c1a9beb81922e11be70fc84352e3ba2f15`) | Trong `updateFromConversation` (dòng 245–259): tạo `planId = \`PLAN-${projectId}-${randomUUID()}\``, `revision = 1`, `expectedRevision: 0`; không tạo `r2`. | **ĐẠT (`PASS`)** |
| **3** | Không đánh đồng hết vòng phản biện với `ALIGNED` & Không nuốt lỗi JSON Patch | `backend/src/application/am-se-handoff-service.js` (`sha256:45b906cd...`, dòng 142–163, 328–340) | - Dòng 328–332: nếu hết `max_critique_rounds` mà chưa `ALIGNED`, dừng ở `status: "paused", reason: "CRITIQUE_CONSENSUS_REQUIRED"`.<br>- Dòng 148–162 & 340: khi khối JSON patch lỗi syntax/schema hoặc conflict, ném `PLAN_PATCH_INVALID` / `PLAN_DECISION_EXISTS` và dừng ở `status: "paused"` kèm `error_code`. | **ĐẠT (`PASS`)** |
| **4** | Idempotent `decide` và tự động Approve khi có lệnh *"tạo kế hoạch xxx, giao việc cho SE / SL"* | - `backend/src/modules/governance/markdown-plan-store.js` (dòng 139–141)<br>- `backend/src/application/am-se-handoff-service.js` (dòng 268, 279, 355) | - `decide()` trả về decision hiện hữu nếu trùng `(plan_id, revision, sha256, decision, approver_id)`.<br>- Khi `explicitOwnerCommand` (`deliveryTarget` là `"se"` hoặc `"sl"`), sau khi `ALIGNED` tự động gọi `markdownPlanStore.decide({ ..., decision: "approved" })`, không dừng ở `PLAN_APPROVAL_REQUIRED`. | **ĐẠT (`PASS`)** |
| **5** | Fail-fast Readiness Check trước khi auto-approve và chạy handoff | `backend/src/application/am-se-handoff-service.js` (dòng 270–271) | Kiểm tra đủ `checkpoint` và cả 3 adapter (`turnRequestArchitecture`, `turnRequestSystemEngineer`, `turnRequestReviewer`) ngay từ đầu trước khi approve hoặc chạy. | **ĐẠT (`PASS`)** |
| **6** | Khi giao việc cho SE từ chat: Tự động chạy hết chu trình `SE → RV → AM` (có ghi durable checkpoint từng bước) và bắn tin nhắn tiến độ ra khung chat | `backend/src/application/am-se-handoff-service.js` (dòng 212–233, 378–383) | **CHƯA ĐẠT:** `startHandoff` (dòng 381) gọi `resumeHandoff` 1 lần duy nhất nên chỉ chạy xong bước `se`, sau đó dừng ở `next_step = "rv", execution_status = "pending"` thay vì chạy tiếp `rv` và `am` cho đến khi `completed` (`[VERDICT: PASS]`). Ngoài ra chưa gọi `publishDualConversationMessage` trong `resumeHandoff`. | **CẦN SỬA (`REVISE`)** |
| **7** | Đồng bộ bộ test `conversation-plan-handoff.test.js` với quy tắc `r1` và auto-handoff mới | `backend/tests/unit/conversation-plan-handoff.test.js` (`sha256:fabfa84d77a84c263f15ae738f7bfc6916f4bf4966f884331a6ce5463682a517`) | **CHƯA ĐẠT:** Một số test cũ trong `conversation-plan-handoff.test.js` vẫn đang assert hành vi cũ (`revision: 2` hoặc thiếu mock `gitService`/`requestReviewer`), dẫn đến fail khi chạy toàn bộ file test đó. | **CẦN SỬA (`REVISE`)** |

---

## 2. Chi tiết 2 hạng mục SE cần sửa nốt

### 2.1. Hạng mục 1: Tự động chạy trọn vẹn chu trình `SE → RV → AM` khi thực thi handoff SE và hiển thị tin nhắn hội thoại (`backend/src/application/am-se-handoff-service.js`)

#### Hiện trạng trong code (dòng 212–233 và 378–383):
1. Tại dòng 379–382 của `startHandoff`:
   ```js
   if (checkpoint) {
     record = await checkpoint.initialize(record.handoff_id, approvedOwnerId);
     return resumeHandoff({ handoffId: record.handoff_id, approvedOwnerId, requestArchitecture: turnRequestArchitecture, requestSystemEngineer: turnRequestSystemEngineer, requestReviewer: turnRequestReviewer });
   }
   ```
   Và tại dòng 228 của `resumeHandoff`:
   - Mỗi lần gọi `checkpoint.resume(...)` chỉ thực thi **1 bước đơn lẻ** (`se` HOẶC `rv` HOẶC `am`), rồi cập nhật `checkpoint.next_step` sang bước tiếp theo (`"rv"` hoặc `"am"`) với `execution_status: "pending"` và kết thúc hàm.
   - Hệ quả: Khi Owner ra lệnh *"tạo kế hoạch xxx, giao việc cho SE"*, hệ thống chạy xong bước `se` rồi đứng im ở `next_step: "rv"` chờ người dùng bấm Resume, thay vì tự động chạy tiếp `rv` (Reviewer) $\rightarrow$ `am` (Architecture Manager nghiệm thu `PASS`/`REVISE`) như đặc tả Mục 4.2 của `docs/architecture/plan-r1-auto-handoff-spec.md`.
2. Bên trong `invoke` của `resumeHandoff` (dòng 212–227):
   - Khi `se`, `rv`, `am` trả kết quả ở luồng `checkpoint.resume(...)`, hàm chưa gọi `publishDualConversationMessage(...)` như nhánh không-checkpoint ở dòng 391–446.

#### Yêu cầu sửa trong `backend/src/application/am-se-handoff-service.js`:
1. **Trong `resumeHandoff` (dòng 167–234):**
   - Trong mỗi nhánh `step === "se"`, `step === "rv"`, `step === "am"` của callback `invoke`, sau khi nhận response từ adapter, gọi `await publishDualConversationMessage(...)` để ghi lại báo cáo của SE, nhận xét của RV và kết luận của AM vào hội thoại (giống định dạng ở dòng 391, 412, 435).
   - Cho phép `resumeHandoff` chạy vòng lặp qua các bước `pending` kế tiếp (`se` $\rightarrow$ `rv` $\rightarrow$ `am`, và nếu `am` trả về `REVISE` thì tiếp tục vòng tiếp theo trong giới hạn `max_review_rounds`) cho đến khi:
     - `record.status === "completed"` (`[VERDICT: PASS]`), hoặc
     - `record.status !== "running"` (ví dụ `paused`, `stopped`, `failed`), hoặc
     - `record.checkpoint?.execution_status !== "pending"` / không còn `next_step`.
   - **Lưu ý quan trọng:** Việc lặp qua `checkpoint.resume(...)` theo từng bước vẫn bảo toàn 100% tính chất **durable checkpoint ở từng role step**: trước và sau mỗi bước (`se`, `rv`, `am`), `checkpoint.resume` đều ghi intent/result xuống đĩa và kiểm tra stop signal. Nếu bất kỳ bước nào ném lỗi hoặc bị Stop/Crash, vòng lặp dừng ngay tại safe point của bước đó!

```js
    let current = record;
    while (
      current.status === "running" &&
      current.checkpoint?.execution_status === "pending" &&
      current.checkpoint?.next_step
    ) {
      current = await checkpoint.resume(handoffId, approvedOwnerId, invoke);
    }
    return toHandoffSummary(current);
```
*(Kiểm tra kỹ điều kiện dừng với các unit test trong `backend/tests/unit/am-se-handoff-checkpoint.test.js` và `backend/tests/unit/am-se-handoff-service-resume.test.js`: nếu có unit test nào muốn chỉ chạy 1 step mỗi lần gọi `checkpoint.resume` trực tiếp, thì `checkpoint.resume` giữ nguyên 1 step, còn `amSeHandoffService.resumeHandoff` / `startHandoff` lặp cho đến khi hết các bước `pending` hoặc dừng theo tùy chọn).*

---

### 2.2. Hạng mục 2: Cập nhật `backend/tests/unit/conversation-plan-handoff.test.js` khớp với quy tắc `r1` mới

#### Hiện trạng:
Trong báo cáo SE đã nêu rõ:
- `conversation-plan-handoff.test.js` vẫn còn các test case cũ mong đợi `revision: 2` khi SE phản biện `DISCUSS` hoặc khi gọi `updateFromConversation`, và một số fixture trong file test đó chưa truyền `gitService` / `requestReviewer` vào `createAmSeHandoffService`.

#### Yêu cầu sửa:
- Cập nhật các test case trong `backend/tests/unit/conversation-plan-handoff.test.js` để:
  1. Khi SE phản biện `DISCUSS` và AM cập nhật JSON patch: kiểm tra `revision` giữ nguyên là `1` (`r1`), `sha256` được cập nhật mới, và bảng audit snapshot có lưu lịch sử.
  2. Khi gọi `updateFromConversation`: kiểm tra tạo ra `plan_id` mới với `revision: 1`, còn plan cũ giữ nguyên bất biến.
  3. Bổ sung đủ mock `gitService` / `requestReviewer` cho các fixture gọi `startHandoff` trong `conversation-plan-handoff.test.js` để toàn bộ file test chạy pass 100%.

---

## 3. Tiêu chí nghiệm thu (Verification Criteria)

SE hoàn thành 2 hạng mục trên và chạy `run_check` pass toàn bộ các bài test sau:
1. `backend/tests/unit/am-se-handoff-service-resume.test.js`
2. `backend/tests/unit/am-se-handoff-checkpoint.test.js`
3. `backend/tests/unit/conversation-plan-handoff.test.js`

Sau đó cập nhật kết quả vào `docs/architecture/plan-r1-auto-handoff-se-report.md` để AM chốt **`PASS`**.
