<!-- Kế hoạch sửa định tuyến lỗi và recovery có budget, bảo toàn quyền quyết định và evidence của ticket. -->
# Plan: Định tuyến lỗi, retry 30 giây và guidance cho repair

## 1. Trạng thái và nguồn gốc

- Cập nhật ngày **2026-10-15**, xử lý sáu nhận xét review bản R1.
- Bổ sung cùng ngày sau review trong chat: thêm §1b pain point, cột "Dependency / guardrail" cho O1–O10, và tham chiếu external (transactional outbox / idempotent consumer) cho §6.
- Nguồn: `PLAN-PROJECT-NODEFORGE-b9680ed7-7430-470e-a5ef-8728e48f3263/ke-hoach-r1.md`.
- File nguồn: `.forge/runtime/nf/plans/PLAN-PROJECT-NODEFORGE-b9680ed7-7430-470e-a5ef-8728e48f3263/ke-hoach-r1.md`.
- SHA-256 nguồn: `07db9e43218504d238ce5bf384076f86b74b6d0d44e5e16ae9a2acb393551e47`.
- Đây là **bản sửa trong repository**, không phải revision R2 đã đăng ký; không sửa artifact R1 hay tái sử dụng approval của R1.
- **Cập nhật triển khai 2026-10-16:** owner yêu cầu triển khai D1/D2/D3; policy hữu hạn và adapter production đã có theo §9b. Chưa đăng ký/approve revision plan và chưa RUN; triển khai code không thay các gate đó.

## 1b. Vấn đề và kết quả mong đợi (pain point)

- **Vấn đề:** Lỗi infra transient (SDK timeout, process exit, mạng tạm thời) hiện được chuyển terminal `task.failed` quá sớm trên cả hai đường — event `agent.response.failed` và exception qua `handleTicketExecutionFailure()` — khiến ticket dừng việc lẽ ra tự phục hồi và cần can thiệp tay.
- **Kết quả mong đợi:** Transient được retry sau ≥30 giây từ lần thất bại đã xác nhận, có budget hữu hạn và audit; lỗi logic/evidence đi repair đúng vai trò Reviewer/Coder; owner/Reviewer không mất quyền adjudicate.
- **Giá trị:** Giảm downtime vận hành và can thiệp tay không cần mở authority mới; D1/D2 được cụ thể hoá tại §9b.

## 2. Mục tiêu và phạm vi

- Transient infrastructure failure được retry **sau ít nhất 30 giây** từ lần thất bại đã xác nhận, có budget hữu hạn và audit.
- Lỗi logic/evidence thiếu đi vào repair/recovery đúng vai trò; không gửi lại nguyên xi như transient retry.
- Reviewer đưa finding đủ mô tả, vị trí/evidence và hướng sửa tối thiểu; Coder không tự đóng finding.
- SL triage và quyết định trong scope/quyền đã được duyệt; owner/Architecture xử lý thay đổi vượt thẩm quyền.
- Bao phủ cả event `agent.response.failed` và exception SDK đi qua `handleTicketExecutionFailure()`, trước khi phát terminal event.
- Bao phủ hard-gate pre-integrate và soft-review hậu-integrate; không đồng nhất hai lifecycle.
- Cho phép bổ sung recovery record/config nội bộ tương thích ngược trong store hiện có sau khi chốt D1 và kiểm tra schema.
- Không thay public terminal event/status, approval/RUN gate, scope/manifest/hash identity hoặc quyền adjudicate của Reviewer.
- Không sửa artifact runtime đã lưu; không đại tu pipeline, tăng repair budget, thêm provider fallback ngoài policy hay sửa lỗi không liên quan.
- Nếu cần thay schema/public contract hoặc rulebook authority: ghi rõ dependency và xin governing revision, không lách dưới nhãn implementation detail.

## 3. Discovery đã xác minh và phần chưa xác minh

Các source reference sau là **snapshot workspace**, gồm cả thay đổi chưa commit; không phải cam kết source bất biến.

