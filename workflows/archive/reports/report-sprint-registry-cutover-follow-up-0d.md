<!-- Follow-up architecture theo source/report; không thay Reviewer, approval hoặc runtime acceptance. -->
# Sprint Registry — Follow-up 0d: observed basis và readiness

**Ngày:** 2026-10-08. **Verdict:** partial implementation; chưa nghiệm thu full cutover O1–O7.
**Baseline:** completion plan revision 1 vẫn ghi Draft; không xác minh runtime approval receipt lượt này.
**Report đã đọc:** `report-sprint-registry-cutover-current.md`, SHA-256 `75cb65d66561eed155d409b8601027b34d3d9c989733b5a3c8751b6a370dcd07`.
Mục này supersede finding tương ứng ở audit 0c; không thay đổi approved contract hoặc scope.

## 1. Delta xác nhận ở source

- `sprint-plan-draft-persistence.js:9–25,29–44` giữ `previous` trước approval-validation await, bind bằng `previous.version`, không refresh/retry để overwrite winner. Exact-parent recovery kiểm tra version; nếu exact revision đã bound thì không reset status/version. Unbound/different binding đi qua guarded bind.
- Conflict/registration race/running-basis conflict giữ immutable revision và derived approval; `error.recovery` ghi disposition/identity. Đây là service-level metadata, không public HTTP recovery contract hoặc durable job/receipt. Không tiếp tục ghi draft persistence chưa truyền observed version.
- `sprint-registry.js:70–83` nhận optional expectedVersion, kiểm tra Project/Sprint/path/hash và recheck scheduling version sau immutable validation. Nhận xét cũ assertReady không revalidate đã lỗi thời. Không đồng nhất successful readiness với durable admission.
- Test draft concurrency đã đọc toàn bộ: actual SQLite/immutable stores, controlled pause sau create/approve, stale loser giữ winner và evidence, exact-parent recovery giữ readiness, initial registration race. Test Registry readiness `:124–148` có block/new-revision/same-basis ABA trong validation.
- Bốn checksums latest report khớp từng source/test đã đọc. Run `VERIFY-RUN-8dcc6083-113c-4996-a405-ba8683feb7ac`, exit 0, evaluated `2026-10-08T17:40:21.463Z` vẫn **Coder-reported**, chưa độc lập đọc output hoặc chạy test. Không suy run này chứng minh các HTTP/UI/migration checks cũ đã rerun.

## 2. Hướng chỉnh tiếp / điều kiện đóng outcomes

| Outcome / mức | Guardrail và witness cần có |
| --- | --- |
| O2/O5 — Major: observed intent toàn caller | Snapshot tại entry draft persistence chỉ bảo vệ workflow từ entry đó. Inventory producers/consumers thực tế; caller dựa snapshot trước entry phải giữ exact observed basis đến mutation. Không tự reload rồi retry intent cũ. Bổ sung stale-before-entry witness và propagation từ scheduling API/UI nếu active; thay required/public precondition cần compatibility decision, không tự áp incompatibility. |
| O5 — Major: durable RUN admission | `ticket-run-dispatch.js:24–47` dùng readiness rồi await checkpoint/recovery/clear trước dispatch. Tuy nhiên production `start-control-api.mjs:126–129` có **readiness check thứ hai** trong dispatchTask trước submitTicket; không nói production hoàn toàn không recheck. Check này vẫn không truyền scheduling basis/attempt vào durable submission trong đoạn đã đọc. Fence exact Project/Sprint/Ticket revision/hash/version và attempt tại admission, bao phủ mọi entrypoint; verify pause trong submit/admission, rebind/block, parallel RUN và restart không dispatch stale/duplicate. Không chỉ thêm một read check. |
| O5 — Major: Sprint lifecycle/terminal fencing | `start-control-api.mjs:162–178` đọc plan rồi set running không truyền version đã quan sát; completion/failure callbacks setStatus không gắn admission attempt/basis. Đây là risk, chưa incident. Giữ basis qua transition và terminal application; witness intervening rebind, delayed old completion/failure versus newer attempt, duplicate/out-of-order event và crash/replay. Không dùng in-memory runningSprints/active map thay durable attempt identity. |
| O2/O4/O5 — Major: durable reconciliation | Retained evidence là đúng hướng nhưng error object mất khi process crash. Cần all-or-nothing hoặc durable recovery protocol cho file/index/approval/bind/handoff/receipt/event, reload exact committed receipt và continue không repost decision/handoff. Inject failures trước/sau từng commit và restart; xác định trạng thái retained-unbound/committed/pending reconciliation, không xóa evidence để che partial failure. SL chọn implementation trong contract đã duyệt. |
| O1/O2/O3/O4 — Major: authority và active diagnostic | Hội tụ writers/dashboard/intake/RUN/review/handoff về Registry. Production composition vừa đọc vẫn có Roadmap intake/review và Sprint projection. Active dashboard diagnostic chưa reaudit UI lượt này, vẫn open theo report: actual HTTP → client → active consumer → DOM, safe/bounded/missing IDs, requestId/project isolation, unavailable khác empty và không Retry/tự retry mutation. Không vá disconnected component chỉ để đóng finding. |
| O6/O7 — Blocker cutover/cleanup | Full per-version/source/link reconciliation, authorized conflicts, backup–restore, resume/rollback giữ writes/events mới. Report đã ghi đúng synthetic-v17 limitation; cần historical artifact hoặc chứng minh fixture tương đương có provenance, cùng crash/restart/restore/rollback witnesses. Reviewer + human rollout/retention decision trước retire/drop. |

