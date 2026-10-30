<!-- Plan kiến trúc chuyển approval sang Coding và cập nhật plan realtime, dành cho System Engineer triển khai trong governance hiện hành. -->
# Plan: Approve plan tại Coding và đồng bộ realtime Sprint Plan

**Plan ID đề xuất:** `NF-APPROVE-PLAN-UI-001`
**Revision tài liệu:** `2` — bổ sung remediation A1–A5 và yêu cầu owner bỏ polling, ngày 2026-10-10.
**Trạng thái:** Draft cập nhật cho SE tiếp tục; full acceptance còn REQUEST CHANGES. Không chuyển approval của revision trước sang revision này; chưa cấp quyền RUN/dispatch.
**Nguồn cập nhật:** `workflows/audit-approve-plan-ui.md` và `workflows/report-approve-plan-ui.md`. Đây là working-copy revision, không sửa immutable artifact đã duyệt.
**Ngày khảo sát:** 2026-10-10.
**Handoff:** System Engineer khảo sát và triển khai theo delivery contracts được phép; SL sở hữu phân rã SP/ticket nếu đi qua pipeline sprint.

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** Owner muốn giữ `/summary` và `/plan` trong conversation Architecture, nhưng review/approve tại trang Coding thay vì dùng `/approve` trong chat.
- **Kết quả:** Đầu cột **Sprint Plan** của Coding hiển thị tên Architecture plan và nút **Approve**. Khi phát `/plan` hợp lệ, cột phản ánh tiến trình và tự tải plan đã persist, không cần reload.
- **Giá trị:** Tập trung quyết định triển khai tại Coding, giữ exact approval và handoff Sprint Leader mà không phụ thuộc thao tác conversation.
- Tách rõ Architecture plan đang chờ duyệt với Sprint Plan/tickets do SL tạo; cùng cột UI không có nghĩa cùng artifact hay cùng approval authority.

## 2. Phạm vi

### In scope

- Giữ nguyên syntax, validation, nguồn summary, nội dung và storage semantics của `/summary`, `/plan <id-file>` đang có.
- Bổ sung trạng thái tạo plan, plan đã persist và lỗi tại Coding bằng project-scoped realtime invalidation + authoritative refetch.
- Đặt tên plan + Approve ở đầu cột Sprint Plan, trước danh sách sprint/tickets; cho review đầy đủ revision/SHA-256 trước quyết định.
- Chuyển approval/handoff Markdown sang API/service của Node, không gửi message `/approve` ngầm từ nút UI.
- Ngừng thực thi `/approve` qua conversation; phản hồi hướng dẫn mở Coding, không ghi approval hoặc gọi SL.
- Giữ retry/recovery handoff, owner authentication, project isolation, registry binding và RUN gates hiện hành.
- Regression tests, integration evidence và cập nhật hướng dẫn/help liên quan đúng phạm vi.

### Out of scope

- Viết lại summary/planning engine, thay template plan hoặc chuyển Markdown thành JSON mới.
- Tự approve, tự RUN, dispatch Coder/Supervisor hoặc làm migration dữ liệu lịch sử.
- Refactor toàn bộ Coding, thay dashboard/ticket status authority, bổ sung workflow Reject/Request changes mới.
- Sửa runtime `.forge/` thủ công, thay credential policy, tự xác nhận production acceptance.

## 3. Hướng tiếp cận và guardrails

### Ràng buộc bắt buộc