| Source tại thời điểm đọc | Fact đã kiểm tra |
| --- | --- |
| `backend/src/modules/supervisor/supervisor-loop.js:123` | `agent.response.failed` hiện chuyển `FAILED`, phát `task.failed` và release Coder ngay. |
| `backend/src/modules/supervisor/supervisor-loop.js:47` | Event được claim theo request/type; phát lại cùng identity có thể bị dedup trước routing. |
| `backend/src/modules/supervisor/ticket-execution-failure.js:22` | Exception SDK/checkpoint có đường riêng phát `task.failed`; sửa mỗi supervisor event handler không đủ. |
| `backend/src/modules/supervisor/ticket-execution-failure.js:5` | Mọi `CODER_BLOCKED` hiện vào `needs_human_review`; đây là hiện trạng, không phải routing đích theo reason. |
| `schemas/agent/tools/report-done.schema.json:14` | Blocker gồm scope, contract, access, security và acceptance ambiguity, không chỉ thay đổi cấu trúc. |
| `backend/src/modules/supervisor/automatic-ticket-review.js:138` | `max_operational_attempts` đếm outcomes của review job; không chứng minh có budget Coder tương ứng. |
| `backend/src/modules/supervisor/automatic-ticket-review.js:151` | `consumeRepair()` bảo vệ repair budget; soft-review không được park ticket đã hoàn tất. |
| `backend/src/modules/supervisor/review-worker.js:98` | Strict findings đã có criterion/failure/evidence/scope; legacy findings vẫn có dạng string. |
| `backend/src/modules/supervisor/ticket-verification-service.js:149` | Artifact có command, exit code, output đã redact và identity; không cần dựng diagnostic từ `failed_paths` đơn thuần. |
| `backend/src/modules/supervisor/supervisor-loop.js:129` | Repair có attempt-builder và fallback; fallback đưa findings/failed_paths vào text, `review_findings` lấy findings. |
| `workflows/agents/sprint-leader/README.md:13` | Access/security/contract/policy vẫn có escalation boundary; SL không sở hữu ticket-local retry loop. |

Policy liên quan: `workflows/README.md:11`, `workflows/multiproject/error-type.md`, `workflows/plan-pipeline-resilience-never-stuck.md`.
README có bốn quyết định thảo luận ngày 2026-10-15; bảng error-type là tài liệu tham khảo, không thay thế contract đang chạy.
Resilience plan có backoff/budget/graceful-degradation riêng; không coi các đề xuất trong đó là code đã triển khai hay approval mới.

**Chưa xác minh đầy đủ, bắt buộc trước manifest/ticket triển khai:**
- Trace event producer → handler → checkpoint → terminal bridge → UI cho từng đường failure, gồm direct-code và ticket execution.
- Đọc hết attempt-builder, `ticket-resume.js`, findings/adjudication store, completion/integration, durable queue và startup recovery.
- Tìm config/budget Coder thực sự đang dùng; kiểm tra schema cho recovery records và khả năng atomic claim giữa nhiều process.
- Chứng minh replay, crash windows, owner stop và provider-outcome reconciliation bằng test; không suy ra từ tên hàm hoặc comment.
- Re-verify path/symbol/line và SHA-256 **đầy đủ** của các source dùng làm evidence; lưu snapshot mới trong handoff.
- Discovery không tìm được budget hoặc route được ủy quyền phải tạo decision/blocker rõ ràng, không tự chọn default hay authority.

## 4. Routing và authority matrix

`needs_human_review` là trạng thái parking hiện có, **không tự chứng minh owner phải quyết định**.
Routing đích phải ghi người có trách nhiệm triage, lý do, căn cứ ủy quyền và action được phép trong audit hiện có.
Tên field mới nếu cần là đề xuất implementation, phải được kiểm tra schema trước dispatch; không tự mở rộng public contract.

