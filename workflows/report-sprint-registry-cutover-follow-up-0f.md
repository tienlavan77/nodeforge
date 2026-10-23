<!-- Architecture follow-up cho Coding Registry dashboard; định hướng outcomes, không thay Reviewer hoặc quyền thực thi. -->
# Follow-up 0f — Coding dashboard remediation

**Ngày:** 2026-10-08. **Verdict:** tiến bộ thực chất ở dashboard scope và diagnostic; vẫn partial O2/O3, chưa nghiệm thu full O1–O7.
**Baseline:** completion plan revision 1 vẫn ghi Draft; không xác minh runtime approval receipt lượt này.
**Report:** `workflows/report-sprint-registry-cutover-coding-dashboard.md`, SHA-256 `2211c6c09d722ecb5979c12fc0d816ba5ced1a9937e012e0cb06b737f875cf6c`.

## 1. Mục tiêu / phạm vi

Ghi delta so với 0e và hướng hoàn tất trong outcomes hiện có. In scope: architecture boundaries, source reachability và acceptance evidence. Out of scope lượt này: implementation review thay Reviewer, sửa code/schema, chạy tests/browser/Git, migration, approve hoặc RUN. Không sửa báo cáo Coder/approved plan.

## 2. Facts đã đối chiếu

- `project-dashboard-service.js:38–41` chọn Registry branch khi có `listDetails`; production composition `start-control-api.mjs:168` truyền Registry. `registry-dashboard.js:5–25` lấy immutable specs, lọc Project trước detail reads, reject legacy-only Sprint kể cả Registry empty, reject persisted extra Ticket IDs. Same-ID legacy metadata không override title/objective của dashboard branch. Finding dashboard luôn union/overwrite đã lỗi thời đối với branch này, không phải toàn service.
- Đường active đã map: `/coding` → loader → `getProjectDashboard` → `requestJson` → Forge dashboard route → dashboard service/Registry; chiều trả về state → `CodingWorkspaceMonitor` → `CodingSprintDashboardState`. Page/monitor thực sự import và truyền state; không phải vá component chưa rõ reachability.
- Loader giữ normalized error object, generation bỏ stale response, reject foreign Project, cancel in-flight result; non-retryable conflict chặn stream-triggered reads tiếp theo. Renderer phân biệt unavailable/empty, giữ safe bounded IDs/requestId, guidance, không Retry với conflict; retryable Retry chỉ đọc dashboard. Nhận xét cũ `/coding` chỉ log rồi clear đã lỗi thời.
- Đọc toàn bộ `coding-registry-dashboard.test.js` (145 lines): năm behavioral cases dùng SQLite/immutable store thật, local HTTP/server/router/client thật, loader và React static HTML. Có 25-ID bound/unsafe filtering/requestId/no controls/no Retry/no auto-read retry, missing-safe IDs, foreign Project/corrupt foreign binding, empty Registry và stale response; continuation là manual read sau thay inventory double.
- **Giới hạn quan trọng:** renderer là `renderToStaticMarkup`, child RUN là button giả. Test không mount `CodingPage`/`CodingWorkspaceMonitor`/Sprint controls thực, không click Retry/reload/modal hoặc chạy browser. Legacy inventory là doubles; không test durable committed approval/handoff, revision/attempt status parity hoặc operational full-inventory reconciliation.
- Claim focused run `VERIFY-RUN-ccde9716-4b8a-468a-9324-4f249d567b5b`, exit 0, evaluated `2026-10-08T18:22:50.821Z` chỉ đọc từ report: **Coder-reported**, không independently verified. Không có raw artifact/TAP totals/environment snapshot trong evidence đã đọc; unavailable không được đoán.

## 3. Hướng đề xuất / guardrails

Giữ remediation này; không làm lại row CAS, observed draft basis hoặc Sprint callback propagation đã xác nhận ở 0c–0e. Tiếp tục đúng active consumers; không vá đường obsolete để đóng finding. Registry branch vẫn gọi Roadmap inventory, constructor vẫn requires legacy projections; compatibility union branch, Ticket detail/graph chưa hội tụ. Null Roadmap ID/version chỉ giữ container tương thích, không chứng minh O1 complete.

Task status hiện lấy `ticketStatusStore.get(ticket.id)` và chỉ kiểm Project (`registry-dashboard.js:18–21`), chưa exact revision/hash/attempt. Không suy `done` từ revision cũ là completion của immutable scope mới. Atomic snapshot/parity qua concurrent rebind/status cần witness riêng, không lấy immutable title assertion thay thế.

## 4. Outcomes / điều kiện đóng tiếp