- Approval luôn gắn exact `project_id + plan_id + revision + sha256`; actor lấy từ server authentication, không tin actor/role do client gửi.
- Revision cũ, hash sai, artifact/source thiếu hoặc thay đổi, token sai và cross-project phải fail closed trước handoff.
- Tên hiển thị lấy từ nội dung immutable: heading `# Plan:` của Markdown hoặc field hợp lệ của artifact hiện hành; fallback plan ID. Không sửa bytes/artifact hash chỉ để thêm tên UI.
- UI không suy diễn approved/ready từ event, chat text hoặc cache. Plan store, decision store và Registry giữ authority tương ứng.
- Giữ append-only decisions, exact approved parent/child binding, durable handoff receipt và admission hiện hành. Không chuyển approval sang revision/hash khác.
- Approved nhưng handoff lỗi vẫn hiển thị approved + lỗi/retry riêng; không ghi quyết định lần hai hay báo ready giả.
- Credential chỉ sống trong state cần thiết của UI; không lưu local/session storage, URL, event payload hoặc log. Log lỗi có mã/correlation và dữ liệu đã redact.
- Approve chỉ dẫn đến SL planning/persistence theo gate hiện hành; không đồng nghĩa RUN. Không nới schema/policy ticket để thực hiện thay đổi UI này.

### Hướng đề xuất

1. `/plan` giữ luồng hiện tại. Node phát tín hiệu project-scoped cho request bắt đầu/kết thúc/lỗi; draft chỉ reviewable sau khi persistence và index thành công. Signal bắt đầu không phải plan artifact.
2. Coding có vùng Architecture plan độc lập với loading/error của sprint dashboard; pending plan không bị ẩn chỉ vì chưa có `sprint_id` hoặc dashboard trống/lỗi.
3. Dùng list/get revision chính thức để refetch. Khi nhiều plan: đề xuất chọn plan pending mới nhất theo `created_at`, tie-break plan ID; cho chọn các plan còn lại, không tự bỏ chúng. Mỗi plan dùng current revision của chính nó.
4. Nút Approve đầu cột mở review/confirmation có tên, nội dung, project, revision và SHA-256. Khi submit disable double-click; stale response buộc reload/review, không tự approve bản mới.
5. Tái sử dụng decision endpoint chính thức. Tách phần handoff/readiness hiện nằm trong command handler thành shared application boundary; expose authenticated action API để UI gọi trực tiếp.
6. Hai phase bền vững: ghi exact decision rồi handoff exact approved revision. Retry phase handoff không repost decision đã tồn tại; timeout/reload phải đọc receipt trước khi tiếp tục. Dùng stable decision ID theo contract hiện hành cho retry phase decision.
7. Handoff API phải kiểm tra lại owner, project, exact current identity và approved actor trước gọi service; không chỉ tin artifact client hoặc approval trước đó. Không yêu cầu mở Architecture conversation; provenance lấy từ persisted artifact nếu cần.
8. Reuse durable handoff service và registry validation; sau persistence/refetch hiển thị sprint/tickets và trạng thái authoritative. Có Continue handoff/recovery cho approved plan chưa hoàn tất.
9. **Bắt buộc reuse project stream hiện có**, bổ sung lifecycle invalidation qua producer → projection/schema → subscriber; không mở stream riêng cho Approve Plan/header. SE xác minh wiring và dùng subscription/shared connection của trang. Tên event do Engineer/SL xác minh contract; không coi tên đề xuất là event đã tồn tại.
10. **Bỏ polling 5 giây và mọi timer lặp refetch cho tính năng này**, kể cả fallback khi mất stream. Reconcile có giới hạn khi initial mount, reconnect/snapshot, phát hiện missed event, quay lại tab hoặc owner Retry; stream lỗi hiển thị degraded/error, không chuyển sang polling. Coalesce burst events bằng debounce một lần được phép; loại response cũ sau đổi project/revision/unmount. Không phụ thuộc active conversation; không refetch plan cho mọi event chat không liên quan.
11. `/approve` trong chat được nhận diện để trả hướng dẫn Coding, không rơi xuống LLM như yêu cầu approval. Cắt cả đường UI gửi `/approve` ẩn. Giữ decision API và JSON-plan consumers hiện hành hoạt động.

### Dependency thật sự

- UI approval chuyển sang action API phải xong và có negative security verification trước khi retire command execution.
- Draft lifecycle signal chỉ phát sau đúng mốc persistence; project stream projection/schema/subscription phải tương thích trước khi coi realtime hoàn tất.
- Ready chỉ hiển thị sau exact registry binding và execution/readiness checks hiện hành; provider/gateway lỗi là blocked, không phải pass.

