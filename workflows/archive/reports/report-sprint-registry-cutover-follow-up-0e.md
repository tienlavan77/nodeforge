<!-- Audit delta RUN basis và hướng nghiệm thu; không thay Reviewer hoặc cấp quyền thực thi. -->
# Sprint Registry — Follow-up 0e: RUN basis và durable admission

**Ngày:** 2026-10-08. **Verdict:** partial O2/O5 remediation; chưa nghiệm thu full cutover O1–O7.
**Report:** `workflows/report-sprint-registry-cutover-current.md`, SHA-256 `ed1f104fca56e5c97753ec25a7780dd3aa34c114b091bab6280737be1498b6fd`.
**Baseline:** completion plan revision 1 vẫn ghi Draft; lượt này không xác minh runtime approval receipt. Mục 0e ưu tiên hơn findings lịch sử tương ứng; không sửa approved bytes hoặc thay scope.

## 1. Facts xác nhận qua source

- `sprint-run-dispatch.js:11–35` lấy specs từ immutable Registry plan, kiểm tra membership/Project/Sprint/approval/DAG trước guarded transition. Start truyền `sprint.version`; completion/failure giữ `sprintBasis.version` đã admission, không reload expectation. Finding 0d về Sprint start/callback thiếu observed version đã lỗi thời ở mức source.
- `start-control-api.mjs:126–156` thực sự compose các boundary mới; không chỉ helper dùng trong tests. Sprint DAG adapter truyền expectedSprintVersion vào shared Ticket RUN; intake/review/terminal/dashboard composition vẫn có Roadmap dependencies. Không gọi authority convergence đã hoàn tất.
- `ticket-run-dispatch.js:24–48` giữ basis trước checkpoint/resume/clear awaits. `approved-ticket-dispatch.js:10–25` revalidate version và exact binding trước submit, đưa `sprint_basis` vào payload. Đây là pre-submit fencing và basis propagation, không phải atomic durable queue admission hoặc durable attempt receipt.
- `sprint-registry.js:108–116` transaction guarded UPDATE và read result, version tăng qua mỗi write. Persisted running/version thay in-memory Sprint Set trong boundary đã đọc; đủ hướng chống admission lại một Sprint đang running, chưa chứng minh recovery sau process chết.
- Đã đọc toàn `sprint-run-basis.test.js` (197 lines): chín behavioral cases, real SQLite/immutable approval ở Registry boundary; DAG/submission doubles, actual DAG forwarding case. Reopen dùng connection thứ hai khi execution cũ còn sống; không killed-process recovery. Không có assertion rollback checkpoint clears/Ticket status trong checkpoint-race case.
- Sáu batch checksums trong report khớp whole-file hashes đọc lượt này. Run `VERIFY-RUN-fe3cf575-4ec1-4fda-ae2f-d3ac78f09550`, exit 0, evaluated `2026-10-08T18:00:47.746Z` vẫn **Coder-reported**; chưa đọc run output artifact hoặc độc lập chạy tests. Git failure/không commit SHA cũng chỉ report-reported, không Git-verified lượt này.

## 2. Hướng chỉnh tiếp / điều kiện đóng outcomes

| Outcome / mức | Guardrail và behavioral evidence cần có |
| --- | --- |
| O5 — Major: durable admission | Chốt recoverable protocol liên kết scheduling basis, durable attempt và queue admission; không chỉ thêm read check hoặc payload field. Pause bên trong actual submit trước durable commit, xen block/rebind và parallel Ticket RUN khác process; stale intent không thành execution được phép. Crash trước/sau scheduling/queue commit phải phân biệt pending/committed/orphan và reconcile/dedup đúng, không redispatch mù. SL chọn transaction/outbox/receipt hoặc cơ chế tương đương trong contract; không áp storage mới như quyết định đã duyệt. |
| O5 — Major: terminal/dependency identity | `sprint-dag.js:36–39,54–79` reuse done/dependencies theo Ticket ID/status; listener lọc task_id + event type, chưa lọc exact Project/revision/hash/attempt. Sprint callback CAS không chặn stale Ticket event mở dependency hoặc stale done được reuse. Bổ sung exact completion evidence và attempt-scoped waits; test old done sau replan, same Ticket ID khác Project, duplicate/out-of-order/old completion khi attempt mới đang chạy, event trước subscription và replay/reconnect. Đây là source risk, không claim incident đã xảy ra. |
| O2/O5 — Major: side effects trước admission | `ticket-run-dispatch.js:39–53` clear checkpoint/protocol/conversation và prepareStatus trước final submit; catch có thể mark failed theo current status mà không attempt predicate. Cần durable recovery/fencing cho các side effects này. Test stale rejection sau clear không mất recoverable evidence; old dispatch failure không mark attempt mới failed; parallel fresh/resume/review và crash giữa các clears/status/submit. Không gọi test hiện tại đã rollback các writes. |
| O2/O4/O5 — Major: observed intent và receipts | Inventory mọi caller giữ precondition từ lúc intent hình thành, gồm stale-before-entry draft witness. File/index/approval/bind/handoff/receipt/event cần all-or-nothing hoặc durable reconciliation; reload exact committed receipt sau read fail, continuation không repost decision/handoff. `error.recovery` chưa là durable job; retention evidence không tự chứng minh restart recovery. |
| O1/O2/O3/O4 — Major: authority và operator diagnostic | Converge active writers/intake/review/handoff/dashboard, không chỉ Sprint plan read. Map actual route/client/consumer; `/coding` cần Registry-backed dashboard giữ scoped error đến DOM, safe/bounded/missing IDs và requestId, Project isolation, unavailable khác empty, không Retry/tự retry non-retryable conflict. Legacy approval components reachability chưa rõ không thay active witness. UI nhóm này chưa reaudit lượt này; giữ open theo report/audit trước. |
| O6/O7 — Blocker cutover/cleanup | Full per-version/source/link manifest và authorized conflicts; historical upgrade provenance hoặc equivalent fixture có chứng minh, consistent backup/restore, crash/resume và rollback giữ writes/events mới. Reviewer source-bound verification + exact human rollout/retention decision trước retire/drop. Version migration/reopen unit case không thay operational drill. |

