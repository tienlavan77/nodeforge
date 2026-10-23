<!-- Plan tổng hợp các thiếu sót cutover Sprint Registry để hoàn tất Project → Sprint → Ticket, migration an toàn và nghiệm thu có evidence. -->
# Plan: Hoàn tất Sprint Registry cutover — một authority, không mất dữ liệu

**Plan ID đề xuất:** `NF-SPRINT-REGISTRY-CUTOVER-COMPLETION-001`.
**Revision tài liệu:** `1`. **Ngày:** 2026-10-08. **Trạng thái:** Draft chờ exact human approval; chưa tạo/duyệt immutable runtime artifact, chưa cấp quyền RUN.
**Decision owner:** Project owner. Architecture chốt boundaries/outcomes; SL phân rã delivery; Reviewer kiểm chứng implementation độc lập; rollout owner do SL đề xuất và human xác nhận.
**Nguồn yêu cầu:** `workflows/plan-sprint-pipe.md` và audit `workflows/report-sprint-registry-cutover.md`.

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** đã sửa từng phần detail/list/UI nhưng Sprint/Ticket vẫn có nhiều nguồn đọc/ghi; guard mixed inventory chưa chứng minh reconciliation; evidence migration và nghiệm thu còn thiếu.
- **Kết quả:** hoàn tất mô hình `Project → Sprint → Ticket`, Registry là boundary duy nhất quản lý contract/lifecycle, mọi public consumer dùng cùng committed execution basis; dữ liệu legacy được migrate hoặc archive có truy vết và không mất dữ liệu.
- **Giá trị:** xử lý trọn các thiếu sót trong một phạm vi delivery được duyệt, thay vì chỉ vá finding mới nhất rồi gọi full cutover hoàn tất.
- **“Làm một lần”** là một plan bao trọn outcomes, không phải một ticket, một commit, một sprint hoặc big-bang migration. Các gate an toàn vẫn bắt buộc.
- Giữ mã **O1–O7 của plan gốc**; tiêu chí dưới đây bổ sung/chi tiết hóa, không giảm yêu cầu gốc. Plan mới chỉ thành baseline completion sau exact approval; không sửa artifact/approval cũ tại chỗ.

### Audit tổng hợp hiện tại

Đây là static architecture audit theo source windows/search đã đọc, không phải implementation review hoặc runtime acceptance. Không kết luận dữ liệu đã mất khi chỉ thiếu evidence.

| Finding | Trạng thái đối chiếu hiện tại | Phần thiếu phải giao trong plan |
| --- | --- | --- |
| A1 backend/UI | Registry tách `ticket_ids` và `ticket_specs`; UI phân biệt details/scope và cảnh báo thiếu specs. Test UI chỉ đọc source bằng `includes`. | Behavioral render/browser witness full/partial/empty/unbound/legacy; scope không đồng nghĩa approved nếu chưa có approval hợp lệ. |
| A2-MIXED / INVENTORY | List chặn current legacy IDs ngoài Registry; chỉ so ID, chưa xét cùng ID khác revision/content/ownership. Detail legacy đọc cả historical versions. | Full source inventory, phân loại active/history, reconciliation và explicit cutover state; không dựa Registry non-empty để chọn authority. |
| A2-WIRE | **Khác audit trước:** router đã dùng `identifiers`, `retryable:false`, `scope:scoped`; canonical formatter giữ tối đa 25 safe identifiers. Sửa đúng hướng ở mức static. | Actual route → HTTP → client → UI witness; UI `normalizeUiError` hiện bỏ `identifiers`, cần recovery contract end-to-end và cách truy xuất inventory đầy đủ khi diagnostic bị giới hạn. |
| A2 authority / parity | Sprint mutations còn Upload; dashboard union Roadmap/Registry/metadata. Ticket RUN intake, Sprint RUN projection và review wiring vẫn dùng Roadmap. | Converge tất cả readers/writers, không chỉ `/sprints`; cùng revision/hash/status/approval basis cho dashboard/detail/RUN. |
| A3 Roadmap | Handoff/recovery còn Roadmap gates; schemas, validators, prompts và UI còn required/label/wrapper Roadmap. | Chuyển active contracts, provenance, composition và UI; giữ immutable legacy bytes và history readers có boundary. |
| A4 migration | Report chưa dẫn backup/restore, per-record/revision/link mapping, conflict resolution, crash/resume hoặc rollback giữ writes mới. | Blocker cutover/cleanup cho đến khi có evidence đầy đủ O6. |
| A5 evidence | Plan gốc vẫn ghi Draft; report chưa dẫn exact approval receipt của cutover hoặc output tests gắn snapshot. Approval của plan khác/test fixture không thay thế. | Exact approval và verification bundle, source identity/checksums, independent review và rollout decision. |
| C1 mutation atomicity — Major | Upload update `53–60` remove Sprint rồi gọi upload; upload `81–85` kiểm tra duplicate trong all versions. Có failure window sau remove; chưa có failure-injection witness. | Mutation all-or-nothing/recoverable; lỗi validation/duplicate/persistence không làm mất current visibility hoặc đổi basis trái phép. Không khẳng định đã xảy ra mất dữ liệu. |
| C2 concurrency/event recovery — Major | Registry bind/status đọc rồi UPDATE không có expected-version predicate; terminal bridge ghi status rồi Roadmap, `seen` in-memory được thêm trước persistence. | CAS/attempt fencing và durable replay/recovery khi crash/partial failure; đây là rủi ro static, chưa phải runtime incident đã chứng minh. |

