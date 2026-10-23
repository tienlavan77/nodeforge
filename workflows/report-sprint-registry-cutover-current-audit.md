<!-- Audit kiến trúc source hiện tại và báo cáo Coder; không thay implementation review hoặc nghiệm thu runtime. -->
# Sprint Registry Cutover — Architecture audit current

**Ngày:** 2026-10-08. **Verdict:** Partial implementation; **chưa nghiệm thu full cutover O1–O7**.
**Baseline:** `workflows/plan-sprint-registry-cutover-completion.md` (revision 1, tài liệu vẫn ghi Draft).
**Report đối chiếu:** `workflows/report-sprint-registry-cutover-current.md`.

## 0h. Follow-up mới nhất — Dependency revalidation và execution recovery (2026-10-09)

Chi tiết/evidence: `workflows/report-sprint-registry-cutover-follow-up-0h.md`; plan remediation Draft: `workflows/plan-sprint-registry-cutover-execution-recovery.md`. 0h ưu tiên hơn finding dependency tương ứng của `workflows/report-sprint-registry-cutover-follow-up-0g.md`: fenced production runner đã re-resolve sau wait và final version/plan/original-execution checks, giữ same-plan done hợp lệ; sáu scenario registrations, pass vẫn Coder-reported. Dependency expectations chưa đi tới durable admission qua shared RUN/submit; synchronous checks không thay cross-process commit. R1–R6 chốt dependency intent, durable admission, event/projection/waiter recovery, side-effect fencing, producer inventory và Reviewer/forecast; mapping O1–O7 không giảm scope. Tiến bộ execution/dashboard của 0g giữ nguyên; mounted UI, authority/handoff và migration–restore–rollback vẫn carry-forward. **Partial O2/O5; chưa nghiệm thu full O1–O7, chưa được retire/drop legacy store/schema.** Lượt Architecture lập 0h chỉ viết tài liệu audit/plan; không sửa code/chạy tests/browser/Git/migrate/commit/push/approve/RUN. **Coder implementation note, 2026-10-09 (không thay Architecture/Reviewer verdict):** expectation set đã được nối qua DAG/shared RUN/submit và lưu cùng claim/queue trong source; check đầu `VERIFY-RUN-4d1e8627-90c7-4604-94dc-1e282c0e398d` FAIL; bản sửa guard đã được owner cho phép rerun trong `VERIFY-RUN-948929d7-5921-409a-ab8d-9b34c0605685`, vẫn FAIL vì fixture thiếu governed toolRegistry trước fake-provider boundary. Hai lượt lỗi trên giữ làm lịch sử. Fixture sau đó đã bổ sung Registry/governance factories thật và MCP/allowlist assertions; focused một-file check `VERIFY-RUN-156a73d0-ef09-4d62-ad6d-aa4c0749437d` PASS, exit 0, evaluated `2026-10-09T00:57:21.270Z`. Pass chỉ cho fixture/submission witness với fake provider; không thay independent Reviewer hoặc durable admission/recovery acceptance. Git outcome được ghi riêng trong report Coder. Chi tiết failed/corrected identities và admission/recovery còn mở: `workflows/report-sprint-registry-cutover-execution-recovery-implementation.md`. Chưa đóng R1–R6 hoặc cấp acceptance/rollout.

## 0d. Follow-up — observed draft basis và readiness (2026-10-08)

Chi tiết/evidence/hướng sửa: `workflows/report-sprint-registry-cutover-follow-up-0d.md` (tách để audit không vượt 250 lines). Mục 0d ưu tiên hơn findings lịch sử tương ứng.
- Đã xác nhận draft giữ observed version; exact-parent recovery không reset readiness; conflict giữ immutable evidence. `assertReady` đã recheck version sau validation. Hai finding cũ tương ứng ở 0c đã lỗi thời; chưa đóng durable admission/recovery.
- Production dispatchTask có readiness check thứ hai trước submit; gap là exact basis/attempt tại durable admission, không phải hoàn toàn thiếu recheck. Sprint RUN transition và terminal callbacks vẫn cần observed basis/attempt fencing.
- Next: caller precondition toàn workflow; durable RUN/terminal fencing; crash/reconciliation/receipt replay; authority + active UI diagnostic; full migration/restore/rollback và Reviewer. Pass vẫn Coder-reported; chưa nghiệm thu O1–O7.
- Chỉ cập nhật tài liệu; SL sở hữu delivery. Không sửa code/chạy tests/migrate/approve/RUN; **chưa được retire/drop legacy store/schema**.

## 0c. Follow-up — Registry row CAS và đường consumer thực tế (2026-10-08)

**Mục này ưu tiên hơn 0b/0a/0/findings lịch sử khi khác biệt.** Verdict: partial implementation; chưa nghiệm thu O1–O7. Đây là đối chiếu architecture/contract, không thay Reviewer độc lập hoặc cấp approval/RUN.

### Delta xác nhận qua source

