<!-- Tổng kết yêu cầu và kế hoạch kiến trúc để bỏ Roadmap, hợp nhất quản lý Sprint/Ticket qua registry trước khi SL phân rã delivery. -->
# Plan: Project → Sprint → Ticket — một Sprint Plan Registry

**Trạng thái:** Draft chờ human review/approval; không phải Sprint Plan hoặc quyền RUN.
**Ngày lập:** 2026-10-08.
**Decision owner:** Project owner (human). Architecture xác lập boundaries; SL sở hữu phân rã delivery sau exact approval.

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** luồng hiện tại còn phụ thuộc Roadmap; Sprint registry, roadmap snapshot, ticket files/metadata và status store được ghép hoặc cập nhật qua nhiều đường. Người dùng yêu cầu bỏ cấp trung gian và chỉ có một đầu mối quản lý Sprint/Ticket.
- **Kết quả:** mô hình nghiệp vụ và điều hướng là `Project → Sprint → Ticket`; Sprint Plan Registry là đầu mối duy nhất quản lý, lưu trữ, cập nhật và đồng bộ Sprint/Ticket cho UI, backend và execution.
- **Giá trị:** không đăng ký một Sprint nhiều lần ở nhiều nguồn, không phải chọn bản dữ liệu khác nhau giữa list/detail/RUN, không còn gate hoàn tất dựa vào Roadmap.

### Tổng kết yêu cầu đã chốt trong hội thoại

1. Bỏ hẳn cấp Roadmap, không chỉ bỏ ID hoặc đổi Roadmap thành một projection/màn hình trung gian.
2. Sprint thuộc trực tiếp Project; Ticket thuộc Sprint trong cùng Project.
3. Không sinh entity/ID/version Roadmap mới và không dựng Roadmap giả.
4. Sprint Plan Registry sở hữu vòng đời Sprint/Ticket, persistence và synchronization; không thêm module quản lý ngang quyền.
5. Giữ Architecture Plan, revision/hash, approval, RUN gates, dependencies thực sự và execution/audit/history.
6. Architecture lập plan theo outcomes; SL quyết định số Sprint/Ticket, ID, DAG và mutable-file manifest sau approval đúng contract.

```text
Project
  └─ Sprint
       └─ Ticket

UI / API / SL / Execution
            │
    Sprint Plan Registry
       ├─ Contract revisions + approval references
       ├─ Sprint/Ticket lifecycle + execution references
       └─ Persistence adapters / read projections / audit
```

Đây là mô hình đích, không phải mô tả registry hiện tại đã đáp ứng đầy đủ. Registry là ownership boundary, không bắt buộc một file hay một bảng chứa mọi dữ liệu.

## 2. Phạm vi

### In scope

- Bỏ Roadmap khỏi entity, quan hệ, navigation, active contracts và điều kiện handoff/execution.
- Hợp nhất các đường đọc/ghi Sprint/Ticket qua registry; tái sử dụng implementation phù hợp bên trong boundary thay vì thêm nguồn chuẩn mới.
- Chuyển schema/validator, API/projection, prompt SL, upload/CRUD, human review, status events và RUN consumers sang mô hình trực tiếp.
- Chuyển dữ liệu legacy có kiểm chứng, xử lý conflicts, bảo toàn immutable approval evidence và có rollback an toàn.
- Cập nhật test fixtures, tài liệu hướng dẫn và composition/wiring liên quan trong scope.

### Out of scope

- Refactor SDK/provider, code index, Git pipeline hoặc execution engine không phục vụ outcomes dưới đây.
- Bỏ approval/security/verification gates; cho phép chỉnh sửa revision đã duyệt hoặc tự chuyển approval sang hash mới.
- Thay đổi policy admission ticket, tự approve/dispatch hoặc thay ownership Architecture/SL/Coder/Supervisor.
- Xóa lịch sử, receipt, checkpoint, owner context hoặc audit chỉ vì có trường legacy Roadmap.
- Bắt buộc gom mọi storage thành một bảng/file; tạo lại Roadmap dưới tên khác.

### Phần luồng cũ cần loại / phần giữ lại

