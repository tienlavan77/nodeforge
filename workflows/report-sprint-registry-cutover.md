<!-- Báo cáo trạng thái hard cutover Sprint Registry, nêu implementation đã xác minh và các phần chưa chuyển đổi. -->
# Báo cáo hard cutover Sprint Registry

**Ngày:** 2026-10-08. **Phạm vi:** phần triển khai đầu tiên của plan `Project → Sprint → Ticket` sau khi owner duyệt hard cutover.

## Kết quả đã triển khai

- `GET /forge/v1/sprints/:id?project=<project>` ưu tiên Sprint Plan Registry.
- Registry dựng Sprint detail từ record SQLite và revision immutable đã bind: identity, project, objective, dependency, lifecycle status, thứ tự, ticket scope, criteria và plan identity/hash.
- Nếu Sprint chưa có plan binding, API vẫn trả record Registry với danh sách ticket/criteria rỗng; không suy diễn dữ liệu từ Roadmap.
- Fallback vào Sprint Plan Upload cũ chỉ còn dùng khi Sprint không tồn tại trong Registry, để không làm mất khả năng đọc legacy artifact trong thời gian migration.

## Bằng chứng kiểm tra

- Đã thêm integration assertion vào `backend/tests/integration/human-plan-workflow.test.js`:
  1. tạo immutable plan;
  2. đăng ký Sprint với exact plan revision;
  3. đọc trực tiếp `/sprints/SPRINT-HTTP`;
  4. xác nhận HTTP 200, Sprint identity và ticket scope từ revision.
- Narrow check đã chạy: `node --test backend/tests/integration/human-plan-workflow.test.js`.
- Kết quả: **passed**.

## UI/UX và backend impact

- Backend: sửa lỗi 404 của direct Sprint URL khi Sprint đã được Registry quản lý nhưng chưa có Roadmap projection tương ứng.
- UI/UX: API trả Sprint object trực tiếp có shape tương thích phần lớn với UI detail hiện tại (`id`, `objective`, `tickets`, `exit_criteria`), nên direct view không cần Roadmap wrapper để render dữ liệu Registry.
- Không thay đổi RUN gate, approval, dependency gate, execution status hoặc UI composition trong đợt này; các luồng đó vẫn phải chuyển authority có kiểm soát ở các bước tiếp theo.

## Những phần chưa hoàn tất của hard cutover

Plan gốc là migration lớn, chưa thể coi hoàn thành chỉ với API detail:

- `roadmap-store` vẫn là write authority cho upload/CRUD, ticket creation, human review và một phần orchestration.
- Schema vẫn yêu cầu `roadmap_id`; chưa được bỏ vì còn nhiều consumer và historical evidence cần migration/reconciliation.
- Dashboard/UI hiện vẫn có response wrapper `roadmap` và legacy projection.
- List, ticket detail, RUN, status/recovery và migration legacy chưa cùng đọc một Registry projection duy nhất.
- Chưa có backup/migration/reconciliation/rollback evidence cần thiết trước khi retire hoặc xóa legacy Roadmap persistence.

Vì vậy trạng thái đúng là **hard-cutover foundation delivered; full source-of-truth migration pending**. Không có Roadmap mới được tạo bởi thay đổi này.

## Git handoff

Forge đã kiểm tra diff và status trước commit. Commit bị chặn bởi session change set có file `workflows/` đang bị `.gitignore` ignore:

```text
GIT_ADD_FAILED: The following paths are ignored by one of your .gitignore files:
workflows
```

Không có commit SHA nên không thể push. Cần xử lý policy staging của `workflows/` hoặc tách các workflow artifact khỏi Forge pending change set trước khi commit.

## Architecture compliance audit — 2026-10-08

**Verdict: NOT ACCEPTED đối với full cutover O1–O7.** Có foundation cho Sprint detail nhưng chưa bỏ Roadmap, chưa hợp nhất authority và chưa chứng minh migration không mất dữ liệu. Đây là audit boundary/contract và độ đầy đủ của evidence, không thay implementation review của Reviewer, không approve/RUN.

### Phát hiện và điều kiện đóng

