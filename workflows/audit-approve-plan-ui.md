<!-- Audit architecture/outcome coverage của Approve Plan UI; không thay independent implementation review. -->
# Audit: Approve Plan UI

**Ngày:** 2026-10-10 (UTC).
**Verdict:** REQUEST CHANGES — chưa đạt full plan acceptance.
**Scope:** Audit contracts, outcome coverage và evidence của `workflows/report-approve-plan-ui.md` so với `workflows/approve-plan-ui.md`; đọc các boundary code liên quan. Không thực hiện independent Reviewer verdict, chạy test/browser/build, kiểm chứng verification service hoặc rollout.

## 0A. Re-audit authorized final-snapshot recheck — 2026-10-10

**Verdict hiện hành: REQUEST CHANGES — remediation có tiến triển, chưa đủ full acceptance.** Mục này supersede disposition hiện tại ở §0; §§0–4 giữ làm lịch sử. Đây là audit coverage/contracts/evidence của report, không phải independent implementation review. Lượt này đọc rulebook Architecture, AGENTS, plan, report và audit; không đọc lại source, chạy test/build/browser hoặc kiểm chứng verification service.

**Document identities đã đối chiếu (whole-file SHA-256, không phải approval identity hay run manifest):**
- Plan revision 2: `a168225ccb114cc8422c84e931f974ee9b0b2443aab09c51b008f7e913f96e8e`.
- Report: `0c63e20b7aed0222053f08261118d2ee3da9fe4b5c068793fdf316834e003e01`.
- Audit trước lượt này: `42623e5543944e6acef1c6269b1716525b3869ed3353768779e59538595880fb`.

### Evidence được ghi nhận

- Report ghi focused recheck đúng tám file PASS, exit 0, service `ready_for_review=true`; run `VERIFY-RUN-ad0a8df1-6782-4659-bdb4-ea04749030f3`, evaluated `2026-10-10T11:30:00.967Z`. PASS được ghi nhận ở cấp service-reported aggregate; không suy ra individual test counts hoặc independent acceptance. Report ghi không sửa source/test sau check.
- Phạm vi check theo report: diagnostics fault injection/command regressions; handoff/readiness recovery; lifecycle projection và real Ajv schema; UI reducer/fan-out và loader/source assertions. Vì vậy nhận xét cũ “chưa fault-injection xác minh A3/A4” hoặc “schema chưa hoàn tất” không còn mô tả đúng evidence được report ở checkpoint mới. Chưa xác minh độc lập chất lượng/độ bao phủ implementation.
- FAIL `VERIFY-RUN-d57a8789-0d33-4d51-a974-2960638882c2` tại `2026-10-10T11:23:52.931Z` vẫn là FAIL lịch sử. Report ghi fixture và production readback dùng cột `plan_revisions.proposal_id` không tồn tại, đã sửa sang đọc exact parent binding từ immutable child JSON và kiểm tra bytes/hash/identity. Recheck sau sửa PASS; không tiếp tục coi “corrected snapshot chưa recheck” là blocker hiện tại, không đổi kết quả run cũ.
- A2 được report đã có strict lifecycle schema, validated projector, bounded reducer/fan-out và reuse page stream không interval/stream riêng. Source/reducer tests không thay browser/network witness; event không phải approval/readiness authority. Khi missed generating, reducer không bịa trạng thái; acceptance lifecycle hai tab vẫn cần witness.
- A3 witness đóng/mở lại SQLite có real Markdown readback/handoff/action nhưng File Service và Registry writes là doubles. Không đồng nhất close/reopen với kill-process, production Registry persistence hoặc cross-process fencing.
- A4 fault injection dùng artifact-store/Architecture doubles; loader được report vẫn đọc authoritative artifacts khi diagnostics lỗi và hiển thị warning đã redact. Đây là focused evidence, chưa chứng minh real persistence/crash durability.

### Disposition và evidence còn thiếu

