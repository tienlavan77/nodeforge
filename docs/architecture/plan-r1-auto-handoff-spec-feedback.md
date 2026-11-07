# SE phản biện: Đặc tả `plan-r1` và auto handoff

Date: 2026-11-07
Recipient: Project Owner / Architecture Manager
Reviewed document: `docs/architecture/plan-r1-auto-handoff-spec.md`
Reviewed document SHA-256: `sha256:918179fa908b3731b8709ff01bc406cff4f68f745413c6d86c9a332a035d8d02`

## Kết luận

**REVISE trước khi triển khai.**

Đặc tả có quyết định nghiệp vụ rõ ràng, phân biệt được critique in-place với owner update, và liệt kê khá cụ thể các file/symbol cần sửa. Tuy nhiên, kế hoạch hiện chưa đủ chặt để triển khai an toàn. Các invariant về revision identity, approval authority, checkpoint state và recovery cần được chốt trước khi SE bắt đầu code.

## Bằng chứng từ source hiện tại

- `backend/src/application/am-se-handoff-service.js` — `maybeApplyCritiqueRevision` hiện tăng `currentPlan.revision + 1`, ghi anchor revision mới và gọi `markdownPlanStore.createRevision`; critique vì vậy vẫn tạo `r2`.
- `backend/src/application/conversation-planning-service.js` — `updateFromConversation` hiện dùng `target.revision + 1`, giữ nguyên `plan_id` và tạo revision tiếp theo; chưa thực hiện quyết định “owner update tạo Plan ID mới, r1”.
- `backend/src/modules/governance/markdown-plan-store.js` — store hiện chỉ expose `createRevision`/`getRevision`/`decide`/`assertApproved`; chưa có `updateDraftRevision` cho overwrite r1 chưa approved.
- `backend/src/modules/governance/conversation-plan-source.js` — `retainConversationPlanSource` dùng `atomicCreate`, không hỗ trợ overwrite có kiểm soát.
- `backend/src/application/am-se-handoff-service.js` — `startHandoff` chỉ gọi `assertApproved`; nếu chưa có decision thì trả `PLAN_APPROVAL_REQUIRED`. Nhánh SE còn phụ thuộc `checkpoint`; thiếu checkpoint trả `HANDOFF_CHECKPOINT_UNAVAILABLE`.
- `backend/src/application/am-se-handoff-service.js` — `resumeHandoff` chưa có `autoApprove`; approval và owner identity được kiểm tra trước khi chạy checkpoint.
- `backend/src/application/am-se-handoff-service.js` — `listHandoffs` hiện không bật `run` cho checkpoint đã tồn tại ở `round=1`, `next_step=se`; `resume` cũng không bao phủ `critique_can_resume`.
- `backend/src/application/owner-chat-command-service.js` — `applyAutoHandoffIfRequested` mặc định `approvedOwnerId` thành `project-owner`, nhưng chưa tự gọi `markdownPlanStore.decide` trước `startHandoff`.

## Blocker 1 — Revision và transaction identity

Spec cần tách rõ hai luồng:

| Tình huống | Identity/store operation đúng |
|---|---|
| AM–SE critique trước approval | Cùng `plan_id`, overwrite `r1` chưa có decision |
| Owner update sau đó | `plan_id` mới, revision `1`, plan cũ immutable |
| Critique sau khi đã approved | Từ chối với `PLAN_DECISION_EXISTS` |

`updateDraftRevision` cần:

- lock theo plan;
- kiểm tra revision hiện tại đúng `1`;
- kiểm tra chưa có decision;
- ghi source JSON, Markdown và digest theo thứ tự có recovery rõ ràng;
- cập nhật `markdown_plan_revisions` nguyên tử;
- không để trạng thái file và database lệch mà không có durable error/reconciliation state;
- lưu audit/source snapshot của các lần critique overwrite nếu cần forensic.

Cần thêm invariant:

```text
handoff.plan_revision == currentPlan.revision
handoff.plan_sha256 == currentPlan.sha256
checkpoint.plan identity == handoff.plan identity
markdown decision identity == same plan identity
```

Mọi thay đổi plan identity phải hoàn tất trước khi bước implementation bắt đầu.

## Blocker 2 — Approval authority và auto-approve

Lệnh “giao việc cho SE/SL” chỉ được coi là approval khi có:

```text
authenticated owner identity
+ explicit delivery target
+ exact plan identity
+ command correlation/idempotency key
```

Không nên coi fallback string `project-owner` là bằng chứng authentication. Cần phân biệt:

- approval của plan;
- authorization tạo Sprint/Tickets;
- authorization chạy SE có mutation;
- authorization chạy RV;
- authorization acceptance cuối của AM.

`autoApprove` không nên là quyền độc lập do client truyền lên. Nên dùng server-owned mode, ví dụ:

```text
approval_mode:
  explicit_owner_command
  existing_decision
  manual_panel_approval
```

Replay cùng command phải idempotent: không tạo decision thứ hai và không chạy handoff hai lần.

## Blocker 3 — State machine và safe-point recovery

Nên chốt bảng transition trước khi sửa code:

