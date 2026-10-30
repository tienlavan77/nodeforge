<!-- Báo cáo đối chiếu source và bằng chứng kiểm thử cho kế hoạch tách API chat theo role và dọn checkpoint. -->
# Kiểm chứng role-scoped chat và checkpoint cleanup — NO-GO

**Ngày:** 2026-10-07. **Plan:** `workflows/plan-role-scoped-chat-checkpoint-cleanup.md`, SHA-256 `9f2f908f8cfadaeaaf13d3efc75272c751342e2e30ad1a68036a6f5439a34d41`. Plan vẫn là đề xuất, chưa có human approval; báo cáo này không phải approval, RUN/dispatch, hay nghiệm thu pause/resume.

**Phạm vi audit:** đọc source và test hiện tại; kiểm tra Git working tree sạch. Evidence test gần nhất được ghi nhận: `VERIFY-RUN-c60d80ab-c50f-4cfd-a0bb-52b4e4cd4ca5`, lệnh `node --test ui/nextjs/tests/architecture-execution.test.js ui/nextjs/tests/conversations-navigation.test.js backend/tests/unit/architecture-execution.test.js`, exit code `0`. Chưa chạy browser, HTTP listener thật, network capture, process crash, hai process đồng thời, hoặc remote Git trong báo cáo này.

| Outcome | Evidence source/test hiện có | Khoảng trống / kết luận |
| --- | --- | --- |
| O1 — không tải sprint/plan dư | Architecture và System gọi `getAgents` với role cụ thể; chat pages không còn render `PendingPlanApproval`; `ConversationProjectGit` giữ NodeForge/Git/Commit & push mà không gọi plan/sprint. Static test kiểm tra không có `listPlans`/`listSprints` trong hai page. | Đạt ở mức source/static. Chưa có browser network capture để chứng minh reload, stream và tương tác không phát request. Việc gỡ approval UI Architecture là thay đổi nghiệp vụ cần human xác nhận trước khi gọi là đạt O1 hoàn toàn. |
| O2 — role và execution đúng scope | Router lọc agent `role`; server chọn checkpoint store theo role cấu hình, đối chiếu conversation, source message và agent; list chỉ trả record được locate. Unit test phủ record agent chéo và project chéo. | **NO-GO:** execution route vẫn không gọi `planOwnerAuth.verify(headers)`; Architecture reconciliation gắn actor `unauthenticated-architecture-control`. Chưa có HTTP negative test cho thiếu/sai token, conversation/agent đoán được, hay identity owner. |
| O3 — dọn checkpoint terminal | List UI không trả terminal record; Discard chặn mutation uncertain và Architecture runner chưa dừng. Unit test phủ hai điều kiện chặn này. | **Không đạt:** checkpoint vẫn được ghi trạng thái `completed`, `discarded`, `restarted`; không có delete runtime record, không có audit terminal độc lập được chứng minh, và không có test restart sau cleanup. Không được xem việc ẩn khỏi list là cleanup an toàn. |
| O4 — race/crash không mất recovery | Checkpoint dùng lock theo conversation/attempt, lease và reconcile; mutation uncertain bị fail-closed. | **Không đạt:** chưa có test hai process, lease hết giữa write, crash trước/sau terminal persist/cleanup, hay runner cũ sống. Không có cleanup idempotent để test. |
| O5 — projection tối thiểu, không polling | `owner-execution-control.summary()` chỉ trả ID/status/capability flags; không trả receipt, pending tool, provider thread hoặc checkpoint content. Controls chỉ GET khi mount/conversation đổi, không GET từ focus, typing hay timer; có Check status thủ công. Static UI test phủ các dấu hiệu này. | Đạt một phần. Chưa có browser/network proof về “tối đa một GET”, và Check status vẫn là GET chủ động như contract cho phép. Không có SSE execution-state event để tự cập nhật sau POST; UI hiện cập nhật optimistic. |
| O6 — Continue một POST, Node tự resume | Client gửi action POST theo conversation/execution ID; control tự load, validate, reconcile rồi tạo replay payload. Unit test chứng minh Continue dùng provider thread và không chèn lại prompt gốc; thiếu provider session trả 409. | **NO-GO:** `decide()` gọi `ownerChatService.replay(...)` fire-and-forget trước khi claim/resume hoàn tất; chưa có idempotency receipt hay test double-click/retry/two process. UI vẫn GET khi mount, nên capture network mới xác minh được không có GET phụ trợ quanh Continue. |

## Nhận định an toàn

- File runtime checkpoint vẫn là nguồn audit duy nhất cho terminal state; do đó xóa record ở thời điểm này sẽ có nguy cơ xóa evidence cần cho recovery/audit.
- Discard đã chặn mutation pending/active và Architecture runner chưa có stop evidence, nhưng chưa dọn record sau Discard.
- UI hiện dùng correlation ID từ owner message để Pause khi chưa có record GET; đây là nguồn định danh cục bộ, chưa có HTTP/browser evidence nó luôn đồng bộ với server receipt.
- Git working tree được quan sát là sạch trước khi tạo báo cáo này; điều đó không chứng minh remote branch hay production state.

## Gate tiếp theo

1. Chốt bằng văn bản retention/audit độc lập cho terminal execution, rồi mới thiết kế delete có lock và test crash trước/sau cleanup.
2. Bắt buộc owner authentication trên GET/POST execution routes theo policy role; thêm HTTP negative matrix cho token/project/conversation/agent/execution.
3. Làm claim trước replay và bổ sung idempotency cho Continue/Restart; test double-click, HTTP retry và hai process.
4. Chạy browser/network capture cho O1/O5/O6, cùng crash/race integration cho O3/O4; gắn run ID, exit code và artifact vào ma trận.

**Trạng thái:** **NO-GO**. Không có outcome nào trong O2–O4 hoặc O6 đủ evidence để production acceptance. Không commit/push trong lượt báo cáo này.
