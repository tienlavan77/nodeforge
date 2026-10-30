# Kế hoạch code: Sprint Plan / Sprint Leader governance và UI

**Trạng thái:** READY TO IMPLEMENT — yêu cầu đã được owner chốt trong hội thoại; tài liệu này không yêu cầu một vòng chép lại hay phê duyệt hình thức khác.

## Mục tiêu đã chốt

1. UI hiển thị toàn bộ sprint của project, kể cả lịch sử/blocked/retired/out-of-scope; sprint hoàn thành thu gọn mặc định, sprint đang code được đánh dấu rõ; ticket hiển thị trạng thái persisted.
2. SL chỉ tạo ticket nguyên tử: đúng một `style` trong `frontend|backend|security|infra|docs`, và tối đa bốn file thực sự thay đổi. Công việc đa-style phải tách thành DAG.
3. Những luật trên phải fail-closed từ schema/admission đến manifest, verification, review, receipt và dispatch; ticket lịch sử vi phạm vẫn nhìn thấy nhưng không chạy lại nếu chưa có approved replacement/replan.
4. Giữ bất biến plan, exact revision/hash approval, registry readiness, DAG và ranh giới SL (planning) / SV (per-ticket execution).

## Rà soát hiện trạng

### Thành phần đã có

- Immutable plan, exact approval/hash và registry readiness: `human-plan-store.js`, `sprint-registry.js`, HTTP plan routes; test chính `human-plan-workflow.test.js`.
- Ticket runtime-state persisted riêng: `ticket-status.js`, `ticket-status-store.js`, terminal bridge; trạng thái đã có `pending`, `blocked`, `running`, `reviewing`, `needs_human_review`, `done`, `failed`, `cancelled`.
- Ledger/verification/review/receipt bền vững: `ticket-change-ledger.js`, `ticket-verification-service.js`, `ticket-review-evidence.js`, `terminal-receipt-writer.js`.
- UI có sprint dashboard, ticket rows, client registry API và project SSE client: `sprint-plan-panels.jsx`, `ticket-detail-modal.jsx`, `node-client.js`, `project-stream-client.js`.
- Tài liệu governance đã nêu đúng luật trong `workflows/human-plan.md` và `workflows/sprint-leader-planning-agreement.md`.

### Gap cần đóng

- `schemas/governance/ticket.schema.json` hiện cho `style` là array nhiều phần tử; chưa có `mutable_file_budget` bắt buộc.
- Admission/SL planner/CRUD chưa reject chuẩn hóa single-style + cap 4.
- Ledger, verification artifact, review evidence và receipt chưa kiểm tra/tồn trữ policy identity của ticket để chứng minh cap xuyên vòng đời.
- Projection hiện chỉ đọc roadmap, còn registry là authority scheduling riêng; UI dashboard đang dùng roadmap nên chưa hợp nhất toàn bộ registry/history và chưa thể hiện disposition/lifecycle đúng nguồn.
- UI đã có collapse state nhưng chưa default-collapse theo terminal lifecycle và chưa map rõ registry state + persisted ticket state; reconnect phải reload authoritative project snapshot cho các panel này.
- Không được sửa dữ liệu lịch sử để “hợp lệ hóa”; cần read-only violation/disposition projection và dispatch gate.

## Contract đích

`ticket.style` đổi từ array thành **string duy nhất**. Ticket mới/replan phải có `mutable_file_budget: 1..4`. Ticket policy identity gồm `style`, budget, approved plan identity/revision/hash và ticket ID. Candidate/read-only evidence không tính budget; actual changed paths trong manifest/artifact/receipt mới là số liệu quyết định.

UI nhận một **project sprint snapshot** do backend hợp nhất read-only từ registry + roadmap projection + Ticket Status Store + disposition. Snapshot không là authority mới: registry giữ lifecycle/binding, ticket-status store giữ execution status, disposition store giữ quyết định lịch sử. SSE chỉ báo refresh; client refetch snapshot project-scoped sau reconnect/missed events.

## Ticket triển khai nguyên tử

### SP-SCHEMA-001 — canonical ticket boundary

