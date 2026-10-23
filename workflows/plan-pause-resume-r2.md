# Plan: Pause/resume r2 an toàn cho direct `system_engineer`

<!-- Bảo đảm tiếp tục/tạo lại execution không replay mù side effect và luôn có đường manual reconciliation. -->

> **Trạng thái:** kế hoạch architecture revision 2. Revision này thay thế các giả định recovery chưa đủ trong `plan-pause-resume-direct-engineer.md`; implementation hiện tại chưa được xem là đạt acceptance production.

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** execution checkpoint đã có lease, heartbeat, tool boundary và UI Continue / Restart / Discard, nhưng Restart tạo attempt mới không kế thừa đầy đủ receipt; pending mutation làm cả Continue và Restart rơi vào dead-end; `push_commit` chưa có receipt/verification riêng; lease chưa fencing được tool đang chạy.
- **Kết quả:** mọi attempt direct `system_engineer` có lineage và checkpoint summary đủ để Continue hoặc Restart có chủ ý; side effect đã hoàn tất được chứng minh và không gọi lại; side effect chưa chắc chắn đi qua manual reconciliation; commit/push được xác minh bằng receipt; execution cũ không thể mở đường cho instance mới chạy đè.
- **Giá trị:** phục hồi sau pause, crash, timeout hoặc provider-thread loss mà không đánh đổi an toàn workspace, Git history, remote branch và auditability.

## 2. Phạm vi

### In scope

- Sửa contract lineage giữa execution gốc, Continue, Restart và provider context.
- Kế thừa bounded checkpoint summary, `changed_paths`, file checksums, commit receipt, push receipt và các boundary chưa xác định sang attempt mới.
- Manual reconciliation có chủ ý cho pending mutation, gồm file write/edit/delete, check và Git boundary.
- Một classification/policy duy nhất cho retryable, reconcile-required và no-auto-replay tools.
- Receipt và verification cho `commit_changes` và `push_commit`.
- Lease fencing ở tool boundary và trạng thái riêng khi lease hết hạn trong lúc mutating tool có thể còn chạy.
- API/control/UI hiển thị recovery state; giữ control ngoài human message bubble; kiểm thử Esc x2 với IME composition.
- Unit/integration/e2e tests cho restart, crash window, push, manual reconciliation, provider-thread loss và hai instance.

### Out of scope

- Tự động rollback nhiều file hoặc hoàn tác commit/push đã phát sinh.
- Tự động resume sau process restart mà không có quyết định rõ ràng của owner.
- Thay đổi semantics checkpoint của ticket/supervisor hoặc mở rộng sang role read-only.
- Ghi transcript/full tool output/file content vào checkpoint; checkpoint chỉ giữ hash, receipt và summary có giới hạn.
- Tự động xóa record `pending`, `unknown` hoặc `manual_required`; revision này giữ chính sách không cleanup tự động, TTL/cleanup tương lai là change riêng.

## 3. Hướng tiếp cận và guardrails

### Ràng buộc bắt buộc

- **Không replay mù:** không tool nào được gọi lại chỉ vì execution mới bắt đầu. Mỗi step phải có policy, precondition và receipt/reconciliation result.
- **Restart không rỗng:** attempt mới phải mang `lineage_id`, `resume_of`, attempt number, completed receipts, changed paths, commit/push receipts, pending/unknown boundaries và next-action summary. Attempt cũ chỉ chuyển terminal sau khi attempt mới đã được persist; không xóa record cũ.
- **Structured restart context:** Restart dùng context mới hoặc provider thread mới theo policy đã chốt, nhưng luôn gửi structured summary từ Node. Mất provider thread không được làm mất evidence hoặc biến `completed_tool_calls` thành mảng rỗng.
- **Manual reconciliation là gate, không phải retry:** owner xác nhận có chủ ý; Node tự kiểm tra checksum/absence, `HEAD`, branch/remote receipt và precondition tương ứng. Một lời xác nhận không được tự biến step không rõ kết quả thành completed.
- **Git không replay tự động:** `commit_changes` và `push_commit` không được chạy lại khi đã có receipt; nếu receipt thiếu hoặc remote không thể xác minh thì giữ trạng thái blocked/manual, không đoán và không push lần hai.
- **Lease fencing:** execution giữ fencing epoch/token. Mỗi tool boundary, đặc biệt ngay trước mutation, phải xác nhận token/owner còn hợp lệ. Lease hết hạn trong lúc tool mutating đang chạy phải tạo `lease_expired_tool_active`/tương đương và buộc reconcile; không coi đó là interrupted bình thường có thể Continue ngay.
- **Authorization và project scope:** route reconciliation/recovery giữ cùng conversation ownership, agent-role và project-scope checks hiện có; không tạo đường bypass qua endpoint mới.
- **Backward compatibility:** record cũ thiếu field r2 được đọc như `unknown`, không suy diễn là đã completed. Continue/Restart phải yêu cầu reconciliation khi thiếu evidence.

