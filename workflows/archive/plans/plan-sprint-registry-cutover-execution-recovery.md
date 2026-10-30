<!-- Plan outcome-based đóng dependency admission, execution recovery và evidence còn thiếu mà không thay approval cutover cũ. -->
# Plan: Sprint Registry — dependency admission và execution recovery

**Plan ID đề xuất:** `NF-SPRINT-REGISTRY-EXECUTION-RECOVERY-001`. **Revision:** 1. **Ngày:** 2026-10-09.
**Trạng thái:** Draft chờ human review/exact approval; Markdown này chưa là immutable runtime receipt, không cấp quyền RUN.
**Decision owner:** Project owner; Architecture giữ contracts/boundaries, SL sở hữu delivery/forecast, Reviewer kiểm chứng độc lập. Rollout owner cần human xác nhận.
**Baseline không sửa:** `workflows/plan-sprint-registry-cutover-completion.md`, revision 1, SHA-256 `566c27dce44272e91b381ae6c215d006cba328518d5c458133eaf8a1b6986504`; tài liệu baseline vẫn ghi Draft, lượt này không xác minh approval receipt runtime.
**Audit đầu vào:** `workflows/report-sprint-registry-cutover-follow-up-0h.md`, SHA-256 `b98e65a60abba5e60f5a2038691332c0e682f8e3ca9edcc38904d745e6770f72`; tiếp nối 0g, không giảm O1–O7.

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** dependency revalidation đã sửa resolve/wait race nhưng evidence dừng trước shared RUN/submit; claim, queue/inline launch và side effects chưa có một durable recovery disposition; missed event vẫn có thể để waiter pending.
- **Kết quả:** exact target/dependency expectations được giữ đến admission; mutation concurrent có commit ordering xác định; crash/restart/replay sửa đủ committed state mà không nhân đôi execution hoặc làm hỏng attempt mới.
- **Giá trị:** chốt đường về đích bằng outcomes/evidence rõ, không tiếp tục thêm một check trước dispatch rồi gọi execution an toàn.
- R1–R6 là mã remediation, không thay O1–O7 hay số/tên ticket. Đóng plan này không đồng nghĩa full cutover; các gate authority/UI/handoff/migration được carry-forward rõ ở mục 5.

## 2. Phạm vi

### In scope

- Dependency expectations trên production DAG → shared Ticket RUN → approved dispatch → actual submit/enqueue/inline execution và continuation.
- Durable admission/reconciliation liên kết Project/Ticket/Sprint immutable plan, scheduling expectation, execution ID, dependency completion attempts, job/launch, occupancy/workspace.
- Event application/projection repair, waiter invalidation/missed-delivery/reconnect/restart; partial clears/review side effects và producer/compatibility inventory phục vụ execution.
- Source-bound verification bundle, mapping remediation vào full completion gates và delivery forecast.

### Out of scope

- Rewrite queue/provider/SDK/Git/index engine, authority thứ hai, general refactor hoặc tính năng mới không cần cho remediation.
- Tự migrate production, destructive cleanup/retire/drop legacy, force-add workflows hoặc đổi ignore policy.
- Nới auth/approval/RUN/source-index-file-hash/verification gates; sửa immutable approved bytes, tự chuyển approval sang revision/hash mới.
- Ép direct-code/tool-lab thành Sprint workflow khi không thuộc contract đó; inventory phải xác định boundary thay vì xóa mọi compatibility entrypoint.

## 3. Hướng tiếp cận và guardrails

### Ràng buộc bắt buộc