Các hàng là outcomes/guardrails trong baseline, không ticket list, manifest cố định hay delivery order. SL sở hữu phân rã/DAG; thay public semantics/security/required precondition vượt boundary cần Architecture/human quyết định.

## 3. Chỉnh report và evidence

- Giữ verdict partial hiện có; ghi Sprint start/callback observed-version fencing **implemented/source confirmed**, pass **Coder-reported**, runtime/independent acceptance pending. Không tiếp tục lặp finding lịch sử như chưa sửa.
- Bổ sung rõ done/dependency reuse theo ID và attempt-unscoped failure catch bên cạnh gap terminal listeners. Giữ phân biệt row version với durable attempt identity; không gọi submitted basis là admission receipt.
- Phần đầu report còn “Focused regression checks passed” và giới hạn consumer cũ: nên ghi historical batch/Coder-reported và trỏ latest reachability inventory, tránh hiểu là HTTP/UI đã rerun hoặc hai approval components chắc chắn active.
- Verification bundle gắn exact snapshot hoặc dirty manifest/checksums, environment/commands/run/result/output artifacts và Reviewer. Không đoán Node version/TAP totals/output hashes khi tool không trả.
- `GIT_ADD_FAILED` không có commit SHA: không gọi committed/pushed; không force-add/đổi ignore rules chỉ để vượt gate. SL/human chốt artifact handoff theo policy, tách Git outcome khỏi runtime acceptance.

## 4. Evidence identities

Whole-file hashes Forge; reads riêng lẻ, không atomic repository/test snapshot.

| File | SHA-256 |
| --- | --- |
| `backend/src/application/sprint-run-dispatch.js` | `f76a3b6beaa15b9caa2de9ebd61cb651609124c2ba06f97383d7a126f9b7158a` |
| `backend/src/application/approved-ticket-dispatch.js` | `01e67772c2555a4b4f2ecbf07f0436743ccc48ce4f40ae066879beb78bbfe29d` |
| `backend/src/application/ticket-run-dispatch.js` | `74b2f01666d52482e166eae2cc3d52faaab8806af56c194279618378eb159da2` |
| `backend/src/modules/supervisor/sprint-dag.js` | `9fb78b64e97c45c631bc382b9478077741b81c7f21818d73680283be26d7df1c` |
| `backend/scripts/start-control-api.mjs` | `769ecca9bb315a42456bf96aa4280546bdd39047d458ff2c4f79db223c28ab13` |
| `backend/tests/unit/sprint-run-basis.test.js` | `50d9c17ac4021fb350054a75f1c1ee6a1bd96ab648af33a4491345437feeb89d` |
| `backend/src/modules/governance/sprint-registry.js` | `d5fa38056917ccd4a010b37faa3c24ced30885c4c34ce49f77523d21ed942a7a` |

**Giới hạn:** đọc instructions/report/baseline/audits/architecture overview và targeted source/test/tree/list/search. Chỉ tạo follow-up này và cập nhật index audit; không sửa implementation/schema/report Coder/plan, chạy tests/browser/Git, migrate, commit/push, approve hoặc RUN. Đây là audit architecture boundaries, không thay Reviewer implementation review. Không cần external references cho repository-specific evidence và không đưa quyết định kiến trúc mới. **Chưa được retire/drop legacy store/schema.**