### Bảng policy đề xuất (source of truth)

| Nhóm | Tools | Hành vi sau interruption |
| --- | --- | --- |
| Retryable | search/read, `git_status`, `git_diff` và các probe không side effect | Có thể gọi lại sau khi lease hợp lệ; vẫn ghi step mới và input hash |
| Reconcile-required | `write_diff`, `edit_diff`, `delete_file`, `run_check` | Không gọi lại pending step; kiểm tra checksum/absence hoặc bounded check receipt; chỉ mở gate sau manual/automatic verification được ghi nhận |
| No-auto-replay | `commit_changes`, `push_commit` | Chỉ dùng receipt/HEAD/remote verification; thiếu bằng chứng thì blocked/manual, không gọi lại |

Bảng này phải được hiện thực hóa thành policy có thể test, không để `MUTATING` đơn lẻ làm source of truth. `run_check` cần receipt gồm command hash, result/status, commit/HEAD context và timestamp; không được gọi lại như thể kết quả cũ chưa tồn tại nếu command đã chạy nhưng response mất.

### Hướng đề xuất

1. **Lineage và restart summary:** mở rộng checkpoint schema/store để lưu attempt lineage, `completed_tool_calls` bounded, `pending_tool_calls`, `unknown_tool_calls`, `changed_paths`, file receipts, `commit_receipt`, `push_receipt`, provider session metadata và fencing token. Tạo một summary serializer có giới hạn kích thước dùng chung cho Continue, Restart và provider fallback.
2. **Continue/Restart semantics:** Continue dùng cùng lineage và chỉ đi qua sau reconcile thành công. Restart tạo execution ID mới nhưng sao chép evidence bất biến và đánh dấu step đã hoàn tất là không được replay; provider prompt phải nêu rõ các bước completed, uncertain và next safe action. Không dùng `resume_of` đơn độc làm cơ chế truyền context.
3. **Manual reconciliation contract:** thêm service/endpoint cho owner chọn execution và boundary cần reconcile. Request phải nêu expected evidence (checksum/absence, commit SHA, branch/remote); server đọc workspace/Git hiện tại để xác minh, ghi actor/time/evidence hash/result. Các mismatch hoặc remote không đọc được trả về `manual_required`, không tự retry.
4. **Receipt verification:** sau commit lưu SHA, `HEAD`, paths và parent context; sau push lưu remote, branch, pushed SHA và remote HEAD/verification result. Khi recover, kiểm tra đúng remote/branch và SHA trước khi cho phép bước tiếp theo. Nếu Git adapter hiện tại chưa cung cấp dữ liệu này, bổ sung contract ở adapter thay vì suy ra từ tool text.
5. **Fencing và process race:** heartbeat gia hạn token hiện tại; token cũ không được bắt đầu boundary mới. Nếu token mất trong một call đang chạy, giữ pending/unknown và phát signal rõ ràng; recovery phải chờ owner xác nhận process cũ không còn hoạt động hoặc hoàn tất manual reconciliation. Không tuyên bố fencing có thể hủy side effect đã bắt đầu.
6. **UI/API:** giữ polling và control card/banner hiện có; hiển thị `manual_required`, `lease_expired_tool_active`, receipt summary và lý do block. Esc bị bỏ qua trong composition; Esc lần một chỉ hint, lần hai trong cửa sổ ngắn mới pause. Recovery controls không được render trong human message bubble.

### Dependency thật sự

- Git adapter phải expose hoặc đọc được remote, branch, pushed SHA và remote HEAD/verification result; mismatch, remote unavailable hoặc verification failure đều giữ `manual_required`, không có operator override.
- Manual reconciliation endpoint và GET execution list phải áp dụng cùng conversation ownership, agent role và project scope; server tự đọc và xác minh evidence, không coi actor confirmation là proof.
- Fencing phải dùng epoch/token tăng đơn điệu và kiểm tra ở mọi tool boundary, gồm cả failure path; cần evidence process cũ đã dừng trước khi mở recovery sau `lease_expired_tool_active`.
- Retention hiện đã chốt là không cleanup tự động; không xóa record có `pending`, `unknown` hoặc `manual_required`. TTL/cleanup tương lai là change riêng.

### Quyết định architecture đã được phê duyệt

