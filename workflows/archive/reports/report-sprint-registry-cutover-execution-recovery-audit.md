<!-- Audit kiến trúc và hướng đóng các outcome execution recovery còn mở, không cấp quyền triển khai. -->
# Sprint Registry — audit execution recovery và hướng hoàn thành

**Ngày:** 2026-10-09 (UTC). **Trạng thái:** Static architecture audit + đề xuất delivery; không phải independent implementation review, approval hoặc runtime acceptance.
**Kết luận:** R1 tiến bộ thật nhưng chưa đóng; R2–R6 còn mở. Không cần mở thêm một remediation plan song song: tiếp tục R1–R6 của plan hiện hữu, giữ toàn bộ O1–O7.
**Owner:** Architecture giữ boundary; human chốt public semantics/approval/rollout; SL phân rã delivery và forecast; Reviewer xác minh độc lập.

## A. Kết quả kiểm tra báo cáo

Đã đọc toàn báo cáo implementation, plan execution-recovery, completion plan, rulebook Architecture và root AGENTS; đối chiếu targeted production wiring, source và toàn bộ fixture submission. Reads là identities từng file, không atomic repository snapshot; không đọc runtime production hoặc chạy kiểm chứng.

- Báo cáo ghi focused one-file PASS, exit 0, run `VERIFY-RUN-156a73d0-ef09-4d62-ad6d-aa4c0749437d`, evaluated `2026-10-09T00:57:21.270Z`. Lượt audit không truy xuất raw run artifact: đây là Coder-reported verification, không Reviewer verdict.
- Fixture hiện đọc được đúng SHA được báo cáo cho focused PASS: `d27313d7f2cca8a0ce0deb9aaf0344dcbd47e7d5c94d14d3f1734874195642d1`. Có real runtime governance + Forge registry; provider kiểm MCP/allowlist rồi cố ý throw `PROVIDER_OBSERVED`. Không chứng minh actual agent/tool invocation hoặc authorization của invocation.
- Có tám scenario registrations: bốn boundary cases, hai local/external combinations, scheduling progression, omissions/substitution. Không suy registrations thành TAP totals; raw totals, Node version và output hashes chưa có.
- Các lệnh tám-file trước vẫn FAILED lịch sử; focused one-file PASS không biến chúng thành PASS. Những câu “corrections were not rerun” ở phần lịch sử cần được đọc theo thời điểm; mục latest đã supersede phần liên quan, không cần sửa lại lịch sử thành pass.
- `queue-save` case chủ động assert còn **một queued job** sau rebind trong save và không inline launch (:81–95). Đây là witness ngăn inline launch, không witness admission fail-closed trên mọi consumer.
- Second SQLite connection đọc được expectations (:108–110) chứng minh persistence qua connection; không phải concurrent RUN nhiều process hay kill/restart.
- Git commit failure/possible partial staging là claim của báo cáo, không được kiểm tra mới. Không có Git SHA để coi batch đã commit; việc ignored reports cần owner xử lý theo policy, không force-add.

## B. Findings còn phải đóng trong outcomes hiện hữu

| Finding / mức độ | Evidence static | Xử lý / mapping |
| --- | --- | --- |
| F1 — Major, blocker execution acceptance: claim/check chưa là admission commit | Shared RUN :47–61 claim rồi clears; integration :114–132 check → enqueue await → check → inline launch. Queue :14–20 chỉ dedup request_id, không commit chung với Registry/status/occupancy. Fixture giữ job sau stale save. | R1/R2: protocol commit + receipt + disposition; reject inline không đủ xử lý persisted job. |
| F2 — Major: partial side effects và stale review | RUN :56–58 sequential clears; reviewOnly :57–70 findings/checkpoint và integrate/release trước final identity guard. | R4: fence/ownership tại irreversible commit; archive và recovery từng partial phase; không chỉ chuyển check lên trước một await. |
| F3 — Major: append không bảo đảm application | Bus :26–34 duplicate return trước fanout; :36 seen trước subscriber. Bridge :35 terminal return, :43–45 status rồi Roadmap/memory. | R3: durable consumer progress/reconciliation cho append → status → projections → notification. Terminal row không ngăn repair projection thiếu. |
| F4 — Major: waiter chỉ inspect lúc subscribe hoặc matching terminal | waitForTicketExecution :9–29 không Registry subscription/reconcile/cancel input. | R3: external rebind/block/replacement trong wait, missed fanout/reconnect/restart và cleanup cần witnesses; không tự đặt timeout mới. |
| F5 — Major: compatibility và recovery producers chưa hội tụ | Helper :17/:32 bỏ guard khi undefined; production :72 submit bypass startTaskExclusive; review handler :26–35 lưu verdict/checkpoint/publish; recovery :153–156 tạo outcome không execution identity; :175–181 chọn jobs bằng task_id và có thể dựng verification.passed từ job tồn tại. | R5 + R3/R4: inventory/revalidate exact attempt, artifact và actual job result trước apply/recovery. Không khẳng định các failure paths đã xảy ra; cần source-bound negative witnesses. |
| F6 — Acceptance/forecast gap | Plan còn Draft; báo cáo không có độc lập Reviewer, full regression/crash evidence hoặc SL forecast. | R6: exact approval proof khi dispatch, nguồn kiểm chứng cố định, verdict theo criterion, owner/estimate/lịch Reviewer. |