| ID / mức độ | Evidence và tác động | Điều kiện đóng / owner |
| --- | --- | --- |
| A1 — Major | `sprint-registry.js:42-48` clone `plan.content.tickets`; assertion `human-plan-workflow.test.js:115-118` kỳ vọng `["TICKET-HTTP"]`. UI `sprint-plan-panels.jsx:100` lại đọc `ticket.id/title/priority`. Vì vậy nhận định shape tương thích UI chưa được chứng minh; fixture đang kiểm tra ticket IDs, không phải đầy đủ ticket detail. | SL xác lập contract ticket scope/detail, cung cấp projection qua registry và UI witness với dữ liệu thực; Reviewer xác minh. Không biến ID thành object giả hoặc lấy contract ngoài registry. |
| A2 — Major | `forge-v1-router.js:135-160`: GET detail ưu tiên registry nhưng list/create/update/delete vẫn gọi upload service; `sprint-plan-upload-service.js:72-102` vẫn tạo và save Roadmap. `project-dashboard-service.js:37-71` union registry/roadmap/metadata và có metadata overwrite. O2/O3 chưa đạt; không thể coi là hard cutover authority. | SL hoàn tất inventory reader/writer, chuyển lệnh và projection về registry; chứng minh list/detail/RUN parity, conflict handling và restart. |
| A3 — Major | `plan-handoff-service.js:24,41,51,56,73-80` vẫn bind/check Roadmap để handoff/recovery hoàn tất. Search xác nhận active governance schemas và UI validator vẫn yêu cầu `roadmap_id`; UI `sprint-plan-panels.jsx:23,90` vẫn dùng wrapper/nhãn Roadmap. O1/O4/O7 chưa đạt. | SL chuyển schema/API/UI/handoff trong guardrails; giữ immutable legacy evidence, bỏ active Roadmap gates và authority. |
| A4 — Blocker đối với migration cutover/destructive cleanup | Chính report thừa nhận chưa có backup/migration/reconciliation/rollback evidence. Chưa chứng minh O6 hoặc yêu cầu owner không mất dữ liệu; không kết luận đã mất dữ liệu. | SL/rollout owner cung cấp source manifest, backup + restore drill, mapping từng record/revision/link, conflict preservation/resolution, hash/approval/status reconciliation, rerun/crash/resume và rollback giữ writes sau cutover. Human chốt trước retire/drop. |
| A5 — Major về evidence/approval | Report ghi owner đã duyệt hard cutover nhưng `plan-sprint-pipe.md` vẫn Draft, chưa có approved identity/revision/hash được dẫn chiếu. Report ghi test passed nhưng không kèm output/count/source revision; phần Git ghi không có commit SHA. Audit không kiểm tra runtime approval, Git status hay chạy lại test nên không xác nhận hoặc phủ nhận các claims đó. | SL dẫn exact approval receipt/artifact và verification output gắn source revision/checksums; xử lý staging theo policy, không sửa ignore hoặc force-add chỉ để vượt gate. |

### Coverage theo plan

| Outcome | Kết quả audit |
| --- | --- |
| O1 — bỏ Roadmap | Chưa đạt: active schema/UI/handoff vẫn phụ thuộc Roadmap. |
| O2 — single authority | Chưa đạt: list/mutations và dashboard chưa hội tụ. |
| O3 — parity | Chưa đạt: detail khác nguồn list/dashboard; UI ticket shape chưa phù hợp fixture. |
| O4 — handoff/recovery | Chưa đạt: vẫn có Roadmap gate. |
| O5 — approval/execution | Có static evidence gate trong `sprint-registry.js:65-74` và integrity ở `human-plan-store.js:65-75`; chưa đủ end-to-end regression/parity để nghiệm thu outcome. |
| O6 — migration an toàn | Blocked acceptance: chưa có evidence bắt buộc. |
| O7 — cleanup | Chưa đạt và chưa được retire/drop trước O6. |

### Evidence snapshot và giới hạn

- Plan được đọc: SHA-256 `c6b5a3e215a9469442094f5bcadb786a36188e2f2327d0abbe73c8143780108c`.
- Registry: `f24810a3f5e229f4bc442bf2b865a94de12467718bc2ecfc9d9270b9ba82823a`.
- Router: `890dbc714581d349871c3a024024718d84e5a65948ae3a2879f7cb901dcb486b`.
- Integration source: `58b8d43a74044239b7cda631db5162821e6db0bbaac29f139c4570916530d3fe`.
- UI sprint panel: `9ca56c4cab889dbb6558e8acb18b4fe1e7ef4778a1dc8c83f142085a2747d39c`.
- Đã đối chiếu report/plan, source windows và content search; không dùng external references vì các kết luận phụ thuộc repository contract.
- Lượt audit chỉ bổ sung tài liệu này; không sửa code/schema/runtime, không migrate, không chạy tests, không commit/push. Claims test/Git của phần report gốc là reported evidence, không phải kết quả thực thi của lượt audit.