Các quyết định dưới đây là contract đã chốt cho revision này; implementation phải chứng minh chúng bằng evidence và acceptance criteria, không xem chúng là câu hỏi mở:

| Quyết định đã chốt | Contract bắt buộc | Phạm vi implementation còn phải xác minh |
| --- | --- | --- |
| Restart dùng provider context/thread mới | Restart tạo execution ID và provider context/thread mới; Node truyền structured summary có lineage, receipts, boundaries, changed paths và next safe action; không dựa vào transcript/thread cũ | Cách adapter khởi tạo context mới và giới hạn kích thước summary |
| Continue/Restart không tự kích hoạt | Chỉ chạy sau click hoặc decision rõ ràng của conversation owner; không auto-resume theo prompt, timeout hoặc provider event | Cách API/UI biểu diễn decision và trạng thái đang chờ quyết định |
| Manual reconciliation có authority giới hạn | Chỉ conversation owner đã xác thực, trong cùng conversation, `system_engineer` role và project scope, được yêu cầu reconciliation; server luôn tự đọc và xác minh workspace/Git | Cách transport lấy actor và áp dụng đầy đủ authorization cho GET/list và endpoint reconciliation |
| Git receipt phải xác minh đầy đủ | Receipt push phải có remote, branch, pushed SHA và remote HEAD hoặc kết quả verification tương đương; mismatch, unavailable hoặc failure phải giữ `manual_required`; tuyệt đối không có operator override để bypass | Git adapter cung cấp remote verification ổn định và cách lưu evidence/hash |
| Lease race là manual recovery | Nếu lease hết hạn khi mutating tool còn chạy, trạng thái là `manual_required` hoặc `lease_expired_tool_active`; không mở Continue/Restart bình thường cho tới khi process cũ được xác nhận dừng và workspace/Git được kiểm tra | Cơ chế fencing và evidence chứng minh process cũ đã dừng; fencing không hủy side effect đã bắt đầu |
| Retention an toàn tạm thời | Không cleanup tự động; không xóa record có `pending`, `unknown` hoặc `manual_required`; giữ evidence cho lineage và reconciliation | Chỉ cần xác định storage/operations không vô tình xóa record; TTL/cleanup tương lai là change riêng |

### Implementation dependencies và ranh giới delivery

- Sprint Leader quyết định ticket, dependency DAG, candidate files và delivery decomposition. Architecture chỉ cung cấp outcomes, contracts, guardrails và evidence requirements; không tạo mutable-file manifest hoặc tự dispatch.
- Cách Git adapter chứng minh remote HEAD và cách xác nhận process cũ đã dừng vẫn là implementation dependencies, không phải thay đổi quyết định architecture.



## 4. Khu vực dự kiến ảnh hưởng và evidence

| Thành phần / khu vực | Vai trò | Evidence / mức chắc chắn |
| --- | --- | --- |
| `backend/src/application/owner-execution-checkpoint.js` | Store, lease, tool boundary, `canContinue`/`reconcile`, receipt schema | Đã đọc source; checksum `sha256:224399bc3a900e204f643d50414e9f7bb867ebb57e5644936b9894697f6349d4`; hiện `canContinue` chặn pending mutation và `reconcile` chưa có manual path/push verification — chắc chắn |
| `backend/src/application/owner-execution-control.js` | Continue/Restart/Discard orchestration | Đã đọc source; checksum `sha256:9889767ce14dc807c9282689264de08144619c794a481334e810b576f4bc1927`; hiện Continue và Restart đều yêu cầu reconcile, Restart chỉ truyền `resume_of` — chắc chắn |
| `backend/src/application/owner-sdk-stream.js` | Provider session, structured resume context, heartbeat/abort | Đã đọc source; checksum `sha256:ad0353b01ec0867b86abf0bfa7b517b8235e18d5fb2bb4686a9029464d846569`; hiện `resume_of` bỏ thread và resume notes chỉ áp dụng Continue — chắc chắn |
| `backend/src/application/owner-execution-tools.js` | Wrapper trước/sau Forge tool và failure window | Đã đọc source; checksum `sha256:e0a362625675342fb7dbbe5afb25704ba2de7b6cf358302d6a1fee8af3e2ab89`; pending mutation được giữ nhưng chưa có reconciliation result — chắc chắn |
| `backend/src/tools/owner-engineer-tools.js` | `run_check`, `commit_changes`, `push_commit` contracts | Đã đọc source; checksum `sha256:47158c585eab60da13c4f53fc15ab2f17d45113a19739ac439dbb763a9f5b90b`; commit trả SHA, push gọi Git service nhưng checkpoint chưa có push receipt riêng — chắc chắn |
| `backend/src/transport/http/forge-v1-conversation-routes.js` | Conversation execution routes và project scope | Đã đọc source; checksum `sha256:a1f40703bea4cc2573b12b52395a7a37bd787776c504527eb1af068e6f993ec1`; hiện có list/pause/continue/restart/discard, cần mở rộng có kiểm soát cho reconcile — chắc chắn |
| `ui/nextjs/components/system-execution-controls.jsx` | Polling, Esc x2, recovery controls ngoài message bubble | Đã đọc source; checksum `sha256:cbbaeb9a52e0a5b4fbf5208b81d47351ce102a388086c1290c6335db288f2f23`; đã kiểm tra `event.isComposing`, còn thiếu test chứng minh các cửa sổ Esc và state mới — chắc chắn |
| `ui/nextjs/lib/owner-execution-client.js` | Client cho execution control API | Đã đọc source; checksum `sha256:da9b1f7ca763a48c3410bffb57b42fdfc3122d32372bc1ad6bab893c6d248a64`; cần thêm method reconciliation nếu contract được duyệt — chắc chắn |
| `backend/tests/unit/owner-execution-checkpoint.test.js` | Existing checkpoint regression coverage | Đã đọc metadata; checksum `sha256:fbae26d7b7ce1ee7b49c63ac77bd3c51313a7872459a581e57564d7b44fd6333`; cần mở rộng theo outcomes — chắc chắn |