| Loại / điều kiện | Người xử lý và action đích | Giới hạn |
| --- | --- | --- |
| Timeout/network/temporary unavailable đã xác nhận invocation cũ kết thúc, không còn side effect chưa rõ | Node/Supervisor lên lịch operational retry (§5–6). | Chỉ allowlist đã kiểm chứng; lỗi mới/không rõ không tự coi là transient. |
| `AGENT_PROCESS_EXITED` / `SERVICE_UNAVAILABLE` / SDK `CONFIGURATION_ERROR` | Classify bằng structured cause và execution evidence trước khi retry. | Hàm `isRetryableSdkFailure()` chỉ là điểm khởi đầu; không coi mọi process exit/config error là an toàn. |
| `PROVIDER_UNKNOWN` / `REVIEW_PROVIDER_OUTCOME_UNKNOWN` / invocation active | Node reconcile provider/claim/lease; giữ audit và ownership thích hợp. | Lease hết hạn không chứng minh provider đã dừng; không redispatch khi kết cục còn unknown. |
| Verification logic failure / `CODER_EVIDENCE_PENDING` / thiếu completion report | Supervisor giao Coder repair/evidence recovery với diagnostic (§7). | Không tiêu budget transient để lặp lại logic error; không auto-approve. |
| `review.request_changes` / finding chưa giải quyết | Reviewer hướng dẫn; Supervisor điều phối repair/re-review. | Coder/SL không tự đóng finding hoặc biến `retain` thành backlog để integrate. |
| `REVIEW_VERDICT_INVALID` / findings thiếu evidence | Retry Reviewer có diagnostic và budget Reviewer. | Không đổ lỗi cho Coder; không coi payload sai là approve hoặc request_changes hợp lệ. |
| `CODER_BLOCKED: ACCEPTANCE_AMBIGUOUS` | SL được làm rõ bằng evidence/criteria **đã duyệt**; thiếu căn cứ thì escalate. | Đổi acceptance criterion phải qua approval/revision; chưa có route an toàn thì giữ parking. |
| `CODER_BLOCKED: SCOPE_CONFLICT` | SL phân rã lại/defer/follow-up trong scope và quyền hiện có. | Mở rộng scope, đổi cấu trúc/contract/quyền → Architecture/owner. |
| `CODER_BLOCKED: CONTRACT_DECISION_REQUIRED` | SL chỉ được chỉ ra contract đã duyệt còn hiệu lực. | Contract mới/thay đổi hoặc compatibility decision chưa có → Architecture/owner. |
| `CODER_BLOCKED: ACCESS_REQUIRED` / `SECURITY_RISK` | SL triage dependency, thu thập evidence, chỉ áp dụng biện pháp đã được ủy quyền. | Không tự cấp quyền, chấp nhận security/data-loss risk hoặc bỏ sandbox; chuyển đúng người có thẩm quyền. |
| `COMMIT_APPROVAL_REJECTED` / `HUMAN_REVIEW_*` / policy exception | Giữ rejection và human-only authority; SL chỉ chuẩn bị đề xuất/reconcile. | Không retry commit để lách rejection; không thay owner approval bằng SL approval. |
| Evidence/source/commit mismatch; review job/status lỗi; `TICKET_INTEGRATION_FAILED` | Node reconcile identity; SL triage ngoài thẩm quyền ticket-local. | Không sửa source chỉ để khớp artifact cũ, không integrate evidence stale, không retry mù. |
| Error code/cause chưa phân loại | Fail closed với diagnostic, SL triage; escalate khi vượt authority. | Không mặc định auto-retry hoặc mặc định sinh owner approval UI cho mọi lỗi. |

Ý nghĩa “owner chỉ can thiệp khi đổi cấu trúc”: giảm owner involvement cho vận hành **đã được ủy quyền**, không bãi bỏ quyền human-only/security/contract hiện hành.
Cách diễn giải và mọi delegation mới cần D2; trước khi có căn cứ, giữ boundary hiện tại, không tự chuyển mọi `CODER_BLOCKED` sang quyền SL.
SL là người triage/điều phối Sprint; Node/Supervisor mới thực thi timeout, schedule, checkpoint và ticket-local retry.