**Trạng thái nên dùng:** `Sprint detail registry-first foundation implemented; full cutover and lossless migration NOT ACCEPTED`. Tiếp tục delivery trong boundary đã duyệt và verification độc lập; chưa nghiệm thu toàn bộ yêu cầu owner.

## A1 remediation — 2026-10-08

Đã xử lý phần contract ambiguity của A1, nhưng không làm thay đổi kết luận full-cutover audit:

- Registry detail trả `ticket_ids` như danh sách identity immutable của approved scope.
- Trường `tickets` chỉ trả object từ `plan.content.ticket_specs`, được lọc theo `ticket_ids`; không dùng ID string như ticket object và không gọi Roadmap để lấp dữ liệu.
- Nếu plan chưa có `ticket_specs`, `tickets` là mảng rỗng còn `ticket_ids` vẫn bảo toàn scope; consumer phải xử lý trạng thái incomplete projection thay vì suy diễn ticket detail.
- Integration fixture tạo exact immutable plan có ticket spec và xác nhận direct Sprint detail trả object `id`, `title`, `objective`, `priority` cùng `ticket_ids`.

**Verification bổ sung:** `node --test backend/tests/integration/human-plan-workflow.test.js` — **passed** trong lượt remediation.

**Đánh giá cập nhật:** A1 contract mismatch đã được remediate ở Registry API và có backend witness. Chưa có browser/UI witness với component `SprintPlanDashboard`, nên chỉ đóng phần backend contract của A1. A2–A5 và O1–O7 ngoài phạm vi remediation này vẫn giữ nguyên trạng thái chưa đạt/blocked ở audit phía trên.

**Git:** Forge commit tiếp tục thất bại với `GIT_ADD_FAILED` vì session pending set chứa `workflows/` bị `.gitignore` ignore; không có commit SHA và không push.

## Architecture re-audit sau remediation — 2026-10-08

**Verdict: PARTIAL REMEDIATION VERIFIED (static); full cutover NOT ACCEPTED.** Đã đối chiếu phần remediation với source hiện tại, không chỉ dựa claim của report. Không thay implementation review độc lập, không cấp approval/RUN.

| Finding | Kết quả đối chiếu hiện tại | Phần còn phải chứng minh |
| --- | --- | --- |
| A1 — backend | `sprint-registry.js:42-50` tách `ticket_ids` khỏi object `tickets`, chỉ lấy specs trong immutable revision thuộc scope. `human-plan-workflow.test.js:112-119` đã có fixture và assertions tương ứng. Xác nhận remediation ở mức static contract/source; chưa xác nhận test pass bằng thực thi độc lập. | UI witness và các case thiếu/partial ticket specs. |
| A1 — UI còn mở (Major) | `sprint-plan-panels.jsx:100` vẫn đếm và render riêng `viewSprint.tickets`; không dùng `ticket_ids` hoặc báo incomplete projection. Với revision có scope nhưng thiếu specs, UI hiển thị `Tickets (0)` dù approved scope không rỗng. Không kết luận dữ liệu đã mất: IDs vẫn được API bảo toàn, nhưng scope bị che ở presentation. | Phân biệt scope count/detail count, hiển thị incomplete projection rõ; không suy diễn object từ ID. Kiểm tra full specs, thiếu toàn bộ và thiếu một phần specs qua component/browser witness. |
| A2 — Major, mở | `forge-v1-router.js:135-160` còn list/create/update/delete qua upload service và detail fallback; `project-dashboard-service.js:37-71` vẫn union registry/roadmap/metadata và trả wrapper Roadmap. | Inventory và convergence single authority, list/detail/RUN parity. |
| A3 — Major, mở | `plan-handoff-service.js:24,41,51,56,73-80` vẫn Roadmap gates/binding. Content search còn active schema required `roadmap_id`, UI validator, Roadmap label và wrapper giả. | Chuyển active schema/API/UI/handoff; giữ nguyên immutable legacy evidence. |
| A4 — Blocker nghiệm thu migration/cleanup, mở | Report cập nhật chỉ bổ sung A1; chưa cung cấp manifest, backup/restore, record/revision/link reconciliation, conflict resolution hoặc rollback bảo toàn writes mới. | Evidence đầy đủ O6 trước cutover/destructive cleanup; không coi thiếu evidence là chứng minh đã mất dữ liệu. |
| A5 — Major evidence, mở | Plan được đọc vẫn Draft và cùng checksum; remediation vẫn chỉ ghi test passed, không có output/count gắn source snapshot hay exact approval receipt. | SL cung cấp evidence approval và verification; Git status/commit claims chưa được xác minh ở lượt này. |

