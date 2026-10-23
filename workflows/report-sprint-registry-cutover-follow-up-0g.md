<!-- Architecture audit Ticket execution ownership và hướng recovery; không thay Reviewer hoặc cấp quyền triển khai. -->
# Follow-up 0g — Ticket execution ownership, parity và recovery

**Ngày:** 2026-10-08 (ngày baseline/báo cáo). **Verdict:** tiến bộ thực chất, partial O2/O3/O5; chưa nghiệm thu full O1–O7.
**Baseline:** completion plan revision 1 vẫn ghi Draft; lượt này không xác minh runtime approval receipt.

## 1. Mục tiêu / phạm vi

Đối chiếu hai báo cáo mới và targeted production source/test để cập nhật architecture boundaries, delta và acceptance guidance. In scope: audit tài liệu. Out of scope: sửa implementation/schema, chạy tests/browser/Git, migration, approve/RUN hoặc thay Reviewer độc lập. Không sửa báo cáo Coder/approved bytes.

| Báo cáo đã đọc toàn bộ | SHA-256 |
| --- | --- |
| `workflows/report-sprint-registry-cutover-current.md` | `6074ef71b76c5f6ab810d331e481cbd62d41a214d74ac25ed723d310c9fd7579` |
| `workflows/report-sprint-registry-cutover-ticket-execution.md` | `e80f321c37de2712786224292a1a7e7d25b64c36a4e49df65c0ed521df1c259d` |

## 2. Facts / delta đã xác nhận

- `ticket-execution-identity.js:2–22` tách exact immutable plan identity khỏi scheduling version: reuse completion đối chiếu Project/Sprint/plan/revision/path/hash; event/failure additionally đối chiếu execution ID và captured version. Không yêu cầu done của cùng immutable plan phải có scheduling version hiện tại chỉ vì Sprint đã đổi status.
- `ticket-status-store.js:35–72,103–116` thêm optional expectedVersion/expectedExecutionId; `beginExecution` claim execution trong existing details_json, UPDATE CAS và history trong transaction khi database hỗ trợ. Running/reviewing không bị claim mới thay thế. Đây là durable status ownership, không queue receipt hoặc transaction xuyên Registry/queue.
- `ticket-run-dispatch.js:36–65` recheck original Sprint version sau checkpoint/resume reads và trước claim/clears. Failure catch kiểm execution ID/basis và CAS status version; không áp lỗi dispatch cũ lên execution mới. Finding cũ failure catch hoàn toàn không attempt-scoped đã lỗi thời ở claimed branch; partial clear/crash recovery vẫn mở.
- `approved-ticket-dispatch.js:10–30` kiểm exact Sprint basis và persisted execution ownership, forward execution_id + sprint_basis. `start-control-api.mjs:119–139` wiring thật truyền status store và Registry vào dispatch/DAG; không chỉ helper dành cho test. Intake/review/human-review vẫn có Roadmap dependencies.
- `terminal-bridge.js:23–65` claimed branch reject old/foreign/hash/version events, guarded CAS conflict không reread/retry old intent. Committed terminal status chặn duplicate application. Unclaimed branch vẫn dùng seen in-memory và compatibility retry; không suy full producer convergence.
- `sprint-dag.js:32–33` chọn fenced runner khi có Sprint basis + beginExecution; `sprint-execution-wait.js:8–63` reuse done theo immutable evidence, wait exact execution và persisted status, read sau subscribe. Finding cũ production DAG chỉ mở dependency theo ID/event type đã lỗi thời ở fenced branch; legacy branch vẫn còn.
- `registry-dashboard.js:18–29` mask status thiếu execution evidence hoặc khác immutable plan thành untracked/zero progress; recheck Registry versions sau projection. Finding 0f về dashboard chỉ kiểm Project/ID đã lỗi thời trong branch này. Không chứng minh globally atomic multi-store snapshot hoặc complete attempt history.
- `nodeforge-task-integration.js:35–37,69–72,155–158` giữ original identity cho review-only và outcome publication. Review checkpoint/findings và workspace integration/ledger release ở :56–68 xảy ra trước final identity guard; guard status/event không fence ngược các side effects đó.

## 3. Evidence và giới hạn

Đã đọc toàn bộ `ticket-execution-fencing.test.js` (184 lines): **chín top-level test cases**, không phải mười như câu mô tả trong report. Phase identity preservation nằm trong case durable claim. Có real SQLite/immutable approvals; second connection, controlled await, wrong-event/CAS conflict, delayed failure, stale-before-clear, actual dispatch/wait/DAG helpers và fake-provider failure producer. Event bus fixture là ordered double; không phải production persistent bus/recovery drill.

Claim run `VERIFY-RUN-939ccc1c-24c4-40ff-b1f3-a92ef9c9630c`, exit 0, evaluated `2026-10-08T22:56:53.848Z` chỉ đọc từ report: **Coder-reported**, chưa independently verified. Chín files trong command không đồng nghĩa chín hoặc mười TAP tests. Không có raw output/TAP totals/environment snapshot trong evidence đã đọc; không đoán. Second connection/bridge reconstruction không thay killed-process witness.