**Queue ownership chưa chốt:** source production hiện tạo senderWorker trên `agent.request` (:128), còn submit enqueue `sender.handoff` (:71). Không có cơ sở nói senderWorker này đã consume orphan handoff; cũng không được giả định mọi consumer ngoài đường đã đọc đều không consume. SL phải hoàn tất inventory consumers/recovery trước quyết định launch owner.

## 1. Mục tiêu / kết quả mong đợi

- Hoàn thành execution remediation bằng durable admission, attempt-scoped side effects và recoverable application, không thêm check lẻ rồi đóng gate.
- Giữ tiến bộ R1; chốt phần thiếu theo ledger có điểm đóng và forecast. Full completion vẫn là O1–O7, không thay bằng focused PASS.

## 2. Phạm vi

**In scope:** toàn bộ R1–R6 hiện hữu, mapping với O1–O7; admission/launch ownership, event/waiter recovery, side-effect fencing, producers/compatibility, independent evidence và delivery forecast.
**Out of scope:** rewrite engine, features/refactor ngoài outcomes; sửa approved bytes, nới auth/RUN/tool governance; tự migrate/retire/drop legacy, đổi ignore policy hoặc force-add. Không tạo authority thứ hai hoặc ép standalone direct-code/tool-lab vào Sprint semantics.

## 3. Hướng tiếp cận và guardrails

### Quyết định đề xuất phải chốt trước phần implementation bị block

1. **Commit ordering:** mutation trước admission commit làm exact stale intent reject; mutation sau commit không thay basis/completion attempt. SL đề xuất disposition cho block/rebind/stop và recovery, Architecture/human chốt nếu đổi public semantics.
2. **Launch ownership:** mỗi committed execution có durable owner/token; queue và inline không được cùng tự launch. SL inventory actual consumers và chọn cơ chế trong boundary, không bắt buộc rewrite queue hay thêm executor.
3. **Unknown outcome:** crash/response loss sát provider/irreversible boundary phải giữ receipt + observable reconciliation. Khi không chứng minh execution đã/chưa chạy, không blind redispatch; không hứa external side effects exactly-once từ queue dedup.
4. **Recovery authority:** journal/outbox/receipt là mechanism nội bộ Registry, không authority ngang quyền. Pending/orphan phải có disposition; retry tiếp tục đúng identity, không resolve latest completion để cứu old intent.
5. **Attempt fencing:** giữ Project/plan/revision/path/hash/execution/dependency set tại commit và consumer apply. Safety fence phải được serialize/recover tại side-effect boundary, không dựa in-memory active map hoặc synchronous check giữa các process.
6. **Liveness:** SL đề xuất detection/reconciliation/cancel policy và owner, human chốt thay đổi public time/stop semantics; không dùng arbitrary timeout để giả hoàn thành.

**Dependency thật sự:** protocol/ownership trước admission và restart launch; evidence R1–R5 + R6 trước execution acceptance; tất cả O1–O7 + human rollout/retention decision trước full cutover/destructive contraction. Inventory và thiết kế recovery witnesses có thể chạy song song trong boundary; SL tự lập DAG.

## 4. Khu vực dự kiến ảnh hưởng và evidence

Candidate areas không phải mutable-file allowlist. Whole-file hashes dưới đây lấy từ Forge reads; SL/Reviewer phải source-bind lại khi triển khai hoặc kiểm chứng.