1. Registry là authority boundary; receipt/outbox/journal là mechanism nội bộ/recovery evidence, không nguồn contract ngang quyền. Không dùng SSE/log/projection làm approval authority.
2. Giữ exact Project/Sprint/Ticket plan revision/path/hash và execution ownership. Original dependency completion attempt không được silently thay bằng current/latest/new done.
3. Không giữ pre-wait scheduling version cố định khiến same-plan running→done hợp lệ bị reject. Capture admission expectations sau revalidation; thay đổi trong admission window phải được phát hiện/serialize theo protocol đã chốt.
4. Có điểm commit/linearization quan sát được, request/admission identity bền vững và retry disposition. Idempotency chỉ theo request_id hoặc in-memory active map không đủ chứng minh cùng execution không launch hai lần.
5. Fence trước irreversible mutation/integration, không chỉ terminal publication. Archive/recovery giữ checkpoint/protocol/conversation/evidence; orphan không tự RUN hoặc repost approval.
6. Event persistence và application là hai bước riêng; mỗi mandatory consumer có progress/reconciliation identity hoặc equivalent. Terminal status đã commit không ngăn repair projection còn thiếu; replay không overwrite attempt mới.
7. Project-scoped diagnostics, safe bounded IDs/requestId, non-retryable reconciliation conflict; authorized full evidence vẫn truy xuất được. Không leak inventory chéo Project hoặc parse identity từ message.
8. Giữ compatibility/lifecycle/public error semantics cho đến khi có inventory và quyết định đúng thẩm quyền. Schema additive nếu cần vẫn phải có upgrade/restart/rollback verification; không drop legacy trong plan này.

### Hướng đề xuất / options

- **Khuyến nghị:** admission intent + durable committed receipt/recovery journal hoặc outbox equivalent bên trong Registry boundary; đối chiếu expected dependency set tại commit và trước launch nếu cần; reconcile pending/committed/orphan qua exact identity.
- **Option:** single-database transaction cho các state cùng SQLite, kèm recoverable external filesystem/queue/occupancy side effects. Transaction SQLite đơn lẻ không chứng minh atomicity với inline provider launch hoặc file-backed queue.
- **Không chọn:** thêm final check đơn lẻ; reload dependency mới để retry old intent; republish cùng event ID và giả định mọi subscriber đã được repair; bỏ compatibility guard chỉ vì new helper pass.
- SL tự chọn chi tiết storage/locking và phân rã trong guardrails; public/schema/security semantics vượt boundary phải quay lại Architecture/human.

### Dependency thật sự / quyết định chưa chốt

- **Trước implementation admission contract:** xác định actual queue và inline-launch consumers, owner của recovery; đề xuất commit point và ordering với block/rebind/stop. Recommendation: mutation trước admission commit làm stale intent fail closed; mutation sau commit không âm thầm đổi basis/attempt, tuân stop/cancel/fence contract. Human/Architecture chốt nếu thay public semantics.
- **Trước cho worker/inline launch tiếp tục sau restart:** committed admission identity và durable ownership/disposition phải được xác minh; pending/orphan không tự dispatch.
- **Trước acceptance execution:** R1–R5 phải có actual production-path/multi-process/crash evidence và Reviewer source-bound verdict (R6). Không phụ thuộc thứ tự số R để lập delivery DAG.
- **Trước full cutover/retire:** vẫn cần O1–O7 completion evidence và human compatibility/retention/rollout decision; plan này không cấp destructive permission.

## 4. Khu vực dự kiến ảnh hưởng và evidence

Refs/checksums đầy đủ tại audit 0h mục 4; các reads là individual files, không atomic tested snapshot. Candidate areas định hướng discovery, không mutable allowlist; SL xác minh reachability và manifest.

| Khu vực đã khảo sát | Vai trò / evidence | Mức chắc chắn |
| --- | --- | --- |
| `sprint-execution-wait.js:32–70`, `sprint-dag.js:32–53` | Capture/revalidation và fenced/legacy branch selection; D1/D2 | Static source confirmed; actual race outcome chưa chạy |
| `start-control-api.mjs:126–139`, `ticket-run-dispatch.js:23–65`, `approved-ticket-dispatch.js:10–30` | Production shared RUN, await/clears/claim và target validation; dependency expectations chưa forward | Targeted production wiring confirmed |
| `nodeforge-task-integration.js:31–141`, `production-runtime.js:65–144`, `durable-queue.js:14–41` | Review side effects, file queue/occupancy và inline launch; submit bypass startTaskExclusive | Static boundary confirmed; chưa full worker inventory |
| `execution-event-bus.js:22–45`, `terminal-bridge.js:23–76`, waiter :8–29 | Append/fanout/application/recovery và pending waiter | Failure-window risk, không incident đã chứng minh |
| `sprint-registry.js:59–135`, `ticket-execution-identity.js:5–22` | Row CAS, immutable vs scheduling identity | Static contracts confirmed |
| `sprint-dependency-revalidation.test.js:1–132` | Sáu scenarios, real SQLite + controlled doubles | Đọc toàn source; pass Coder-reported |
| Completion plan và follow-ups 0f/0g | Authority/UI/handoff/migration gates carry-forward | Requirements/evidence gaps; không reaudit toàn UI/migration lượt này |

