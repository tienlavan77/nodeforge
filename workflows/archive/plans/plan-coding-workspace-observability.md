<!-- Khảo sát Coding hiện tại và đề xuất workspace theo execution, để SM implement trực tiếp mà không mở quyền Coder. -->
# Plan: Coding workspace minh bạch execution, tool và evidence

- **Ngày:** 2026-10-10.
- **Trạng thái:** đề xuất để human review; chưa approval, chưa quyền thực thi.
- **Identity:** workflows/plan-coding-workspace-observability.md; approval theo revision/SHA-256 hiệu lực.
- **Ownership đợt này:** SM trực tiếp khảo sát bổ sung, sửa code, chạy verification được phép và báo cáo evidence. Chưa dùng SL; không yêu cầu SP, ticket, forecast hay dispatch agent cho công việc triển khai này.
- Architecture chỉ thiết kế; không tự implement hoặc verdict. Các ticket/execution bên dưới là đối tượng của sản phẩm, không phải yêu cầu SM tạo ticket cho đợt này.

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** Coding đang ghép Sprint controls với hoạt động agent tức thời; chưa cho human thấy rõ execution nào đang chạy, provider có sẵn sàng không, tool/quyền hiệu lực và verification thực sự bao phủ gì.
- **Kết quả:** workspace lấy execution làm trung tâm; phân biệt yêu cầu direct-code và immutable ticket, theo dõi hoạt động và xem evidence trước khi hành động.
- **Giá trị:** không đánh đồng role Coder với readiness, tool được expose với quyền sử dụng, request accepted với completed, hoặc một check PASS với toàn bộ ticket đạt.

### 1.1 Khảo sát hiện tại — facts từ source

| Có gì | Hành vi đã đọc | Evidence |
| --- | --- | --- |
| Routes/navigation | /coding là workspace; /code redirect; sidebar ghi Code, không hiện conversation controls | ui/nextjs/app/code/page.jsx:1–8; app/coding/page.jsx:50–53 |
| Layout | Hai cột Sprint Plan và Workspace Agent, tỷ lệ CSS 1:2; dưới 760px chuyển một cột | components/coding-workspace-monitor.jsx:24–42; app/styles/workspace-monitors.css:31–43 |
| Sprint controls | Sprint mặc định collapse; objective, done-count/status; View, Delete, Run; status events và messages | components/coding-workspace-monitor.jsx:28; components/sprint-plan-panels.jsx:12–113 |
| Ticket controls | View, Human Approve, Run/Run fresh/Resume; Stop khi running; Delete; checkpoint phase/turn | components/ticket-detail-modal.jsx:18–66 |
| Direct-code | Composer nằm trong Sprint đã mở; Add ticket bị disable; Code gửi text trực tiếp; Resume dùng checkpoint đầu tiên trả về | components/sprint-plan-panels.jsx:116–161 |
| Direct-code backend | Không tạo sprint ticket; tạo task CODE-* và input riêng; sprintId là optional; dispatch Supervisor; listPending trả danh sách đã sort | backend/src/application/direct-code-request.js:14–47,64–76 |
| Live monitor | Chỉ coder/reviewer; lấy activity mới nhất theo agent rồi lọc status working; hiện tên, activity type, summary, tool name | components/coding-workspace-monitor.jsx:8–18,21–40 |
| Loading/error | Có loading, empty và unavailable riêng; reconciliation không tự retry; có affected IDs/request ID khi lỗi | components/coding-sprint-dashboard-state.js:6–22; lib/coding-dashboard-loader.js:45–62 |
| Local deletion | Áp receipt ticket/sprint đã xóa, tránh response cũ làm sống lại; không reload toàn dashboard khi xóa | lib/coding-dashboard-loader.js:14–42 |
| Registry projection | Immutable Registry basis; status chỉ dùng khi execution basis khớp; progress suy từ status: done 100, running/reviewing/working 50, còn lại 0 | backend/src/application/registry-dashboard.js:20–36 |
| Shared tool nền tảng | forge-engineering-v1 có 12 canonical tools; readiness available/locked; binding trả readiness theo capabilities và registry | backend/src/tools/engineering-tool-catalog.js:7–31; engineering-tool-binding.js:13–46 |
| Test đang đọc | Có assertions bám heading, component imports và CSS grid string; chưa phải bằng chứng browser behavior | ui/nextjs/tests/conversations-navigation.test.js:35–74 |