- Report SHA-256 `eb2e02e43874c951bb447b3a6b17ad910bdf710d08c1a4d514993f4476f34954` mô tả đúng giới hạn row CAS và consumer reachability; không claim full cutover.
- `sprint-registry.js:59–67,82–112` đã thêm expectedVersion, UPDATE theo Project/Sprint/version, tăng version và trả non-retryable/scoped 409 khi stale. **Nhận xét cũ bind/status UPDATE không có version predicate đã lỗi thời.** C2 chỉ remediation ở row bind/status, không đóng dispatch/event/cross-store recovery.
- `forge-v1-plan-routes.js:34–38` forward optional `expected_version`; `sprint-registry-migration.js:51–54` thêm version 18 additive/default 0. Migration runner `index-migrations.js:192–207` bỏ versions đã ghi và transaction từng migration. Chưa có historical snapshot để độc lập chứng minh extraction 11/12 byte/statement-equivalent.
- Đã đọc toàn test concurrency: real SQLite/immutable stores, delayed validation, second connection, same-clock ABA, one winner và route precondition/project guard. Test migration có preserve/reopen/stale-version assertions nhưng dựng schema pre-version bằng DROP COLUMN + xóa marker trong database mới; chưa là upgrade witness từ artifact v17 nguyên gốc, chưa test crash/rollback migration.
- `/coding` source `app/coding/page.jsx:26–32,53` gọi getProjectDashboard và catch log rồi clear dashboard. Search UI không thấy expected_version/expectedVersion hoặc page import PendingPlanApproval. Đây là static reachability evidence có giới hạn, không browser proof hoặc kết luận mọi approval UI obsolete.
- Claim pass `VERIFY-RUN-56ecf02f-fdfe-4c57-aa43-0472dd4a76fa`, exit 0, evaluated `2026-10-08T17:27:18.648Z` chỉ đọc từ report; chưa independently verified. Batch này không chứng minh HTTP/UI checks cũ đã rerun.

### Hướng sửa tiếp và điều kiện đóng trong outcomes hiện có

| Outcome / mức | Hướng chỉnh và witness cần có |
| --- | --- |
| O2/O5 — Major, precondition từ caller | Optional omission chỉ bảo vệ thay đổi trong operation, không bảo vệ intent dựa snapshot cũ. `sprint-plan-draft-persistence.js:13–25` đọc previous trước await/create/approve rồi bind không truyền previous.version. Giữ expected version của basis đã quan sát cho workflow này và mọi mutation caller thực tế; không tự reload/retry để ghi đè winner. Test hai workflows interleave trước khi vào bind, stale loser không đổi current binding; immutable revision/approval đã tạo phải có recovery disposition, không xóa evidence. UI dùng scheduling GET có version hoặc projection được chốt: getDetail hiện không expose version. Không bắt buộc đổi public field khi chưa cần; đổi semantics/required precondition cần compatibility review. |
| O5 — Major, RUN basis/attempt fencing | `assertReady:70–79` snapshot trước await và không revalidate version khi trả; `ticket-run-dispatch.js:24–47` còn await checkpoint/clear trước dispatch, không dùng scheduling version vào durable admission. Đây là failure-window risk, chưa chứng minh RUN sai đã xảy ra. Fence exact Project/Sprint/plan revision/hash/version + attempt ở admission, không chỉ check cuối assertReady. Witness pause readiness hoặc checkpoint, rebind/block xen giữa rồi dispatch phải fail closed; stale terminal event không đổi attempt mới, crash/restart không duplicate. |
| O3 — Major, actual consumer diagnostic | Hoàn tất inventory page → client → endpoint → service → renderer. Đường `/coding` hiện đọc dashboard, không nhận migration conflict của listSprints chỉ vì GlobalToast có nhánh. Converge dashboard về Registry rồi giữ structured scoped error đến DOM, phân biệt unavailable/conflict với empty; test actual HTTP/client/active consumer DOM, IDs/requestId/bounded/missing IDs và không tự retry mutation. Không vá approval components reachability chưa rõ chỉ để đóng finding. |
| O2/O4/O5 — Major, atomicity/recovery | Row CAS không gộp immutable create/approval/index/bind/handoff receipt/event commit. Cần all-or-nothing hoặc durable recovery protocol giữ committed visibility; failure injection tại từng boundary, reload exact receipt sau handoff committed/read fail và continue không repost decision/handoff. Hội tụ writers/RUN/review/handoff về Registry; không quay lại remove-trước/upload-sau. |
| O6/O7 — Blocker cutover/cleanup | Version-column migration không thay full legacy inventory/reconciliation. Bổ sung bound/unbound/dependency/approval-linked upgrade fixtures hoặc real v17 artifact, restart/crash recovery; full per-version conflict manifest, backup–restore, resume và rollback giữ writes/events mới. Reviewer + exact human rollout/retention decision trước retire/drop. |

### Evidence / handoff

- Sáu source/test checksums trong latest report khớp từng file đọc lượt này: Registry `399247b6…`, index migrations `ab2765fd…`, migration module `099ca520…`, routes `499d2169…`, concurrency test `97ee9292…`, version migration test `4dfe29de…`; exact whole-file hashes được giữ trong report. Đây không phải atomic run snapshot.
- Bổ sung evidence: draft persistence SHA-256 `bfc3c6e92e7db41d7ec74e83ee50fa70d0d85824bd8fb3d92b146e16750fdc34`; dispatch `fda08a6eb5160f57bb42e6026a897bf1bbdf2fefa6d1caa2a8f7805e1eda5c3a`; active coding page `365e08cb593bbfd6457e56757c2276501fafb7361638dc2dbd5377df51c2dbf8`.
- Report nên bổ sung caller-observed precondition gap, RUN check-to-dispatch window và synthetic-v17 fixture limitation; giữ O5 partial. Source-bound bundle cần exact environment/snapshot/dirty manifest/output artifacts và Reviewer; comment-only edit sau run vẫn phải ghi riêng tested identity, không gọi final bytes đã chạy.
- SL sở hữu phân rã/DAG/manifests trong approval hiệu lực; bảng trên là outcomes/guardrails, không ticket list hoặc quyền dispatch. Baseline completion plan vẫn ghi Draft; lượt này không xác minh runtime approval receipt.
- **Giới hạn:** chỉ đọc instructions/report/plan/architecture overview và targeted source/tests/tree/list/search; một read offset vượt EOF không có evidence, phần Registry đã đọc đầy đủ qua hai windows hợp lệ. Chỉ cập nhật audit này, không sửa code/schema/report Coder/plan, chạy tests/browser/Git, migrate, commit/push, approve hoặc RUN. Không dùng nguồn ngoài vì nguồn ngoài không chứng minh repository implementation. **Chưa được retire/drop legacy store/schema.**

