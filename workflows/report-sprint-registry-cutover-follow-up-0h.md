<!-- Audit dependency revalidation và các boundary admission/recovery còn mở; không thay Reviewer hoặc cấp quyền RUN. -->
# Follow-up 0h — Dependency revalidation và đường đóng remediation

**Ngày:** 2026-10-09. **Verdict:** remediation thực chất ở pre-dispatch dependency guard; partial O2/O5, chưa nghiệm thu full O1–O7.
**Nguồn:** `workflows/report-sprint-registry-cutover-dependency-revalidation.md`, SHA-256 `8d3299addedbef29794ed775f317232a64ccf3adaf1a18f9ed38d7b27dba2007`.
**Plan sửa chữa mới:** `workflows/plan-sprint-registry-cutover-execution-recovery.md` — Draft, không thay approval/baseline completion tại chỗ.

## 1. Facts đã đối chiếu

- Đã đọc toàn bộ waiter (83 lines) và test mới (132 lines). Hai whole-file hashes khớp report; không chứng minh atomic tested snapshot.
- `sprint-execution-wait.js:61–70` capture original dependency immutable basis + execution ID; external lookup được gọi lại sau wait, local lookup dùng current Registry scheduling record.
- `:32–45` kiểm immutable identity/lifecycle rồi final synchronous pass kiểm captured Registry version, done status và original execution ID. ABA xảy ra ở dependency đã capture trong khi await lookup dependency sau được phát hiện. **Finding 0g “external dependency chỉ resolve một lần trước wait” đã lỗi thời ở fenced branch này.**
- `:36,43` cho phép ready/running/done của cùng immutable plan; không khóa version pre-wait mãi mãi. Không thay completion bằng attempt mới chỉ vì attempt đó đã done. Cross-Project basis bị chặn ở :65.
- `sprint-dag.js:32–33` chọn fenced runner; production composition `start-control-api.mjs:132–135` truyền Registry và shared Ticket RUN. Đây là đường production, không chỉ helper test.
- Test có **sáu scenario registrations**: loop đăng ký hai case rebind/block và bốn case ABA/replacement/same-plan completion/foreign Project. Disposable SQLite/immutable plans/status/terminal bridge là thật; bus và async lookup boundary là doubles; dispatch callback trực tiếp mark done, không actual production submit/enqueue.

## 2. Findings / boundary còn mở

| ID / mức | Evidence và giới hạn | Yêu cầu đóng / mapping |
| --- | --- | --- |
| D1 — Major, dependency evidence không đi tới admission | Waiter :69 await revalidation rồi :70 dispatch chỉ truyền ticket + sprintBasis, không dependency expectation set. Production :132 chuyển sang dispatchTicket chỉ giữ expectedSprintVersion; Ticket RUN :23–57 còn nhiều awaits; approved dispatch :14–21 kiểm target basis/claim rồi submit, không original dependency attempts. | Giữ hoặc đối chiếu tương đương exact dependency expectations đến durable admission, không silently resolve thành attempt mới. Witness pause trong actual shared RUN/submit, rebind/block/attempt replacement xen giữa. O2/O5; R1/R2. |
| D2 — Major, final synchronous pass không là cross-process commit | Registry get dùng SELECT riêng; guard :40–43 không transaction xuyên Registry/status/queue. Integration :83–110 await workspace/context/occupancy trước enqueue; :123 chạy provider inline. Queue :14–20 dedup request_id; không thay admission identity/receipt gắn execution/dependencies. | Chốt linearization và durable recovery disposition cho exact execution, queue/inline launch, occupancy/workspace. Kill/restart và parallel processes; không gọi status claim hoặc thêm check cuối là atomic admission. O2/O5; R2. |
| D3 — Major, waiter/application liveness | Waiter :21–28 inspect ban đầu rồi chỉ inspect khi matching terminal fanout. Event bus :27–34 duplicate persistent event trả trước fanout; bridge :35–45 terminal status return trước projection repair. Rebind/block không có matching terminal event cũng chưa đánh thức waiter theo source đã đọc. | Reconciliation event→status→projections và waiter/reconnect/restart; invalidated dependency phải có recoverable disposition, không pending vô hạn hoặc redispatch mutation. O2/O3/O5; R3. |
| D4 — Major, side effects trước final fence | Ticket RUN :52–55 clears sequential; review-only integration :56–68 ghi findings/checkpoint, integrate/release trước final identity check :69. Đây là failure-window risk, không incident đã chứng minh. | Fence trước irreversible commit và durable recovery cho từng partial side effect; stale review không đổi evidence/workspace attempt mới. O2/O5; R4. |
| D5 — Major, producer/compatibility coverage | DAG vẫn có legacy branch :34–53; composition :128–139 còn Roadmap intake/review; production :72 submitTicket đi trực tiếp baseIntegration, không startTaskExclusive. Chưa đọc đầy đủ mọi producer/status writer ở lượt này. | Inventory active/history/obsolete và execution preconditions; actual queued review/revision và direct/compatibility disposition. Không suy mọi entrypoint phải bị xóa hoặc direct-code phải thành Sprint. O1/O2/O5; R5. |