Các khu vực trên là candidate discovery, không phải mutable-file allowlist. SL xác minh dependency và file thực tế trước khi lập SP.

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Dependency / guardrail |
| --- | --- | --- | --- |
| O1 | Restart/Continue giữ được execution lineage và checkpoint evidence | Restart tạo execution ID và provider context/thread mới, nhận structured summary từ Node có `resume_of`/lineage, bounded receipts, changed paths, pending/unknown boundaries và next safe action; Continue/Restart chỉ chạy sau owner click, không auto-resume theo prompt, timeout hoặc provider event; completed side effect không bị gọi lại; attempt cũ còn audit record và không bị xóa | Decision đã chốt về provider context mới và explicit action; remaining verification là fencing/receipt và giới hạn summary — không checkpoint rỗng |
| O2 | Pending mutation có recovery path an toàn | Process chết trước `afterTool` không làm Continue/Restart vô thời hạn; manual reconciliation do conversation owner đã xác thực yêu cầu, giới hạn trong cùng conversation, `system_engineer` role và project scope; server tự kiểm tra checksum/absence/HEAD/remote/branch theo loại step, ghi actor/time/evidence hash/result, chỉ mở recovery khi đạt; mismatch hoặc remote không đọc được vẫn `manual_required`, không retry mù, không có override | Authority đã chốt; remaining verification là chuyển đầy đủ authorization xuống GET/list và reconciliation endpoint |
| O3 | Tool classification và receipt ngăn replay side effect | Có policy table/policy function được test cho mọi tool, phân loại retryable / reconcile-required / no-auto-replay; commit receipt chứa SHA/local HEAD/parent/paths; push receipt chứa remote, branch, pushed SHA và remote HEAD hoặc verification result tương đương, và mọi mismatch đều giữ blocked/manual; `run_check` có bounded receipt gồm command hash, status/result, commit/HEAD context và timestamp; commit/push không bị gọi lại khi receipt chứng minh đã hoàn tất | Không dùng `MUTATING` đơn lẻ; không suy receipt từ tool text |
| O4 | Lease có fencing và phát hiện execution cũ còn nguy hiểm | Hai instance không cùng claim một conversation hoặc bắt đầu mutation tiếp theo; fencing epoch/token tăng đơn điệu bị từ chối ở mọi tool boundary, gồm cả `failTool()`; lease hết hạn khi mutating tool còn chạy tạo `manual_required`/`lease_expired_tool_active`; test race chứng minh không mở Continue/Restart cho tới khi có evidence process cũ đã dừng và workspace/Git được verify; record ở trạng thái này không bị cleanup | Không hứa hủy được side effect đã bắt đầu; lease timeout không phải proof of safety |
| O5 | UX và API expose recovery state đúng, không phá composition | Polling sau reload hiển thị lineage/receipt, `manual_required`, `lease_expired_tool_active` và lý do block; nút Continue/Restart chỉ enabled khi recovery được phép; Esc trong IME không pause; Esc lần một/lần hai/cửa sổ hết hạn/không active có test; controls vẫn ở component riêng, không trong human bubble; route giữ conversation ownership, project scope và agent role | Giữ explicit decision, không auto-resume |
| O6 | Regression evidence đủ để human đánh giá production readiness | Có test cho restart sau write/commit/push, provider-thread loss, pending mutation, manual reconciliation, two-instance Continue, lease race, push verification và UI Esc x2/IME; failure path được log/rethrow, không swallow error | SL mapping từng criterion tới ticket/verification |

