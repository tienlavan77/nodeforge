<!-- Mục đích: ghi kết quả triển khai và các gate còn thiếu của Human Plan Approval Workflow. -->
# Báo cáo triển khai Human Plan Approval Workflow

Ngày cập nhật: 2026-10-02  
Kế hoạch: `workflows/human-approve.md`  
Trạng thái nghiệm thu: **Đạt nghiệm thu kỹ thuật trong repository; chưa đạt nghiệm thu vận hành production.**

## Approval record

- Current plan: `NF-HUMAN-APPROVE-SL-SP-001`, revision `2`
- Current status: **approved**
- Current artifact SHA-256: `6365e2348eed378a4dcd217a4a277be970aa95072013fd562a479ceabc51cdc4`
- Current decision ID: `PLAN-DECISION-NF-HUMAN-APPROVE-SL-SP-001-R2`
- R2 source SHA-256: `265be907b9d2c0214f369e1240610b2afa2afdd6a5a0972a213936fd4a474c8f`

R1 remains historical and superseded. It cannot authorize R2 execution.

- Plan: `NF-HUMAN-APPROVE-SL-SP-001`, revision `1`
- Trạng thái: **approved**
- Approved by: **Project Owner**
- Approved source SHA-256: `8e4aadf9e662734e11ddaed06480d095a0f0d5ef61e0a46c54f8541a15458b8e`
- Immutable artifact SHA-256: `1cf1a946994932727c425f3637b03d2389736c4a608a4c957945083e606e60e3`
- Decision ID: `PLAN-DECISION-NF-HUMAN-APPROVE-SL-SP-001-R1`
- Approval được ghi append-only trong plan decision index. SHA trên là checksum snapshot đã được owner review; phần trạng thái approval được cập nhật sau đó trong tài liệu nội bộ.
- Source binding hardening: khi tạo revision có nguồn, Node bắt buộc `source_path` và `source_sha256`, đọc trực tiếp file nguồn và từ chối checksum sai hoặc file không tồn tại.
- R2 hardening: dashboard hợp nhất registry, roadmap, persisted ticket files và `ticket_status_store`; ticket thiếu trong roadmap vẫn được hiển thị, trạng thái không còn suy diễn từ log khi có status authority, và project/sprint mismatch bị fail-closed.
- Coder hardening boundary: prompt execution chỉ cho phép sửa ticket đã persisted/manifest-approved; không được viết lại boundary đã PASS, hạ gate, alias route legacy hoặc tự đánh dấu production accepted.
- Sprint Leader planning boundary: mỗi ticket phải khai báo đúng một `style` và `file_budget` từ 1 đến 4; Node từ chối plan thiếu hoặc vượt giới hạn trước khi persistence.
- Sprint dispatch hardening R1: owner-approved immutable artifact `08a42b3528996592daeae56e5d36a9e8508a460ddca12e539eadb48e0bb0cc89` is recorded; dispatch now compares normalized ticket ID sets and rejects malformed, duplicate, missing, or extra IDs before Coder execution.
- Owner chat planning commands: `/summary`, `/plan <id-file>`, and `/approve <plan_id>` are implemented in `owner-chat-command-service.js` and wired into the Control API. `/summary` persists a project-scoped temporary Markdown artifact; `/plan` creates an immutable draft bound to `awaiting_human_approval`; `/approve` requires the current approved revision and exact SHA-256, then invokes the Sprint Leader planning handoff. None of these commands starts RUN or dispatches Coder/Supervisor.

## Verdict

- **Implementation gate:** PASS
- **Automated verification gate:** PASS
- **HTTP contract migration gate:** PASS
- **Human approval security gate:** PASS trong test với server bearer credential
- **Production live acceptance gate:** BLOCKED
- **Overall release verdict:** **NOT ACCEPTED FOR PRODUCTION**

## Bổ sung nghiệm thu chat planning commands