Paths UI rút gọn trong bảng đều nằm dưới ui/nextjs/. Đây là khảo sát source, không phải kiểm tra giao diện runtime.

### 1.2 Gaps / nhận định thiết kế

- Monitor hiện không phải lịch sử execution: card biến mất khi activity mới nhất không còn working, và gộp theo agent có thể che các execution khác nhau.
- Trang được đọc chưa render provider/model readiness, catalog version, scope, locked reasons, commit grants hoặc verification coverage. Không suy ra backend toàn hệ thống chưa có các dữ liệu này.
- Composer chỉ xuất hiện khi có Sprint mở, trong khi service nhận sprintId optional. Đưa direct-code ra cấp workspace là thay đổi UX đề xuất, cần human chốt, không tự nới authorization.
- Resume direct-code hiện chỉ dùng checkpoints[0]; người dùng chưa chọn được mọi session dở từ control này.
- Progress 50% là projection từ state, không đo khối lượng hoàn thành; nên dùng phase thay vì thanh phần trăm giả chính xác.
- workﬂows/plan-coding-page.md là artifact cũ: mô tả ConversationsAccordion và xóa sidebar, không khớp source hiện đọc. Không sửa hoặc coi nó là approval của thiết kế này.
- Báo cáo workflows/report-coder-unified-forge-tools.md ghi focused recheck FAILED ngày 2026-10-10, chưa nghiệm thu. Đã đọc báo cáo nhưng không chạy lại; binding hiện đọc đã có hash khác bản ghi trong báo cáo, nên không chuyển failures lịch sử thành verdict source hiện tại.

## 2. Phạm vi

### In scope

- Information architecture cho Coding; chọn execution/session; runtime tools/permissions và evidence drill-down.
- Giữ Sprint/ticket controls, Registry diagnostics, local deletion và checkpoint recovery hiện có.
- Projection/API/event extensions tối thiểu, backward-compatible, từ Node tới Coding.
- UX trạng thái loading/empty/unavailable/unsupported/locked/stale; hành động có lý do disable.

### Out of scope

- Hợp nhất role Coder và System Engineer hoặc thay Coding thành trang /system.
- Tạo SL/SP runtime cho đợt triển khai này; thay immutable approval/storage gates.
- Implement mọi provider adapter trong plan UI này; dependency thuộc plan unified Forge tools.
- Arbitrary shell, sửa .forge trực tiếp, nới scope, tự commit/push/rollout.
- Refactor conversation workspace hoặc đổi authentication/database semantics.

## 3. Hướng tiếp cận và guardrails

### 3.1 Layout đề xuất — không phải quyết định đã duyệt

```text
Code / Project                  Connection + snapshot freshness
[Direct code] [Sprint / Tickets] [Sessions / History]
┌──────────────────────┬────────────────────────────────────────┐
│ Work/session list    │ Selected execution                     │
│ Filter by status    │ Identity · phase · provider/model      │
│ Sprint/ticket scope │ Readiness · scope · available actions  │
│ Pending checkpoints │ [Activity] [Tools & Scope]             │
│ Completed/failed    │ [Changes] [Verification] [Review]      │
└──────────────────────┴────────────────────────────────────────┘
```

- Giữ navigation chung; Sprint/ticket là một view, không chiếm mặc định toàn workspace khi mục tiêu là xem execution đang chạy.
- Work list dùng task/execution identity, không dùng agent_id làm identity. Agent có thể xuất hiện trong nhiều historical runs.
- Direct-code composer: ghi rõ không tạo immutable ticket; cho thấy scope/readiness trước submit. Không mô tả việc SM code trực tiếp là sản phẩm direct-code.
- Sessions hiển thị tất cả pending checkpoints và lịch sử đọc được; Resume chọn đúng task, không tự chọn newest session cho mọi thao tác.
- Activity theo execution có timestamp, phase, tool status và receipt; kết thúc vẫn giữ result/history. Không show raw secrets/tool inputs mặc định.
- Tools & Scope lấy catalog và effective policy từ Node: available/locked/unsupported/unknown, reason, version, role, read/write scope, protected paths và authorization commit/push. Không hardcode inventory theo provider.
- Changes lấy diff/changed-path ledger có scope; Verification hiển thị check type/command đã redact, status, source basis, thời điểm, artifact/log và criteria được/không được cover.
- Review tách Coder completed, verification completed, Reviewer verdict và human decision. Không gộp thành một PASS chung.
- Mobile: work list/detail chuyển view hoặc stack; giữ selection, keyboard focus, accessible labels và live announcements; màu không là tín hiệu duy nhất.