### Evidence snapshot của lượt re-audit

- `backend/src/modules/governance/sprint-registry.js`: SHA-256 `476db4aa3f27b9cf782d5cbcbe04140db7735a1b26b0e39326774db94c6e5bcb`.
- `backend/tests/integration/human-plan-workflow.test.js`: SHA-256 `ca394acf2477edb273db52a76de9f9d4abe65040df6b94c82b49bc41d4f56fff`.
- Router, UI panel, handoff, dashboard và plan đọc lại vẫn có checksum tương ứng đã dẫn trong audit/plan; các source windows trên là evidence hiện tại, không suy ra từ checksum cũ.
- Đã đọc role rulebook, root/UI instructions, architecture overview, plan và report; đối chiếu source windows và content search. Không cần external architecture references vì đây là kiểm chứng repository-specific contracts.
- Chỉ bổ sung report; không sửa code/schema/runtime, không migrate, không chạy tests/browser/Git và không commit/push. Test passed trong phần remediation vẫn là reported evidence.

**Kết luận cập nhật:** ghi nhận A1 backend đã sửa theo hướng đúng; A1 UI còn mở, A2–A5 chưa đủ điều kiện đóng. Coverage O1–O7 chưa đủ nghiệm thu full cutover hoặc cam kết migration không mất dữ liệu.

## A2 list remediation — 2026-10-08

Đã chuyển read path `GET /forge/v1/sprints` sang Registry-first:

- `sprintRegistry.listDetails()` dựng mỗi Sprint từ cùng Registry record và immutable plan revision mà detail endpoint dùng.
- Router trả Registry list khi Registry có Sprint; checkpoint decoration vẫn được giữ nguyên.
- Upload service chỉ là legacy fallback khi Registry rỗng, nhằm giữ khả năng đọc artifact chưa migrate; nó không còn là ưu tiên với Sprint đã đăng ký.
- Integration test tạo plan/revision, register Sprint, gọi `/sprints`, rồi xác nhận Sprint identity và `ticket_ids` đúng scope Registry.

**Verification:** `node --test backend/tests/integration/human-plan-workflow.test.js` — **passed** trong lượt triển khai list remediation.

**Đánh giá cập nhật:** A2 read parity đã tiến thêm một bước: list và detail cùng source Registry khi dữ liệu đã được register. A2 vẫn mở vì create/update/delete và dashboard còn Roadmap paths; fallback legacy cũng chưa được retire trước migration evidence. A1 UI, A3–A5 và O1–O7 không thay đổi trạng thái acceptance.

**Git:** commit Forge tiếp tục thất bại với `GIT_ADD_FAILED` vì `workflows/` bị `.gitignore` ignore trong pending set; không có commit SHA hoặc push.

## Architecture re-audit sau A2 list remediation — 2026-10-08

**Verdict: A2 list remediation VERIFIED STATICALLY; full cutover NOT ACCEPTED.** Phần này cập nhật kết luận hiện hành; các bảng audit trước là snapshot lịch sử. Audit chỉ kiểm tra boundary/contract và evidence, không thay implementation review của Reviewer hoặc cấp approval/RUN.

### Kết quả đối chiếu