- **Style:** backend
- **Mục tiêu:** đổi schema ticket mới sang single-style và bắt buộc budget tối đa 4; bảo toàn việc đọc historical ticket thông qua migration/compatibility policy được xác định rõ, không tự dispatch legacy.
- **Files (3):** `schemas/governance/ticket.schema.json`; `schemas/governance/sprint-plan.schema.json`; `backend/tests/unit/ticket-schema-boundary.test.js` (new).
- **Dependency:** none.
- **Acceptance/evidence:** schema reject style array, unknown style, budget 0/5; nhận single style + 1..4; fixture asserts exact validation errors.
- **Block:** phát hiện schema consumer bắt buộc array mà chưa có conversion path.
- **Tests:** schema validator + new unit.

### SP-ADMISSION-002 — SL/admission fail-closed

- **Style:** backend
- **Mục tiêu:** validate ticket SL/CRUD/draft trước persistence; reject multi-style, missing budget, >4, malformed DAG; historical violation marked non-dispatchable rather than rewritten.
- **Files (4):** `backend/src/application/sprint-orchestration-service.js`; `backend/src/application/ticket-crud-service.js`; `backend/src/modules/governance/sprint-plan-draft.js`; `backend/tests/unit/ticket-crud-service.test.js`.
- **Dependency:** SP-SCHEMA-001.
- **Acceptance/evidence:** persisted newly-created/replanned ticket has one style/budget; cross-cutting input receives deterministic validation error; plan hash/revision gate remains unchanged.
- **Block:** required mutation of an already approved plan instead of creation of a new revision.
- **Tests:** focused CRUD/orchestration tests and schema validation.

### SP-LEDGER-003 — enforce actual changed-file cap

- **Style:** backend
- **Mục tiêu:** bind allowed budget to execution context and reject fifth distinct actual path at ledger write/sync; persist violation reason for SV escalation.
- **Files (3):** `backend/src/modules/supervisor/ticket-execution-context.js`; `backend/src/modules/supervisor/ticket-change-ledger.js`; `backend/tests/unit/ticket-execution-context.test.js`.
- **Dependency:** SP-ADMISSION-002.
- **Acceptance/evidence:** four distinct files pass; fifth fails `TICKET_FILE_BUDGET_EXCEEDED`; retries/repeated writes do not double-count; context records single style/budget.
- **Block:** ticket lacks approved policy identity.
- **Tests:** focused unit test plus existing ledger integration suite.

### SP-EVIDENCE-004 — verify/review/receipt policy continuity

- **Style:** backend
- **Mục tiêu:** verification, review and terminal receipt reject artifact/manifest exceeding budget and persist policy identity + actual changed paths in terminal evidence.
- **Files (4):** `backend/src/modules/supervisor/ticket-verification-service.js`; `backend/src/modules/supervisor/ticket-review-evidence.js`; `backend/src/modules/supervisor/terminal-receipt-writer.js`; `backend/tests/unit/terminal-receipt-writer.test.js`.
- **Dependency:** SP-LEDGER-003.
- **Acceptance/evidence:** artifact/review/receipt mismatch or >4 paths fail closed; completed receipt exposes style, budget and changed paths without source contents.
- **Block:** legacy receipt cannot satisfy new required identity; mark disposition needed, do not synthesize evidence.
- **Tests:** targeted unit tests and immutable pipeline integration.

### SP-DISPATCH-005 — historical violation and dispatch gate

- **Style:** backend
- **Mục tiêu:** deny dispatch for historical tickets with multi-style/oversize evidence unless approved replacement/replan is bound; return safe reason for UI.
- **Files (4):** `backend/scripts/start-control-api.mjs`; `backend/src/modules/governance/sprint-registry.js`; `backend/tests/integration/human-plan-workflow.test.js`; `backend/tests/unit/ticket-pipeline-disposition.test.js`.
- **Dependency:** SP-EVIDENCE-004.
- **Acceptance/evidence:** valid new approved ticket dispatches; nonconforming historical ticket returns deterministic blocked code; disposition/replacement reference is durable.
- **Block:** no owner-approved replacement or disposition decision.
- **Tests:** live composition-safe integration fixtures; no production RUN.

### SP-SNAPSHOT-006 — authoritative project sprint snapshot