## 0b. Follow-up mới nhất — C3 và scope rendering (2026-10-08)

**Mục này ưu tiên hơn 0a/0/findings lịch sử khi có khác biệt.** Verdict: partial implementation; chưa nghiệm thu O1–O7. Đây là đối chiếu architecture/contract, không thay implementation review của Reviewer.

### Delta xác nhận qua source

- Report mới SHA-256 `f93b6791f03c4ff8a8d34fd797986a8cfcc0d4f8e9a6064bd2587ff74923abaa` đã dùng đúng public `tickets`, phân biệt scope với approval, bổ sung mapping O1–O7 và giới hạn verification.
- **C3 đã remediation ở mức source:** `sprint-registry.js:99–115` dùng `readBoundPlan`; chỉ skip khi cả bốn binding fields null, reject partial/invalid binding, đối chiếu Project/Sprint/path/hash và không catch để nuốt lỗi store. `getDetail:42–50` dùng cùng validator. Không tiếp tục yêu cầu sửa lỗi lookup unbound cũ như chưa được xử lý.
- Regression `sprint-registry-ticket-lookup.test.js:13–80` dùng disposable SQLite và actual immutable store, có empty/unbound-before-bound/missing-ticket/project isolation/partial/path/hash/foreign reference/missing/tampered file. Đây là test source đã đọc; runtime pass vẫn chưa độc lập xác minh.
- **Approval-label đã sửa ở scope component:** `sprint-ticket-scope.js:5–12` dùng nhãn trung tính và missing-detail status; `sprint-plan-panels.jsx:101` tích hợp component. Test `sprint-plan-panels.test.js:8–29` thực sự render React HTML với bảy cases, không còn chỉ source-string assertions. Đây không phải full modal/browser interaction hoặc proof toàn UI approval semantics.
- Report dẫn Forge run `VERIFY-RUN-afe6c2ec-f1a1-4f1a-b160-1eca06cfbc36`, exit 0, evaluated `2026-10-08T17:09:52.050Z`. Lượt này chỉ đọc claim trong report, không đọc run artifact hoặc chạy test; không gọi independently verified. Report minh bạch không có TAP counts/output hashes/atomic snapshot.

### Hướng chỉnh tiếp trong outcomes hiện có

1. **O3 — diagnostic ở đường đang active:** map route/client/caller/render thực tế trước khi chọn files sửa. Search hiện chỉ thấy `PendingPlanApproval` ở definition và test loại khỏi architecture/system; indexed imported_by cũng rỗng. Đây là dấu hiệu cần xác minh reachability, không chứng minh runtime dead hoặc active. Không bắt buộc vá component không còn dùng chỉ để đóng finding; phân loại active/history/obsolete và chứng minh đường active có diagnostic đầy đủ.
2. **Nếu hai consumers còn active:** `pending-plan-approval.jsx:33,42` và `plan-review-modal.jsx:125` vẫn chuyển lỗi thành `.message`. Giữ normalized object riêng đến renderer scoped, gồm identifiers/scope/retryable/requestId; message chỉ là presentation. Bổ sung actual migration HTTP → requestJson → active consumer → DOM; assert safe/bounded/missing IDs, requestId, guidance và không Retry/automatic retry. Bounded subset không thay full authorized inventory.
3. **O4/O5 — hậu handoff:** `plan-review-modal.jsx:110–125` có thể commit approval/handoff rồi fail ở list read trước cập nhật local plan. Đây là failure-window risk, chưa phải incident duplicate đã chứng minh. Tách read-recovery khỏi mutation failure; reload exact durable approval/receipt trước continue; test conflict sau committed handoff rồi reopen/continue không repost decision hoặc tạo handoff mới. Không suy ra backend thiếu idempotency từ local state.
4. **O1/O2/O5 — scope render không đóng authority:** report vẫn để writers/dashboard/handoff/RUN mở. Registry `bindPlan:59–66` và `setStatus:82–95` vẫn UPDATE không expected-version predicate sau await. Cần contract CAS/revision/attempt fencing và failure-injection/restart/replay evidence; lookup integrity mới không thay concurrency proof. Các nhóm chưa reaudit toàn source lượt này vẫn là open work theo report và baseline, không kết luận thêm incident.
5. **O6/O7 — giữ gates:** full per-version inventory/link reconciliation, backup/restore drill, conflict resolution, resume và rollback giữ writes/events mới; Reviewer và human rollout/retention decision trước retire/drop. Manual reconciliation được chấp nhận nếu có authorized full inventory và recovery witness; không thêm yêu cầu tự động migrate.

### Điều chỉnh report/evidence trước Reviewer

