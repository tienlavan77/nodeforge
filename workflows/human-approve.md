# Kế hoạch chi tiết: Human Approve → Node → Sprint Leader → Persisted Sprint/Ticket Snapshot

**Plan ID:** `NF-HUMAN-APPROVE-SL-SP-001`
**Revision:** `2`
**Trạng thái artifact R2:** `approved`
**Phạm vi:** project-scoped. R2 là baseline kỹ thuật đã được owner duyệt; không được dùng nội dung này để nới gate hoặc tự xác nhận production acceptance.

**Approval R2 (authoritative):** immutable artifact SHA-256 `6365e2348eed378a4dcd217a4a277be970aa95072013fd562a479ceabc51cdc4`, decision ID `PLAN-DECISION-NF-HUMAN-APPROVE-SL-SP-001-R2`. Nguồn R2 đã được source-bind có SHA-256 `265be907b9d2c0214f369e1240610b2afa2afdd6a5a0972a213936fd4a474c8f`. Approval R2 chỉ cấp quyền theo artifact immutable và exact project scope; checksum của working copy tài liệu sau khi ghi nhận trạng thái không thay thế artifact SHA.

**Lịch sử approval R1 (không áp dụng cho R2):** `Approve plan_id=NF-HUMAN-APPROVE-SL-SP-001 revision=1 sha256=8e4aadf9e662734e11ddaed06480d095a0f0d5ef61e0a46c54f8541a15458b8e` bởi `Project Owner`. R1 vẫn là artifact đã duyệt nhưng đã superseded; không được tái sử dụng approval đó cho R2.

## 1. Mục tiêu và kết quả cần đạt

Khi Architecture Manager lập kế hoạch, kế hoạch xuất hiện trực tiếp trong chat/review UI cùng nút **Approve**. Owner chỉ cần review và approve đúng bản kế hoạch. Node xác thực approval, chuyển kế hoạch cho Sprint Leader (SL), nhận Sprint Plan/ticket decomposition, lưu bền vững vào database qua service chính thức, rồi UI tải snapshot authoritative để sprint mới hiển thị đầy đủ ticket và persisted status.

## 2. Quy tắc governance bắt buộc

- Plan immutable theo `plan_id + revision + sha256`; sửa nội dung tạo revision mới.
- Approval phải gắn exact plan identity, actor/project scope, decision, timestamp và comment tùy chọn.
- `approved` là điều kiện để dispatch SL; thiếu approval, sai hash/revision, sai project hoặc stale revision phải fail closed.
- Không coi câu “đồng ý” chung chung là approval của revision khác; UI/API phải gọi decision contract chính thức.
- Node là orchestrator; SL chỉ phân tích/decompose, không tự thay đổi source hay tự quyết định scope ngoài plan.
- Registry giữ sprint lifecycle/binding; ticket store giữ ticket; `ticket_status_store` giữ execution status; roadmap không trở thành authority thứ hai.

## 3. Hiện trạng repository làm căn cứ

- Governance/plan: `backend/src/modules/governance/human-plan-store.js`, `plan-owner-auth.js`, `architecture-manager.js`, `backend/src/application/human-decision-service.js`.
- SL: `backend/src/application/sprint-leader-intake-service.js`, `backend/src/modules/governance/sprint-leader-adapter.js`, `sprint-leader-planner.js`, `backend/src/workflows/sprint-leader-loop.js`.
- Persisted domain: `sprint-registry.js`, `sprint-plan-upload-service.js`, `ticket-crud-service.js`, `ticket-status-store.js`.
- HTTP/UI: `forge-v1-plan-routes.js`, router, `ui/nextjs/components/plan-review-modal.jsx`, `sprint-plan-panels.jsx`, `home-page-dashboard.js`, project stream client.
- Existing `workflows/human-plan.md` là policy nền; plan này không thay authority hoặc nới approval gate.

### Baseline bắt buộc trước khi Coder nhận việc

`workflows/report-human-plan.md` (2026-10-02) ghi nhận implementation gate, automated verification, HTTP contract migration và human-approval security gate đã **PASS**. Vì vậy các hạng mục approval/UI/SL/persistence/snapshot trong mục 5 là **đối chiếu nghiệm thu và hardening có điều kiện**, không phải yêu cầu viết lại từ đầu. Coder phải đọc report và source hiện tại, chỉ tạo ticket sửa phần còn thiếu; không duplicate route/store/UI đã tồn tại và không tự đổi verdict production.

Báo cáo xác nhận các boundary đã có: revision JSON bất biến tại `.forge/runtime/nf/plans/<plan_id>/<revision>.json`; quyết định owner append-only; source-bound revision bắt buộc `source_path` + `source_sha256`; registry route chính thức là `/forge/v1/sprints/registry` (legacy `/forge/v1/sprint-registry` trả `410 ROUTE_RETIRED`); token owner chỉ nằm trong state modal và Control API fail-closed nếu thiếu server credential. Coder không được thay đổi, alias/redirect route legacy, hoặc hạ các gate này nếu không có revision kiến trúc được duyệt.