| Finding | Evidence hiện tại / kết luận | Điều kiện đóng |
| --- | --- | --- |
| A2 — list remediation xác nhận | `sprint-registry.js:53-56` có `listDetails()` gọi cùng `getDetail()` cho từng record. `forge-v1-router.js:140-145` dùng Registry list trước và giữ checkpoint decoration. `human-plan-workflow.test.js:115-116` đã assert identity/scope ở list; `117-121` assert detail. Nhận định cũ “list luôn qua Upload” không còn đúng với Registry không rỗng. | Backend source đã thay đổi đúng claim; cần verification output và parity đủ revision/hash/status/RUN, không chỉ ID/scope. |
| A2-MIXED — Major, mới | Router `141-144` trả ngay toàn bộ Registry list nếu có ít nhất một Sprint, không kiểm tra legacy inventory. Với fixture Registry có A và legacy có B chưa migrate, B không xuất hiện trong `/sprints`, nhưng detail `149-152` vẫn có thể đọc B qua fallback; dashboard `project-dashboard-service.js:41-45` vẫn union cả ba nguồn. Đây là hệ quả static của nhánh điều kiện, chưa phải runtime witness hoặc chứng minh mất dữ liệu. Claim fallback “giữ khả năng đọc legacy” đúng cho detail/Registry rỗng, không bảo đảm list trong trạng thái mixed. | SL thêm mixed-store witness, Registry-empty/unavailable/error cases và admission/cutover gate chứng minh đủ inventory trước khi ưu tiên collection Registry. Không sửa bằng union tùy tiện ngoài authority; dữ liệu legacy phải migrate/reconcile hoặc lộ trạng thái chưa hoàn tất rõ ràng. |
| A2 — authority còn mở | POST/PUT/DELETE ở router `135-137,155-162` vẫn gọi Upload; dashboard `37-71` vẫn ghép Roadmap/metadata/Registry và trả wrapper `roadmap`. Search composition `control-api-platform.mjs:79` vẫn inject `roadmaps` vào Upload. | Converge writer/dashboard và legacy routes, chứng minh mutations phản ánh ngay list/detail/RUN sau commit/restart. |
| A1 UI — Major, còn mở | Đọc lại `sprint-plan-panels.jsx:100`: chỉ count/render `tickets`, chưa thể hiện scope `ticket_ids` hoặc missing specs. A1 backend tách scope/specs vẫn được giữ ở Registry `42-50`. | Full/partial/missing-specs UI witness và thông báo incomplete projection; không tạo object giả từ IDs. |
| A3 — Major, còn mở | Handoff `24,41,51,56,73-84` vẫn kiểm tra/bind Roadmap. Search active governance schemas và UI validator vẫn required `roadmap_id`; panel `90` còn nhãn Roadmap. | Chuyển active contracts/UI/handoff, giữ immutable legacy evidence. |
| A4 — Blocker migration/cleanup, còn mở | Phần report mới chỉ bổ sung list remediation; chưa dẫn source manifest, backup/restore, reconciliation từng record/revision/link, conflict resolution, resume hoặc rollback giữ writes mới. Không kết luận đã mất dữ liệu. | Đầy đủ O6 evidence trước cutover/retire/drop; rollout owner/human chốt compatibility và rollback boundary. |
| A5 — Major evidence, còn mở | Plan đọc lại vẫn Draft; report chưa dẫn exact approval identity/revision/hash receipt. Test vẫn chỉ ghi “passed”, chưa có output/count gắn snapshot. Fixture approval trong integration test không phải approval của plan kiến trúc. | Exact approval receipt và verification artifacts tương ứng source snapshot; claims Git chưa được xác minh bằng Git tools trong lượt này. |

**Coverage hiện hành:** O2/O3 tiến bộ ở Registry list/detail cho tập đã register, nhưng chưa nghiệm thu single authority hoặc parity toàn inventory. O1/O4/O6/O7 chưa đạt; O5 chưa đủ regression evidence. A2-MIXED phải được kiểm chứng và xử lý trước nghiệm thu read parity/cutover.

### Evidence snapshot và giới hạn lượt audit

| Source | Whole-file SHA-256 |
| --- | --- |
| `backend/src/modules/governance/sprint-registry.js` | `191a3ba17b969604370393d1a1695d3c86c6e36ac5c27eb33e559f5bc5ed6f04` |
| `backend/src/transport/http/forge-v1-router.js` | `acec6ab0d787df0410ef50e93ca63b157d17c77fca34214a2acabb60be3fc29d` |
| `backend/tests/integration/human-plan-workflow.test.js` | `3d3bf79e27dea6eb4da2fd76e3d7aaf5880e0b14ac497f414106d13b8f55c84d` |
| `backend/src/application/project-dashboard-service.js` | `742ab3ba7efa87ea1c9f47e44d80bb69e378866c8d3cbb07c9311b8d9a64d925` |
| `backend/src/application/plan-handoff-service.js` | `cfc40ffab5e21cd73b4046c74794b3f109152b0a85668598fbe28b9b7d18f9e1` |
| `ui/nextjs/components/sprint-plan-panels.jsx` | `9ca56c4cab889dbb6558e8acb18b4fe1e7ef4778a1dc8c83f142085a2747d39c` |
| `workflows/plan-sprint-pipe.md` | `c6b5a3e215a9469442094f5bcadb786a36188e2f2327d0abbe73c8143780108c` |

Đã đọc rulebook, instructions root/UI, phần overview architecture, plan/report và source windows; dùng directory/file listing và content search. Không cần external references vì kết luận phụ thuộc contract/source nội bộ. Chỉ bổ sung report; không sửa code/schema/runtime, không migrate, không chạy tests/browser/Git hoặc commit/push. Test passed vẫn là reported evidence, chưa được tái thực thi độc lập.

## Architecture re-audit sau A1 UI remediation — 2026-10-08