| Thành phần / khu vực | Vai trò / refs | SHA-256 |
| --- | --- | --- |
| `workflows/report-sprint-registry-cutover-execution-recovery-implementation.md` | Coder progress/verification claims | `785e35200ef12369ac92546bc398a0f324da2e73375707e259bfd6c10a4e025a` |
| `workflows/plan-sprint-registry-cutover-execution-recovery.md` | Draft baseline R1–R6, revision 1, không sửa | `80cbcae0d1b81e5c4516a313c0f504cc058556e827f5c68557dc95196961eba2` |
| `workflows/plan-sprint-registry-cutover-completion.md` | Draft baseline O1–O7, không sửa | `566c27dce44272e91b381ae6c215d006cba328518d5c458133eaf8a1b6986504` |
| `backend/scripts/start-control-api.mjs` | :126–139 DAG expectation adapter; review/intake authority chưa hội tụ | `3649a0921032172711ebc3783bcdd46b312bac21a5c5382cbb66aa77974ead27` |
| `backend/src/application/ticket-run-dispatch.js` | :19–74 shared RUN/claim/clears | `6cb4f5490bdaf838ea4424bd781a10bbf6716defa308f64a10134f1935324eed` |
| `backend/src/application/approved-ticket-dispatch.js` | :11–35 claim match và payload forwarding | `6913fb86a5977911fe650d00c5daf4450c8654edd8891bf5630b89023c667040` |
| `backend/src/modules/projects/ticket-status-store.js` | :35–72 CAS/history và persisted dependency intent | `ac55b41d68bfd0faa82cf9154189e5dd6d2dabacdcdc5d7936d3b56c11253dca` |
| `backend/src/modules/supervisor/ticket-dependency-expectations.js` | :16–38 immutable/scheduling checks, undefined compatibility | `e2a0a7fffaa5b6829aeb3247337b23b006d90b3f9d09b0ed1207e58c46c4e966` |
| `backend/src/modules/supervisor/nodeforge-task-integration.js` | :32–150 review/submit/inline boundaries | `83bab4da8cecff7cd6099ad9526a2fa2006c9b9cdc98aba09b40366a3c44486b` |
| `backend/src/modules/supervisor/production-runtime.js` | :54–200 composition, worker queues và recovery producers | `50046f8dab6ac5097c26a8fa97c0f8991e53bda21f9fa9de97f0cfda38e2797a` |
| `backend/src/modules/supervisor/durable-queue.js` | :14–41 dedup/save/lease recovery | `6d9d024449b0eceb583c42b58f098dc2ee4d157eb8206c164b426612ee3bd459` |
| `backend/src/modules/supervisor/execution-event-bus.js` | :22–45 append/dedup/fanout | `f0251268d1b405d3bcf2d04b87dcf412f452305f44a1c131a9ad37b290423a2c` |
| `backend/src/modules/supervisor/terminal-bridge.js` | :23–76 status/projection/memory ordering | `adf2da928021f682a953c1b137bb6c44ec259dc27335ecc1ce78c19f896e6942` |
| `backend/src/modules/supervisor/sprint-execution-wait.js` | :9–80 waiter/capture/dependency revalidation | `87504759fb1b775815387803806754382bf192ee8509f489337d38e211e30eb1` |
| `backend/src/modules/supervisor/review-request-handler.js` | :11–36 verdict/checkpoint/event/ack | `29b2234c6e68919b29ecdfed0e4dd7dc124e5fb9be611d6fbb407069749b44b1` |
| `backend/tests/unit/ticket-dependency-submission.test.js` | :1–148 actual components, controlled provider/occupancy, save orphan assertion | `d27313d7f2cca8a0ce0deb9aaf0344dcbd47e7d5c94d14d3f1734874195642d1` |

## 5. Outcomes và điều kiện nghiệm thu / đường về đích

Không tạo mã outcome mới. Bảng này là hướng đóng phần còn lại, không thay/giảm acceptance criteria của plan R1–R6.

| Mã | Outcome / phần còn thiếu | Evidence để đóng | Dependency / guardrail |
| --- | --- | --- | --- |
| R1 | Exact dependency intent tới admission/continuation | Giữ focused fixture; actual production composition và restart/resume giữ original completion; local/external/multiple + same-plan progression; stale intent không được consume/launch ở đường khác. | R2 commit ordering; không thay bằng latest attempt. |
| R2 | Durable admission và launch owner | Receipt liên kết exact target/dependencies/execution/job/occupancy/workspace; pause trong actual save/commit; concurrent RUN nhiều process; kill trước/sau claim, queue save, receipt, launch; pending/orphan/unknown đều có disposition; mất response/read tiếp tục cùng receipt. | Chốt ordering/ownership; queue-save job không bị bỏ mặc hoặc blind redispatch. |
| R3 | Application/projections/waiter phục hồi | Persistent bus inject lỗi sau append/status/mỗi projection/trước notification; duplicate/restart/reconnect repair đủ; dependency rebind/block/attempt change trong wait không cần matching terminal mới để reconcile; listener cleanup được chứng minh. | Exact attempt; không republish duplicate ID thay consumer repair. |
| R4 | Side effects recoverable và fenced | Lỗi/kill từng clear, findings/checkpoint write, integration và claim/ledger release; delayed stale review không chạm workspace/evidence attempt mới; archive/continuation partial phases có evidence. | R2 ownership; fence trước irreversible commit. |
| R5 | Producer/compatibility/recovery convergence | Inventory mọi entrypoint/writer/queue/consumer với owner và preconditions; stale cached verdict, wrong attempt/artifact, failed verification job không được apply như pass; Registry-owned path không bypass expectations; standalone có boundary riêng. | Chưa remove compatibility guard trước reconciliation; incompatibility cần approval. |
| R6 | Reviewer bundle + forecast | SL coverage từng criterion, source snapshot hoặc dirty manifest/hashes, environment/Node, commands/exit/raw output/hash/counts khi có; independently Reviewer verdict; missing/skip/block ghi thật; exact approval khi dispatch; forecast theo mốc. | One-file PASS không đóng regression batch hoặc O1–O7. |