## 2. Phạm vi

### In scope

- Registry ownership cho Sprint/Ticket admission, upload, CRUD/replan/delete, approval resolution, lifecycle/status, human review, RUN, recovery, dashboard và context/provenance lookup liên quan.
- Active JSON/database schema, validators, API contracts, SL prompts, composition/wiring, UI và events phục vụ O1–O7.
- Migration bắt buộc: inventory toàn nguồn/versions, backup/restore, dry-run, mapping, conflicts, reconciliation, restart/resume, cutover và rollback giữ writes mới.
- HTTP diagnostic + UI recovery, parity/security/concurrency verification, docs/fixtures và retire obsolete paths sau gates.

### Out of scope

- Viết lại approval/provider/SDK, index/Git/execution engine hoặc refactor không cần cho outcomes.
- Tạo authority thứ hai, Roadmap đổi tên, union/fallback tự chọn contract hoặc dual-write hai nguồn chuẩn như trạng thái ổn định.
- Nới auth/approval/RUN/dependency/source-index-file-hash gates; sửa approved bytes hoặc chuyển approval sang hash mới.
- Xóa history/checkpoint/receipt/context/audit; force-add hoặc đổi ignore policy chỉ để vượt Git gate.

## 3. Hướng tiếp cận và guardrails

### Ràng buộc bắt buộc

1. **Authority:** Registry là ownership boundary, không bắt buộc một bảng/file. Ticket/status/immutable-plan adapters được tái sử dụng nội bộ nhưng không có public entrypoint cạnh tranh.
2. **Identity/security:** Project scope kiểm tra ở lookup, mutation, relation, diagnostic, approval và attempt. Cùng ID ở hai Project không được đọc/ghi hoặc leak inventory chéo; giữ role/auth/protected-path policy.
3. **Contract:** scope IDs và immutable specs tách rõ; details không lấy metadata/latest/Roadmap để lấp approved contract. Missing/duplicate/out-of-scope specs phải được phân loại; RUN thiếu execution contract hợp lệ fail closed. UI không gọi scope là approved khi chưa có approval evidence.
4. **Immutable approval:** giữ bytes/revision/hash/source binding của legacy artifact. Representation/schema mới không tự kế thừa approval; derived approval chỉ theo contract hiệu lực và exact parent lineage.
5. **Mutation:** expected revision/version, idempotency và atomic/recoverable commit. Replan tạo revision mới; không thay basis của running attempt. Delete/archive không xóa immutable evidence hoặc gây orphan; admission phải giữ dependency graph hợp lệ.
6. **Status/events:** persisted status gắn Project/Ticket revision/attempt; stale/duplicate/out-of-order events không ghi đè attempt mới. Commit trước success/event; retry/restart khôi phục partial state. Không dùng log/SSE payload làm contract authority.
7. **Compatibility:** có consumer/version inventory và adapter có thời hạn nếu cần; adapter chỉ dịch vào Registry. Không khôi phục route đã retired hoặc active Roadmap dưới tên khác.
8. **Migration:** không silent drop/last-write-wins; thiếu identity/link/approval phải preserve và block dữ liệu liên quan. Quiescence hoặc capture/replay phải bao phủ mọi writer và execution events trong lúc migration.
9. **Cutover:** dùng readiness/reconciliation evidence explicit, không suy từ số record. Registry unavailable/corrupt/error không fallback âm thầm sang legacy; archived history truy xuất qua history boundary, không thành active Sprint/RUN.
10. **Evidence:** source snapshot có checksum; commit nếu có, dirty manifest nếu chưa có. Report tách implemented/static/verified/runtime/accepted; không coi “test passed” không output là độc lập xác minh.