| Loại khỏi active flow | Thay thế / chức năng giữ |
| --- | --- |
| Entity, ID, version và quan hệ cha Roadmap | `project_id` trực tiếp ở Sprint; liên kết Ticket–Sprint–Project được kiểm chứng |
| Tạo Roadmap trước Sprint; đăng ký Sprint rồi ghi thêm roadmap | Admission/commit duy nhất qua registry |
| Roadmap Store là nguồn chuẩn Sprint/Ticket | Retire nguồn chuẩn sau migration; legacy artifact chỉ đọc phục vụ evidence/history |
| Duyệt `roadmaps.getCurrent().sprints` để tìm Ticket | Lookup registry theo project/sprint/ticket và exact revision |
| Gate handoff/recovery yêu cầu Sprint có trong roadmap | Kiểm tra registry commit, child plan binding và receipt theo approved parent |
| Dual-write status store + roadmap; sửa ticket ngoài registry | Lệnh registry; adapters nội bộ không có quyền quản lý độc lập |
| Union/fallback roadmap–metadata–plan–log ở UI/backend | Quy tắc resolve contract/revision/status thống nhất tại registry |
| UI Roadmap, breadcrumb/label/upload field và Roadmap giả | Project mở Sprint trực tiếp; giữ backlog, dashboard và tiến độ |
| Provenance/dependency có nút Roadmap | Giữ approved parent plan, Sprint/Ticket provenance và dependency nghiệp vụ thật |

Không coi bảng này là danh sách file được phép xóa. Service có chức năng hữu ích được chuyển ownership hoặc thay adapter; chỉ xóa code/schema obsolete khi chứng minh hết consumers.

## 3. Hướng tiếp cận và guardrails

### Ràng buộc bắt buộc

- **Single authority:** mọi public read/write Sprint/Ticket/status qua registry. Storage adapter nội bộ có thể tồn tại nhưng không có entrypoint quản lý cạnh tranh, không đồng bộ vòng.
- **Identity:** mọi lookup, relation, mutation và approval/execution binding kiểm tra Project; không lookup latest toàn hệ thống rồi suy ra ownership.
- **Immutable contract:** nội dung đã duyệt giữ nguyên bytes/revision/hash; status mutable riêng và gắn đúng Ticket revision/execution attempt. Giữ `plan_id` cho approval, không nhầm nó với Roadmap ID bị bỏ.
- **Approval/RUN:** registry trả cùng execution basis mà RUN kiểm tra; missing/hash mismatch/unapproved/stale/conflicting basis phải fail closed. Handoff không tự RUN.
- **Concurrency:** mutation có expected revision/version/status phù hợp; conflict trả lỗi rõ, không lost update. Replan không thay nền thực thi của attempt đang chạy.
- **Commit/event:** chỉ báo thành công và phát dữ liệu UI sau commit; có recovery/replay/idempotency cho partial persistence, retry và duplicate/out-of-order events. Không bỏ failed event âm thầm.
- **Security:** giữ authorization/role gates, project isolation và protected-path policy; không cho UI hoặc agent sửa trực tiếp runtime state để bypass registry.
- **History:** history/export/index là artifact/projection do registry kiểm soát; checkpoint/receipt/log thuộc execution/audit, không là fallback tự cấp quyền cho Ticket contract.

### Hướng đề xuất

- Mở rộng/converge boundary registry hiện có với immutable plan persistence và ticket lifecycle adapters; không tạo một quản lý Sprint song song chỉ vì đổi tên.
- Contract truy vấn thể hiện Project và danh sách Sprint trực tiếp, không có wrapper Roadmap. Sprint detail và Ticket detail trả identity/revision/status đủ để đối chiếu với RUN.
- Các lệnh nghiệp vụ cần được registry bao phủ: admission/handoff, upload, CRUD/replan, bind revision, approval resolution, lifecycle transitions và execution event application.
- Registry là nơi duy nhất chọn revision hiện hành và diễn giải status; list/detail có thể dùng projection nhưng phải từ committed state, có thể rebuild và không tự merge nguồn ngoài.
- SL xác minh public API/schema thực tế rồi chọn versioned replacement hoặc adapter legacy có thời hạn. Adapter nếu cần chỉ dịch vào registry, không giữ Roadmap là active entity hay nguồn có quyền ghi.

