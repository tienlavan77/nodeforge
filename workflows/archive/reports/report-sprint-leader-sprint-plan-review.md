<!-- Rà soát contract Sprint Leader/Sprint Plan và liên hệ lỗi pending; không cấp quyền triển khai. -->
# Rà soát Sprint Leader và Sprint Plan

**Ngày:** 2026-10-08. **Revision:** r2. **Loại:** architecture review, không phải SP hoặc approval.

**Cập nhật r2:** bổ sung F7 về 7 đầu mối quản lý plan/sprint/ticket, rủi ro authority/projection và verification cần có; giữ nguyên F1–F6. Đây là cập nhật report theo hội thoại, không phải đợt xác minh source mới.

## Phạm vi và giới hạn

Đối chiếu role rules, governance plan, schema, prompt, outcome admission, approved-ticket comparison và pending queue liên quan yêu cầu hiện tại. Đây là static review; chưa chạy tests, chưa xem execution trace, chưa xác minh SP/approval/receipt thực tế của phiên user. Không sửa source, runtime hoặc artifact đã duyệt.

## Kết luận

Chưa đủ cơ sở kết luận SL/runtime hoạt động đúng xuyên suốt. Có lệch contract tài liệu–code và thiếu proof trong admission; pending có sai lệch so với outcome và test hiện chỉ kiểm tra chuỗi source.

## Findings

### F1 — Major: rulebook/plan khác schema và prompt hiệu lực

- `workflows/agents/sprint-leader/README.md:53-57` và `workflows/human-plan.md:209-216` mô tả một `style` trong frontend/backend/security/infra/docs.
- `workflows/plan-sprint-plan-sprint-leader-governance-ui.md` yêu cầu `style` string và `mutable_file_budget`; ghi gap schema cũ.
- Source hiện tại: `schemas/governance/ticket.schema.json:72-74` dùng `implementation_type` array đúng một phần tử, chỉ frontend/backend/security, cùng `file_budget` 1..4.
- `backend/src/application/sprint-plan-leader.js:60-65` và `sprint-orchestration-service.js:218-224` yêu cầu contract này và reject `style`.
- Tác động: không thể đưa ticket infra/docs hoặc field của plan cũ vào runtime hiện tại. Không nên triển khai lại gap cũ mà chưa xác minh thay đổi đã có.
- Đề xuất: owner/architecture chốt contract canonical và compatibility; tài liệu cập nhật bằng revision phù hợp. Không đổi schema ngầm chỉ để khớp wording.

### F2 — Major: coverage được điền trước khi kiểm tra, không chứng minh phân rã

- `backend/src/modules/governance/markdown-sprint-scope.js:57-73` tự thêm toàn bộ approved AC và ghi đè criterion/guardrail/dependency refs cho từng outcome được ticket nhận.
- `:129-153` gọi binding trước khi kiểm tra coverage; mỗi ticket tham chiếu outcome phải mang đầy đủ criteria của outcome đó.
- Tác động: SL chia một outcome thành nhiều ticket vẫn bị gắn toàn bộ AC cho mỗi ticket; metadata đủ không chứng minh từng ticket thực sự giao phần nào. Ref thiếu/sai có thể bị thay thế trước validation.
- Đề xuất: tách reference tới approved scope khỏi allocation/proof của SL. Kiểm tra coverage hợp của các ticket, ownership từng criterion và verification; không tự điền proof để coi là đạt admission.
- Verification cần có: split một outcome giữa hai ticket hợp lệ; thiếu một criterion bị reject; refs sai không được âm thầm chữa thành proof.

### F3 — Major: dependency refs chưa buộc đúng cạnh DAG

- `markdown-sprint-scope.js:150-158` kiểm tra danh sách dependency refs và DAG không cycle; final check có thể thỏa chỉ bởi một ticket mang outcome prerequisite.
- Binding F2 đã tự điền dependency refs từ approved outcome, độc lập với ticket.dependencies.
- Tác động: trong validator đã đọc, việc có O1 và O2 cùng metadata O2 phụ thuộc O1 chưa bắt buộc ticket O2 có cạnh prerequisite tới ticket giao O1. Chưa khẳng định các gate khác không kiểm tra thêm.
- Đề xuất: enforce ánh xạ mandatory outcome dependency tới DAG thực tế trước persistence/dispatch.
- Verification cần có: O2 phụ thuộc O1 nhưng không có cạnh phải bị reject; dependency đảo/cycle bị reject; DAG đúng được nhận.

### F4 — Major: approved-ticket comparison bỏ sót policy fields