### Hướng đề xuất và phương án

- **Khuyến nghị:** incremental converge Registry hiện có → migration rehearsal → chuyển consumers/writer theo gate → parity/recovery verification → retire active legacy paths. Một plan, nhiều bước có rollback, SL tự quyết định delivery DAG.
- **Không chọn:** union collection tùy tiện để che migration gap; giữ current Roadmap làm reconciliation authority; big-bang drop stores trước proof; xây store quản lý Sprint ngang quyền.
- HTTP migration conflict đi qua canonical envelope hiện có, wire code lowercase, explicit non-retryable và safe project-scoped diagnostics. Diagnostic bị bounded không được trình bày như toàn bộ inventory; có manifest/detail access được phân quyền cho reconciliation đầy đủ. SL chọn chi tiết contract, đổi public semantics cần Architecture/human chốt.

### Dependency thật sự / quyết định chưa chốt

- Trước chuyển writer/RUN: contract Registry đủ Sprint/Ticket/attempt, project identity và approval mapping được verify; storage recovery protocol sẵn sàng.
- Trước production migration: consistent backup + restore drill, writer/event control, dry-run mapping/conflict evidence; rollout owner được xác nhận.
- Trước cutover: không còn unresolved conflict trong tập active chuyển đổi; per-record reconciliation và rollback bảo toàn writes mới đạt. Schema expansion/fixtures có thể làm trước; destructive contraction thì không.
- Trước retire/drop: O1–O6 đạt, consumer inventory hết active dependencies, human chốt compatibility window/retention/cleanup và rollout evidence. Approval plan không tự cho phép drop.
- Human quyết định conflict resolution/active-vs-archive khi evidence không đủ; không tự nâng historical-only/deleted record thành active. Historical artifacts luôn phải truy xuất được.

## 4. Khu vực dự kiến ảnh hưởng và evidence

Whole-file SHA-256 lấy trực tiếp Forge; line refs là windows đã đọc, không phải mutable-file allowlist. Các reads không phải atomic repository snapshot; SL phải source-bind và kiểm tra freshness trước triển khai. Không khảo sát `.forge/` runtime hoặc dữ liệu production.