- **Style:** backend
- **Mục tiêu:** expose read-only project snapshot merging all registry rows, roadmap-only historical rows, persisted ticket statuses and disposition metadata without replacing their authorities.
- **Files (4):** `backend/src/application/project-dashboard-service.js`; `backend/src/modules/governance/sprint-plan-projection.js`; `backend/src/transport/http/forge-v1-router.js`; `backend/tests/unit/project-dashboard-service.test.js`.
- **Dependency:** SP-DISPATCH-005.
- **Acceptance/evidence:** every known sprint appears once by ID; source fields identify registry lifecycle versus ticket execution; terminal/retired/out-of-scope remain visible and non-runnable.
- **Block:** ambiguous same ID with conflicting project ownership.
- **Tests:** dashboard/projection tests and project isolation test.

### SP-UI-007 — all-sprint and ticket-status rendering

- **Style:** frontend
- **Mục tiêu:** render snapshot records, lifecycle/state badges, safe blocked reason and default collapse only for completed/terminal sprints; preserve manual expand and accessibility.
- **Files (4):** `ui/nextjs/components/sprint-plan-panels.jsx`; `ui/nextjs/components/ticket-detail-modal.jsx`; `ui/nextjs/app/styles/sprint-ticket.css`; `ui/nextjs/tests/sprint-dashboard.test.js` (new).
- **Dependency:** SP-SNAPSHOT-006.
- **Acceptance/evidence:** historical sprints visible; running/coding explicit; ticket state comes from API; no inferred “done”; completed default-collapsed.
- **Block:** snapshot unavailable: show explicit loading/error/stale state, never hide data as empty.
- **Tests:** UI unit/render tests and production build.

### SP-STREAM-008 — snapshot refresh on SSE reconnect

- **Style:** frontend
- **Mục tiêu:** project stream triggers debounced snapshot reload for sprint/ticket/disposition events and guaranteed reload after reconnect/open; it never mutates canonical statuses from event payload.
- **Files (4):** `ui/nextjs/lib/home-page-event-stream.js`; `ui/nextjs/lib/project-stream-client.js`; `ui/nextjs/lib/project-stream-event.js`; `ui/nextjs/tests/project-sprint-stream.test.js` (new).
- **Dependency:** SP-UI-007.
- **Acceptance/evidence:** missed event/reconnect reloads project snapshot; project ID isolation is preserved; no second status store in React.
- **Block:** unknown event type is ignored safely but reconnect refresh remains mandatory.
- **Tests:** EventSource mock tests and UI build.

### SP-CANARY-009 — controlled live governance canary

- **Style:** infra
- **Mục tiêu:** execute one isolated ≤4-file, one-style canary through SL draft → exact owner approval → registry ready → SV → verification/review → terminal receipt; then record historical disposition outcome.
- **Files (4):** `workflows/report-human-plan.md`; `workflows/immutable-ticket-acceptance-record.md`; `workflows/sprint-leader-planning-agreement.md`; `docs/sprint-plan-sl-canary-evidence.md` (new).
- **Dependency:** SP-STREAM-008.
- **Acceptance/evidence:** redacted live responses, plan/revision/hash/decision, registry readiness, receipt, reviewer evidence, negative-gate checks and historical disposition register are recorded.
- **Block:** provider 429/failure, no owner credential, unapproved hash, any file-cap/style breach, or incomplete historical disposition. Verdict remains NOT ACCEPTED FOR PRODUCTION.
- **Tests:** documented live commands plus focused automated regression suite.

## Dependency graph and order

`SP-SCHEMA-001 → SP-ADMISSION-002 → SP-LEDGER-003 → SP-EVIDENCE-004 → SP-DISPATCH-005 → SP-SNAPSHOT-006 → SP-UI-007 → SP-STREAM-008 → SP-CANARY-009`.

No ticket mixes styles or exceeds four planned files. Tests are included in the same ticket because they verify that ticket’s one technical boundary.

## Definition of Done

A ticket is done only after its single-style/four-file contract is persisted; targeted tests and relevant regression tests pass; review evidence matches the exact manifest/artifact; receipt/status is durable; and no plan/registry/status authority was duplicated. The program is production-accepted only when SP-CANARY-009 succeeds and every historical sprint has an owner disposition.