### Quyết định chưa chốt

- Owner review đề xuất nhiều-plan selection ở bước 3; không khóa số lượng pending plan thành một.
- Handoff route/method và tên lifecycle events chưa chốt: Engineer/SL chọn additive contract phù hợp router/schema sau discovery, Architecture review nếu phá public contract.
- Retire `/approve` là thay đổi command compatibility có chủ đích theo yêu cầu owner, không phải thay đổi approval authority. Hướng dẫn chuyển sang Coding phải được triển khai cùng release; không sửa approval baseline đã duyệt tại chỗ.

## 4. Khu vực dự kiến ảnh hưởng và evidence

Repository discovery complete cho các boundary dưới đây; runtime wiring đầy đủ, stream schema/projection và consumers ngoài các file đã đọc còn **unverified**, cần Engineer xác minh trước manifest.

| Thành phần / khu vực | Vai trò / fact đã khảo sát | Evidence / mức chắc chắn |
| --- | --- | --- |
| Owner command service | `/summary`, `/plan <id-file>`, `/approve` hiện được nhận diện; plan persist qua Markdown store; command chứa handoff/readiness | [Evidence: backend/src/application/owner-chat-command-service.js#L25-L36], [Evidence: backend/src/application/owner-chat-command-service.js#L70-L115] |
| Markdown plan store | Immutable bytes/hash, source summary, conversation provenance, decision và handoff status | [Evidence: backend/src/modules/governance/markdown-plan-store.js#L19-L77] |
| Plan HTTP routes | List/get cho Markdown và JSON; decision xác thực owner nhưng nhánh route khảo sát chưa gọi handoff | [Evidence: backend/src/transport/http/forge-v1-plan-routes.js#L12-L27] |
| Plan handoff service | Recheck exact approval, lưu durable receipt/generated draft, reuse SL result và kiểm tra child Registry | [Evidence: backend/src/application/plan-handoff-service.js#L12-L73] |
| Coding page/monitor | Có project SSE và sprint dashboard; phần đầu cột hiện chỉ có heading Sprint Plan | [Evidence: ui/nextjs/app/coding/page.jsx#L16-L53], [Evidence: ui/nextjs/components/coding-workspace-monitor.jsx#L21-L29] |
| Pending approval component | Load plans dựa vào conversation message IDs; có pending/Continue handoff UI; chưa xác minh mount runtime | [Evidence: ui/nextjs/components/pending-plan-approval.jsx#L10-L44] |
| Plan review modal | Markdown Approve hiện ghi decision rồi post owner message `/approve`; đòi conversation | [Evidence: ui/nextjs/components/plan-review-modal.jsx#L97-L126] |
| Shared project stream hook | Refresh dashboard cho ticket/sprint events; conversation events bị active-conversation filter; onOpen chỉ đổi watcher state | [Evidence: ui/nextjs/lib/home-page-event-stream.js#L25-L36], [Evidence: ui/nextjs/lib/home-page-event-stream.js#L87-L105] |
| Governance baseline | Exact identity, decision API, event invalidation, registry authority và không tự RUN | `workflows/human-approve.md` §§2–4; tài liệu baseline, không thay evidence code/runtime |

**Checksums khảo sát (whole-file SHA-256, không phải approval artifact SHA):**
- `owner-chat-command-service.js`: `84559d11f81bcf3b23cd32c36c7195d6cc5f552717e57fbdb4594b23ea940081`.
- `forge-v1-plan-routes.js`: `499d21696564f56d4eeefb296bce683cccd02b51e7d4d2b1b8c276d99b61445e`.
- `plan-review-modal.jsx`: `b2b0810751bf611ea42a5eea092b3105233db228537989e295e559aa90f278c0`.
- `home-page-event-stream.js`: `16d184dec4d54104980b6474419d9b0608b2e50be46c65a8b276f809c0fe086f`.

Các khu vực này định hướng discovery, không phải mutable-file allowlist. Engineer/SL đọc AGENTS áp dụng, glossary, relevant local Next guides và policy/schema hiệu lực trước khi tạo code/ticket; không suy ra implementation đã pass từ tài liệu.

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Dependency / guardrail |
| --- | --- | --- | --- |
| O1 | Giữ summary/plan và bỏ command approval | Positive/negative regressions của `/summary`, `/plan <id-file>` giữ nguyên; `/approve` chỉ hướng dẫn Coding, không decision/SL/RUN; UI không gửi approval qua owner message | Không đổi planning/storage semantics |
| O2 | Plan header tại Coding | Pending Architecture plan xuất hiện dù chưa có sprint; đầu cột có tên + Approve; review thấy exact project/revision/hash/nội dung; empty/loading/error/stale phân biệt; keyboard/accessibility hoạt động | Không conflating parent plan với child SP |
| O3 | Realtime độc lập conversation | Mở Coding ở tab A, gọi `/plan` ở Architecture tab B: thấy generating rồi persisted plan hoặc lỗi mà không reload; active conversation khác/null không cản cập nhật; reconnect/missed event/reload reconcile đúng; duplicate/out-of-order events không làm lùi revision | Event chỉ invalidation; identity từ API |
| O4 | Approval/handoff trực tiếp an toàn | UI gọi decision/action API, không cần mở conversation; sai token/project/hash/revision/actor bị từ chối trước SL; Request changes/Reject không handoff; new revision trong lúc review không được auto-approved | Owner auth + exact identity + existing admission |
| O5 | Retry và persisted result | Double-click/retry/timeout/restart không tạo decision/sprint trùng; approved + handoff lỗi giữ decision và Continue handoff; thành công refetch thấy child binding, sprint/tickets/status; không RUN/dispatch | Durable receipts và registry checks |
| O6 | Verification và rollout có evidence | Backend route/service, stream contract, UI behavior và regression suites pass; E2E hai tab/cross-project/stale/recovery có redacted evidence; deploy backend additive trước UI rồi retire command; smoke và rollback disposition ghi rõ | Gateway lỗi là blocked, không production pass |

**Gợi ý delivery (không bắt buộc):** giảm rủi ro bằng shared handoff boundary + security tests trước; UI header và lifecycle stream có thể tách; end-to-end hội tụ sau cả hai. SL tự chọn số/tên ticket, DAG, file manifest và verification chi tiết.

SL mapping từng outcome/criteria tới ticket contracts; không giảm tiêu chí, mở scope hoặc dùng artifact tài liệu này để tự dispatch.

## 6. Rủi ro, giả định và câu hỏi mở

| Rủi ro / câu hỏi | Tác động | Evidence / giả định | Người chốt / cách xử lý |
| --- | --- | --- | --- |
| Chuyển UI mà vẫn gửi `/approve` ngầm | Major | Modal hiện post owner message | Engineer thay bằng Node action API; test network và no-message side effects |
| Decision thành công nhưng handoff timeout/fail | Major | Store và handoff receipt là hai phase | Engineer/SL giữ recoverable status, exact identity và retry không repost decision |
| Command consumers cũ mất approval entrypoint | Major | Service và HTTP conversation paths có consumers/tests theo search; inventory chưa đầy đủ | Engineer inventory callers/help/tests; owner đã yêu cầu retire chat; thông báo migration sang Coding |
| SSE bỏ qua lifecycle plan hoặc reconnect | Major | Shared hook hiện refresh ticket/sprint, không reconcile onOpen | Engineer xác minh producer/schema/projection; test two-tab và recovery |
| Nhiều plan và response cũ ghi đè selection | Major | Assumption: có nhiều pending plans trong project | Owner chốt UX; Engineer key theo project/plan/revision, stable selection và bỏ stale response |
| Ready policy, SL/provider vận hành chưa xác minh | Blocker cho E2E acceptance | Source có gates; chưa chạy runtime/gateway hoặc canary | Engineer chạy controlled tests; thiếu credential/provider thì blocked, không bypass |
| Rollback đưa command cũ trở lại | Major | Assumption: có thể rollback UI/backend độc lập | Release owner không hạ security gates/đổi decisions; rollback UI cần phối hợp API và báo unavailable thay vì fallback `/approve` ngầm |

Observability tối thiểu: lifecycle/action failures và handoff correlation có project/plan/revision, retry/result/error code an toàn; không log token/full content. Không cần DB migration nếu reuse stores/receipts; đây là giả định cần Engineer kiểm chứng. Nếu cần schema migration, nêu additive/backfill/rollback riêng và xin Architecture review khi đổi semantics.

## 6A. Remediation bắt buộc sau audit — handoff cho SE

Các tiêu chí dưới đây bổ sung O1–O6, không phải ticket manifest. **Yêu cầu no-polling tại revision 2 thay thế câu “polling là recovery fallback” trong audit A2**; audit/report giữ nguyên như evidence lịch sử. Chưa finding nào được đóng bởi việc cập nhật tài liệu.

### A1 — Retire approval qua chat → O1/O4

- Sau negative security verification của direct API, `/approve` chỉ hướng dẫn mở Coding; không ghi decision, handoff, gọi SL, RUN hoặc rơi xuống LLM. Bao phủ command service, conversation HTTP entrypoint và malformed approval commands; không đổi `/summary` hoặc `/plan`.
- Cập nhật help/callers cùng release; UI không gửi owner message `/approve` ngầm.
- **Đóng khi:** regression positive/negative và no-side-effect assertions qua cả command/HTTP pass; network witness chứng minh UI chỉ gọi API trực tiếp.

### A2 — Lifecycle qua project stream, tuyệt đối không polling → O3/O6

- Phát generating → persisted/failed với project/request correlation qua project stream sẵn có. Persisted/reviewable chỉ sau core persistence/index đúng contract. Producer, projection/schema và subscriber phải được xác minh end-to-end; event không thay authority của API.
- Gỡ interval 5 giây và stream riêng đang mở tại header; reuse connection/subscription của trang, không nhân đôi kết nối vì tính năng này. Không thêm endpoint polling hay fallback timer khi stream mất.
- Lifecycle ngắn không được mất generating vì debounce/refetch: SE chọn contract phản ánh tiến trình qua event/projection phù hợp; lifecycle signal không cấp quyền approve. Snapshot cuối vẫn kiểm tra exact artifact qua API.
- **Đóng khi:** browser tab A Coding / tab B Architecture thấy generating rồi persisted/failed không reload; conversation khác/null, reconnect/missed/duplicate/out-of-order và cross-project đúng. Network trace lúc idle, tạo plan và mất stream chứng minh không có request polling định kỳ hoặc kết nối project stream thêm do header; refetch chỉ theo trigger hợp lệ, burst được coalesce.

### A3 — Recovery riêng sau handoff completed nhưng readiness lỗi → O5

- Authoritative readback phân biệt approval, child persistence/handoff receipt và Registry readiness/recovery. Receipt completed không chứng minh ready; không lọc mất mọi đường recovery chỉ vì receipt completed.
- Reload Coding vẫn thấy disposition/error và recovery action có thể truy cập (header hoặc sprint UI với wiring chứng minh). Retry readiness giữ exact approved identity, reuse child đã persist; không repost decision, gọi provider lại hay tạo sprint trùng. Không sửa receipt completed thành failed giả hoặc bypass dependencies/RUN gates.
- **Đóng khi:** inject readiness error/conflict và crash sau receipt completed, trước readiness; reload/restart rồi retry thành công hoặc blocked có lý do authoritative. Chứng minh một decision, một child, không RUN/dispatch.
- **Mức chắc chắn:** rủi ro suy luận từ control flow trong audit, chưa chạy repro; SE phải tái hiện hoặc cung cấp evidence loại trừ, không trình bày là lỗi runtime đã xác nhận.

### A4 — Core `/plan` outcome độc lập diagnostics → O1/O3

- Lỗi diagnostic start/complete/fail hoặc lifecycle publication không biến artifact đã persist thành generation failed. Diagnostic start lỗi không chặn core planning vốn hợp lệ; lỗi core vẫn phải được báo đúng dù fail-diagnostic cũng lỗi.
- Diagnostics/projection lỗi phải được log an toàn và thể hiện degraded/reconciliation cần thiết, không nuốt lỗi hoặc log secret. Recover artifact bằng exact identity từ store/index; không tự chạy lại generation hoặc tạo revision mới chỉ để sửa telemetry.
- **Đóng khi:** fault injection cho start/complete/fail writes và event publication; artifact persisted vẫn đọc/review được, core failure không bị che, retry/recovery không tạo revision dư. Giữ nguyên artifact validation/storage và nguồn summary.
- **Mức chắc chắn:** failure risk suy luận từ control flow, chưa repro; contract durability cụ thể do SE khảo sát trong guardrails, không giảm tiêu chí.

### A5 — Evidence đầy đủ và review độc lập → O2/O4/O5/O6

- Lập evidence map O1–O6 và A1–A5 tới tests/witnesses với exact source identity/checksums hoặc manifest batch, commands, kết quả và limitations. Focused service-reported PASS trước đây không thay rendered/browser hoặc independent verification.
- Bao gồm build/lint áp dụng, browser/keyboard/focus/accessibility, HTTP auth composition, stale/double-click, timeout/crash/restart, project isolation và stream/no-polling witnesses. Không suy ra cross-process fencing từ process-local guard/PID probe.
- Provider/credential unavailable ghi blocked; recovery ngoài scope chỉ defer khi owner chốt boundary, không tự giảm O5. Không gộp unrelated worktree changes vào source manifest/commit.
- **Đóng khi:** SE cung cấp source-bound verification bundle; independent Reviewer kiểm chứng implementation; release owner ghi smoke/rollback disposition. Architecture không tự review/approve implementation hay xác nhận rollout.

**Evidence cập nhật:** Audit A1–A5 và Report §§1–4 là nguồn finding/limitations, không phải test rerun. Đã đọc lại `owner-chat-command-service.js:25–49` (diagnostic coupling/chat approve), `coding-architecture-plans.jsx:16–26` (stream riêng + interval), `plan-approval-action.js:17–24` (readiness sau handoff), `coding-plan-loader.js:4–6` (lọc approved/completed). Evidence/checksums §4 là lịch sử revision 1; SE revalidate source hiện tại trước manifest, không dùng như hash approval.

**Handoff:** SE/SL tự phân rã remediation và mapping coverage theo policy; giữ các outcome IDs hiện có. Direct API security verification là dependency thật trước retire chat; contract stream đầy đủ là dependency thật trước realtime acceptance. Hoàn tất code không tự đóng audit: cập nhật report với evidence, chuyển independent Reviewer rồi owner quyết định acceptance.

## 7. Acceptance criteria của plan

- [x] Mục tiêu, in/out scope và outcomes nhất quán với yêu cầu đã trao đổi.
- [x] Facts có repository evidence; assumptions/unverified và owner quyết định được ghi rõ.
- [x] Guardrails/dependency bắt buộc tách khỏi gợi ý delivery.
- [x] Outcomes đủ kiểm tra, không áp đặt số ticket hoặc mutable-file manifest.
- [ ] Human review phạm vi, UX nhiều plan và thay đổi compatibility `/approve`.
- [ ] Engineer/SL xác minh runtime/API/event contracts và chứng minh outcome coverage theo policy hiệu lực trước dispatch.
- [ ] Node đăng ký immutable artifact và owner approve exact identity/revision/SHA-256 theo contract; checksum working copy không thay artifact SHA.
- [ ] Implementation verification và controlled E2E có evidence; lập SP/approve plan không tự RUN/dispatch.