- Giữ trạng thái partial và mapping O1–O7 hiện có; C3/neutral-label ghi **remediated in source + focused pass Coder-reported; independent verification pending**, không ghi full O2/O3/O5 accepted.
- Các commands phần Verification đầu report chưa có run identity/time/source-bound artifact tương ứng. Phân biệt evidence của batch cũ với remediation run mới; không dùng run mới chứng minh batch HTTP/error tests đã rerun.
- Bổ sung consumer reachability inventory, committed-handoff read-failure witness và verification bundle gắn exact source snapshot/dirty manifest, environment, command/run/result artifacts. Nếu tool không cung cấp counts/raw output hash, ghi unavailable và Reviewer bổ sung evidence phù hợp; không đoán số liệu.
- Bảng source identities trong report trùng năm checksums đọc lượt này. Đây là individual file identities, không chứng minh atomic snapshot của run. Baseline plan giữ historical findings cũ; dùng delta audit mới, không sửa approved bytes hoặc đổi approval tại chỗ.

### Evidence identities mới

| File | SHA-256 |
| --- | --- |
| `backend/src/modules/governance/sprint-registry.js` | `2f794586f76ed53789ea9940f701ab97b2d60fff2f2f855a9a852759af3d90cd` |
| `backend/tests/unit/sprint-registry-ticket-lookup.test.js` | `fa9c51d9899b9f990d146c38d77d1ce654b45917f626b196d256d118f24315e7` |
| `ui/nextjs/components/sprint-ticket-scope.js` | `8ea45909e2ebdff597cf4055b4d524079330661b6c021d1bab9001a471a9042d` |
| `ui/nextjs/components/sprint-plan-panels.jsx` | `5bb502e78ea5f90c50afcc25fbd397bd1de7fe5d30028ef7f30efc21eda2139a` |
| `ui/nextjs/tests/sprint-plan-panels.test.js` | `7edd42bd640d2334de90097fdc3312cf0c2a947f45c8016bdc969769646b2575` |

Consumer checksums không đổi so với mục 0a. **Giới hạn:** chỉ đọc rulebook/instructions/report/plan và targeted source/tests, tree/list/search; cập nhật audit document. Không chạy tests/browser/Git, sửa code/schema/report Coder/plan, migrate, commit/push, approve hoặc RUN. Không cần nguồn ngoài cho repository-specific evidence. **Chưa được retire/drop legacy store/schema.** SL sở hữu phân rã delivery và manifests trong approval hiệu lực.

## 0a. Follow-up mới nhất — GlobalToast và consumer recovery (2026-10-08)

**Mục này ưu tiên hơn mục 0 và findings lịch sử bên dưới khi có khác biệt.** Verdict vẫn partial; đây là nhận xét architecture theo source, không thay Reviewer hoặc cấp acceptance/RUN.

### Delta và evidence vừa đọc

- Report mới có SHA-256 `14e2070878c826e4b0235f82a8a1b24b2703fdd2a2b9eae34c5b80c8c1d3f98c`. Đã bổ sung claim GlobalToast hiển thị affected IDs và không offer retry; open UI recovery vẫn ghi partial.
- **Xác nhận static:** `ui/nextjs/components/GlobalToast.jsx:7–14` normalize error, hiển thị identifiers khi code lowercase đúng migration conflict, hiển thị requestId và chỉ render Retry nếu `normalized.retryable`. SHA-256 `8c97865e5a83b4e6923cbae8af907da9385f285016b75ed82c3ba7b0b9166d09`. Không tiếp tục nhận xét component chưa có nhánh hiển thị IDs.
- `ui/nextjs/lib/ui-error.js:23–39` giữ tối đa 25 safe IDs; SHA-256 `98bd04b6fade932c29729d37aab866e1bffebe9a5c31f23e8817e84da34f23c7`. Migration HTTP test `backend/tests/integration/error-envelope-transport.test.js:57–78` giữ SHA-256 `a59cad8b53cdc7579b1da34de91045e674d816c7952d3c2d16d65560a7849ea2`: listener thật + doubles + fetch/body assertion, chưa migration-specific requestJson/render witness.
- Registry và Sprint panel/test giữ checksum của audit trước. Đã đọc lại: `getByTicket:99–103` vẫn gọi getRevision cho unbound; detail vẫn trả public `tickets`; panel `:100` vẫn dùng nhãn approved vô điều kiện; panel test vẫn source includes. C3/approval-label chưa được đóng ở mức static.

### Gap cần sửa: component có nhánh render không đồng nghĩa actual consumer nhận diagnostic

**Major — consumer diagnostic loss (O3/O4/O5):** các consumers list đã đọc vẫn chuyển Error thành string:

- `ui/nextjs/components/pending-plan-approval.jsx:22–34,42`: listSprints nằm trong Promise.all; catch lưu `loadError.message`, render inline string. SHA-256 `9c72f538616652be6c28874c49c2587ff6d38521358d2654c65765c4e6ab6015`.
- `ui/nextjs/components/plan-review-modal.jsx:115–125`: listSprints sau handoff; catch lưu `error.message`, không giữ identifiers/retryable/scope/requestId. SHA-256 `ab764d4ade70cc1401be7823155f77bcef9f073364b078dd4c36b143e0c48beb`.

Đây là các đường source có mất structured diagnostic, **không khẳng định mọi UI path đều hỏng hoặc hai components đang được mount trong runtime hiện tại**. SL xác minh active reachability, mapping các callers listSprints và nơi render lỗi. Không coi việc thêm GlobalToast là đủ chứng minh actual Sprint conflict xuất hiện cho operator.

### Hướng chỉnh sửa và điều kiện đóng