### 3.2 Data contract đề xuất — SM xác minh schema và consumers

- Node cấp snapshot của execution: project/task/execution IDs, kind (direct-code/ticket), ticket/plan basis nếu có, provider/model, phase/status, checkpoint, timestamps và freshness.
- Kèm engineering catalog version + effective readiness; action availability có reason và authority reference an toàn. Phân biệt adapter unsupported với tool locked và dữ liệu chưa biết.
- Scope và evidence phải cùng execution/basis; evidence cũ hiện stale, không dùng làm acceptance hiện tại.
- Dùng snapshot đọc bền vững + events update. Reconnect re-read snapshot; duplicate/out-of-order events không đảo terminal status hoặc sống lại artifact đã xóa.
- Schema fields/tên endpoint/event cụ thể chưa chốt. Ưu tiên additive extension; consumer cũ không có metadata mới thì hiện unknown, không giả ready.
- Phân trang/bounded history và log; không đưa credentials, session tokens, runtime raw files hoặc source ngoài read scope ra UI.
- Preflight readiness phục vụ giải thích UX, không phải grant. Backend kiểm tra lại scope/revision/grants lúc submit, resume, stop, commit/push và mọi tool call.
- Có canonical tool không chứng minh action được phép. Missing service/grant hoặc provenance không rõ phải deny và giải thích; UI không sửa capability.

### 3.3 Compatibility và dependencies thật sự

- Giữ /coding và redirect /code; không xóa controls hoặc đổi semantics Run fresh/Resume/Stop/Delete/Human Approve âm thầm.
- Giữ Registry conflict diagnostics; lỗi reconcile không trở thành empty list, không giải quyết bằng lặp approval/RUN.
- Không làm mất receipts/revision khi đổi layout; giữ local deletion fencing. Shared components còn consumers khác cần regression riêng.
- Readiness transport là dependency của Tools & Scope thật; sửa primitive để phản ánh executor/grants hiệu lực trước nghiệm thu badge Ready. Có thể giao UI unknown/locked trước, nhưng không tuyên bố parity.
- History và selection phụ thuộc identity/snapshot API được xác minh; không suy diễn lịch sử từ activity stream trong bộ nhớ.
- Rollback UI không xóa execution/evidence hoặc mở lại quyền cũ; rollout owner và gates do human/SM xác định trước triển khai.

## 4. Khu vực dự kiến ảnh hưởng và evidence

Candidate areas ở mục 1, không phải mutable-file allowlist; SM xác minh code, authorization và Next.js local guides trước viết UI.

Whole-file SHA-256 của reads trong lượt khảo sát (individual identities, không phải atomic verification manifest):

| File | SHA-256 |
| --- | --- |
| ui/nextjs/app/coding/page.jsx | 1a319811e54e6b255c1073919373a13a4216bf0cce87e87d41a5305b8682bc73 |
| ui/nextjs/components/coding-workspace-monitor.jsx | ba88ec8ec37a6a358a2b005919ae1d62b77b1935fe0b379eff35ea5fd630215a |
| ui/nextjs/components/sprint-plan-panels.jsx | 18394cea00529ad1052a41d15e98ab734ae8bb1da805d1f608a298d5af393d76 |
| ui/nextjs/components/ticket-detail-modal.jsx | 8331f04f3803fcf0ec12f4ece4ce9ac544a02e1e5c82de3ecbd8aecb1b808341 |
| backend/src/application/registry-dashboard.js | 60e621a6b14f3ce23ae8b2d29fbadf465a82dcef54eb4969f09d8ce5586b2666 |
| backend/src/tools/engineering-tool-catalog.js | e5fe540d7864e480c03fd2d1271e459ae3a4f5f769e6b85f3b74de1e4e501ca1 |
| backend/src/tools/engineering-tool-binding.js | 7653356c2163678a2a13deb1cb5f4cc3a571663eb858b9abc441bf27116dc813 |