**Recovery boundary bổ sung:** `execution-event-bus.js:27–45` persistent duplicate event_id trả duplicate trước subscriber fanout; `terminal-bridge.js:35–45` terminal status đã commit thì duplicate không repair Roadmap/memory projection. Vì vậy append event, apply status, apply projections và wake waiter cần recovery disposition riêng; replay publish cùng ID không mặc nhiên sửa partial application. Đây là source failure-window risk, không incident đã chứng minh.

## 4. Hướng tiếp theo / outcomes và acceptance criteria

| Outcome / mức | Kết quả và witness bắt buộc | Guardrail / owner |
| --- | --- | --- |
| O2/O5 — Major admission | Chốt linearization/commit semantics của RUN: exact Project/revision/hash/version + execution ID liên kết recoverably tới queue job/occupancy/workspace. Dùng pending/committed/orphan receipt/outbox hoặc equivalent trong Registry boundary; không thêm authority ngang quyền. Pause trong actual submit/enqueue, block/rebind xen giữa, full RUN nhiều process, kill/restart trước/sau commit; reconcile không duplicate execution. | SL đề xuất protocol; Architecture/human chốt public/schema semantics nếu đổi. Status claim/check cuối không thay admission proof. |
| O2/O5 — Major side effects | Archive hoặc recovery disposition cho checkpoint/protocol/conversation clears; fence workspace integration/ledger/checkpoint review trước irreversible commit, không chỉ final publication. Inject lỗi/kill sau từng clear/claim/integrate; stale review/failure không sửa evidence/workspace của attempt mới; orphan không tự redispatch. | Giữ evidence và exact execution ownership; không remove-trước rồi hy vọng rollback. |
| O2/O3/O5 — Major convergence/dependencies | Inventory active entrypoints, status writers và queued review/revision producers; required execution preconditions trên claimed paths, explicit compatibility disposition. External dependency rebind/block trong lúc resolve/wait phải được revalidated theo contract trước dispatch dependent; không chỉ check một lần rồi wait old basis. | Không xóa compatibility guard khi chưa inventory. Test actual persistent bus, in-flight reconnect/missed delivery, stale/duplicate/out-of-order/parallel processes; giữ same-plan done reuse hợp lệ. |
| O2/O4/O5 — Major replay/recovery | Durable application/reconciliation cho event append → status → projections → waiter notification; failure sau append hoặc status commit phải có continuation riêng, không dựa duplicate publish. Exact approval/handoff receipt reload sau committed mutation/read failure; restart/continue không repost decision/handoff. | Receipt/application progress có owner và identity; projection không thành authority. File/index/approval/bind cũng cần failure injection và recovery. |
| O1/O2/O3/O4 — Major authority/UI | Hội tụ detail/graph/intake/review/writers/handoff theo inventory active/history/obsolete. Giữ mounted /coding controls/Retry/SSE/reconnect/unmount witness từ 0f; status parity patch không đóng interaction acceptance. | Không vá disconnected component làm substitute; bounded IDs không thay full authorized inventory. |
| O6/O7 — Blocker cutover/cleanup | Full per-version/source/link/approval reconciliation; genuine historical upgrade provenance; consistent backup/restore; crash/resume/rollback giữ writes/events mới; source-bound Reviewer bundle và human rollout/retention/conflict decisions. | Không retire/drop legacy store/schema khi gates chưa đạt. Synthetic v17 witness không thay historical artifact. |

Đây là outcome/guardrail guidance trong completion scope, không Sprint Plan, số/tên ticket, mutable-file allowlist hoặc quyền dispatch. SL sở hữu delivery/DAG/manifests; public incompatibility và quyết định dữ liệu/retention phải escalate human/Architecture. Không sửa approved revision tại chỗ.

## 5. Source identities / handoff

Mười một source/test identities của batch trong report khớp Forge reads lượt này: identity helper, status store, Ticket RUN, approved dispatch, production composition, terminal bridge, task integration, execution waiter, DAG, dashboard và test đều đã được đối chiếu (tổng **11 files**). Exact hashes giữ trong report; các reads là từng file, không atomic tested snapshot.

Bổ sung source: `execution-event-bus.js` SHA-256 `f0251268d1b405d3bcf2d04b87dcf412f452305f44a1c131a9ad37b290423a2c`; `production-runtime.js` SHA-256 `4c64d29b33593130e4e8f09b7812289c82ba2473964781e9d789a12668bd6dbd` (targeted :65–144 xác nhận submitTicket dùng base integration, không startTaskExclusive lock).

Report nên sửa số case thành chín và tách subclaims; giữ verdict partial, admission/side-effect/projection replay limits. Reviewer bổ sung exact snapshot/dirty manifest/environment/output artifacts và coverage từng criterion. Git GIT_ADD_FAILED/no commit/no push vẫn chỉ Coder-reported; owner xử lý ignored-artifact handoff, không force-add/đổi ignore policy.

**Giới hạn công cụ:** các read_lines thử đầu bị từ chối do window >80 hoặc approved scope; không dùng chúng làm evidence. Các windows cần thiết đã đọc bằng read_file offset/limit hợp lệ. Chỉ cập nhật audit index và follow-up này; không sửa code/báo cáo Coder/plan, không chạy tests/browser/Git/migrate/commit/push/approve/RUN. Không dùng nguồn ngoài vì không cần external architecture references để chứng minh repository-specific boundaries. **Chưa được retire/drop legacy store/schema.**