1. **Diagnostic actual consumers:** giữ normalized Error object đến nơi render lỗi scoped/inline; message chỉ dùng để hiển thị, không thay toàn bộ error state. Dùng renderer phù hợp scope hiện hành, không ép mọi scoped error thành global toast. Không parse IDs từ message.
2. **Behavioral witness:** actual migration HTTP → requestJson → active consumer → DOM. Assert IDs/requestId hiển thị, không có Retry và không tự retry; unsafe IDs không lộ; >25 chỉ là bounded subset và có hướng truy xuất full authorized inventory. Test error không có IDs vẫn có recovery guidance. Chứng minh project isolation qua storage/composition thích hợp, không chỉ query trên doubles.
3. **Recovery an toàn:** hướng dẫn reconciliation rõ ràng, không tự migrate/approve/RUN. Automated reconciliation action **không tự là requirement bắt buộc**; manual recovery đạt nếu có full inventory được phân quyền và bằng chứng operator có thể tiếp tục sau resolve. Post-handoff list conflict không được tự repost approval/handoff đã commit; test reload/continue theo durable receipt để tránh duplicate.
4. **C3/approval-label:** skip record thực sự unbound, fail closed với partial/corrupt binding; regression unbound-before-bound/missing/empty/corrupt/cross-project. Đổi nhãn generic thành scope; approved chỉ dựa exact approval evidence. Thay test đang khóa chuỗi approved bằng render assertions draft/approved/full/partial/empty/unbound/legacy.
5. **Toàn scope:** writer authority, explicit full inventory readiness, atomic mutation, CAS/attempt fencing/durable replay, O6 migration/backup/restore/rollback giữ writes mới và O7 gates vẫn bắt buộc theo plan/mục 0. Lượt này không reaudit toàn source của các nhóm đó; report vẫn thừa nhận phần lớn còn mở. SL sở hữu phân rã/DAG/manifest; không coi thứ tự danh sách này là dependency delivery.

### Chỉnh report Coder trước gửi Reviewer

- Giữ partial; ghi GlobalToast là **implemented/static confirmed; active-consumer behavioral verification pending**, không ghi end-to-end recovery completed.
- Public immutable specs là `tickets`, nội bộ là `ticket_specs`; đổi generic approved ticket identities thành scope ticket identities và ghi approval-label còn mở.
- HTTP witness: implemented, focused pass Coder-reported, independent verification pending. Các lệnh hiện báo cáo không có component/browser witness.
- Bổ sung consumer structured-diagnostic loss, C3, atomicity/concurrency/replay và UI behavioral evidence vào open work; mapping O1–O7 kèm owner/evidence.
- Verification bundle cần source snapshot/dirty manifest, command/environment/exit code/pass-fail-skip, output refs + hashes, exact approval receipt và Reviewer verdict. Report chưa dẫn các artifact đó; không suy ra chúng không tồn tại ở nơi khác.

**Giới hạn lượt này:** đọc rulebook/root/UI instructions, report/plan/audit và targeted source/test, tree/list/search; chỉ cập nhật audit này. Reads/checksums từng file không phải atomic snapshot. Không chạy tests/browser/Git, sửa code/schema/report Coder/plan, migrate, commit/push, approve hoặc RUN. Không cần external references để chứng minh repository-specific claims. **Chưa được retire/drop legacy store/schema.**

## 0. Follow-up báo cáo mới — nhận xét và hướng chỉnh sửa (2026-10-08)

**Phần này supersede các nhận xét HTTP witness/report identity cũ bên dưới; các mục sau giữ làm lịch sử audit.** Không thay baseline plan, không cấp approval hoặc implementation acceptance.

### Delta đã đối chiếu

- Report hiện tại có SHA-256 `da62a8d8cf2f13b8d6c495b51ad71e06778271291e6e19fea141093a77bdc2dc`, vẫn ghi **partial implementation**: kết luận phù hợp với phạm vi được báo cáo.
- `backend/tests/integration/error-envelope-transport.test.js:57–78` đã có test khởi động HTTP listener thật, dùng actual Sprint router với Registry/Upload doubles, gọi `/forge/v1/sprints?project=PROJECT-A` và assert canonical 409 body. **Không tiếp tục nói chưa có HTTP listener/witness source.** SHA-256 test: `a59cad8b53cdc7579b1da34de91045e674d816c7952d3c2d16d65560a7849ea2`.
- Witness migration hiện chỉ dùng một safe ID; chưa đi qua `requestJson` hoặc rendered recovery UI. Test generic phía trên có client ingress nhưng không assert migration identifiers. Query PROJECT-A với doubles không chứng minh project isolation của storage/composition thật.
- Claim tests passed vẫn Coder-reported: lượt này không có công cụ chạy tests và chưa đọc output artifact/source-bound verification bundle. HTTP witness source có thật không đồng nghĩa đã độc lập xác minh runtime pass.
- Registry, Upload, UI panel và source-only panel test có whole-file checksum trùng audit trước. Đã đọc lại `getByTicket`, detail/bind/readiness, Upload inventory/update, panel và panel test; C3, approval-label và remove-trước/upload-sau vẫn còn ở mức static. Không suy ra đã xảy ra mất dữ liệu.

### Hướng chỉnh sửa trong scope O1–O7