| Thành phần / khu vực | Vai trò / evidence | SHA-256 |
| --- | --- | --- |
| `workflows/plan-sprint-pipe.md` | Baseline O1–O7/migration | `c6b5a3e215a9469442094f5bcadb786a36188e2f2327d0abbe73c8143780108c` |
| `workflows/report-sprint-registry-cutover.md` | Audit lịch sử/claims, 245 lines; không sửa thêm | `a439d5ff146e9d5cfcae86083ff293606f4c8680704a6c2c12cf6100324b6f09` |
| `backend/src/modules/governance/sprint-registry.js:19–105` | Scheduling, detail, binding/status/readiness | `191a3ba17b969604370393d1a1695d3c86c6e36ac5c27eb33e559f5bc5ed6f04` |
| `backend/src/transport/http/forge-v1-router.js:135–174` | List guard/legacy fallback/mutations, diagnostic mới | `15cd5ee2aef10d401091cd7b8fb2e189460d1db0bf236199bb57c237e869ba21` |
| `backend/src/shared/error-contract.js:21–43` | Bounded identifiers và HTTP formatter | `5646499c82dee2431fac72e63483ef08be07855e485c1b0be8c4ff5599da3707` |
| `backend/src/transport/http/server.js:71–75` | Canonical HTTP egress | `8716f744bd39e342786bdfcfb59929cd20eed80bbed2c842dac15d832c26ad5b` |
| `backend/src/application/sprint-plan-upload-service.js:24–98` | Legacy inventory/history, destructive update gap | `a1bd031d0752fa1c4a4cac0c4dd57985d25f60fb0100fc19ad283086b70a9a96` |
| `backend/src/application/project-dashboard-service.js:14–80` | Multi-source ticket/dashboard/status | `742ab3ba7efa87ea1c9f47e44d80bb69e378866c8d3cbb07c9311b8d9a64d925` |
| `backend/src/application/plan-handoff-service.js:15–94` | Parent receipt/child admission/Roadmap gate | `cfc40ffab5e21cd73b4046c74794b3f109152b0a85668598fbe28b9b7d18f9e1` |
| `backend/src/modules/governance/human-plan-store.js:25–79` | Immutable/index/source identity integrity | `f5d22c54aaec4508142b854a5774f9e65f4383d763bae35bf7535fec351e4e6a` |
| `backend/scripts/start-control-api.mjs:120–179` | RUN/review/intake/terminal production composition | `310d5e83db038de9ba210bbefdb7cae8dd02a7113168bd8c268e4d87a60933b4` |
| `backend/src/application/ticket-run-dispatch.js:16–65` | Ticket gates/resume/status path | `fda08a6eb5160f57bb42e6026a897bf1bbdf2fefa6d1caa2a8f7805e1eda5c3a` |
| `backend/src/modules/supervisor/terminal-bridge.js:22–56` | Split status writes/in-memory dedup/CAS | `64be7346b4b7d57df2a6800d29c1ca53ea0fd75044ede449d51d888513df2e4d` |
| `ui/nextjs/components/sprint-plan-panels.jsx:89–100` | Detail count/warning, active Roadmap label | `5c6e0cffbaa1d4c9bed095980fdc53cc8bfd6cdfa2e0a2bbae8a12795394d852` |
| `ui/nextjs/lib/ui-error.js:23–34` | Normalized error drops identifiers | `cfd4a6b409a7d14430ae1c529e704dd76b041a963378141ba928a4f6e118977f` |
| `ui/nextjs/tests/sprint-plan-panels.test.js:6–11` | Source-only test, không render | `53a876b5ed4af1f2ece49e8e67806ebb0f975c97393e89ddaf54b81599b369a8` |
| `backend/tests/unit/forge-v1-sprint-registry-list.test.js:7–17` | Router rejection, không HTTP listener | `b8db231ac4d9361babbc1949599bf50828d4518036937c05a545a39d6503b600` |
| `backend/tests/unit/error-contract.test.js:49–54` | Formatter test cho identifiers/non-retryable | `da94f59338bcd60b25c1d49e63610360194d2be03d6ed02867e450ee7de01a1a` |