- `backend/src/modules/governance/sprint-plan-draft.js:32-40` so sánh title/objective/AC/verification/dependencies/implementation_type/outcome_refs/execution_contract, không so sánh `file_budget` hoặc `coverage`; thiếu ticket_specs thì return.
- Tác động: riêng helper này không bắt được thay đổi budget trong khoảng hợp lệ hoặc coverage sau approval. Đây là gap của helper; chưa xác minh exploit xuyên các integrity gates khác.
- Đề xuất: bind/compare toàn bộ immutable execution policy; legacy không có specs cần compatibility/disposition rõ, không tự suy là hợp lệ.
- Verification cần có: đổi budget 1→4 hoặc coverage trên ticket projection phải blocked; revision hợp lệ mới được mở lại.

### F5 — Major: pending chưa đáp ứng O2/O3; test không kiểm tra hành vi

- `workflows/plan-conversation-agent-copy-share-pending-queue.md:18-20,51-53` yêu cầu truth workingByAgent, FIFO, preview và không gửi trùng.
- `ui/nextjs/app/page.jsx:151-152` truyền agentTyping thay cho execution working state; System cũng truyền agentTyping (`system/page.jsx:145-146`, evidence search).
- `conversation-pending-queue.jsx:19-46` clear queue khi đổi agent, gửi dựa vào working true→false, lấy item ra trước acknowledgement, không lưu conversationId.
- `home-page-message-handlers.js:23-43,63-70` có early return và catch không rethrow; outer catch của page không nhận lỗi đã xử lý này. Queue có thể mất pending item khi send thực tế không thành công.
- `conversation-pending-queue.jsx:68-74` chỉ hiển thị số lượng/nút hủy; chưa có preview nhìn thấy.
- `ui/nextjs/tests/conversation-pending-queue.test.js:1-27` đọc source rồi assert includes/indexOf; không chạy hook, network failure, FIFO, switching hoặc race.
- Đề xuất: SL lập remediation trong scope đã duyệt, có behavior tests cho completion/failure/retry/switch/rapid submit và acknowledgement contract rõ. Persist qua reload đang out-of-scope; không coi thiếu persistence là bug của plan này. Quyết định giữ queue khi đổi agent phải chốt riêng nếu mở rộng hành vi.

### F6 — Major: governance plan tự ghi READY không chứng minh approval

- Dòng 3 của `plan-sprint-plan-sprint-leader-governance-ui.md` ghi READY TO IMPLEMENT dựa hội thoại, không cần approval hình thức khác.
- `workflows/human-plan.md:145-161` yêu cầu approval exact identity/revision/hash; Architecture rulebook cũng không cho plan tài liệu cấp quyền RUN.
- Đề xuất: coi READY chỉ là mô tả document, không là authorization. SL phải resolve approval artifact thực tế trước handoff/dispatch; chưa có evidence trong review này để xác nhận approval hiện tại.

### F7 — Major (cần đối chiếu authority): nhiều đầu mối quản lý plan, sprint và ticket

**Bổ sung theo kết quả rà soát đã nêu trong hội thoại:** có ít nhất **7 đầu mối theo store/trách nhiệm**, không phải 7 database độc lập. Lần cập nhật report này không đọc lại source của các store; bảng dưới ghi nhận kết quả trước đó, không bổ sung checksum hoặc line references chưa xác minh.

| # | Đầu mối | Dữ liệu / trách nhiệm được ghi nhận |
| --- | --- | --- |
| 1 | `markdown-plan-store.js` | Plan Markdown gốc, revision/hash và approval của owner. |
| 2 | `human-plan-store.js` | Plan JSON immutable, gồm SP suy ra từ plan đã duyệt; artifact tại `.forge/runtime/nf/plans/`, index trong SQLite. |
| 3 | `sprint-registry.js` | Danh sách/thứ tự sprint, dependency, trạng thái và binding tới plan revision/hash. |
| 4 | `roadmap-store.js` | Snapshot roadmap chứa sprint, nội dung ticket và trạng thái ticket; bảng `governance_roadmaps`. |
| 5 | `ticket-file-store.js` | Lịch sử nội dung ticket tại `.forge/runtime/nf/tickets/<id>.jsonl`; bảng `tickets` giữ metadata/context. |
| 6 | `ticket-status-store.js` | Trạng thái thực thi ticket và lịch sử chuyển trạng thái riêng. |
| 7 | `task-store.js` | Task thực thi riêng trong bảng `project_tasks`. |

**Không tính là nguồn dữ liệu độc lập:**

- `sprint-plan-projection.js`: projection đọc sprint/ticket từ roadmap.
- `.forge/runtime/nf/sprint-plan/`: directory artifact SP được truyền vào orchestration; riêng directory không chứng minh một authority/store độc lập.
- Supervisor: queue, checkpoint, verification, review và terminal receipt thuộc luồng thực thi/evidence; không mặc nhiên là nguồn chuẩn của ticket scope.
- `workflows/`, `docs/`: tài liệu/đề xuất, không tự trở thành SP runtime đã duyệt.