| Hạng mục | Kết quả | Evidence |
| --- | --- | --- |
| `/summary` tạo summary ID và artifact Markdown project-scoped | **PASS (repository)** | `owner-chat-command-service.test.js` |
| `/plan <id-file>` tạo immutable draft, không RUN | **PASS (repository)** | Draft có revision/SHA và trạng thái `awaiting_human_approval` |
| `/approve <plan_id>` từ chối khi chưa có owner approval | **PASS (repository)** | `PLAN_APPROVAL_REQUIRED` được kiểm tra trong test |
| `/approve <plan_id>` handoff Sprint Leader sau exact approval | **PASS (repository)** | Handoff callback và Sprint Leader wiring đã được nối vào Control API |
| Live UI/API canary | **CHƯA CHẠY** | Cần restart Control API và chạy qua route thực tế |

Các lệnh planning chỉ tạo artifact, draft hoặc Sprint Plan handoff. Chúng không tự chuyển sprint sang `ready`, không RUN ticket và không dispatch Coder/Supervisor.

## Đã triển khai

- Migration SQLite tạo chỉ mục revision, head, quyết định duyệt và sprint registry.
- Plan JSON được ghi bất biến tại `.forge/runtime/nf/plans/<plan_id>/<revision>.json`; SQLite lưu đường dẫn, SHA-256 và metadata. File thiếu, bị sửa hoặc revision không còn là head đều không thể cấp quyền RUN.
- Quyết định `approved`, `rejected`, `changes_requested` được ghi append-only và gắn với plan ID, revision, checksum, approver và thời điểm.
- Sprint registry lưu thứ tự, dependency, trạng thái và plan revision chính xác. Gate `ready` kiểm tra approval, file/hash và dependency.
- Sprint Leader SDK/chat phải trả `human_plan` với outcome, in/out scope, approach, components, risks, assumptions, open questions, evidence references và acceptance criteria. Thiếu evidence/components làm draft fail; Node không tự tạo mô tả giả. Agent có thể tạo revision mới cùng sprint sau yêu cầu sửa.
- Draft revision được lưu trước sprint projection; sự kiện tạo sprint ghi `awaiting_human_approval` cùng plan ID, revision và checksum.
- RUN ticket/sprint kiểm tra plan được duyệt và ticket thuộc plan. Với draft do Sprint Leader tạo, RUN còn so khớp title, objective, acceptance criteria, dependency, style và execution contract; thay đổi các trường này cần revision mới.
- Sprint DAG cập nhật registry `running`, rồi `done` hoặc `failed`. API bên ngoài chỉ cho chuyển `ready`/`blocked`, không tự đặt terminal status.
- Forge v1 có API tạo/đọc revision, ghi quyết định, đăng ký/gắn plan và đọc/đổi trạng thái sprint. Direct Code RUN/resume bị chặn khi plan gate được cấu hình vì checkpoint đó chưa gắn ticket đã duyệt.
- Cấu trúc public route của Sprint Registry được tách rõ dưới `/forge/v1/sprints/registry`: `GET/POST` collection, `GET /:sprint_id`, `PUT /:sprint_id/plan` và `PUT /:sprint_id/status`, tất cả nhận `?project=<project_id>`. `/forge/v1/sprints` vẫn thuộc sprint-plan/roadmap service; `sprintRegistry` vẫn là domain/storage authority nội bộ.
- Route legacy `/forge/v1/sprint-registry` phải trả `ROUTE_RETIRED`, không redirect hoặc alias. Draft/run dưới `/forge/v1/sprints/:sprint_id/...` chưa tự nhập vào registry và vẫn giữ contract/ownership hiện tại cho đến khi có contract riêng được duyệt.
- Plan decision bắt buộc bearer token so khớp credential phía Control API; owner ID lấy từ cấu hình server, bỏ qua `actor`/`actor_role` do client khai. Thiếu cấu hình thì fail-closed.
- UI có modal xem revision, SHA-256, scope, approach, evidence và acceptance; có approve/reject/request changes, chỉnh sửa tạo revision mới và intake thủ công cho sprint lịch sử. Token chỉ giữ trong state modal, không lưu vào browser storage.
- `POST /forge/v1/sprints/:id/draft` gọi Sprint Leader để lập plan, tách khỏi RUN implementation. Sprint mới được nhập vào roadmap projection mà vẫn giữ các sprint hiện có.
- Registry HTTP đã chuyển sang `/forge/v1/sprints/registry` với collection/detail/plan/status routes. `/forge/v1/sprint-registry` trả `410 ROUTE_RETIRED`; không redirect hoặc alias. Registry có thể lưu sprint `planned` chưa có plan reference, nhưng chuyển `ready` vẫn fail-closed nếu chưa có approved immutable plan.