| Finding | Trạng thái hiện hành | Việc còn cần để đóng theo plan revision 2 |
| --- | --- | --- |
| A1 → O1/O4 | OPEN — retirement chưa triển khai theo report | Negative direct-API security prerequisite; retire command/HTTP `/approve` thành hướng dẫn Coding; malformed-command/no-side-effects/help/callers và UI no-hidden-message witness |
| A2 → O3/O6 | OPEN — partial remediation + focused service-reported PASS | Browser hai tab generating → persisted/failed; conversation khác/null, reconnect/missed/cross-project; network idle/create/disconnect chứng minh không polling định kỳ và không thêm stream. Duplicate/out-of-order có reducer evidence nhưng cần xác minh wiring/runtime |
| A3 → O5 | OPEN — corrected readback + focused recovery PASS được report | Readiness conflict/error và crash sau completed, reload UI/recovery action; real Registry-write/kill-process evidence, exact one decision/child, không provider/ingestion lại, không RUN/dispatch |
| A4 → O1/O3 | OPEN — fault injection và loader isolation PASS được report | Source-bound kiểm chứng core success/error, exact artifact reviewability và no-extra-generation; real persistence/durability evidence theo contract, safe degraded diagnostics. Không gọi remediation này “chưa có fault injection” nữa |
| A5 → O2/O4/O5/O6 | OPEN — focused verification tăng coverage | Atomic/source-bound bundle hoặc mapping exact final source identities với run; commands/results/raw evidence/runtime version; applicable build/lint, browser/keyboard/focus/accessibility, HTTP auth composition, stale/double-click/timeout/recovery, independent Reviewer và smoke/rollback disposition |

**Không finding nào đóng toàn bộ.** O1 còn thiếu retirement; O2 thiếu rendered/accessibility; O3 có focused contract/reducer evidence nhưng thiếu runtime witnesses; O4 chưa có acceptance HTTP/security độc lập; O5 có recovery witness giới hạn; O6 chưa đủ verification/release evidence. `ready_for_review=true` của service chỉ là kết quả focused check, không đổi các disposition này thành accepted.

**Handoff cho SE:** Không yêu cầu rerun tám file chỉ vì báo cáo lịch sử bên dưới còn câu “not rechecked”; successful recheck đã supersede câu đó. Ưu tiên A1 sau security prerequisite và bổ sung các witnesses còn thiếu A2–A5; lập evidence map final snapshot O1–O6/A1–A5 rồi chuyển independent Reviewer. Nếu source thay đổi tiếp, verification cần gắn snapshot mới. Không giảm O5 hoặc defer recovery ngoài scope khi chưa có owner quyết định. Không sửa plan/report/code, approve, RUN, dispatch hay rollout trong audit này.

## 0. Re-audit report revision 2 — 2026-10-10

**Verdict hiện tại: REQUEST CHANGES.** Đây là đối chiếu coverage/evidence của báo cáo mới với plan revision 2, không phải independent implementation review. Không đọc lại source, chạy tests, browser hoặc xác minh verification service trong lượt này. Các nhận xét code ở §§1–4 bên dưới là evidence lịch sử, không mô tả mặc nhiên worktree hiện tại.

**Identity tài liệu đã đọc (whole-file SHA-256, không phải immutable approval identity):**
- Plan revision 2: `a168225ccb114cc8422c84e931f974ee9b0b2443aab09c51b008f7e913f96e8e`.
- Report: `c5d73bd2a42f635be09e5ad2cc5f90c842a437a60c912ed686b6a1fd0d175b8f`.

### Evidence mới và giới hạn

- Report mục “Revision 2 projector retry” ghi projector đã được sửa sau owner authorization và focused check hai file PASS tại `2026-10-10T10:58:46.503Z`, run `VERIFY-RUN-04a7d894-bdc2-4e8b-9d59-84204a2cb7fd`. Đây là service-reported evidence; Architecture chưa xác minh độc lập. Blocked projector trong checkpoint cũ đã được supersede, không tiếp tục coi đó là blocker hiện tại.
- Check mới chỉ bao phủ projector/native stream theo báo cáo. Không mở rộng PASS sang diagnostics, readiness, UI, full lifecycle schema hoặc browser E2E. Các checksum riêng trước check chưa phải atomic batch manifest.
- Report ghi header đã bỏ interval 5 giây và stream riêng, dùng connection của trang. Đây là implementation claim chưa có network/browser witness; không kết luận polling vẫn tồn tại từ phần revision 1, cũng không kết luận A2 đã đóng.
- Yêu cầu owner/plan revision 2 là **không polling định kỳ**, kể cả fallback mất stream. Câu “Polling là recovery fallback” ở A2 lịch sử bên dưới không còn là yêu cầu hiệu lực. Giữ reconcile theo trigger hữu hạn và authority từ API.

### Disposition A1–A5 hiện tại

| Finding | Tiến triển theo report mới | Điều kiện còn mở |
| --- | --- | --- |
| A1 — OPEN | Report vẫn ghi chat approval chưa retire | Security verification prerequisite, command/HTTP no-side-effects, malformed command và help/callers |
| A2 — OPEN, partial remediation | Producer/subscriber/allowlist và projector được report đã sửa; focused projector/stream PASS | Full schema compatibility, wiring E2E, hai tab/conversation khác-null, reconnect/missed/duplicate/out-of-order/cross-project; network witness không polling và không thêm stream |
| A3 — OPEN, unverified remediation | Readback readiness và giữ approved/completed khi readiness chưa xác lập được report đã sửa | Fault injection readiness/conflict, crash/restart/reload, recovery action và exact one decision/child; không gọi provider lại hoặc RUN |
| A4 — OPEN, unverified remediation | Diagnostics boundary được report đã tách khỏi core outcome | Inject start/complete/fail writes và publish errors; core success/error đúng, artifact reviewable, recovery không tạo revision dư |
| A5 — OPEN | Có thêm narrow service-reported PASS và source identities riêng | Source-bound verification bundle đầy đủ O1–O6/A1–A5, build/lint, rendered/browser/accessibility/security/recovery và independent Reviewer; smoke/rollback disposition |