Các blocker còn lại là vận hành: restart Control API từ commit hiện tại, chạy lại canary với SL gateway hoạt động, owner approve exact artifact canary, RUN đúng ticket sau khi registry `ready`, lưu terminal receipt/evidence và disposition từng sprint lịch sử trước khi mở chúng. Canary audit hiện có `PLAN-SPRINT-HUMAN-PLAN-CANARY-20261002` revision `1`, SHA-256 `cd2272a396ed8a5148c66eb89804bfe45abd16a7baa66515f7368c203bad9548`, đang `awaiting_human_approval`; artifact này chưa approved và chưa RUN. Attempt trước kết thúc `agent.failed` do tracker cũ đòi Architecture Decision cho roadmap canary; code hiện phải ghi `provenance_pending` để giữ draft thay vì làm mất draft trong tình huống này, và Sprint Leader profile đã trở lại Anthropic. Provider `429`, thiếu credential/evidence, hoặc terminal event failed phải giữ trạng thái `BLOCKED/NOT ACCEPTED FOR PRODUCTION`, không được ghi nhận là pass.

## 4. Luồng đích end-to-end

1. AM tạo draft, lưu immutable artifact/index với `awaiting_human_approval`, trả `plan_id`, revision, SHA-256 và nội dung reviewable.
2. Chat/review panel render nội dung, identity, acceptance criteria, affected scope và nút Approve/Request changes/Reject.
3. Approve gửi authenticated request chứa exact `plan_id`, `revision`, `sha256`, project và actor. Disable nút khi pending; retry không tạo quyết định trùng.
4. Node kiểm tra owner authorization, project isolation, artifact existence, computed hash, current revision và decision idempotency. Nếu hợp lệ, ghi append-only human decision `approved`, trạng thái `sl_analysis_pending`, phát correlation ID/event.
5. Node dispatch đúng payload immutable cho SL; SL trả Sprint Plan gồm sprint, ticket, dependency DAG, acceptance criteria, owner role, verification, style và file budget.
6. Node validate SL output theo schema/admission trước persistence; reject malformed, orphan, duplicate, cross-project hoặc ticket vượt policy.
7. Node transactionally lưu SL analysis, sprint registry binding/lifecycle, ticket records và initial `ticket_status_store` state; liên kết approval/correlation/provenance.
8. Node phát event chỉ như invalidation signal. UI refetch project-scoped authoritative snapshot; không coi event payload là status authority.
9. UI hiển thị `Approved → SL analyzing → Persisted → Ready`, sprint mới, toàn bộ ticket và trạng thái persisted. SSE reconnect/missed event luôn reload snapshot.

## 5. Ticket triển khai do SL tách

### SP-APPROVAL-001 — plan review và exact approval contract
- **Style:** backend; **budget:** tối đa 4 file thực sự thay đổi.
- Bổ sung/chuẩn hóa response plan identity và action approval; validate project/actor/revision/hash; idempotent decision.
- Acceptance: sai hash/revision bị từ chối; approved decision lưu append-only; request changes/reject không dispatch SL.
- Test: human decision, hash mismatch, replay và project isolation.

### SP-APPROVAL-002 — UI trình bày plan và nút Approve
- **Style:** frontend; **budget:** tối đa 4 file.
- Render plan trong chat/review panel; hiển thị revision/SHA-256/trạng thái; action Approve, Request changes, Reject; loading/error/success rõ ràng.
- Acceptance: nút gửi exact identity, không approve revision cũ, refresh không mất trạng thái, không expose secret.
- Test: render/action/error và accessibility.
- **Dependency:** SP-APPROVAL-001.

### SP-SL-003 — dispatch và validate Sprint Leader analysis
- **Style:** backend; **budget:** tối đa 4 file.
- Chỉ dispatch sau khi approved; bảo toàn correlation/provenance; validate sprint/ticket/DAG, project scope, single style và mutable file budget tối đa 4 theo governance.
- Acceptance: SL không được gọi khi approval invalid; output lỗi không persist một phần; analysis gắn đúng plan approval.
- Test: orchestration, adapter/loop, malformed output và retry.
- **Dependency:** SP-APPROVAL-001.

### SP-PERSIST-004 — persist analysis, sprint và ticket status
- **Style:** backend; **budget:** tối đa 4 file.
- Ghi analysis, registry, ticket store/status store trong transaction/idempotency boundary; khởi tạo trạng thái ticket đúng contract; không sửa roadmap thành authority.
- Acceptance: retry không duplicate; rollback khi một store lỗi; project isolation; provenance đầy đủ.
- Test: persistence integration, transaction failure, duplicate correlation.
- **Dependency:** SP-SL-003.