| Phase | Status/checkpoint | Actions |
|---|---|---|
| `plan_critique` | `paused`, chưa checkpoint, đã `ALIGNED` | `run` |
| `implementation` | `pending`, `next_step=se` | `resume` hoặc `run` theo authorization |
| `implementation` | `running` | `stop` |
| `implementation` | `unknown`/`reconciliation_required` | chỉ `reconcile` |
| `completed` | terminal | không action |

Mỗi action phải định nghĩa rõ:

- precondition;
- exact owner/plan revision/checksum;
- idempotency behavior;
- allowed transition;
- failure state.

`Resume` phải dùng durable terminal receipt để bỏ qua predecessor đã completed. Không retry mù execution có trạng thái `unknown`. Nếu `stop` xảy ra trong mutation, phải chuyển `reconciliation_required`, không tự động resume.

## Blocker 4 — Critique consensus và lỗi fail-closed

Trong code hiện tại, khi hết `max_critique_rounds`, `startHandoff` vẫn có thể hoàn tất critique dù status cuối là `DISCUSS`. Điều này không tương đương consensus.

Khuyến nghị:

- Nếu hết số vòng mà chưa `ALIGNED`, chuyển `REVISE_REQUIRED`/`paused`.
- Chỉ auto-approve khi có `ALIGNED` hoặc explicit owner override được xác thực.

Ngoài ra, `maybeApplyCritiqueRevision` hiện nuốt mọi lỗi và quay về plan cũ. Không nên `void err`. Cần phân loại:

- invalid patch → `PLAN_PATCH_INVALID`;
- revision conflict → `PLAN_REVISION_CONFLICT`;
- source mismatch → `PLAN_SOURCE_MISMATCH`;
- persistence failure → paused với error code durable.

Không được tiếp tục auto handoff như thể critique patch đã thành công nếu persistence thất bại.

## Blocker 5 — Checkpoint và adapter wiring

Spec phải quyết định checkpoint là dependency bắt buộc hay optional. Với auto SE execution, nên fail-fast trước khi approve nếu thiếu checkpoint/adapter; không approve plan rồi mới trả `HANDOFF_CHECKPOINT_UNAVAILABLE`.

Cần integration composition test chứng minh cùng một project-scoped service nhận đủ:

```text
owner command
 -> amSeHandoffService
 -> markdownPlanStore
 -> checkpoint
 -> requestArchitecture
 -> requestSystemEngineer
 -> requestReviewer
```

Cần cả happy path và fail-fast path khi thiếu một adapter. Nếu adapter thiếu, record không được chuyển sang `running`.

## Các điểm cần làm rõ thêm

1. Critique overwrite r1 có lưu audit history/source snapshot không?
2. Nếu source write thành công nhưng Markdown/database write thất bại, recovery authority là file hay database?
3. Owner update sau khi plan đã approved có luôn tạo plan mới không? Cần cấm mọi mutate plan cũ.
4. Trigger critique patch và trigger owner update có grammar/actor semantics khác nhau thế nào?
5. Target SL và target SE có cần approval modes/side-effect permissions khác nhau không?
6. Khi multi-idea batch có một handoff thành công và một handoff thất bại, status tổng và retry semantics là gì?
7. UI có được hiển thị “completed” trước terminal receipt hay chỉ sau khi backend xác nhận?
8. Sau restart, capabilities được tính từ checkpoint nào và xử lý orphan runner ra sao?

## Verification bổ sung bắt buộc

Ngoài bốn nhóm test trong spec, cần thêm:

### Revision/integrity

- DISCUSS → patch hợp lệ: cùng `plan_id/r1`, SHA đổi.
- Patch invalid: không có file/database mutation.
- Critique sau decision: `PLAN_DECISION_EXISTS`.
- Owner update: plan ID mới/r1; plan cũ immutable.
- Concurrent update: một thắng, một `PLAN_REVISION_CONFLICT`.
- Crash giữa source write và Markdown/database update: recovery state rõ ràng.

### Approval/authorization

- Owner command hợp lệ → decision `approved` với approver ID thật.
- Thiếu owner authorization → paused, không approve.
- Replay command → idempotent.
- Target SL không được dùng SHA cũ.
- Adapter thiếu → không chuyển record sang `running`.

### Recovery/UI/API

- SE completed/RV pending → Resume chỉ gọi RV rồi AM.
- RV completed/AM pending → Resume chỉ gọi AM.
- Unknown execution → không retry mù.
- Stop trong mutation → reconcile bắt buộc.
- Restart → capabilities vẫn đúng.
- Plan identity mismatch giữa handoff/checkpoint/Markdown → fail closed.
- HTTP/SSE/chat không báo completed trước terminal receipt.

## Khuyến nghị thứ tự triển khai

1. Chốt state machine và approval authority.
2. Chốt transaction/identity model cho `plan_id`, `revision`, `sha256`.
3. Implement `updateDraftRevision` và owner-update new-plan path.
4. Implement server-side auto-approve với authenticated owner decision.
5. Làm checkpoint bắt buộc cho auto SE execution và idempotent recovery.
6. Đồng bộ adapter composition cho chat/HTTP/panel/restart.
7. Cập nhật UI capabilities.
8. Chạy integration/e2e tests rồi mới tuyên bố sẵn sàng.

## Quyết định phản biện

**REVISE — chưa nên triển khai theo spec nguyên văn.**

Phản biện này là design feedback, không thay đổi source code và không tuyên bố rằng fixture test hiện tại chứng minh production readiness.