## 5. Outcomes và điều kiện nghiệm thu

| Mã / coverage | Outcome bắt buộc | Acceptance criteria quan sát được | Dependency / guardrail |
| --- | --- | --- | --- |
| R1 — O2/O5, D1 | Dependency intent end-to-end | Original Project/immutable plan/completion execution expectations còn kiểm chứng được qua actual DAG→shared RUN→submit. Pause sau final revalidation và trong checkpoint/workspace/occupancy awaits; rebind/block/replacement không được âm thầm admit dependent. Có local/external/multiple-dependency cases; same-plan running→done hợp lệ vẫn dispatch. | Commit ordering R2; không substitute latest attempt hoặc khóa pre-wait version mãi mãi. |
| R2 — O2/O5, D2 | Admission durable và recoverable | Exact target + dependencies + execution liên kết job/inline launch/occupancy/workspace qua committed evidence. Parallel actual RUN nhiều process không tạo hai committed admissions/launch trái protocol. Kill/restart trước/sau intent, claim, queue save, receipt và launch boundary; pending/committed/orphan được reconcile có evidence, không mất hoặc nhân đôi execution. Duplicate request và response/read loss tiếp tục cùng receipt; conflict không tự retry old intent. | Human/Architecture chốt commit/stop ordering; queue delivery retry không mặc nhiên bảo đảm side effect exactly-once. |
| R3 — O2/O3/O5, D3 | Event application và waiter phục hồi | Inject failure sau append, status, projection và trước notification; restart/replay repair mọi required projection và waiter theo exact execution. Test production persistent bus, duplicate IDs, missed fanout, reconnect và concurrent consumer. Dependency bị invalidated không có terminal fanout phải đạt observable reconciliation/cancellation disposition theo policy thời gian được chốt, không pending vô hạn; listener cleanup khi stop/unmount runtime consumer. | Không dùng duplicate publish đơn lẻ; projection không authority, stale event không overwrite. |
| R4 — O2/O5, D4 | Side effects attempt-scoped | Inject lỗi/kill từng checkpoint/protocol/conversation clear, review findings/checkpoint, integrate/ledger release. Fence trước irreversible commit; stale review hoặc delayed failure không sửa workspace/evidence attempt mới; partial state có archive/continuation rõ và không orphan auto-RUN. | Admission/ownership protocol R2; giữ audit/history, không remove-trước rồi hy vọng rollback. |
| R5 — O1/O2/O5, D5 | Producer/compatibility coverage | Authorized inventory actual entrypoints, status writers, queued review/revision producers và recovery consumers; mỗi path classified active/history/obsolete/standalone với owner, preconditions và witness hoặc explicit retirement gate. Không bypass exact execution/dependency requirements trên Registry-owned paths; compatibility có exit criteria, chưa xóa khi reconciliation chưa đạt. | Không ép standalone workflow ngoài scope; incompatibility cần decision trước rollout. |
| R6 — O5/O7 | Nghiệm thu source-bound và delivery forecast | SL mapping từng criterion R1–R5 + carry-forward gates vào ticket/evidence, owner, dependency/blocker, estimate và forecast theo mốc; Reviewer độc lập kết luận từng criterion với source snapshot/dirty manifest, environment/Node version, commands/exit/counts/raw artifact refs+hashes. Unavailable/skip/block phải ghi rõ. Human xử lý ignored-artifact handoff theo policy, không giả Git commit. | Không hứa ngày khi chưa SL estimate; không dùng six registrations làm TAP totals hoặc receipt approval. |