### SP-SNAPSHOT-005 — authoritative project sprint/ticket snapshot
- **Style:** backend; **budget:** tối đa 4 file.
- Hợp nhất read-only registry + ticket records + `ticket_status_store` + roadmap/disposition theo project/sprint ID; registry lifecycle và ticket execution state giữ riêng.
- Acceptance: sprint mới và lịch sử đều xuất hiện; ticket không bị mất khi roadmap thiếu `sprint.tickets`; empty/loading/error/stale phân biệt.
- Test: dashboard/projection/project isolation và status authority.
- **Dependency:** SP-PERSIST-004.

### SP-UI-006 — render snapshot và refresh stream
- **Style:** frontend; **budget:** tối đa 4 file.
- Dashboard dùng snapshot; ticket card đọc persisted status; sprint completed collapse mặc định, running/coding nổi bật; reconnect/missed SSE refetch.
- Acceptance: không suy diễn done từ roadmap/order; blocked reason an toàn; sprint mới render ticket ngay sau persistence.
- Test: component, event-stream/reconnect, build/accessibility.
- **Dependency:** SP-SNAPSHOT-005.

### SP-CANARY-007 — controlled end-to-end verification
- **Style:** infra; **budget:** tối đa 4 file.
- Canary project/sprint cô lập: draft → owner approve exact hash → SL → persistence → snapshot/UI; negative checks cho invalid token/hash/revision.
- Acceptance: có correlation, decision, SL result, registry, ticket status, snapshot và redacted evidence; provider failure là blocked, không phải pass.
- **Dependency:** SP-UI-006.

## 6. Thứ tự và phân công

`SP-APPROVAL-001 → (SP-APPROVAL-002 + SP-SL-003) → SP-PERSIST-004 → SP-SNAPSHOT-005 → SP-UI-006 → SP-CANARY-007`.

AM giữ contract/architecture gate; Node/orchestrator sở hữu approval intake và handoff; SL sở hữu decomposition; Coder chỉ thực hiện ticket đã persisted/approved; Reviewer độc lập xác nhận evidence. Mỗi ticket phải có target paths, acceptance criteria, dependency, verification và out-of-scope; không giao cả plan cho một Coder.

## 7. Ngoài phạm vi

Không sửa `.forge/` thủ công; không thay roadmap/registry authority; không tự approve; không dispatch code/run thật trước exact approval; không rewrite historical ticket để làm hợp lệ; không thêm tính năng Add ticket ngoài approval flow; không triển khai production canary nếu thiếu owner credential/evidence.

## 8. Rủi ro và xử lý

- **Blocker:** contract hiện có khác schema/route; dừng và tạo revision/decision kiến trúc.
- **Major:** SL output không atomic hoặc persistence không transaction/idempotent; không hiển thị Ready, giữ blocked.
- **Major:** snapshot mơ hồ project/sprint ownership; reject, không merge theo display order.
- **Minor:** event đến trễ; refetch snapshot, không tự sửa status client.

## 9. Definition of Done

Plan exact revision được owner approve; tests focused và regression pass; approval/SL/persistence/snapshot/UI có evidence; invalid approval không chạy; sprint registry và ticket status không bị nhân bản; canary end-to-end thành công hoặc verdict rõ `NOT ACCEPTED FOR PRODUCTION`. Chỉ sau đó mới được mở implementation/run tiếp theo.

## 10. Trạng thái approval và điều kiện thực thi

R2 đã được persist bất biến và **approved** với exact artifact identity sau:

`Approve plan_id=NF-HUMAN-APPROVE-SL-SP-001 revision=2 sha256=6365e2348eed378a4dcd217a4a277be970aa95072013fd562a479ceabc51cdc4`

Decision authoritative là `PLAN-DECISION-NF-HUMAN-APPROVE-SL-SP-001-R2`. SHA `265be907b9d2c0214f369e1240610b2afa2afdd6a5a0972a213936fd4a474c8f` là source SHA của R2 được source-bind; không nhầm với artifact SHA đã được duyệt. SHA của working copy quản trị này cũng không thay thế identity immutable.

Approval R2 cho phép thực hiện các ticket/hardening đã persisted trong project scope, nhưng **không** chuyển verdict release sang production accepted. Chỉ được ghi nhận production acceptance sau canary end-to-end có owner-approved canary artifact, registry `ready`, RUN đúng ticket, terminal receipt/evidence hợp lệ và disposition sprint lịch sử theo báo cáo nghiệm thu.

Lịch sử: approval R1 có decision ID `PLAN-DECISION-NF-HUMAN-APPROVE-SL-SP-001-R1`; SHA `8e4aadf9e662734e11ddaed06480d095a0f0d5ef61e0a46c54f8541a15458b8e` là checksum artifact immutable R1 do owner review. R1 đã superseded và không cấp quyền cho R2. Nếu tiếp tục thay đổi nội dung hoặc governance của R2, phải tạo revision mới, persist artifact mới và yêu cầu owner approve lại; không tái sử dụng approval R1/R2 cho nội dung mới.