## 5. Budget: tách operational retry khỏi repair

| Phạm vi | Identity / cách đếm | Exhaustion đích |
| --- | --- | --- |
| Coder operational recovery | Ledger theo `project_id + task_id + execution_id + coder`; chỉ tăng khi tạo retry vì infra failure, không tính initial invocation hoặc repair dispatch bình thường. | `task.failed`, giữ checkpoint và diagnostic, SL triage; không biến thành Coder-completed kể cả review gate OFF. |
| Reviewer operational recovery | Giữ identity review job đầy đủ và `review_policy.max_operational_attempts`; outcomes/active attempt là source of truth hiện có. | Gate ON park `needs_human_review` có context; Gate OFF chỉ outcome + follow-up, không reopen/parking ticket completed. |
| Coder repair revision | Giữ `consumeRepair()`/`max_review_revisions` theo ticket và các verification repair bound đã được xác minh. | Giữ terminal/disposition của policy tương ứng; không dùng operational retry để sinh thêm repair budget. |

- **Chưa xác minh có budget Coder hiện hữu**; không mượn `review_policy.max_operational_attempts`, không tuyên bố đang tái sử dụng budget chưa tìm thấy.
- D1 phải chốt nguồn config và giá trị hữu hạn cho số retry Coder và recovery elapsed deadline. Tên đề xuất: `max_coder_operational_retries`, `max_coder_recovery_elapsed_ms`; chưa phải field canonical đang tồn tại.
- Retry count là số retry sau lần đầu; không trộn với “total attempts”. Nếu map config cũ, phải chứng minh cách chuyển đổi, không tăng giới hạn đã duyệt.
- Đổi request/provider/source revision hoặc restart trong cùng execution không reset ledger Coder; retry infra trong repair cũng tiêu ledger này.
- Execution mới chỉ theo RUN/approval policy hiện hành, không tự tạo execution ID mới để reset budget.
- Thiếu config hợp lệ: không bật automatic Coder retry; giữ failure có audit và yêu cầu quyết định D1. Không dùng default vô hạn/ngầm định.
- Deadline giới hạn scheduling recovery, không tự kill rồi redispatch invocation còn unknown; không thay runtime timeout đã duyệt.

## 6. Durable scheduling, idempotency và terminal semantics

1. Event failure và executor exception dùng chung classification/recovery decision trước terminal emission; cùng invocation fail chỉ tiêu budget một lần.
2. Persist recovery record trước enqueue: execution/basis, phase, failure identity, source revision, parent/child request ID, retry ordinal, `available_at`, deadline, cause và checkpoint/artifact reference.
3. `available_at = confirmed_failure_at + 30s`; không dispatch trước hạn. Dùng durable queue/clock; không chỉ `setTimeout` trong process.
4. Failure identity phải ổn định khi redelivery. Child retry có request ID mới được persist một lần, liên kết invocation cũ; không tái dùng ID bị `requestStore.claim()` loại bỏ.
5. Reservation budget + claim/enqueue phải atomic hoặc có outbox/reconciliation tương đương; crash không làm mất retry, tăng budget hai lần hoặc phát hai invocation.
6. Một execution/phase chỉ có một invocation active; kiểm tra ownership/basis/source revision, approved scope, cancel và budget/deadline ngay trước dispatch.
7. Owner stop/cancel, terminal result hoặc execution bị thay thế làm retry pending mất hiệu lực có audit. Retry cũ không thay đổi execution mới.
8. Restart giữ nguyên ordinal/deadline/`available_at`; đến hạn chỉ dispatch tối đa một retry sau reconcile, không chạy bù nhiều lần.
9. Provider acknowledgement bị mất hoặc attempt active sau crash → unknown/reconcile; không coi lease expiry là quyền gọi provider lần nữa.
10. Resume từ SDK checkpoint và ledger hiện có; không lặp edit/commit đã hoàn tất, không giả lập Forge operation receipt hay artifact passed.
11. Khi retry còn hợp lệ, không phát `task.failed` terminal sớm. Exhaustion/non-retryable chỉ có một logical terminal outcome đúng execution ownership.
12. Audit mỗi scheduled/started/succeeded/exhausted/cancelled/reconcile-required outcome, có identity, count, next time, cause và evidence; redact secrets/source payload.