### Dependency thật sự và quyết định chưa chốt

- Trước chuyển writer/RUN: phải có contract registry bao phủ Ticket và migration identity/approval mapping được kiểm chứng.
- Trước bỏ consumer/schema/store cũ: phải hoàn tất consumer inventory, migration reconciliation và verification parity.
- Trước destructive cleanup/cutover: human/architecture chốt compatibility window và rollback boundary trên evidence SL cung cấp; phần cleanup bị block nếu chưa chốt.
- Chi tiết API names, storage topology, số Sprint/Ticket và thứ tự delivery do SL quyết định trong guardrails; không phải điều kiện approval kiến trúc riêng nếu không đổi public/data semantics đã chốt.

## 4. Khu vực dự kiến ảnh hưởng và evidence

Evidence là static source đã đọc/tìm kiếm trong lượt lập plan; chưa có runtime witness hoặc test execution. Line refs dùng để định hướng, SL phải khảo sát lại source trước implementation.

| Thành phần / khu vực | Vai trò / evidence đã xác minh |
| --- | --- |
| `backend/src/modules/governance/sprint-registry.js:11-80` | Có SQLite scheduling, bind exact plan revision/hash và readiness gates; API đọc được chưa bao phủ đầy đủ Ticket CRUD. SHA-256: `e30a6873f8c9d7606ef5c5826cb41beb1e6b34b42d9f4f51be7231dc2954ae0f` |
| `backend/src/modules/governance/human-plan-store.js:25-80` | Immutable file + SQLite integrity/decision index, expectedRevision và identity/hash checks. SHA-256: `f5d22c54aaec4508142b854a5774f9e65f4383d763bae35bf7535fec351e4e6a` |
| `backend/src/modules/governance/sprint-plan-draft-persistence.js:6-29` | Child draft được bind approved parent, persist revision và register/bind Sprint. SHA-256: `bfc3c6e92e7db41d7ec74e83ee50fa70d0d85824bd8fb3d92b146e16750fdc34` |
| `backend/src/application/plan-handoff-service.js:12-76` | Durable retry receipt nhưng completed/recovery còn kiểm tra roadmap snapshot. SHA-256: `cfc40ffab5e21cd73b4046c74794b3f109152b0a85668598fbe28b9b7d18f9e1` |
| `backend/src/modules/governance/markdown-plan-store.js:41-60` | Handoff status phụ thuộc `isSprintInRoadmap`. SHA-256: `139fabfa7d245e9b7fe3078f6cd17a8e454f58a7dcf10d25d72eb1202c6d4d29` |
| `backend/src/modules/governance/sprint-plan-projection.js:5-55` | Sprint/backlog/status hiện resolve từ Roadmap Store. SHA-256: `91298cc36468fa49c891d3958eeebc78e155570d51a55881908b620c79519dea` |
| `backend/src/application/project-dashboard-service.js:14-71` | Ticket fallback, union registry/roadmap/metadata và status override; output Roadmap wrapper. SHA-256: `742ab3ba7efa87ea1c9f47e44d80bb69e378866c8d3cbb07c9311b8d9a64d925` |
| `backend/src/modules/supervisor/terminal-bridge.js:13-54` | Terminal events cập nhật status store rồi roadmap, có CAS handling cần giữ. SHA-256: `64be7346b4b7d57df2a6800d29c1ca53ea0fd75044ede449d51d888513df2e4d` |
| Search hits: application CRUD/upload/human-review/intake, governance planner/provenance/architecture-manager, HTTP conversation routes, control API scripts | Có Roadmap lookup/identity/persistence hoặc status consumers; chưa đọc toàn bộ implementation, không kết luận xóa file |
| Search hits: `schemas/governance/{sprint-plan,ticket}.schema.json`, `backend/src/infrastructure/sqlite/index-migrations.js` | Schema yêu cầu `roadmap_id`; tickets SQL có `roadmap_id TEXT NOT NULL`; cần migration/versioning, không chỉ xóa trường UI |
| Search hits: `ui/nextjs/lib/{home-page-dashboard,sprint-plan-validator}.js`, `components/{Dashboard,NodeForgePanels}.jsx` | Dựng wrapper/ID Roadmap giả, validator và upload/display còn Roadmap; cần xác minh tất cả UI consumers |
| File listing: unit/integration suites cho handoff, projection, CRUD, status, dashboard, immutable pipeline và orchestration | Có test areas để mở rộng regression; sự tồn tại file không chứng minh tests pass |