| Nhóm / mức | Hướng sửa bắt buộc và điều kiện đóng | Owner / coverage |
| --- | --- | --- |
| C3 — Major | Phân biệt unbound hợp lệ và corrupt binding; bỏ qua record thực sự unbound khi lookup ticket, không nuốt lỗi immutable plan của bound record. Test unbound trước bound, missing ticket, empty Registry và corrupt bound; lookup vẫn tìm đúng ticket cùng Project. | SL/Coder, Reviewer kiểm chứng; O2/O3/O5. |
| Approval/UI — Major | Không gọi `ticket_ids` là approved nếu chưa có exact approval evidence. Dùng nhãn trung tính cho scope; trạng thái approved chỉ theo contract approval hiện hành, không suy từ IDs/status đơn lẻ. Render full/partial/empty/unbound/legacy/draft/approved; assertion DOM/status thay source `includes`. | O3/O5; thay public approval projection cần chốt contract. |
| Diagnostic end-to-end — Major evidence gap | Mở rộng migration-specific witness qua actual HTTP → `requestJson` Error → rendered scoped guidance/action. Assert safe IDs, >25/truncation behavior, unsafe entries, requestId và không tự retry non-retryable conflict. Chứng minh project isolation bằng wiring/storage phù hợp; nếu list bounded, không trình bày nó như full inventory. Recovery không tự migrate hoặc RUN. | O3/O5; giữ canonical error boundary. |
| Authority/atomicity — Major | Hội tụ writers, dashboard, Ticket/Sprint RUN/review/context và handoff về Registry; inventory consumer/producer có mapping rõ. Không chỉ vá read API. Mutation phải all-or-nothing/recoverable; CAS/expected-version và revision/attempt fencing; durable replay cho crash/restart/duplicate/stale events. Failure injection chứng minh committed visibility và basis không mất/ghi đè. | O1/O2/O4/O5; SL quyết định DAG/manifest, không thêm authority ngang quyền. |
| Inventory/migration — Blocker cutover | Đối chiếu toàn versions, history-only, same-ID revision/content conflicts và record/link/approval/attempt lineage; explicit readiness thay Registry non-empty. Backup + restore drill, dry-run/resume, conflict decisions và rollback giữ writes/events mới; fixture pass không thay evidence môi trường mục tiêu. | O6; human/rollout owner chốt conflicts và cutover. |
| Verification/retire — Blocker acceptance | Bổ sung exact approval receipt theo contract, source snapshot/dirty manifest, lệnh/environment/exit code/pass-fail-skip, output refs + hashes, coverage O1–O7 và Reviewer độc lập. O7 chỉ sau O1–O6 và human retention/compatibility/rollout decision. | SL/Reviewer/human; không retire/drop hiện tại. |

Đây là hướng outcomes/guardrails, không là ticket manifest hay thứ tự delivery bắt buộc. SL tự phân rã trong approval hiệu lực; chỉnh scope/public semantics vượt boundary phải quay lại Architecture/human.

### Chỉnh báo cáo Coder cho chính xác

1. Giữ verdict partial; đổi “HTTP witness Completed” thành “witness implemented; focused pass Coder-reported, independent verification pending” cho đến khi có bundle/Reviewer.
2. Public detail trả immutable specs trong `tickets`; `ticket_specs` là nguồn nội bộ. Viết rõ để không tạo kỳ vọng public field sai.
3. Đổi “approved ticket identities” thành “scope ticket identities” khi nói chung về Registry detail; chỉ dùng approved khi có evidence exact approval. UI hiện còn nhãn sai nên ghi thành open item, không gọi data clarity hoàn tất.
4. Thêm C3, atomic mutation, CAS/attempt fencing/durable recovery và UI behavioral evidence vào open acceptance work; báo cáo mới chưa nêu đủ các gap này.
5. Dẫn evidence artifact và coverage từng outcome; không sửa plan Draft/approved revision tại chỗ chỉ để cập nhật trạng thái triển khai. Finding UI bỏ identifiers đã lỗi thời; finding HTTP chưa có test source cũng đã lỗi thời.

**Giới hạn follow-up:** đọc report/plan/audit, rulebook/root instructions, targeted source/test windows và content search; chỉ cập nhật audit này. Không sửa báo cáo Coder/code/schema/plan, không chạy tests/browser/Git, migrate, commit/push, approve hay RUN. Đây là nhận xét architecture, không thay implementation review của Reviewer. Không dùng nguồn ngoài vì nguồn ngoài không chứng minh repository implementation.

## 1. Phạm vi và mức evidence

Đọc rulebook Architecture, root/UI instructions, architecture overview, completion plan, báo cáo Coder, source windows và tests liên quan. Đây là static architecture audit, không tự review implementation thay Reviewer, không cấp approval/RUN.

Không chạy tests/HTTP/browser/Git hoặc đọc runtime inventory. Forge hiện có không cung cấp công cụ thực thi tests. Các reads/checksums là từng file, không phải atomic snapshot. Claim test passed trong báo cáo là **Coder-reported**, chưa được lượt này xác minh độc lập.

Bảo toàn báo cáo Coder và plan; ghi audit riêng để không trộn claim implementation với audit verdict.

## 2. Phần xác nhận đúng hướng ở mức static

- Router list gọi Registry `listDetails()`, detail gọi `getDetail()` trước compatibility fallback.
- Khi Registry không rỗng và current legacy có ID ngoài Registry, router throw 409 với `identifiers`, `retryable:false`, `scope:scoped`.
- Backend formatter và UI `normalizeUiError` cùng lọc safe identifiers, tối đa 25; wrapper `normalizeBackendError` gọi normalizer này và `requestJson` gắn normalized fields vào Error.
- **Delta so với plan:** finding UI normalization bỏ `identifiers` đã sửa ở mức static. Không tiếp tục ghi đây là lỗi còn tồn tại.
- Unit UI mới kiểm tra identifier an toàn, loại string không hợp lệ/non-string, giữ non-retryable và scope. Backend formatter có assertion tương ứng.
- Registry giữ `ticket_ids`, chỉ lấy detail từ immutable `ticket_specs` thuộc scope; public projection trả detail trong trường `tickets`, không phải một trường public `ticket_specs`.
- Báo cáo Coder tự ghi partial implementation và còn mở writers/consumers/migration; không có claim hoàn tất O1–O7 để bác bỏ.