Các hàng là outcomes/guardrails, không ticket manifest hoặc delivery DAG. SL sở hữu phân rã và mutable manifests trong approval hiệu lực; Architecture/human chốt thay đổi semantics/scope vượt boundary.

## 3. Chỉnh report / evidence cho Reviewer

- Giữ verdict partial; ghi draft observed basis và assertReady recheck là **implemented/source confirmed**, focused pass **Coder-reported**, independent verification pending. Không claim O5 admission/attempt fencing đã đóng.
- Bổ sung production second-readiness check để mô tả gap chính xác: check-to-durable-admission, không khẳng định không có recheck. Bổ sung Sprint RUN transition/terminal caller chưa giữ observed basis/attempt.
- Giữ `recovery` là service metadata; chưa gọi durable recovery completed. Report đã minh bạch atomicity, synthetic-v17 và các batch không rerun: giữ các giới hạn này.
- Bundle gắn exact source/environment/snapshot hoặc dirty manifest, command/time/result/output artifacts; fields không có từ Forge ghi unavailable, không đoán counts/hash. Reviewer độc lập kiểm chứng coverage O1–O7; audit này không tự acceptance.

## 4. Evidence identities

Whole-file hashes từ Forge; reads riêng lẻ, không atomic snapshot hoặc độc lập chứng minh tested bytes.

| File | SHA-256 |
| --- | --- |
| `backend/src/modules/governance/sprint-plan-draft-persistence.js` | `69e3272166df9bb973b36d83417ebff72e35e7b07a5b9276f88052fff667d30b` |
| `backend/src/modules/governance/sprint-registry.js` | `d5fa38056917ccd4a010b37faa3c24ced30885c4c34ce49f77523d21ed942a7a` |
| `backend/tests/unit/sprint-plan-draft-concurrency.test.js` | `87928af2c81eb8a23434266378916127b1b392abaf72ddbf81937f74b6f52b7c` |
| `backend/tests/unit/sprint-registry-concurrency.test.js` | `3dd60373d1e74499b6bc35fa8d6364297abeb0394245176847140510b28c52c0` |
| `backend/src/application/ticket-run-dispatch.js` | `fda08a6eb5160f57bb42e6026a897bf1bbdf2fefa6d1caa2a8f7805e1eda5c3a` |
| `backend/scripts/start-control-api.mjs` | `310d5e83db038de9ba210bbefdb7cae8dd02a7113168bd8c268e4d87a60933b4` |

**Giới hạn:** đọc rulebook/root instructions/architecture overview/plan/report/audit, tree/list/search và targeted source/tests. Chỉ viết follow-up này và index 0d trong audit (tách để giữ file audit ≤250 lines). Không sửa code/schema/report Coder/plan, chạy tests/browser/Git, migrate, commit/push, approve hay RUN. Không dùng nguồn ngoài vì không cần quyết định kiến trúc mới và nguồn ngoài không chứng minh repository implementation. **Chưa được retire/drop legacy store/schema.**