D1/D2 chi tiết hóa admission gate đã mở ở 0g, không phải scope mới ngoài completion. D3/D4/D5 giữ gate cũ có evidence targeted mới. Không yêu cầu reconstruct mọi lifecycle change suốt thời gian wait: ABA witness hiện chỉ bao phủ captured revalidation window; same-plan lifecycle progress hợp lệ vẫn phải được giữ.

## 3. Evidence run và giới hạn acceptance

Report dẫn `VERIFY-RUN-0c539eef-2a42-4d30-8def-a6e8529c3565`, exit 0, evaluated `2026-10-09T00:10:05.806Z`, command gồm dependency-revalidation, execution-fencing và sprint-dag tests. **Coder-reported**, chưa đọc raw run artifact hoặc Reviewer verdict; không chạy lại. Node version/raw output hashes/TAP totals unavailable theo report; không đoán counts từ số registration.

Git dirty tree 45 paths, commit GIT_ADD_FAILED vì ignored workflows, no commit SHA/no push đều chỉ là report claims, không Git verification của lượt này. Không force-add hoặc đổi ignore policy. Chưa có chứng cứ mới đóng mounted UI, authority/handoff, historical migration provenance, backup–restore–rollback hoặc O6/O7.

## 4. Source identities

Individual Forge reads, không atomic repository snapshot; line windows là evidence đã đọc, không mutable allowlist.

| File | SHA-256 |
| --- | --- |
| `backend/src/modules/supervisor/sprint-execution-wait.js` | `b3d59b3647f3c457b3c1093ca020b160ed3a54c451bd971e9b836d49536048db` |
| `backend/tests/unit/sprint-dependency-revalidation.test.js` | `e1cc5373da64140514638c7939e2eb7ffd5cbe72edad47219c8b4163e9be3898` |
| `backend/src/modules/supervisor/sprint-dag.js` | `9f9cdbd369c311b8cc2562c3bee2c43d2004cd96236b2e2953d3edc0e801bed1` |
| `backend/src/modules/projects/ticket-execution-identity.js` | `584dc1eca0f31d2d4adafd082eb241ae191b70816bb0f73a2d9e914a1e1def8d` |
| `backend/src/modules/governance/sprint-registry.js` | `d5fa38056917ccd4a010b37faa3c24ced30885c4c34ce49f77523d21ed942a7a` |
| `backend/scripts/start-control-api.mjs` | `68c727d90cdf85b8c98ea3b830601475cde8ae399955b0de937de195760dc6ec` |
| `backend/src/application/ticket-run-dispatch.js` | `6ad8e99ec822ef4e860bb6dfdcc9270851b6a35bdac1e310a6fc30d4eec4eeec` |
| `backend/src/application/approved-ticket-dispatch.js` | `68a29fe4d475176943690e3e2e286ddfadde3527add43321d23fd919609ca1c3` |
| `backend/src/modules/supervisor/nodeforge-task-integration.js` | `58dd16c47160dcb978756cfdc0f87cbfe0be2aeb331226827c1c96e37d055ea4` |
| `backend/src/modules/supervisor/production-runtime.js` | `4c64d29b33593130e4e8f09b7812289c82ba2473964781e9d789a12668bd6dbd` |
| `backend/src/modules/supervisor/durable-queue.js` | `6d9d024449b0eceb583c42b58f098dc2ee4d157eb8206c164b426612ee3bd459` |
| `backend/src/modules/supervisor/execution-event-bus.js` | `f0251268d1b405d3bcf2d04b87dcf412f452305f44a1c131a9ad37b290423a2c` |
| `backend/src/modules/supervisor/terminal-bridge.js` | `adf2da928021f682a953c1b137bb6c44ec259dc27335ecc1ce78c19f896e6942` |

## 5. Handoff

Không sửa report Coder hoặc completion revision 1. Plan remediation dùng R1–R6 mapping vào O1–O7, không mở lại guard đã sửa, không thay full completion acceptance bằng focused pass. SL sở hữu SP/ticket/DAG/manifest và forecast; Reviewer kiểm chứng độc lập; human quyết định exact approval/public semantics/rollout/retention.

**Giới hạn lượt này:** đọc rulebook/root instructions/glossary, overview architecture :1–250, baseline/audits, tree/list/search và targeted source/test; chỉ viết audit + plan + cập nhật audit index. Không dùng nguồn ngoài vì repository contracts/source đủ cho quyết định này; nguồn ngoài không thay proof triển khai. Không sửa code/schema/runtime, chạy tests/browser/Git, migrate, commit/push, approve hoặc RUN. **Chưa được retire/drop legacy store/schema.**