### Các mốc đóng, không mở scope mới

- **Mốc A — execution an toàn:** mọi R1–R6 có independent verdict và contract decisions đã chốt. Đến đây chưa full cutover.
- **Mốc B — authority trên đường sử dụng thật:** giữ O1/O2 detail/graph/intake/review/writers; O3 mounted `/coding` controls/Retry/SSE/reconnect/unmount; O4 exact committed handoff continuation không repost mutation. Những gate này carry-forward, chưa reaudit toàn bộ UI/handoff lượt này.
- **Mốc C — full completion:** O6 provenance/per-version mapping, backup–restore, migration/restart/rollback giữ writes/events mới; O7 consumer/compatibility/retention/rollout decisions và Reviewer bundle. Chỉ full completion khi toàn bộ O1–O7 đạt.

**Handoff ngay cho SL:** cung cấp protocol proposal + consumer inventory, ledger gate/owner/evidence, mapping R1–R6 và O1–O7, estimates/blockers/forecast từng mốc và lịch Reviewer. SL chủ động số ticket/Sprint/DAG trong boundary, mỗi ticket tối đa bốn mutable files, file ≤250 lines. Không dùng audit này làm approval/RUN receipt.
**Ưu tiên đề xuất:** chốt admission/launch protocol thay vì thêm final check; inventory/recovery witness design song song khi được phép. Sau đó đóng execution rồi authority/UI/handoff và migration theo dependencies thật; forecast phải giải thích gate nào được đóng, còn gate nào và lịch đổi vì sao.

## 6. Rủi ro, giả định và quyết định mở

| Câu hỏi / rủi ro | Tác động | Evidence / giả định | Owner / phần bị block |
| --- | --- | --- | --- |
| Commit vs block/rebind/stop, launch/recovery owner | Blocker admission contract | Chưa có committed admission receipt ở đường đã đọc | SL đề xuất; Architecture/human chốt semantics trước implementation bị ảnh hưởng. |
| Actual consumer của sender.handoff và restart | Major | Đường senderWorker đã đọc dùng agent.request; inventory chưa hoàn tất | SL inventory, không đoán consumer hoặc xóa queue. |
| Provider outcome không biết sau crash | Major | Fixture provider throw không chứng minh crash disposition | SL protocol + witnesses; owner chốt manual reconciliation nếu cần. |
| Waiter liveness/stop policy | Major | Không trigger Registry rebind trong waiter đã đọc | SL đề xuất; human chốt thay đổi public timing/cancel. |
| Cached review/recovery thiếu exact identity/result | Major | Static F5, chưa runtime incident | SL negative witnesses theo R3–R5; Reviewer kiểm độc lập. |
| Dirty/staged source, ignored report handoff | Major evidence | Coder-reported, audit không chạy Git | SL/Reviewer kiểm khi được phép; human quyết định artifact policy, không force-add. |
| Approval/effort/capacity chưa xác minh | Blocker dispatch/forecast | Draft docs; không đọc runtime receipt hoặc lịch staffing | SL đưa exact proof/forecast; không hứa ngày hoặc suy approval từ hội thoại. |

## 7. Acceptance criteria của hướng xử lý / giới hạn

- [x] Giữ R1–R6/O1–O7, không mở remediation plan song song hoặc giảm gate vì thúc tiến độ.
- [x] Facts/source identities, Coder claims, risk và proposed decisions được tách rõ.
- [x] Dependency kiến trúc tách khỏi delivery; không áp ticket IDs/số Sprint/manifest.
- [ ] Human chốt decisions còn mở và exact approval theo contract cho phần việc cần triển khai; audit không tự cấp quyền.
- [ ] SL coverage/owner/forecast và source-bound Reviewer bundle đủ trước acceptance.
- [ ] R1–R6 và carry-forward O1–O7 được đóng bằng evidence tương ứng, không bằng một batch pass.

**Lượt này:** chỉ tạo tài liệu audit/hướng xử lý này; không sửa plan baseline/report implementation/code/schema, chạy tests/browser/Git, migrate, commit/push, approve hoặc RUN. Không cần external reference cho các kết luận repository-specific; reference bên ngoài không thay implementation proof. **Chưa được retire/drop legacy store hoặc schema.**