**Search evidence, chưa full implementation review:** active `schemas/governance/{sprint-plan,ticket}.schema.json` required `roadmap_id`; SQL `index-migrations.js:129` NOT NULL; UI validator/upload/fallback dashboard; CRUD/human-review/intake/provenance/planner/architecture-manager/markdown handoff/composition còn Roadmap. SL phải đọc toàn bộ consumers/producers, policy/schema và tests thực tế, phân loại mỗi hit active/history/obsolete; không suy ra file được xóa từ search hit.

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Dependency / guardrail |
| --- | --- | --- | --- |
| O1 | Bỏ active Roadmap | Active schema/API/SQL/validator/SL prompt/UI tạo/mở Sprint trực tiếp dưới Project; không required/sinh Roadmap ID/version/wrapper giả; Ticket liên kết Sprint cùng Project; legacy-only fields ở history reader được phân loại. | Giữ immutable bytes; compatibility được chốt. |
| O2 | Một authority cho mọi Sprint/Ticket flow | Inventory và mapping mọi reader/writer/route/composition; upload/CRUD/replan/delete/intake/context/provenance/handoff/human-review/status/RUN qua Registry boundary. Mutation retry/CAS/partial failure không lost update, orphan hoặc silent contract fallback; committed state giữ qua restart. | Không thêm quản lý ngang quyền; delete giữ evidence, running-basis fencing. |
| O3 | List/detail/dashboard/RUN parity và diagnostic | Cùng Project/Sprint/Ticket revision/hash/approval/status/attempt cho committed basis; không metadata overwrite/ghost Sprint. Mixed/current/history/same-ID conflict, empty/unbound/unavailable/error có explicit behavior. Actual HTTP 409 đi qua canonical formatter và UI giữ safe diagnostics/non-retryable/recovery; bounded list có đường inventory đầy đủ. UI full/partial/empty specs, draft-vs-approved và refresh/reconnect được render/test thực. | O2; không suy approval từ scope; no fake specs/union fallback. |
| O4 | Handoff/recovery không cần Roadmap | Exact approved parent → validated child → Registry commit/binding → durable receipt. Completed/replay/continue dựa exact identity/hash/lineage, không roadmap snapshot; crash/retry/parallel handoff không duplicate hoặc đổi scope; handoff không RUN. | Giữ receipt cardinality/derived approval contract; đổi semantics cần review. |
| O5 | Approval/execution/concurrency an toàn | Missing/tampered/stale/unapproved/cross-project/invalid dependencies/missing specs fail closed. Replan revision mới không reuse approval; concurrent bind/status/delete/RUN có CAS/fencing. Individual/Sprint RUN, review/resume/human-review và duplicate/stale terminal event không đổi basis/status attempt khác; commit/event crash phục hồi được. | Giữ auth/source-index-file-hash/dependency/verification gates và transition semantics. |
| O6 | Migration/cutover/rollback không mất dữ liệu | Manifest toàn nguồn và versions; consistent backup+restore drill; dry-run per-record/revision/link mapping; tất cả nguồn có target hoặc archive được duyệt. Preserve IDs khi không conflict, mọi conflicting variant được giữ và human resolve; hashes/approvals/status/attempt/checkpoint/receipt/context/audit reconcile. Rerun/crash/resume/restart và rollback drill giữ writes/events mới sau cutover. | Block cutover/cleanup nếu thiếu proof; writer/event control, rollout owner và human decision. |
| O7 | Retire obsolete paths và bàn giao có evidence | O1–O6 đạt; không active Roadmap authority/gate/sync vòng. Consumer inventory, schemas/fixtures/docs cập nhật; legacy archive còn truy xuất; adapters có exit criteria/owner. Verification bundle và Reviewer verdict gắn snapshot; human xác nhận compatibility/retention/rollout trước drop. Git/artifact handoff đúng policy, không giả commit/approval. | Không grep-zero thay runtime proof; không tự approve/RUN/destructive cleanup. |

**Coverage:** A1→O3/O5; A2/MIXED/INVENTORY/WIRE→O2/O3/O6; A3→O1/O4/O7; A4→O6/O7; A5→O5/O7; C1→O2/O5/O6; C2→O2/O5/O6.
**SL handoff:** tạo ticket contracts và mapping từng outcome/criterion → ticket → verification/evidence; chủ động số Sprint/Ticket/ID/DAG/manifest. Mỗi ticket một implementation type hợp lệ, tối đa bốn mutable files theo policy hiện hành; file ≤250 lines, split khi cần. Không dispatch chỉ vì SP được lập.

### Verification bundle bắt buộc