**Rủi ro và giới hạn kết luận:**

- Nội dung ticket được ghi nhận xuất hiện ở plan immutable, roadmap snapshot và ticket JSONL; trạng thái xuất hiện ở roadmap, metadata ticket và status store. Đây là duplication cần phân loại authority, không phải bằng chứng tất cả các bản có thẩm quyền ngang nhau hoặc đã lệch dữ liệu.
- Wiring được ghi nhận dùng `sprintPlans = createSprintPlanProjection({ roadmaps })` trong orchestration, trong khi sprint registry quản lý binding tới plan immutable. Cần đối chiếu hai đường đọc/quản lý này bằng source và artifact thực tế trước khi kết luận drift.

**Đề xuất, chưa phải quyết định đã duyệt:**

1. Chốt nguồn chuẩn riêng cho **approved scope/ticket contract**, **sprint identity và binding revision/hash**, **execution status** và **execution evidence**; owner phải xác nhận store có thẩm quyền cho từng loại.
2. Phân loại các bản còn lại là projection/index/history; ghi rõ write owner, chiều đồng bộ, revision/hash binding và cách rebuild/reconcile. Không hợp nhất store hoặc migration chỉ vì số lượng đầu mối lớn.
3. Verification cần có: trace một ticket từ approved plan → registry/projection → ticket artifact → execution status/task/receipt; kiểm tra identity/revision/hash và chuyển trạng thái nhất quán. Thử stale projection, retry/restart và cập nhật đồng thời; mismatch phải có hành vi reject hoặc reconcile rõ, không âm thầm đổi approved scope.
4. Chỉ đề xuất migration/compatibility/rollback sau khi xác minh authority và consumers; không sửa runtime state trong review này.

## Handoff đề xuất

1. Architecture/human chốt canonical ticket contract và semantics coverage/dependency; không chuyển approval cũ sang hash mới.
2. SL tự phân rã remediation trong boundary đã duyệt; một ticket hợp lệ với cap tối đa bốn mutable files; không giao cả plan thẳng Coder.
3. Mỗi AC phải có behavioral verification phù hợp; substring test chỉ là supplementary wiring check.
4. SV quản lý Coder/Reviewer theo ticket; Reviewer độc lập; SL chỉ mở downstream sau evidence terminal hợp lệ.
5. Đối chiếu SP, mapping O2/O3, verification artifact và review/receipt thực tế để truy trách nhiệm acceptance. Static review này chưa kết luận cá nhân SL đã dispatch hoặc accept sai.

## Evidence identity

Whole-file SHA-256 khi đọc:

| Artifact | SHA-256 |
| --- | --- |
| workflows/agents/sprint-leader/README.md | 9c889fcc2a9ed4cfed701ddc5ba440e134cd53e53d0ea020c1589892367d3863 |
| workflows/plan-sprint-plan-sprint-leader-governance-ui.md | 84fafdc4634707005a98ec9c531c9c8d1f5d6e0701d73cd9a83c01a46cd7f39a |
| workflows/plan-conversation-agent-copy-share-pending-queue.md | 39f70a3b0f97ee0279a4d43b15a4f85d28b2006bcd42432cf18b5a94630ecffd |
| schemas/governance/ticket.schema.json | 542ba32a0b974c93d4c095cd7ce89ff82f012a7483d8da473caa8f86543d8bd1 |
| backend/src/application/sprint-plan-leader.js | ade903417cf74954c323152b99285847f1e73aeee530576f9a047a2979a04b90 |
| backend/src/modules/governance/markdown-sprint-scope.js | 266e5ea5a021e944440e68181a6e10330598da1cfe1ec5a099211ae8142ae950 |
| backend/src/modules/governance/sprint-plan-draft.js | 59646eda4bacc825235461de0f51ed59a4b95432a81152eb929c4493d1d991da |
| ui/nextjs/components/conversation-pending-queue.jsx | 13b4ea158d994f92b17225fc9d12a1fcbf2912197530601057f3116075211e24 |
| ui/nextjs/lib/home-page-message-handlers.js | 615295b014d805c8f11a091aa6c1410fcea55986a5bdd48b631fb42e9af606cd |
| ui/nextjs/tests/conversation-pending-queue.test.js | be1233f89737d1501f094d8ba50722caa4ce05485a0d45c1183033b8019c0388 |

## Kết quả và việc chưa làm

Đã tạo report này; không sửa rulebook/plan đã có, source hoặc runtime. Chưa chạy tests/canary; không có tool execution trong phiên review. Lệnh list_files có một lần lỗi unsupported flags; đã retry flags mặc định thành công. Không cần external references để kết luận repository-specific findings trên.