Candidate areas không phải mutable-file allowlist; SL đọc instructions áp dụng và xác minh paths/consumers trước chốt manifest.

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Dependency / guardrail |
| --- | --- | --- | --- |
| O1 | Bỏ cấp Roadmap | Project tạo/liệt kê/mở Sprint trực tiếp; Ticket thuộc Sprint cùng Project; active schema/API/prompt/UI không yêu cầu hoặc sinh Roadmap; legacy evidence không còn là gate | Không đổi immutable bytes |
| O2 | Registry là single authority | Inventory mọi reader/writer; upload/CRUD/replan/handoff/human-review/status/RUN dùng registry; không có độc lập dual-write hay fallback contract ngoài boundary; restart giữ state | Project isolation, persistence recovery |
| O3 | List/detail/RUN nhất quán | Cùng Ticket revision/hash/approval/status cho cùng execution basis; sau commit UI nhận state đã commit, refresh/reconnect nhất quán; không ghost Sprint hoặc metadata overwrite âm thầm | O2; fail closed khi dữ liệu không hợp lệ |
| O4 | Handoff/recovery không cần Roadmap | Approved parent sinh/admit child qua registry; completed khi exact binding/commit/receipt hợp lệ; retry/crash không tạo duplicate; không cần roadmap snapshot và không tự RUN | Giữ approved parent lineage, derived-approval contract hiện hành |
| O5 | Approval và execution an toàn | Missing/tampered/stale/unapproved/cross-project bị chặn; replan cần revision mới và không kế thừa approval sai; status không đổi plan hash; conflict và stale attempt không ghi đè | Giữ source/index/file/hash, dependency và auth gates |
| O6 | Migration/cutover bảo toàn dữ liệu | Có dry-run, counts/identity/revision/status reconciliation, duplicate-ID conflict report và restart/idempotency witness; legacy approval vẫn exact; rollback drill không mất writes sau cutover | Human chốt compatibility/rollback trước destructive cleanup |
| O7 | Loại code obsolete có chứng cứ | Không còn active consumer/gate/authority Roadmap hoặc sync vòng; tests/docs/fixtures cập nhật; chỉ giữ legacy artifacts phục vụ evidence và adapters có exit condition | O1–O6 đạt, consumer inventory hoàn tất |

**Gợi ý delivery, không bắt buộc:** contract/consumer discovery → registry convergence và migration dry-run → consumer/UI cutover → parity/recovery witness → retire obsolete paths. Chỉ các dependencies nêu rõ ở trên là bắt buộc.

SL tạo ticket contracts và mapping mỗi outcome/criterion tới một hoặc nhiều ticket, chủ động split/resequence; không giảm tiêu chí hoặc mở rộng scope. Mỗi ticket tuân thủ admission policy hiện hành, một style hợp lệ và tối đa bốn mutable files theo rulebook; không RUN chỉ vì đã lập SP.

### Verification cần có trước acceptance

- Unit/contract: identity, project isolation, revision conflict, lifecycle transitions, approval/hash và dependency checks.
- Integration: SL intake/handoff retry, upload/CRUD/replan/human review, terminal events, API list/detail/RUN parity qua wiring thực tế.
- Migration fixtures: roadmap-only, registry-only, metadata-only, thiếu status, duplicate ID khác content, immutable approved legacy và broken references; không tự suy ra approval khi thiếu evidence.
- Recovery/concurrency: crash giữa file/index/commit/event, restart, duplicate/out-of-order events, CAS conflict, stale execution attempt và UI reconnect.
- UI witness: mở Project → Sprint → Ticket, upload không cần Roadmap, empty/error states, trạng thái sau commit; không có Roadmap wrapper giả.
- Static inventory: mọi hit Roadmap còn lại phân loại legacy history/compatibility hoặc obsolete; không dựa grep-zero đơn thuần thay cho runtime witness.
- Chạy schema validation và regression/backend/UI checks phù hợp repository scripts do SL xác minh; không bịa lệnh hoặc tuyên bố pass trước khi chạy.