**Không finding nào được đóng.** A3/A4 vẫn là rủi ro suy luận của audit trước và remediation claims chưa được fault-injection xác minh; không nâng thành lỗi runtime đã tái hiện.

**Handoff tiếp theo:** SE hoàn tất các tiêu chí còn thiếu trong plan revision 2 và evidence map. Report đã tách checkpoint lịch sử, nhưng bảng acceptance revision 1 không dùng làm disposition hiện tại. Independent Reviewer kiểm chứng implementation; owner quyết định acceptance/rollout. Không cần đổi phạm vi plan chỉ vì focused projector check PASS; không cấp approval, RUN hoặc dispatch.

## 1. Kết luận

Báo cáo minh bạch khi ghi additive batch và full acceptance còn mở; không có cơ sở chuyển trạng thái sang completed/accepted cho toàn plan. Source đã đọc xác nhận header nằm trước dashboard, Markdown modal dùng direct API, route handoff xác thực owner và exact identity, snapshot có cancellation/reconnect/polling. Đây là evidence tĩnh, không phải chứng minh rendered UX hoặc production behavior.

## 2. Findings cần xử lý

### A1 — Major: O1 chưa retire chat `/approve`

- **Evidence:** `backend/src/application/owner-chat-command-service.js:47–49,105–128` vẫn gọi handoff và chuyển readiness; `backend/src/transport/http/forge-v1-conversation-routes.js:72–78` còn approval entrypoint. Report §4 thừa nhận chưa retire.
- **Tác động:** Chưa đáp ứng yêu cầu owner chuyển approval khỏi chat. Compatibility tests cho hành vi cũ không chứng minh O1 mới.
- **Yêu cầu:** Sau khi direct API có security verification, `/approve` chỉ trả hướng dẫn Coding; không decision/handoff/SL/RUN, không rơi vào LLM. Cập nhật help và regression positive/negative của summary/plan cùng release.
- **Đóng finding:** Có test no-side-effects qua command và conversation HTTP entrypoints, kể cả malformed command; evidence UI không gửi command ẩn.

### A2 — Major: O3 lifecycle realtime chưa đủ contract/evidence

- **Evidence:** `ui/nextjs/components/coding-architecture-plans.jsx:16–25` subscribe generic events và poll 5 giây; `backend/src/application/plan-request-state.js:21–56` persist diagnostics nhưng không có lifecycle publisher tại boundary này. Report §4 ghi producer/schema và E2E còn mở.
- **Tác động:** Chưa chứng minh generating → persisted/failed được truyền ngay từ `/plan`; request ngắn có thể hoàn tất giữa hai lần polling nên UI không quan sát được generating.
- **Yêu cầu:** Hoàn thiện project-scoped lifecycle producer/projection/schema/subscriber; event chỉ invalidation, refetch vẫn authority. Polling là recovery fallback, không thay acceptance realtime.
- **Đóng finding:** Browser hai tab Coding/Architecture, active conversation khác/null, reconnect/missed/duplicate/out-of-order events và cross-project có redacted witnesses.

### A3 — Major: Recovery sau handoff completed nhưng readiness lỗi có thể mất khỏi header

- **Evidence:** `backend/src/application/plan-handoff-service.js:56–58` ghi receipt completed trước khi trả về; `backend/src/application/plan-approval-action.js:19–24` mới gọi Registry readiness sau đó. `markdown-plan-store.js:51–54` chỉ kiểm tra registration để giữ completed; `ui/nextjs/lib/coding-plan-loader.js:4–6` loại tất cả approved + completed.
- **Tác động (suy luận từ control flow, chưa chạy repro):** Nếu `setStatus(ready)` lỗi do dependencies/conflict hoặc process dừng giữa hai phase, receipt vẫn completed. Sau reload/poll, plan bị lọc khỏi header dù action chưa hoàn tất; readiness error cũng không được ghi vào handoff receipt bởi action boundary. Một đường recovery khác, nếu có, chưa được chứng minh cho ca này.
- **Yêu cầu:** Phân biệt approval, handoff persistence và readiness/recovery trong authoritative readback; giữ đường recovery có thể truy cập sau reload, không repost decision hoặc gọi provider lại khi child đã persist. Không đổi receipt completed thành failed giả và không bypass dependencies.
- **Đóng finding:** Inject lỗi readiness và crash sau completed; reload Coding phải thấy đúng disposition và retry hợp lệ; một decision/child, không RUN. Nếu dùng recovery tại sprint UI thay header, chứng minh wiring và outcome coverage rõ ràng.