API/event/permissions consumers chưa khảo sát đầy đủ; SM cần discovery targeted trước chốt schema. Phần đầu ARCHITECTURE.md có mô tả filesystem trực tiếp cũ; không dùng nó để nới boundary Forge hiện hành.

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome | Acceptance criteria quan sát được | Dependency / guardrail |
| --- | --- | --- | --- |
| O1 | Navigation và work identity rõ | Phân biệt direct-code/ticket; chọn đúng execution; reload giữ hoặc khôi phục selection hợp lệ; empty/error khác nhau | Human chốt IA |
| O2 | Tools/quyền minh bạch | Catalog/version và provider/model readiness từ Node; tool/action có state/reason; missing metadata hiện unknown; unauthorized calls bị Node deny | Unified-tool readiness/transport |
| O3 | Activity và sessions bền vững | Xem working/completed/failed/blocked; chọn từng checkpoint; reconnect phục hồi; không gộp execution theo agent hoặc replay mutation | Durable identity/snapshot |
| O4 | Changes và verification có basis | Diff/log đúng scope; stale evidence được đánh dấu; check PASS không thành full ticket PASS; thấy coverage và phần chưa kiểm tra | Evidence producer thực |
| O5 | Lifecycle controls không regression | Run/Resume/Run fresh/Stop/Delete/Human Approve giữ gates; local deletion không resurrect; Registry conflicts không kích hoạt rerun | Existing authorization/revision |
| O6 | UI usable và verified | Keyboard/mobile, loading/unavailable/unsupported có hành vi test; focused backend/UI checks và browser evidence gắn source; cập nhật tests bám strings sang behavior khi thích hợp | Không tự claim runtime PASS |

SM trực tiếp implement và báo cáo outcome → thay đổi → evidence/coverage/blocker sau authorization. Không handoff SL; không cố định số ticket hoặc manifest. Human tổ chức review độc lập; Architecture không tự nghiệm thu implementation.

## 6. Rủi ro, giả định và câu hỏi mở

| Nội dung | Tác động | Người chốt / xử lý |
| --- | --- | --- |
| Đưa direct-code ra khỏi Sprint là đổi UX, không tự cấp scope | Major | Human chốt; SM xác minh direct-code authorization trước enable |
| Chưa đủ Node readiness/history/evidence transport | Major | SM inventory API/events; không mock thành ready ở production |
| Catalog/binding đang thay đổi, báo cáo verification có source identities cũ | Major | SM re-read và verify snapshot được phép; giữ lịch sử FAILED |
| Phase/progress semantics đang heuristic | Minor | Đề xuất phase + counts, không đổi backend status contract tùy tiện |
| Tests assert headings/layout strings | Major khi thay UI | SM cập nhật có chủ đích và bổ sung behavior/browser evidence |
| Approval của artifact Coding cũ chưa xác minh | Major | Không overwrite plan cũ; human chốt quan hệ/supersession trước implementation |

**Đề xuất human chốt:** execution-centric layout; giữ Sprint/ticket view và navigation; direct-code ở cấp workspace chỉ sau xác minh quyền; không thêm commit/push controls chỉ vì catalog có tên tool.

## 7. Acceptance criteria của plan và handoff

- [x] Facts/source evidence và giới hạn khảo sát được tách khỏi đề xuất.
- [x] Scope, security, compatibility, dependencies và outcomes có tiêu chí quan sát được.
- [x] SM implement trực tiếp; chưa SL/SP/dispatch trong đợt này.
- [ ] Human approve đúng identity/revision/SHA-256; chốt IA/direct-code placement và quyền thực thi.
- [ ] SM xác minh API/events/guides/policy, implement và cung cấp focused + browser evidence.
- [ ] Review độc lập và acceptance theo gates hiệu lực; commit/push/rollout có authorization riêng.

**Giới hạn lượt này:** chỉ đọc source/tests/tài liệu và tạo plan; chưa chạy test, browser/session runtime, sửa source, dispatch, commit/push hoặc rollout. Không dùng tham khảo bên ngoài vì quyết định lượt này dựa trên contracts/source nội bộ; không đưa repository lên web search.