Hợp đồng chống chạy trùng (persist-then-enqueue, atomic claim, idempotent khi redelivery, reconcile khi outcome unknown) đối chiếu **transactional outbox + idempotent consumer pattern** chuẩn ngành — microservices.io/patterns/data/transactional-outbox.html, microservices.io/patterns/idempotent-consumer.html, microservices.io/patterns/exactly-once.html (tradeoff exactly-once delivery); D3 dùng làm căn cứ nghiệm thu thay vì chỉ đánh giá nội bộ.
State recovery nội bộ đề xuất: pending → claimed → running → succeeded / exhausted / cancelled / reconcile_required.
Đây không phải public ticket status mới. Phải kiểm tra compatibility của record/event nội bộ trước implementation.
Recovery record không được mutate verdict/artifact cũ, đóng finding hoặc bypass source-bound verification/integration.

## 7. Guidance contract cho Reviewer và verification repair

### Reviewer findings
- Tái sử dụng canonical fields hiện có: `failure` mô tả lỗi cụ thể, `acceptance_criterion`, `evidence_refs`, `minimum_change_scope`, `files`/`per_file_necessity` khi cần.
- Location phải truy ngược được từ source/evidence reference đúng revision; ghi path/symbol/line nếu áp dụng. Finding không gắn file phải giải thích vì sao và dẫn evidence phù hợp.
- `minimum_change_scope` phải mô tả hành động sửa/điều kiện hoàn tất tối thiểu, không chỉ lặp title. Không tự thêm required public schema field ngoài scope được duyệt.
- Validate trước khi lưu và trước repair dispatch; plain title hoặc thiếu diagnostic/evidence không thành finding hợp lệ cho Coder sửa.
- Legacy string findings phải qua adapter được kiểm thử hoặc Reviewer bổ sung structured evidence; adapter không được tự bịa vị trí/cách sửa.
- Payload sai là lỗi Reviewer, đi operational recovery của Reviewer; không tiêu Coder repair revision trước khi có decision hợp lệ.
- Kiểm thử cả attempt-builder, fallback và đường repair production hiện dùng; text/structured guidance phải cùng nội dung và identity, không mất dữ liệu khi resume.
- Reviewer adjudicate `fixed`/`withdraw`/`not_applicable` có evidence; SL gắn backlog không đóng finding còn `retain`.

### Verification repair
- Guidance gồm artifact ID và execution/source/commit identity, failed check/command kind, argv đã redact, exit code, diagnostic stdout/stderr đã redact và reference tới output đầy đủ được phép đọc.
- `failed_paths`/finding bổ sung vị trí nếu có; không bắt buộc bịa failed path khi command-level failure không gắn file.
- Missing/truncated diagnostic phải có lý do và đường lấy evidence; không thay bằng câu “tests failed” chung chung.
- Tách logic failure khỏi infra như `VERIFY_STORAGE_EXHAUSTED`; không yêu cầu Coder sửa business code để chữa storage/provider outage.
- Giữ evidence-recovery cho `CODER_EVIDENCE_PENDING`, revision bound và owner scope; không downgrade verification plan hoặc auto-approve vì thiếu evidence.

## 8. Outcomes và nghiệm thu bắt buộc