### A4 — Major: Diagnostics persistence có thể thay đổi failure semantics của `/plan`

- **Evidence:** `backend/src/application/owner-chat-command-service.js:34–45`: `planRequests.start()` nằm trước core plan; `complete()` được await trong cùng try sau `createPlan()`; lỗi complete đi vào `fail()` rồi throw. `createPlan()` trả về sau artifact persistence tại dòng 100–101.
- **Tác động (suy luận từ control flow):** Diagnostic start lỗi có thể chặn planning vốn hoạt động; diagnostic complete lỗi có thể báo request failed dù artifact đã persist. Owner retry có nguy cơ tạo revision tiếp theo không cần thiết. Chưa có evidence những failure semantics này được owner chấp nhận; O1 yêu cầu giữ planning/storage semantics.
- **Yêu cầu:** Tách core artifact outcome khỏi diagnostic failure; reconciliation phải phân biệt persisted artifact với lỗi telemetry/state projection. Engineer chọn cách đảm bảo durability trong guardrails, không nuốt lỗi hoặc log secret.
- **Đóng finding:** Inject start/complete/fail write errors; artifact đã persist phải được recover bằng exact identity, không báo generation failed sai hoặc tạo revision trùng qua recovery.

### A5 — Major acceptance gap: O2/O4/O5/O6 thiếu verification độc lập/source-bound

- **Evidence:** Report §§3–5 chỉ service-reported PASS cho 8 test files; không raw run bundle/source-bound manifest, build/lint/browser E2E hoặc independent verdict. `ui/nextjs/tests/coding-plan-approval.test.js:36–54` dùng source assertions, không rendered modal/browser interactions. Action tests dùng mocked store/auth/registry.
- **Tác động:** Chưa chứng minh accessibility, thực tế stale/double-click/reload, HTTP auth composition, provider timeout/crash recovery hoặc deploy/rollback. Không suy ra cross-process fencing từ process-local guard/PID probe.
- **Yêu cầu:** Engineer bổ sung source-bound verification bundle, checks áp dụng, browser/security/recovery tests và independent Reviewer. Không gộp unrelated worktree changes để tạo evidence/commit batch.
- **Đóng finding:** Evidence map từng O1–O6 tới test/witness và exact source identity; limitations/provider blocked ghi riêng; release owner ghi smoke/rollback disposition. Recovery findings ngoài scope chỉ được defer khi owner chốt boundary, không tự giảm O5.

## 3. Outcome disposition

| Outcome | Audit disposition |
| --- | --- |
| O1 | Chưa đạt: A1, A4; summary/plan regression PASS chỉ được report, không rerun |
| O2 | Có source evidence header/review; browser/accessibility chưa xác minh |
| O3 | Partial: fallback/reconciliation có source; lifecycle và E2E thiếu |
| O4 | Có source guards và mocked tests; HTTP/security integration chưa độc lập xác minh |
| O5 | Partial: reuse receipt; A3 và crash/concurrency acceptance còn mở |
| O6 | Chưa đạt: A5; không rollout |

## 4. Identity và phạm vi evidence

Whole-file SHA-256 tại thời điểm audit (không phải approval artifact SHA):

- Plan: `6015ed56ae508999061487247fafb31683ed98fd0b0ba7b9813de19473e5ef10`.
- Report: `cca060be455b56e130a2c298023b6063261ab9051dbca1968bfb1b67b66006a3`.
- Action: `13fb672cf0005f9363b87cbcfa33a3fa81abd9dd4824edf981c44fadc9b339b7`.
- Command: `640c05b02b45dc458b678780dc64b169365ec3288c082f54dd59fbc183fb725e`.
- Loader: `782f1a912d96f074896440f9a78b655bc81ed5f6d469fe2b0869ce54b2fc34e8`.
- Markdown store: `498eee6c4cae0547971d5bc0de426acb1d53f1b791feea0d844a35222134d093`.
- Handoff: `d4b771ef118e380a59a36873e9254f4bcf0ec973dc1b9cca3743421cb87328b2`.

**Owner tiếp theo:** System Engineer xử lý và cung cấp evidence; independent Reviewer kiểm chứng implementation; human/release owner quyết định acceptance/rollout. Audit không approve, RUN, dispatch hoặc sửa implementation/plan/report.