**Verdict hiện hành: A1 presentation remediation VERIFIED STATICALLY; full cutover NOT ACCEPTED.** Các audit trước là snapshot lịch sử. Architecture kiểm tra boundaries/contracts và evidence, không thay Reviewer, không approve/RUN.

| Finding | Kết quả đối chiếu source hiện tại | Điều kiện đóng |
| --- | --- | --- |
| A1 — presentation | `ui/nextjs/components/sprint-plan-panels.jsx:100` đã tách số details và số identities từ `ticket_ids`, có warning `role="status"` khi thiếu specs và chỉ render object trong `tickets`. Nhận định cũ UI chỉ hiện `Tickets (0)` không còn đúng với API Registry có scope. Registry `42-50` vẫn bảo toàn IDs và lấy specs từ bound revision. | Xác nhận sửa ở mức static; Reviewer cung cấp component/browser witness cho full, partial, empty specs và legacy response. |
| A1-TEST — evidence chưa đủ | `ui/nextjs/tests/sprint-plan-panels.test.js:6-11` là một test đọc file và kiểm tra ba chuỗi bằng `includes`; không mount/render component, không fixture full/partial/empty specs, không assertion DOM hoặc accessibility. Ngay cả khi test này pass cũng chỉ chứng minh source chứa chuỗi, không chứng minh hành vi UI. | Bổ sung behavioral witness và output gắn source snapshot; không gọi source-text assertion là UI runtime witness. |
| A2-MIXED — Major, còn mở | Router `140-145` vẫn trả riêng Registry collection khi không rỗng; legacy-only Sprint có thể bị thiếu trên list dù detail `148-152` còn fallback. Đây là hệ quả static, không phải bằng chứng mất dữ liệu. | Mixed-store witness và inventory/reconciliation gate trước collection cutover. |
| A2 — Major, còn mở | Router `135-137,155-162` vẫn mutations qua Upload; dashboard `37-71` vẫn union Registry/Roadmap/metadata và trả wrapper `roadmap`. | Hội tụ writer/dashboard và chứng minh list/detail/RUN parity sau commit/restart. |
| A3 — Major, còn mở | Handoff `24,41,51,56,73-84` vẫn Roadmap gates/binding; active governance Sprint/Ticket schemas và UI validator vẫn required `roadmap_id`; panel `23,90` còn wrapper/nhãn Roadmap. | Chuyển active contracts/handoff/UI, không sửa immutable legacy bytes/hash. |
| A4 — Blocker nghiệm thu migration/cleanup | Report mới chỉ thêm UI remediation, chưa dẫn backup/restore, manifest, reconciliation từng record/revision/link, conflict preservation/resolution, crash/resume hoặc rollback giữ writes mới. | Đầy đủ O6 evidence; chưa được retire/drop schema/store cũ hoặc destructive cleanup. |
| A5 — Major evidence, còn mở | Plan đọc lại vẫn Draft cùng checksum; report vẫn chưa dẫn exact approval receipt hoặc verification output/count gắn snapshot. Claims test passed/Git failure chưa được xác minh độc lập trong lượt này. | Exact approval identity/revision/hash receipt và verification artifacts; không suy ra approval từ nhãn/status tài liệu hoặc test fixture. |

**Coverage:** A1 backend/presentation có tiến bộ static, chưa đóng UI behavioral acceptance. O2/O3 chưa parity toàn inventory; O1/O4/O6/O7 chưa đạt, O5 chưa đủ regression evidence. Thiếu evidence không đồng nghĩa đã mất dữ liệu.

### Evidence snapshot / giới hạn

- UI panel SHA-256: `5c6e0cffbaa1d4c9bed095980fdc53cc8bfd6cdfa2e0a2bbae8a12795394d852`.
- UI source-text test SHA-256: `53a876b5ed4af1f2ece49e8e67806ebb0f975c97393e89ddaf54b81599b369a8`.
- Registry, router, dashboard, handoff và plan đã đọc lại source windows/nội dung; whole-file checksums vẫn trùng bảng snapshot của audit A2 phía trên.
- Đã đọc role/root/UI instructions, architecture overview, plan/report; dùng directory/file listing và content search. Không dùng external references vì phát hiện phụ thuộc source/contracts nội bộ.
- Chỉ cập nhật report; không sửa code/schema/runtime, không migrate, không chạy tests/browser/Git hoặc commit/push. Test passed trong remediation vẫn là reported evidence.

## A1 UI remediation — 2026-10-08

Đã xử lý finding A1 UI mà audit nêu:

- Modal Sprint detail hiện hiển thị hai số độc lập: số `details` đã load và số identity `approved` từ `ticket_ids`.
- Khi approved identity lớn hơn immutable ticket detail, UI hiển thị trạng thái accessible (`role="status"`) nêu chính xác số identity thiếu detail.
- UI chỉ render ticket cards từ `tickets`; không tạo object giả từ `ticket_ids` và không đọc Roadmap để lấp scope.
- Đã thêm `ui/nextjs/tests/sprint-plan-panels.test.js` để bảo vệ count contract và incomplete-projection warning.

**Verification:** `node --test ui/nextjs/tests/sprint-plan-panels.test.js` — **passed** trong lượt triển khai UI remediation.

**Đánh giá cập nhật:** A1 backend và presentation contract đã có static/backend witness. Browser rendering với full, partial và empty specs vẫn cần Reviewer xác minh trước khi đóng hoàn toàn UI acceptance. A2-MIXED, writer/dashboard authority, A3–A5 và O1–O7 giữ nguyên trạng thái mở/blocked.

**Git:** commit Forge của lượt này vẫn bị chặn bởi `GIT_ADD_FAILED` do `workflows/` bị `.gitignore` ignore trong session pending set; không có commit SHA hoặc push.

## A2-MIXED remediation — 2026-10-08

Đã xử lý fail-open inventory gap của Registry list:

- Khi Registry có Sprint, router đồng thời đọc legacy Sprint inventory.
- Nếu legacy có Sprint ID chưa nằm trong Registry, `/sprints` trả fail-closed `409 SPRINT_REGISTRY_MIGRATION_REQUIRED` cùng `sprint_ids` cần reconcile.
- API không union tùy tiện các nguồn và không ưu tiên Registry bằng cách che Sprint legacy chưa migrate.
- Khi không có mismatch, Registry list vẫn là source trả về; khi Registry rỗng, legacy list vẫn là compatibility fallback.
- Đã thêm `backend/tests/unit/forge-v1-sprint-registry-list.test.js` với mixed fixture: Registry `SPRINT-REGISTRY` và legacy `SPRINT-LEGACY`, xác nhận response bị block cùng ID legacy.

**Verification:** `node --test backend/tests/unit/forge-v1-sprint-registry-list.test.js` — **passed** trong lượt remediation.

**Đánh giá cập nhật:** Finding A2-MIXED đã có backend guard và focused test; chưa hoàn tất migration/reconciliation tự động, Registry-unavailable behavior, writer/dashboard convergence hay proof restart/RUN parity. A2 full authority, A3–A5 và O1–O7 vẫn mở/blocked theo audit.

**Git:** commit Forge của lượt này tiếp tục bị chặn bởi `GIT_ADD_FAILED` vì session pending set chứa `workflows/` bị `.gitignore` ignore; không có commit SHA hoặc push.

## Architecture re-audit sau A2-MIXED remediation — 2026-10-08

**Verdict hiện hành: mixed-current-inventory guard VERIFIED STATICALLY; full cutover NOT ACCEPTED.** Audit boundaries/evidence, không thay Reviewer hoặc cấp approval/RUN. Các bảng trước là snapshot lịch sử.

| Finding | Evidence hiện tại và điều kiện đóng |
| --- | --- |
| A2-MIXED — partial remediation xác nhận | Router `140-150` đọc legacy list và throw `409 SPRINT_REGISTRY_MIGRATION_REQUIRED` khi có ID legacy ngoài Registry; không còn âm thầm trả collection Registry trong mixed fixture này. Unit test `forge-v1-sprint-registry-list.test.js:7-17` assert rejected exception/code/status/IDs, không kiểm tra HTTP response. Cần actual transport witness và các case empty/equal/error/unavailable. |
| A2-WIRE — Major, mới | Report claim API trả cùng `sprint_ids` chưa đúng qua HTTP egress: `server.js:71-75` dùng `formatErrorBody`; `error-contract.js:22-37` chỉ giữ code/message/retryable/scope/requestId và lowercase code. `sprint_ids` bị loại; 409 mặc định retryable dù cần reconcile. SL xác lập diagnostic contract an toàn theo Project, không bypass canonical envelope; Reviewer kiểm tra HTTP body/UI recovery. |
| A2-INVENTORY — Major, còn mở | Guard chỉ so ID từ Upload `list():36-41`, mà list chỉ đọc current Roadmap. Upload `get():42-45` còn đọc all versions: historical-only Sprint có thể vẫn đọc detail nhưng không được guard phát hiện. Cùng ID khác revision/content cũng qua guard. Đây là giới hạn static, không chứng minh mất dữ liệu; cần manifest/reconciliation toàn nguồn, phân loại history-only và conflict witness, không ép mọi historical record thành active Sprint. |
| A2/A3 — còn mở | Mutations router `135-137,160-167` còn Upload; dashboard `37-71` còn union/metadata override/wrapper Roadmap; handoff `24,41,51,56,73-84` còn Roadmap gate. Chưa nghiệm thu O1–O4/O7; active schema/UI findings trước chưa được khảo sát lại riêng trong lượt này. |
| A1/A4/A5 — evidence chưa đủ | UI behavioral finding trước chưa có witness mới trong report. Chưa dẫn backup/restore, record/revision/link reconciliation, conflicts/resume/rollback giữ writes mới; O6 vẫn blocker cutover/cleanup. Plan đọc lại vẫn Draft, chưa có exact approval receipt; test passed/Git claims chưa có output gắn snapshot để xác minh độc lập. |