| Mã | Acceptance quan sát được | Dependency / guardrail |
| --- | --- | --- |
| O1 | Cả event và executor exception transient đi cùng recovery decision; fake clock ở 29.999s chưa dispatch, 30s dispatch đúng một lần nếu policy/budget cho phép. | D1 (budget/allowlist transient); §5–§6. |
| O2 | Persistent/unknown cause, commit rejection và thiếu Coder config không tự retry; cùng invocation qua hai đường failure không tiêu budget hai lần. | D1 (fallback: không bật auto-retry khi thiếu config); §4 fail-closed. |
| O3 | Budget Coder độc lập Reviewer/repair; exhaustion và deadline có audit/terminal đúng matrix, không reset khi đổi request/provider/restart. | D1 (bắt buộc: nguồn config + giá trị hữu hạn); §5. |
| O4 | Restart trước/sau enqueue, redelivery, hai worker, active lease và provider outcome unknown không tạo duplicate invocation hoặc mất recovery. | D3 (atomic claim/store compatibility); §6 items 2–9. |
| O5 | Stop/cancel, stale basis/revision và execution replacement vô hiệu retry pending; event cũ không hoàn tất/release claim của execution mới. | D3; §6 items 6–9. |
| O6 | Finding thiếu description/location evidence/fix guidance bị từ chối như lỗi Reviewer; legacy và strict path đều có coverage, Coder không bị repair vì verdict malformed. | Không đổi public finding schema ngoài scope duyệt; §7 adapter. |
| O7 | Verification command failure truyền diagnostic source-bound đủ dùng qua dispatch/resume; storage failure không thành repair code mù. | Dùng artifact/diagnostic đã có (`ticket-verification-service.js:149`); không dựng từ `failed_paths` đơn thuần. |
| O8 | Routing test theo từng reason và delegation: SL xử lý case in-scope có evidence; ngoài quyền giữ escalation; không sinh owner approval UI chỉ từ trạng thái parking. | D2 (bắt buộc trước khi mapping outcomes → tickets). |
| O9 | E2E tối thiểu: Coder report → review dispatch → request_changes → repair revision mới → approve đúng identity → integrate; không reuse approval revision cũ. | D3 (coverage mapping); giữ `consumeRepair()` bound hiện có. |
| O10 | Nhánh verdict invalid, evidence stale, unknown provider, budget exhausted, finding unresolved và owner rejection không integrate/auto-approve; soft-review sau completed không reopen/parking. | D2/D3; không đổi verdict authority của Reviewer. |

Chạy targeted unit/fake-clock và integration/E2E liên quan; không mặc định full suite hay gọi provider thật.
Test phải chứng minh số invocation, số lần tiêu budget, durable record và terminal outcome, không chỉ khớp prompt/log text.

## 9. Quyết định và dependency trước dispatch

| Mã | Cần chốt | Trách nhiệm / fallback an toàn |
| --- | --- | --- |
| D1 | Đã triển khai default/config + policy snapshot hữu hạn theo yêu cầu owner; xem §9b. | Config sai fail-closed, thiếu scoped execution basis không retry. Không tạo plan approval record. |
| D2 | Đã chốt giữ authority hiện hành, SL chỉ triage có evidence; xem §9b. | Không cấp delegation mới hoặc bypass human-only/security/access/contract/Reviewer boundary. |
| D3 | Adapter production + targeted lifecycle/store tests đã có; xem §9b. | Trước manifest SL vẫn re-verify source/coverage theo revision; provider live/deployment không được suy ra từ SDK giả lập. |

Không tự tạo owner decision ID, confirmed_at, approval hay registered revision cho các mục trên.
Nếu policy mới xung đột resilience plan/rulebook, ghi governing revision và precedence rõ; không để hai tài liệu cùng tự nhận ưu tiên.
SL được tự chia ticket và sequencing sau khi có căn cứ; không ép số lượng/tên ticket hay manifest từ snapshot này.

## 9b. Kết quả triển khai D1–D3 (2026-10-16)