| Outcome / mức | Kết quả cần đạt và acceptance witness | Boundary / owner |
| --- | --- | --- |
| O3 — Major evidence | Mount active page/monitor với HTTP/client thật trong môi trường verification được cấp quyền; DOM loading/empty/conflict/outage, IDs/requestId/bounded/missing IDs, actual controls bị suppress, Workspace Agent còn hiện. Click retryable Retry chỉ GET; conflict + SSE/reconnect/remount không tự POST approval/handoff/RUN. Resolve rồi reload tiếp tục an toàn; unmount không apply response cũ. | SL chọn harness/manifests; Reviewer kiểm độc lập. Static HTML hiện có là evidence hợp lệ nhưng chưa full interaction acceptance. |
| O2/O3/O5 — Major parity | Registry boundary cho detail/graph/status và writers; cùng committed Project/Sprint/Ticket revision/hash/approval/attempt. Test replan cùng Ticket ID khi status cũ done/running; old terminal/dependency evidence không đánh dấu scope mới hoàn tất. Concurrent read/rebind không trình bày mixed basis như committed snapshot. | Giữ auth và source/hash gates; đổi public status/approval projection cần contract review. |
| O1/O2/O3 — Major authority | Inventory từng active reader/writer/route/composition, compatibility/history/obsolete. Dependency legacy ở constructor và inventory phải có disposition; không xóa guard trước full reconciliation/readiness. Search thấy `NodeForgeApp.jsx:87–100` còn catch clear dashboard; imported_by rỗng không chứng minh active, cần phân loại reachability trước yêu cầu sửa. | Không grep-zero hoặc patch disconnected component làm acceptance. |
| O4/O5 — Major durable recovery | Nếu approval/handoff đã commit rồi dashboard/list read fail: tách read error khỏi mutation failure, reload exact durable approval/receipt, reopen/continue không repost decision hoặc tạo handoff mới. Failure injection + restart chứng minh receipt/lineage cardinality. | Guidance “do not repeat” và manual dashboard read hiện tại không thay proof này. |
| O2/O5 — Major admission/concurrency | Durable exact basis + attempt/receipt tại queue admission; pause submit để block/rebind, parallel process RUN, killed-process crash/replay/dedup. Fence terminal/failure catch và recover pre-submit checkpoint/protocol/conversation clears/status writes. | Các gap 0e vẫn mở theo report; lượt này không reaudit source execution. |
| O6/O7 — Blocker cutover/cleanup | Full per-version/source/link/approval inventory, same-ID content/revision conflicts, approved readiness; historical upgrade provenance, backup/restore, crash/resume và rollback giữ writes/events mới. Source-bound evidence + Reviewer + exact human rollout/retention decision. | Bounded diagnostic không thay inventory; chưa được retire/drop store/schema. |

Các dòng là outcome/guardrail, không áp số/tên tickets hay mutable-file allowlist. SL sở hữu delivery/DAG và mapping criteria; approval lập plan không tự cấp RUN. Human quyết định compatibility/retention/conflicts; thay semantics vượt scope phải escalate.

## 5. Evidence identities / handoff

Whole-file hashes đọc trực tiếp Forge; không phải atomic test snapshot. Bảy identities code/test chính khớp report:

| File | SHA-256 |
| --- | --- |
| `backend/src/application/registry-dashboard.js` | `477eb4e355e87eed097974d9a47d13f900095d5f5db11d82491034fd7c2436e6` |
| `backend/src/application/project-dashboard-service.js` | `da6e280a4e5601965319451ec49c702e6096e15dcfb1425937e740ac1bd384ed` |
| `ui/nextjs/lib/coding-dashboard-loader.js` | `56280678c8abf59a7c73ab65c68862f0bd5315b09d7bb8aed91db32ef31cc53f` |
| `ui/nextjs/components/coding-sprint-dashboard-state.js` | `32426f81335ace413bd916d33047d1b3c634f01cc857d778ce0d3825a482ed9d` |
| `ui/nextjs/app/coding/page.jsx` | `76633bd5a65db26c0293d4a4da3185c99addf966c8e9c09190c743da40b5c354` |
| `ui/nextjs/components/coding-workspace-monitor.jsx` | `c8ed8b6b7a02b4919424bfc70de3d614435e589c3640efee648fbd8f0573cca0` |
| `backend/tests/integration/coding-registry-dashboard.test.js` | `da5668c082e1fcdb3c5bcbffa0bcd6b790dabc5c6be3ae18710a63e30e276ff7` |

- Report giữ verdict partial và tách historical tests khỏi batch mới đúng hướng. Bổ sung mapping measured criteria → exact tested snapshot/dirty manifest/environment/output refs; run totals/hash unavailable phải ghi rõ, Reviewer bổ sung bằng tool được cấp quyền. Source navigation assertion chỉ supplementary, chưa đọc lại test đó lượt này.
- Giữ Git kết quả là Coder-reported `GIT_ADD_FAILED`, không có commit SHA/push; không force-add hoặc đổi ignore policy. Human/SL xử lý artifact handoff theo policy, không ghép staged prior work thành batch mới.
- Không dùng external references: nguồn ngoài không chứng minh repository wiring/receipt/evidence. Không đọc local Next guide vì không viết UI code; report ghi access denial, không biến thành guide đã đọc.
- **Kết luận:** implemented/static confirmed + focused pass Coder-reported; active mounted DOM/recovery/independent acceptance pending. Chỉ cập nhật audit tài liệu; không approve/RUN, không retire/drop legacy store/schema.