## 3. Findings / acceptance gaps

| ID | Mức | Evidence hiện tại | Yêu cầu đóng finding |
| --- | --- | --- | --- |
| A2-WIRE-EVIDENCE | Major, evidence gap | Server dùng canonical formatter; normalizer/client có đường giữ identifiers. Test list chỉ `assert.rejects(router.route(...))`, không listener/HTTP body; test UI gọi normalizer, không recovery component. | Actual Sprint route → server HTTP 409 → client Error → rendered scoped guidance/action; assert lowercase code, requestId, non-retryable, safe IDs, truncation và project isolation. Không gọi wire contract đã runtime-verified. |
| A2-INVENTORY | Major | Router `140–153` chỉ so IDs của current legacy khi Registry có record; Upload `36–50` list current nhưng detail đọc all versions. Same-ID content/revision conflicts và history-only không được guard phát hiện. | Full per-version inventory/reconciliation; active/archive classification được duyệt; explicit readiness/cutover state, không dùng Registry non-empty làm migration proof. |
| A2-AUTHORITY | Major | POST/PUT/DELETE vẫn Upload; Dashboard `37–70` union Registry/Roadmap/metadata và metadata overwrite; composition `133–179` review/intake/Sprint RUN vẫn đọc Roadmap/projection. | Tất cả readers/writers qua Registry boundary, cùng committed revision/hash/approval/status/attempt; restart và failure witnesses. |
| A1-APPROVAL-LABEL | Major | UI `100` luôn gọi scope/count là “approved”; Registry `42–49` trả cả unapproved/bound plan, không xuất approval evidence. `bindPlan` đặt awaiting_human_approval. | Draft và approved phân biệt dựa exact approval evidence; không suy approval từ ticket IDs. Render full/partial/empty/unbound/legacy/draft/approved. |
| A1-UI-EVIDENCE | Major, evidence gap | `sprint-plan-panels.test.js:6–11` chỉ đọc source và ba `includes`; focused command của Coder không bao gồm test này. | Component/browser behavior và accessible status/action witness; source includes chỉ supplementary. |
| A3-ROADMAP | Major | Handoff `24,51,56,73–80` dùng Roadmap để replay/admit/complete; search thấy active schemas/SQL/validator/prompts/UI/provenance còn Roadmap. | O1/O4: bỏ active dependency; giữ history decoding và immutable bytes; consumer inventory và compatibility evidence. Search hits không tự là quyền xóa. |
| C1-MUTATION | Major | Upload `53–60` remove current Sprint rồi gọi upload; validation sâu/duplicate/persistence còn có thể fail sau remove. | Atomic/recoverable mutation và failure injection; giữ committed visibility và immutable history. Đây là risk, không phải evidence đã mất dữ liệu. |
| C2-CONCURRENCY | Major | Registry `59–66,82–95` read/await rồi UPDATE không expected-version predicate. Terminal `25–35` dedup in-memory trước persistence, status và Roadmap là writes riêng. Bridge có CAS theo status nhưng chưa chứng minh attempt/revision fencing hoặc durable replay. | CAS/version/attempt fencing, stale/duplicate events, crash/retry/restart và partial-write recovery witnesses. Không mô tả bridge là hoàn toàn không có CAS. |
| C3-UNBOUND-LOOKUP | Major, phát hiện bổ sung | Registry cho phép register không plan; `getByTicket:99–103` gọi `plans.getRevision` cho mọi record, không skip unbound. Human Plan Store `65–66` reject null plan/revision. | Test unbound Sprint đứng trước bound Sprint: ticket lookup vẫn tìm được bound record; missing ticket có behavior rõ. Skip unbound phù hợp contract; corrupt bound plan vẫn fail closed. Chưa chạy reproducer runtime. |
| A4-MIGRATION | Blocker cutover/cleanup | Báo cáo Coder chưa cung cấp manifest, backup/restore drill, per-record/revision/link reconciliation, conflict decisions, resume hoặc rollback bảo toàn writes/events mới. | O6 verification bundle và dữ liệu môi trường mục tiêu có phân quyền; fixture tests không thay reconciliation thực. |
| A5-ACCEPTANCE-EVIDENCE | Blocker full acceptance | Plan còn Draft; report có command và claim passed nhưng không exact approval receipt, source snapshot/dirty manifest, output refs/checksums, exit/pass/fail/skip counts hay Reviewer verdict. | Exact approval theo contract và verification bundle source-bound; Reviewer độc lập. Không suy ra không tồn tại receipt ngoài tài liệu đã đọc. |

### C3 — đường tái hiện cần Coder/Reviewer xác minh

1. Register một Sprint `planned` không `planId/revision` ở position thấp hơn Sprint bound.
2. Register/bind Sprint sau với immutable plan chứa ticket cần tìm.
3. Gọi `getByTicket(ticketId)`: source hiện tại gọi `getRevision({planId:null, revision:null})` ở Sprint đầu và store reject `PLAN_ID_INVALID`, trước khi duyệt Sprint sau.
4. Kiểm tra cả missing-ticket, empty Registry và corrupt-bound cases; không dùng fallback legacy để che corrupted immutable basis.