- **D1:** `backend/src/modules/supervisor/coder-recovery-policy.js` cung cấp mặc định 2 retry/execution, deadline 600.000ms từ failure đã xác nhận đầu tiên, delay tối thiểu 30.000ms. Config `NODEFORGE_CODER_RETRY_ENABLED=false` tắt retry; `NODEFORGE_CODER_MAX_RETRIES` (1–10), `NODEFORGE_CODER_RETRY_DEADLINE_MS` (>30.000 đến 86.400.000) cho deployment. Config sai bị từ chối; snapshot policy persist theo execution, không reset khi restart/repair/đổi provider. Không áp dụng cho standalone/direct-code thiếu execution basis. Đây là cấu hình triển khai theo yêu cầu owner, không sinh approval record cho plan.
- **D2:** `coder-recovery-policy.js` và `ticket-execution-failure.js` persist reason/evidence + triage role SL. SL chỉ inspect/clarify tiêu chí đã duyệt/propose follow-up/escalate; không mở quyền sửa scope/contract/access/security, override owner rejection hay đóng finding của Reviewer. Không tạo delegation mới cần giả lập approval.
- **D3:** `coder-recovery-runtime.js` nối validate–dispatch–terminal–Stop; `production-runtime.js` dùng adapter mặc định khi đủ Registry/status/workspace. Hai failure paths dùng chung ledger và inline launch claim; retry giữ child request ID/checkpoint. Reserve/delivery/preparation kiểm tra execution/basis/source/base/manifest/commit, approved scope, dependency và cancellation. Stop fence status trước abort SDK và persist cancellation; restart không replay pending/unknown parent.
- **Phân loại an toàn:** structured HTTP 429/503 rejection hoặc transient turn đã kết thúc mới được retry; raw timeout/disconnect/abort không chứng minh provider đã dừng thì giữ launch ownership và chờ reconciliation. Không suy diễn process exit/config/auth/502/504 thành retry-safe.
- **Evidence tests:** `backend/tests/unit/coder-production-recovery.test.js`, `coder-operational-recovery.test.js`, `coder-recovery-runtime.test.js`, `ticket-stop-route.test.js`, SDK gateway tests và automatic-review E2E. Dùng SDK giả lập và file store thật để kiểm tra budget/deadline, restart, dedup, Stop, stale authority, unknown outcome và review/repair/integrate. Chưa kiểm chứng provider live hoặc deployment process đang chạy.
- **Handoff:** xem `backend/error-routing-recovery.md`; code chỉ có hiệu lực khi deployment/service nạp phiên bản mới. Không tự restart service, RUN ticket, đăng ký revision hay tái dùng approval R1.

## 9c. Quyết định bổ sung 2026-10-17: AM quyết định kỹ thuật và hướng dẫn Coder xử lý blocker