**Gợi ý delivery (không bắt buộc):** tách discovery/contract + checkpoint lineage, receipt/policy + manual reconciliation, fencing/control API, UI và regression verification thành các nhánh có thể song song sau khi các dependency ở mục 3 được chốt. Không xem số nhánh hoặc số ticket là contract.

## 6. Rủi ro, giả định và câu hỏi mở

| Rủi ro / câu hỏi | Tác động | Evidence / giả định | Người chốt / cách xử lý |
| --- | --- | --- | --- |
| Attempt mới kế thừa receipt nhưng provider vẫn tự gọi lại tool | Blocker | Current Restart chỉ gửi `resume_of`; structured context chưa bao phủ đầy đủ receipt | Architecture/SL: O1 bắt buộc prompt + wrapper guard; test provider transcript |
| File đã đổi nhưng `afterTool` chưa ghi | Major | Pending mutation hiện khiến `canContinue()` false | Architecture: manual reconciliation kiểm tra độc lập; không retry tự động |
| Push đã thành công nhưng response mất | Major | `push_commit` hiện trả `{ sha, remote, branch }` và kiểm tra local HEAD, nhưng checkpoint chưa lưu push receipt/remote HEAD verification | Architecture đã chốt receipt bắt buộc có remote/branch/pushed SHA/remote HEAD; SL phải chứng minh adapter cung cấp đủ evidence, remote không đọc được thì `manual_required`, không override |
| Lease mất trong call mutating dài | Major | `failTool()` hiện update mà không kiểm tra `owner_instance_id`/status; abort không thể hủy side effect đã bắt đầu | Architecture đã chốt `manual_required`/`lease_expired_tool_active`; SL phải chốt cách lấy evidence process cũ đã dừng, không coi lease timeout là proof of safety |
| Receipt bị truncate vì giới hạn bounded steps | Major | Checkpoint hiện giới hạn `MAX_STEPS` | SL: giữ summary/critical receipts bất biến; không cho Continue nếu evidence critical bị mất |
| Cleanup vô tình xóa record khi chưa reconcile xong | Major | Revision này chốt: không cleanup tự động; record `pending`, `unknown`, `manual_required` không được xóa | Human owner chốt storage/operations tuân thủ hợp đồng này ở O1/O6; TTL/cleanup là change riêng, không làm implicit ở revision này |
| Manual endpoint bị dùng như quyền bỏ qua checksum | Blocker | Action routes đi qua `locate()` (conversation + recipient agent + `system_engineer` role) và project scope, nhưng `ownerExecutionControl.list()` chỉ gọi `checkpoint.inspect()`; GET execution list chưa chứng minh được cùng mức authorization | Đã chốt: manual reconciliation do conversation owner đã xác thực, trong cùng conversation/agent role/project scope; server luôn tự verify evidence và ghi actor/time/evidence hash/result. SL phải chứng minh GET/list và endpoint reconcile áp dụng đủ các check, không có override |
| IME event behavior khác nhau giữa browser | Minor | Component đã kiểm tra `event.isComposing`, chưa có cross-browser test | SL: test event composition và fallback state nếu cần, không thay đổi UX ngoài scope |

## 7. Acceptance criteria của plan

- [ ] Mục tiêu, in/out scope và outcomes trực tiếp xử lý P0 restart, P0 pending mutation, P1 push receipt, classification, lease race và IME evidence.
- [ ] Facts repository-specific có path, symbol/checksum và mức chắc chắn; assumption/open question không được trình bày như fact.
- [ ] Restart lineage, manual reconciliation, receipt, fencing và authorization là guardrail; không biến thành retry tự động.
- [ ] Outcomes có tiêu chí quan sát được, bao phủ backend, API, UI và test đủ để SL lập SP.
- [ ] Plan không khóa số ticket, tên ticket hoặc mutable-file manifest; candidate files chỉ định hướng discovery.
- [ ] Các decision đã chốt được thể hiện như contract; implementation dependencies còn mở (remote verification adapter, evidence process đã dừng, authorization enforcement) được ghi rõ mà không mở lại quyết định.
- [ ] SL phải mapping toàn bộ O1–O6 và từng acceptance criterion tới ticket/verification theo policy hiện hành trước dispatch.
- [ ] Approval đúng identity/revision/SHA-256 của plan này; lập SP không tự RUN/dispatch.