## 6. Rủi ro, giả định và câu hỏi mở

| Rủi ro / câu hỏi | Tác động | Evidence / giả định | Người chốt / cách xử lý |
| --- | --- | --- | --- |
| Registry hiện có mới là scheduling boundary | Major | API source đọc được tách khỏi plan store và status consumers | SL khảo sát, converge ownership; Architecture review khi đổi public/data semantics |
| Dữ liệu cùng ID khác nhau giữa legacy stores | Blocker đối với cutover dữ liệu liên quan | Nguy cơ suy ra từ multi-source reads, chưa đo runtime | SL xuất conflict report; human chọn bản/mapping, không last-write-wins ngầm |
| Xóa `roadmap_id` làm thay approved bytes/hash | Blocker đối với in-place migration | Immutable persistence đã hash exact bytes | Giữ bytes legacy qua reader nội bộ hoặc tạo revision mới theo approval contract; không chuyển approval sang hash mới |
| Compatibility của consumers ngoài UI hiện tại | Major / chưa chốt | Chưa có đầy đủ external consumer inventory | SL lập inventory/versioning đề xuất; human/architecture chốt cửa sổ tương thích trước cleanup |
| Rollback sau khi có writes mới | Blocker nếu chỉ restore snapshot cũ | Chưa có witness triển khai | SL cung cấp replay/reconciliation hoặc quiescence protocol; human/rollout owner xác nhận trước cutover |
| Status/attempt correlation và semantics Sprint aggregate | Major | Terminal bridge và dashboard hiện resolve riêng | SL xác minh đầy đủ producers/readers, giữ transition semantics và ngăn stale event |
| Handoff một parent có thể sinh nhiều Sprint | Câu hỏi compatibility, không khóa số Sprint | Handoff đọc được đang lưu một `sprint_id` | SL đánh giá coverage; nếu cần đổi receipt/cardinality/public contract, trình Architecture/human trước triển khai phần đó |

### Yêu cầu bổ sung của owner: schema và migration không mất dữ liệu

**Ghi nhận ngày 2026-10-08:** owner cho phép sửa schema khi cần để đạt mô hình `Project → Sprint → Ticket`, đồng thời yêu cầu migrate dữ liệu cũ sang mô hình mới và không để mất dữ liệu. Đây là ràng buộc scope/acceptance, không thay exact approval của plan hoặc cấp quyền RUN.