- **Schema/API:** active contracts không cần Roadmap; compatibility/history decoding; project isolation và auth; canonical diagnostics qua real HTTP router/server/client/UI, >25 IDs/unsafe IDs/cross-project cases.
- **Parity:** registry-only, legacy-only, mixed, history-only, same-ID same/different content/revision/Project, metadata-only, unbound/draft, missing/partial specs, invalid links/hash/approval; list/detail/dashboard/RUN đối chiếu execution basis, không chỉ ID/count.
- **Mutations:** create/update/replan/delete/human review/status; expected-version conflict, retry/duplicate request; injected failure giữa remove/create/file/index/commit/event không mất visible committed state hoặc immutable evidence.
- **Recovery:** crash/restart tại admission/handoff/migration/event application; stale/duplicate/out-of-order attempts, parallel RUN và UI reconnect/missed events; durable replay không phụ thuộc in-memory dedup.
- **UI:** component/browser DOM và accessible status/action assertions; full/partial/empty specs, draft/approved, migration conflict/error/unavailable; source `includes` chỉ là supplementary guard.
- **Migration/rollback:** fixture rehearsal và evidence môi trường mục tiêu được phân quyền; checksums/record/link reconciliation, restore drill và post-cutover writes replay. Tests fixture không thay reconciliation dữ liệu thực.
- **Report:** lệnh thực tế do SL xác minh từ scripts, environment/time, exit code, pass/fail/skip counts, full output artifact refs/checksums, source commit hoặc dirty manifest/checksums; Reviewer kết luận độc lập từng criterion. Test skip/block/failure không ghi pass.

## 6. Rủi ro, giả định và câu hỏi mở

| Rủi ro / quyết định | Tác động | Evidence / giả định | Người chốt / phần bị block |
| --- | --- | --- | --- |
| Legacy conflicts/ownership/broken links | Blocker dữ liệu liên quan | Chưa đọc runtime inventory; không biết số record/conflict | SL xuất report, human quyết định mapping; block affected cutover/RUN. |
| External consumers và incompatible schema/API | Major | Consumer inventory chưa đầy đủ | SL đề xuất versioning/window; Architecture/human chốt trước incompatible rollout/retire. |
| Running attempts/writes trong migration | Blocker cutover | Wiring còn nhiều producers; chưa có capture/quiescence proof | Rollout owner + human xác nhận protocol/drill; không chỉ dừng HTTP writer. |
| Backup/archive retention và destructive contraction | Blocker cleanup | Chưa có retention/window/restore evidence | Human chốt duration/access/rollback boundary trên O6 evidence. |
| Working source thay đổi trong lúc audit | Major evidence | Router/error checksum mới khác report cũ; reads không atomic | SL source-bind snapshot, revalidate freshness; không dùng hash cũ cho implementation approval. |
| Parent→child cardinality/derived approval | Major nếu đổi contract | Handoff hiện một `sprint_id`; chưa chứng minh cần đổi | SL khảo sát; giữ contract, escalate Architecture/human nếu phải đổi. |
| Git staging workflows bị ignore | Handoff chưa xác minh | Report ghi failure; lượt này không chạy Git | SL xác minh status/policy, trình owner nếu cần quyết định; không force-add tự động. |

## 7. Acceptance criteria của plan và approval

- [x] Mục tiêu/in-out scope bao trọn phần thiếu của O1–O7 và owner yêu cầu migration không mất dữ liệu.
- [x] Static facts có refs/checksums; rủi ro/assumptions/runtime evidence gaps tách rõ.
- [x] Guardrails/dependency bắt buộc tách khỏi gợi ý delivery; không áp số ticket/manifest cố định.
- [x] Outcomes kiểm tra được, có coverage A1–A5/C1/C2 và verification requirements.
- [ ] Human approve đúng immutable plan identity/revision/SHA-256/Project theo contract hiệu lực. ID/revision đề xuất ở đầu tài liệu không thay artifact receipt; source SHA của Markdown không mặc nhiên là artifact SHA.
- [ ] SL source-bind, chứng minh coverage và policy admission, lập SP trước dispatch; approval plan không tự RUN ticket.
- [ ] Human/rollout owner chốt compatibility, conflict mapping, retention và rollback boundary trước các bước bị block.
- [ ] Reviewer xác minh implementation độc lập; chỉ full acceptance khi mọi O1–O7 có evidence và rollout decision tương ứng.

**Giới hạn lượt lập plan:** đọc rulebook/root/UI instructions, baseline/report, architecture overview/glossary, source windows/tree/list/search; tạo duy nhất tài liệu này. Không sửa code/schema/runtime hoặc report lịch sử; không migrate, chạy tests/browser/Git, commit/push, tạo approval receipt hoặc dispatch. Không cần external references vì quyết định dựa repository contracts; không coi tài liệu tham khảo ngoài là proof implementation.