**Carry-forward bắt buộc, không được đóng bằng R1–R6:** O1/O2 authority cho detail/graph/intake/review/writers; O3 mounted `/coding` controls/Retry/SSE/reconnect/unmount; O4 exact committed approval/handoff continuation không repost mutation; O6 full inventory/per-version links/approval provenance, historical upgrade, backup–restore và rollback giữ writes/events mới; O7 consumer retirement, Reviewer bundle và human rollout/retention. SL phải giữ ledger riêng cho các gate này, không gọi chúng scope phát sinh mới.

**Gợi ý delivery, không bắt buộc:** chốt protocol/admission trước; inventory và chuẩn bị persistent recovery witnesses có thể song song; nghiệm thu execution R1–R5, rồi nối vào mốc authority/UI/handoff và full cutover của completion plan. SL chủ động ticket IDs/số Sprint/DAG và tối đa bốn mutable files/ticket theo rulebook, file ≤250 lines; không dispatch chỉ vì tạo SP.

**Điểm kết thúc:** execution remediation đạt khi mọi R1–R6 được Reviewer xác minh và decisions cần thiết đã chốt. Full completion chỉ đạt khi tất cả O1–O7 được nghiệm thu. Findings mới được phân loại blocker trong outcome hiện hữu hay scope change cần human decision; không mở rộng scope ngầm hoặc mở lại remediation đã đạt chỉ vì wording cũ.

## 6. Rủi ro, giả định và câu hỏi mở

| Rủi ro / câu hỏi | Tác động | Evidence / giả định | Người chốt / xử lý |
| --- | --- | --- | --- |
| Commit ordering block/rebind/stop sau admission | Blocker contract trước rollout | Chưa có durable commit point theo audit; recommendation chưa approved | SL đề xuất, Architecture/human chốt phần public semantics |
| Queue file-backed và inline execution cùng tồn tại | Major reliability | Integration :109–123 enqueue rồi chạy inline; chưa full recovery inventory | SL inventory/đề xuất launch owner; không mặc định queue là executor duy nhất |
| Waiter liveness/time policy | Major | Matching terminal fanout là trigger hiện tại; chưa có reconciliation SLA | SL đề xuất bounded detection/cancel policy, escalate nếu đổi public behavior |
| Schema/consumer compatibility | Major nếu đổi semantics | Chưa full external consumer inventory | SL khảo sát, Architecture/human duyệt incompatibility; additive migration cần witness |
| Source tree dirty và report ignored | Major handoff evidence | Claims trong report, không Git verification lượt này | SL/Reviewer source-bind; human quyết định artifact handoff, không force-add |
| Chưa biết effort/owner capacity/runtime approval | Blocker forecast/dispatch | Không đọc runtime receipt hoặc inventory production | SL cung cấp forecast và exact approval proof; không suy approval từ hội thoại |

## 7. Acceptance criteria của plan / approval handoff

- [x] Facts có source refs/checksums ở audit 0h; assumptions/options/recommendation tách khỏi decisions.
- [x] In/out scope, R1–R6, O1–O7 mapping và exit criteria nhất quán; giữ remediation đã sửa và carry-forward gates.
- [x] Mandatory contracts/dependencies tách khỏi delivery suggestions; không áp số/tên ticket hoặc manifest cố định.
- [ ] Human approve đúng immutable identity/revision/Project/SHA-256 theo storage contract hiệu lực; Markdown SHA không mặc nhiên là runtime artifact SHA.
- [ ] SL source-bind, lập SP/coverage/forecast và tuân ticket admission policy trước dispatch; approval plan không tự cấp RUN.
- [ ] Decision owner chốt commit/stop semantics và mọi incompatibility cần thiết trước bước bị block.
- [ ] Reviewer xác minh independently từng criterion; full cutover/cleanup vẫn chờ các carry-forward gates và human decisions.

**Giới hạn:** lượt này chỉ tạo plan/audit và cập nhật audit index; không sửa implementation/schema/runtime, chạy tests/browser/Git, migrate, commit/push, approve hoặc RUN. Không dùng external references vì source/contracts repository đủ cho plan; không coi tài liệu ngoài là proof triển khai. **Chưa được retire/drop legacy store/schema.**