- **Schema thuộc in scope:** có thể sửa JSON schema/validators, database schema/migrations và API contracts liên quan. Không giữ `roadmap_id` bắt buộc trong active model chỉ để né migration; SL xác minh consumers và chọn versioning/adapter trong guardrails. Không mở rộng sang schema không liên quan.
- **Migration là delivery bắt buộc của O6**, không phải tùy chọn hoặc giao người dùng nhập lại. Phải bảo toàn Sprint/Ticket, Project ownership, quan hệ/dependencies, mọi contract revision, approval evidence, execution status/attempt, checkpoint/receipt và history/audit đang tồn tại trong phạm vi chuyển đổi. Dữ liệu legacy không có chỗ trong active schema phải có archive/mapping có thể truy xuất, không bị bỏ âm thầm.
- **Inventory và backup trước thay đổi:** lập manifest nguồn dữ liệu, identity/revision và checksum thích hợp; tạo backup/snapshot nhất quán, chứng minh restore được. Kiểm soát writers bằng quiescence hoặc cơ chế capture/replay có kiểm chứng để không bỏ sót cập nhật trong lúc migration.
- **Mapping có truy vết:** ghi source identity → target identity/schema version và kết quả chuyển đổi; giữ ID nếu không có conflict. Thiếu Project/link/status/approval không được tự suy đoán; báo lỗi và giữ nguyên bản nguồn. Không đổi bytes/hash revision đã duyệt; representation mới không được kế thừa approval sai.
- **Conflict không phải dedup tùy tiện:** cùng ID nhưng content/revision/ownership khác nhau phải xuất conflict report và bảo toàn tất cả bản nguồn. Không last-write-wins, merge hoặc ghi đè ngầm. Dữ liệu liên quan chưa giải quyết bị chặn cutover/RUN; human quyết định mapping/bản có hiệu lực, các bản còn lại vẫn giữ làm evidence.
- **Reconciliation bắt buộc:** đối chiếu từng record/revision và liên kết, không chỉ tổng counts; chứng minh mọi bản nguồn có đích hợp lệ hoặc archive kèm lý do được duyệt, không có silent drop/orphan. Đối chiếu riêng hash/approval và trạng thái/attempt; list/detail/RUN phải parity trên dữ liệu đã migrate.
- **Recovery và rollback:** migration có version/checkpoint, idempotency và resume sau interruption; thử rerun/crash/restore trên fixtures. Rollback phải bảo toàn/replay writes phát sinh sau cutover, không restore snapshot cũ làm mất cập nhật mới.
- **Gate nghiệm thu O6/O7:** không drop schema/store hoặc xóa dữ liệu legacy trước backup/restore witness, conflict resolution, reconciliation đầy đủ và parity verification. Nếu chưa chứng minh không mất dữ liệu thì block cutover/destructive cleanup; thời hạn giữ backup/archive do owner chốt.

Chi tiết storage/migration scripts, manifest và phân rã tickets do SL sở hữu sau approval; Architecture chỉ cập nhật yêu cầu và guardrails. Chưa khảo sát lại source/schema, chưa sửa schema/code, chưa migrate dữ liệu hoặc chạy tests trong lượt bổ sung này.

### Migration / rollout boundary

- SL chỉ định rollout owner thực tế, consumer/version inventory, backup và preconditions; Architecture không hứa production acceptance.
- Dry-run đọc dữ liệu legacy, map Project–Sprint–Ticket, exact plan/revision/approval/status và dependencies; mọi thiếu/mâu thuẫn phải hiện ra.
- Không cập nhật file đã duyệt tại chỗ. Legacy Roadmap fields chỉ được tồn tại trong artifact lịch sử/reader tương thích nội bộ, không thành active entity hoặc nguồn ghi.
- Cutover writer theo single-authority boundary; không triển khai dual-write hai nguồn chuẩn như trạng thái ổn định. Partial state phải có fail-closed và recovery protocol.
- Reconciliation và witness đủ rồi mới retire paths/schema legacy. Rollback phải xử lý writes sau cutover; thiếu khả năng đó thì block cutover, không restore backup mù.
- Log/metrics phải nhận diện conflict, approval/hash failure, migration/recovery failure và stale/duplicate event với project/sprint/ticket/revision/attempt khi phù hợp; không log secrets.

## 7. Acceptance criteria của plan và approval/handoff

- [x] Tổng kết đủ yêu cầu Project → Sprint → Ticket, bỏ Roadmap và single registry.
- [x] In/out scope, guardrails, candidate areas và outcomes tách rõ khỏi delivery decomposition.
- [x] Facts có static evidence; giả định và phần chưa khảo sát/runtime chưa kiểm chứng được ghi rõ.
- [x] Không áp đặt số Sprint/Ticket, tên ticket hoặc mutable-file manifest.
- [ ] Human review compatibility/migration/rollback trade-offs và approve đúng artifact identity/revision/SHA-256 theo storage contract hiệu lực.
- [ ] SL chứng minh coverage O1–O7, xác minh policy/schema hiện hành và lập SP trước dispatch.
- [ ] Implementation cung cấp verification evidence và rollout decision; viết tài liệu hoặc lập SP không tự cấp quyền RUN.

**Giới hạn lượt lập plan:** chỉ khảo sát static source và tạo tài liệu này; không sửa code/runtime/schema, không migration, không chạy tests, không tự approve hoặc dispatch. Không dùng external architecture reference vì quyết định trong plan dựa trên yêu cầu owner và repository contracts.