## Evidence kiểm thử

| Kiểm tra | Kết quả |
| --- | --- |
| Plan workflow, HTTP routes, sprint upload, Sprint Leader và dashboard tests | **14/14 pass** focused R2 suite; prior integration/HTTP suite **25/25 pass** |
| Control API composition trên project tạm | **1/1 pass** khi chạy riêng; lần chạy song song với UI build đã timeout |
| `pnpm lint` | **Pass** |
| `pnpm typecheck` | **Pass** |
| `node backend/scripts/validate-schemas.mjs` | **98 schemas, 91 fixtures pass** |
| `pnpm --filter @nodeforge/ui-nextjs build` | **Pass** |
| `git diff --check` | **Pass** |
| Source-bound approval checksum, source-file verification and decision replay | **Pass** |
| R2 immutable artifact approval and execution gate | **Pass** | Artifact SHA `6365e2348eed378a4dcd217a4a277be970aa95072013fd562a479ceabc51cdc4`; exact R2 approval opens execution |
| Authoritative dashboard projection | **Pass** | Persisted ticket/status and project/sprint isolation tests |
| Coder hardening/production boundary | **Pass** | Claude/Codex prompts restrict work to persisted scope, preserve PASS boundaries, and forbid self-acceptance |
| Sprint Leader style/file budget gate | **Pass** | Prompt, schema and pre-persistence admission reject multi-style or file budgets above 4 |
| Sprint dispatch membership gate | **Pass** | Exact plan/projection ID-set comparison before ticket or sprint dispatch |
| Owner chat command contract | **Pass (repository)** | Focused command tests 2/2; `/approve` without owner decision fails closed |

### Sprint Dispatch Hardening R1 delivery report

- Plan: `PLAN-SPRINT-DISPATCH-HARDENING-R1`, revision `1`
- Approval: `approved` by `PROJECT-OWNER`
- Artifact SHA-256: `08a42b3528996592daeae56e5d36a9e8508a460ddca12e539eadb48e0bb0cc89`
- Decision ID: `PLAN-DECISION-PLAN-SPRINT-DISPATCH-HARDENING-R1-R1`
- Registry/membership implementation: **PASS**
- Focused dispatch and governance tests: **12/12 pass**
- Production RUN: remains **BLOCKED** until the canary acceptance gate is completed.

Các test xác nhận revision cũ mất quyền sau replan, file thiếu/sai hash fail-closed, dependency và reject chặn readiness, token thiếu/sai bị từ chối dù client tự khai owner, draft thiếu evidence bị chặn, section dạng list được chuẩn hóa thành text bất biến, ticket bị đổi objective sau approval bị chặn, upload sprint canary giữ sprint cũ, route registry mới hoạt động và route cũ trả `ROUTE_RETIRED`. Probe Control API trước migration: không có token trả `403 plan_owner_unauthorized`; token server đúng với ID không tồn tại trả `409 plan_revision_not_found`.

## Acceptance checklist