**Snapshot mới (whole-file SHA-256):** router `17ebedbc810540df9dc366a481bb39550aef00803ad1c3f1d333bcab87f99ce4`; mixed test `a643566a0c98219355669f9debfca6d5f3ebc73b3e80c8bf67b7897454547608`; Upload `a1bd031d0752fa1c4a4cac0c4dd57985d25f60fb0100fc19ad283086b70a9a96`; HTTP server `8716f744bd39e342786bdfcfb59929cd20eed80bbed2c842dac15d832c26ad5b`; error contract `4e4d9def8cb2aad9a7124ffdbf4d0aefdd806bef27288142ea4f8c687b9cd6da`. Dashboard/handoff/plan đọc lại trùng checksums lịch sử.

**Giới hạn:** đã đọc role/root instructions, architecture overview, plan/report và source windows, listing/tree/search. Chỉ cập nhật report; không sửa code/schema/runtime, migrate, chạy tests/browser/Git hoặc commit/push. Không dùng external references vì kết luận repository-specific. Chưa được retire/drop schema/store cũ; SL bổ sung evidence, Reviewer kiểm chứng độc lập trước full acceptance.

## A2-WIRE remediation — 2026-10-08

Đã xử lý HTTP diagnostic gap cho Registry migration guard:

- Canonical error envelope nhận `identifiers` là danh sách bounded, validated identifier; giá trị không an toàn hoặc không phải string bị loại.
- `SPRINT_REGISTRY_MIGRATION_REQUIRED` khai báo `retryable: false`, `scope: "scoped"` và đưa Sprint IDs cần reconcile vào `identifiers`.
- Điều này thay `sprint_ids` private field vốn bị HTTP error contract loại bỏ; transport có thể gửi diagnostic trong canonical error body mà không bypass envelope.
- Test error contract xác nhận sanitization identifier và conflict không retryable; test Registry list xác nhận mutation error mang `identifiers`.

**Verification:** `node --test backend/tests/unit/error-contract.test.js backend/tests/unit/forge-v1-sprint-registry-list.test.js` — **passed**.

**Đánh giá cập nhật:** A2-WIRE có static/backend witness cho safe diagnostic egress. Còn cần transport-level HTTP response witness, full legacy inventory/revision reconciliation, writer/dashboard convergence, restart/RUN parity và migration evidence. Full cutover/O1–O7 vẫn chưa được nghiệm thu.

## A2-WIRE client-contract follow-up — 2026-10-08

Đã nối tiếp diagnostic contract đến tầng UI:

- `normalizeUiError` giữ lại `identifiers` theo cùng policy bounded/validated với backend, để UI recovery theo scope có dữ liệu reconcile mà không phải parse message.
- Test UI xác nhận chỉ identifier hợp lệ được giữ và `409 SPRINT_REGISTRY_MIGRATION_REQUIRED` vẫn là non-retryable/scoped.
- Regression check chạy đồng thời backend envelope, mixed-inventory guard và UI normalizer:
  `node --test backend/tests/unit/error-contract.test.js backend/tests/unit/forge-v1-sprint-registry-list.test.js ui/nextjs/tests/error-normalizer.test.js` — **passed**.

**Đánh giá cập nhật:** A2-WIRE hiện có witness từ router error metadata qua canonical backend envelope đến UI normalizer. Chưa có component nào render recovery action/identifier, cũng chưa có transport-level HTTP witness; vì vậy đây không phải acceptance cho full cutover. A2-INVENTORY, mutation writers, dashboard/handoff convergence, migration/reconciliation evidence, restart/RUN parity và O1–O7 còn mở.