## 4. Mapping outcomes

| Outcome | Verdict lượt này |
| --- | --- |
| O1 | Chưa đạt: active Roadmap contract/schema/UI vẫn còn. |
| O2 | Chưa đạt: writers và consumers chưa hội tụ; C1/C2/C3 còn mở. |
| O3 | Partial static: reads/diagnostic normalization tiến bộ; parity, real HTTP và UI recovery/render chưa đủ. |
| O4 | Chưa đạt: handoff/replay còn Roadmap gates. |
| O5 | Chưa đủ: approval-label, concurrent basis/fencing/recovery và source-bound verification. |
| O6 | Blocker: migration/restore/reconciliation/rollback evidence chưa có trong report. |
| O7 | Chưa đủ điều kiện retire/drop; phụ thuộc O1–O6 và human rollout decision. |

## 5. Evidence identity

Whole-file SHA-256 do Forge trả; line windows ghi ở findings. Bảng không thay source snapshot toàn repository.

| File | SHA-256 |
| --- | --- |
| `workflows/report-sprint-registry-cutover-current.md` | `385322eba4868164f642d8d653dafd07a173c30b3da6d889b6cdbce88cadc8da` |
| `workflows/plan-sprint-registry-cutover-completion.md` | `566c27dce44272e91b381ae6c215d006cba328518d5c458133eaf8a1b6986504` |
| `backend/src/transport/http/forge-v1-router.js` | `15cd5ee2aef10d401091cd7b8fb2e189460d1db0bf236199bb57c237e869ba21` |
| `backend/src/shared/error-contract.js` | `5646499c82dee2431fac72e63483ef08be07855e485c1b0be8c4ff5599da3707` |
| `backend/src/transport/http/server.js` | `8716f744bd39e342786bdfcfb59929cd20eed80bbed2c842dac15d832c26ad5b` |
| `ui/nextjs/lib/ui-error.js` | `98bd04b6fade932c29729d37aab866e1bffebe9a5c31f23e8817e84da34f23c7` |
| `ui/nextjs/lib/error-normalizer.js` | `e8f6c5d35e1c04069fab8612118b4cc0526eabcebb27c64630d0d1ddefce8456` |
| `ui/nextjs/lib/node-client-request.js` | `53f3aab378c488b6cf049180503ee7d40e8cee748ca3d5ae7eb9467734f3b793` |
| `backend/src/modules/governance/sprint-registry.js` | `191a3ba17b969604370393d1a1695d3c86c6e36ac5c27eb33e559f5bc5ed6f04` |
| `backend/src/modules/governance/human-plan-store.js` | `f5d22c54aaec4508142b854a5774f9e65f4383d763bae35bf7535fec351e4e6a` |
| `backend/src/application/sprint-plan-upload-service.js` | `a1bd031d0752fa1c4a4cac0c4dd57985d25f60fb0100fc19ad283086b70a9a96` |
| `backend/src/application/project-dashboard-service.js` | `742ab3ba7efa87ea1c9f47e44d80bb69e378866c8d3cbb07c9311b8d9a64d925` |
| `backend/src/application/plan-handoff-service.js` | `cfc40ffab5e21cd73b4046c74794b3f109152b0a85668598fbe28b9b7d18f9e1` |
| `backend/src/modules/supervisor/terminal-bridge.js` | `64be7346b4b7d57df2a6800d29c1ca53ea0fd75044ede449d51d888513df2e4d` |
| `backend/scripts/start-control-api.mjs` | `310d5e83db038de9ba210bbefdb7cae8dd02a7113168bd8c268e4d87a60933b4` |
| `ui/nextjs/components/sprint-plan-panels.jsx` | `5c6e0cffbaa1d4c9bed095980fdc53cc8bfd6cdfa2e0a2bbae8a12795394d852` |
| `ui/nextjs/tests/sprint-plan-panels.test.js` | `53a876b5ed4af1f2ece49e8e67806ebb0f975c97393e89ddaf54b81599b369a8` |
| `ui/nextjs/tests/error-normalizer.test.js` | `405f21101b18269caa03a710095316729e2b164f2f92bcaf457de02bc30a72ae` |
| `backend/tests/unit/forge-v1-sprint-registry-list.test.js` | `b8db231ac4d9361babbc1949599bf50828d4518036937c05a545a39d6503b600` |
| `backend/tests/unit/error-contract.test.js` | `da94f59338bcd60b25c1d49e63610360194d2be03d6ed02867e450ee7de01a1a` |

## 6. Handoff / giới hạn

- SL tiếp tục mapping O1–O7 → delivery/evidence theo completion plan và approval hiệu lực; audit không tự mở quyền dispatch.
- Coder bổ sung C3 witness/fix trong O2/O3/O5, approval-label và full diagnostic witnesses; không chỉ sửa finding mới nhất rồi gọi cutover complete.
- Reviewer xác minh implementation/tests độc lập; rollout owner/human quyết định migration, compatibility, retention và destructive cleanup trên evidence đầy đủ.
- **Không retire/drop schema/store cũ lúc này.** Không kết luận đã mất dữ liệu từ static failure windows.
- Lượt này chỉ tạo audit document; không sửa code/schema hoặc báo cáo Coder/plan, migrate, chạy tests/browser/Git, commit/push, approve hoặc RUN. Không dùng external architecture references vì kết luận dựa repository contracts/source; nguồn ngoài không chứng minh implementation.