| Gate | Verdict | Evidence | Ghi chú |
| --- | --- | --- | --- |
| Immutable JSON revision + SQLite checksum/index | **PASS** | Plan workflow tests | Hash/file/revision mismatch fail-closed |
| Append-only owner decision | **PASS** | Owner-auth tests | Bearer token lấy từ server config |
| Sprint registry dependency/readiness | **PASS** | Registry tests | Sprint chưa có plan không thể `ready` |
| Registry route boundary | **PASS** | HTTP route tests | `/sprints/registry` chính thức; route cũ `410 ROUTE_RETIRED` |
| Sprint Leader draft contract | **PASS** | SDK/prompt tests | Thiếu evidence/components bị từ chối |
| UI review/approve/revision | **PASS** | UI production build | Chưa có live browser acceptance |
| Production agent → draft → approval → RUN | **BLOCKED** | Canary audit | R2 approved; chưa có terminal canary evidence hợp lệ |
| Historical sprint disposition | **BLOCKED** | Registry inventory | Chưa có approved revision cho sprint cũ |

## Chưa đạt để nghiệm thu toàn bộ

1. **Chưa có live acceptance.** Credential owner nằm trong `config/.env` bị Git ignore và không in vào log. Canary `SPRINT-HUMAN-PLAN-CANARY-20261002` đã được tạo, sprint cũ vẫn hiện trong projection. Anthropic Sprint Leader bị gateway `429`; Codex attempt đầu bị validator từ chối section list, sau đó code đã chuẩn hóa. Attempt tiếp theo đã tạo artifact:
   - plan: `PLAN-SPRINT-HUMAN-PLAN-CANARY-20261002`
   - revision: `1`
   - SHA-256: `cd2272a396ed8a5148c66eb89804bfe45abd16a7baa66515f7368c203bad9548`
   - registry status: `awaiting_human_approval`
   - event kết thúc: `agent.failed` do tracker cũ yêu cầu Architecture Decision cho roadmap canary.
   Code đã sửa để ghi `provenance_pending` thay vì làm mất draft khi roadmap không có quyết định kiến trúc; profile Sprint Leader đã khôi phục về Anthropic. Revision 1 là audit draft, chưa approved và chưa RUN.
2. **Sprint lịch sử chưa được disposition hàng loạt.** UI cho tạo draft thủ công từng sprint, nhưng chưa có quyết định owner và approved revision cho các sprint cũ. Các sprint đó vẫn nhận `SPRINT_PLAN_REQUIRED` khi RUN.
3. **Chất lượng nội dung vẫn cần human review.** Schema buộc đủ trường và evidence references, nhưng không thể tự chứng minh mọi lập luận kiến trúc trong text là đúng. Owner cần kiểm tra từng plan và nguồn chứng cứ trước khi duyệt.
4. **Chat command live canary chưa chạy.** Các lệnh đã có test repository, wiring Control API và đường handoff Sprint Leader, nhưng chưa restart process hiện tại để xác nhận luồng UI/API thực tế. Cần kiểm tra `/summary` → `/plan` → owner approval qua UI/API → `/approve` → Sprint Plan; không được xem test tự động là production acceptance.

## Kết luận nghiệm thu

**Nghiệm thu kỹ thuật: ĐẠT.** Approval contract, immutable plan persistence, owner authentication, source-file checksum binding, Sprint Leader admission, registry gate, snapshot/UI wiring, Coder hardening boundary và các kiểm thử tự động đã đạt.

**Nghiệm thu vận hành production: CHƯA ĐẠT.** Chưa có canary end-to-end với terminal receipt hợp lệ và chưa disposition toàn bộ sprint lịch sử. Vì vậy chưa được chuyển verdict release sang accepted/done.

Để hoàn tất nghiệm thu production cần:

1. restart Control API từ commit hiện tại;
2. chạy lại canary với Sprint Leader gateway hoạt động;
3. owner duyệt đúng plan ID/revision/SHA-256 qua UI/API;
4. RUN đúng ticket sau khi registry chuyển `ready`;
5. lưu terminal receipt và evidence agent/reviewer;
6. disposition các sprint lịch sử trước khi mở chúng.

Không tự đổi verdict sang accepted/done khi các gate production còn blocked.