- **Nguyên tắc phân vai (Owner chốt):** Khi Coder gặp blocker, vai trò của Architecture Manager (AM) là **ra quyết định kỹ thuật trong cấu trúc đã duyệt và cung cấp `guidance` cụ thể để Coder tự sửa code**, tuyệt đối không tự nhảy vào sửa code thay Coder và không đùn đẩy các quyết định kỹ thuật đã được ủy quyền ngược lên Owner.
- **Quy tắc định tuyến và validation (`blocker-recovery-contract.js`, `blocker-decision-authority.js`, `blocker-recovery-agent.js`):**
  1. **SL (`stage: "sprint_leader"`):** Tự giải quyết (`action: "resolved"`) các vấn đề nằm trong phạm vi Sprint. Với `ACCESS_REQUIRED`, `SECURITY_RISK`, hoặc `CONTRACT_DECISION_REQUIRED` chưa có `contract_evidence` khớp sẵn, SL bắt buộc trả `action: "architecture_required"` để chuyển lên AM. Nếu SL trả `resolved` sai thẩm quyền, validator trả `blockerValidationError` với `retryable_disposition: true` để SL tự điều chỉnh sang `architecture_required` ngay trong vòng retry thay vì rơi vào `reconciliation_required`.
  2. **AM (`stage: "architecture_manager"`, `authority_scope: "architecture"`):** Được ủy quyền trả `action: "resolved"` kèm `guidance` chi tiết cho Coder trên cả `CONTRACT_DECISION_REQUIRED`, `ACCESS_REQUIRED` và `SECURITY_RISK` khi giải pháp nằm gọn trong cấu trúc, `allowed_paths` và quyền hiện có (cả 6 cờ `boundary_assessment` đều `false`: `changes_structure`, `changes_owner_scope`, `changes_security_policy`, `changes_data_semantics`, `overrides_guardrails`, `changes_ticket_contract`).
  3. **Chặn đùn đẩy lên Owner & chống lật cờ:** Nếu AM trả `owner_required` khi cả 6 cờ `boundary_assessment` đều `false`, validator từ chối bằng `delegated_to_architecture` (`retryable: true`) để buộc AM ra quyết định và hướng dẫn Coder; đồng thời chặn hành vi tự ý lật cờ từ `false` sang `true` ở lần retry kế tiếp (`boundary_inflation_forbidden`).
  4. **Đảm bảo retryable cho các lỗi hình thức còn sót trong `blocker-recovery-contract.js`:**
     - Nhánh kiểm tra `proposal` của `owner_required` (`blocker-recovery-contract.js:35`, `sha256:45275a8fe23feff45bcd5ff972c6cce907d79356e98ca231829277c813c805fc`) và nhánh `requireContractBinding` khi `job?.stage === "sprint_leader"` (`blocker-recovery-contract.js:73`) phải dùng `blockerValidationError(..., { retryable: true })` thay vì `invalid()` không có cờ retry, đồng thời vẫn giữ nguyên hành vi bắt lỗi tĩnh của `preflightBlockerContract` (`blocker-contract-preflight.js:17`, `sha256:ca867fc99b60c3b244e5f0ba82d7a182b551fa764320d6dfc2ab705a4b50beea`).
  5. **Vận hành với ticket đã dừng ở `reconciliation_required` trước đó:** Theo `blocker-recovery.js:31,74,176` (`sha256:a7cc1c977c7b5a93b0268cc94677cc0e160900d43b140eb302d572aba941a548`) và `ticket-run-dispatch.js:68` (`sha256:251688fa21ef2c82907f9c5c7933e429eb0ea08695a901f81f1fd8ad4f79ddc0`), các job đã ở trạng thái `reconciliation_required` cần được bấm **RUN** lại trên ticket để `resumeTicket` re-arm stage và `salvagePersistedAttempt` thẩm định lại quyết định đã lưu.

## 10. Checklist và handoff

- [x] Đã tách facts đã đọc khỏi vùng chưa xác minh; không tuyên bố discovery toàn pipeline đã hoàn tất.
- [x] Đã bổ sung routing theo reason, budget riêng, durable retry và guidance source-bound.
- [x] Đã có acceptance cho hai đường failure, restart/dedup/cancel, hard/soft review và E2E repair.
- [x] D1 có policy deployment hữu hạn, config rõ và snapshot durable theo yêu cầu triển khai của owner; không giả lập plan approval.
- [x] D2 giữ authority hiện hành, triage có evidence, không bypass owner rejection hoặc security boundary.
- [x] D3 nối production dispatch–cancel–restart và có targeted simulated-SDK/file-store coverage; provider live/deployment chưa xác minh.
- [ ] SL re-verify evidence/source và coverage theo revision triển khai trước manifest/dispatch; §3–§8 vẫn là snapshot, không phải bằng chứng runtime live.
- [ ] Plan revision thực sự được đăng ký và approve theo đúng identity/revision/SHA-256; không reuse approval nguồn R1.
- [ ] RUN/dispatch riêng theo gate hiện hành; việc lưu tài liệu này không tự RUN.
