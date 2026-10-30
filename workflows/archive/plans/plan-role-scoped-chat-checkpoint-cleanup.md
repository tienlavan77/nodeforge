<!-- Đề xuất Architecture cho tối giản API chat và vòng đời checkpoint; chưa là quyền triển khai. -->
# Plan: Tách API chat theo role và dọn checkpoint kết thúc

> **Trạng thái:** đề xuất, chưa được human approve; độc lập với nghiệm thu pause/resume Architecture (hiện NO-GO). Không sửa plan pause/resume đã được nhận diện bằng SHA.

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** workspace Architecture còn gọi `/sprints` để nạp dashboard không hiển thị; các controls execution và dữ liệu agent cần ràng buộc rõ với role trang. Checkpoint owner execution hiện giữ record terminal lâu dài.
- **Kết quả:** hai trang chat chỉ gọi API cần cho chat và agent đúng role; UI nhận trạng thái tối thiểu của execution đang cần xử lý khi khôi phục trang, không đọc checkpoint đầy đủ và không gọi lại list khi Continue. Node tự tìm và tiếp tục attempt từ checkpoint phía server sau một POST. Sau khi lượt thực sự hoàn tất hoặc được Discard an toàn, checkpoint runtime của lượt đó biến mất, trong khi audit và khả năng phục hồi lượt dở vẫn còn.
- **Giá trị:** giảm request không liên quan và dữ liệu runtime tồn đọng mà không nới quyền recovery/governance.

## 2. Phạm vi

### In scope

- Trang System chỉ liệt kê/chọn `system_engineer`, trang Architecture chỉ liệt kê/chọn `architecture_manager`; execution list và actions kiểm tra role từ conversation phía server, không tin role do client tự khai. Không trả nhầm attempt giữa project/conversation/agent/role.
- Bỏ các lệnh gọi `/sprints` và `/plans` không cần thiết **từ hai trang chat**, gồm refresh/cached dashboard không hiển thị và các dependency chỉ dùng cho mục đích đó; kiểm tra các nhánh approval/handoff và monitor trước khi bỏ. Giữ chức năng duyệt plan thực sự cần thiết của Architecture, không phá workflow approval.
- Execution **owner chat** System/Architecture: lúc tải lại trang/conversation cần khôi phục chỉ đọc projection nhỏ, server-derived (`execution_id`, `status`, quyền thao tác, cờ cần human duyệt; dữ liệu đối chiếu tối thiểu nếu cần), không gửi `pending_tool_calls`, receipts, provider thread hoặc nội dung checkpoint. Sau đó UI dùng response POST và event có sẵn để cập nhật; không refetch executions khi focus, typing, Pause/Continue/Discard hoặc timer. Nếu mất event, cho phép thao tác kiểm tra trạng thái thủ công, không polling.
- Continue từ execution được chọn: đúng một POST, chỉ mang định danh conversation/attempt và thông tin xác thực cần thiết; Node tự load checkpoint, xác minh ownership, trạng thái, reconciliation, claim và replay. Human approval/reconcile đối với mutation chưa chắc chắn vẫn là thao tác riêng nếu bắt buộc, không để client tự chọn tool sequence từ checkpoint thô.
- Checkpoint **owner chat execution** System/Architecture: dọn record terminal sau khi kết quả cuối và audit đã được lưu ổn định; dọn sau Discard chỉ khi runner dừng và không còn mutation uncertain. Trạng thái interrupted/manual_required/running/pausing và attempt parent còn phục vụ recovery phải giữ.

### Out of scope

- Xóa hoặc vô hiệu hóa API `/sprints`, `/plans` trên backend, thay contract approval, Sprint Plan, RUN/dispatch hay các consumer khác.
- Xóa checkpoint Coder/Reviewer/ticket, lịch sử hội thoại, receipt/audit bắt buộc hoặc xử lý retention của các runtime khác.
- Tuyên bố pause/resume GO chỉ nhờ tối giản giao diện hay dọn dữ liệu.

## 3. Hướng tiếp cận và guardrails

- **Ràng buộc bắt buộc:** role/project/conversation/agent phải được Node xác định từ cấu hình và record có thẩm quyền; kiểm tra cả GET executions và POST pause/continue/restart/reconcile/discard, kể cả token owner khi role yêu cầu. Không lọc ở UI rồi coi đó là authorization.
- **Hướng đề xuất:** request agent list dùng role server-side (hoặc filter trên danh sách cấu hình đã cấp quyền nếu contract hiện tại không hỗ trợ query role), với UI phòng vệ khi danh sách sai. Execution GET chỉ trả projection của attempt chưa terminal cần phục hồi/duyệt; Node suy role từ conversation và kiểm tra chéo trước khi trả, không serialize checkpoint thô. Gắn trạng thái khởi tạo với reload/khôi phục conversation, tránh gọi lại do focus/agentTyping hay pausing timer; cập nhật trong phiên từ POST response và stream sự kiện, có nút kiểm tra thủ công khi stream mất đồng bộ. Khi agent mới bắt đầu và UI cần ID để Pause/Esc, dùng receipt của POST tạo lượt hoặc sự kiện có ID thay vì list lại. Continue chỉ POST theo ID của attempt đã chọn, backend resolve nội bộ. Trang Architecture bỏ refresh `/sprints` ẩn; nếu `PendingPlanApproval` hoặc handoff cần plans/sprints, giới hạn call theo thao tác duyệt thay vì xóa mù. System không tải plan approval khi role này không được duyệt plan, trừ khi phát hiện contract thực tế khác.
- **Vòng đời:** commit response/message và audit receipt trước, rồi xóa checkpoint terminal có khóa theo conversation/attempt; cleanup idempotent, không để trạng thái thiếu checkpoint bị hiểu là quyền retry. Nếu crash giữa terminal persist và cleanup, recovery chỉ dọn khi chứng minh terminal từ nguồn bền vững độc lập; nếu không chứng minh được, giữ record để điều tra. Discard pending mutation chưa xác định phải bị chặn hoặc có quy trình thủ công được duyệt; không xóa để bypass reconcile. Restart chỉ dọn parent sau khi child đã claim thành công và audit lineage còn truy được.
- **Dependency thật sự:** phải xác nhận nơi lưu audit/terminal và chính sách owner auth trước khi định nghĩa thời điểm xóa; SL chọn phân rã và cách triển khai trong guardrails này.
- **Quyết định cần owner xác nhận:** “bỏ API sprints, plan” hiểu là **bỏ request dư từ trang chat**, không retire backend endpoints; “checkpoint” hiểu là owner execution của hai trang, không phải checkpoint ticket. Nếu ý định rộng hơn, cần replan và đánh giá migration/consumer trước khi làm.

## 4. Khu vực dự kiến ảnh hưởng và evidence

| Khu vực | Vai trò | Evidence / mức chắc chắn |
| --- | --- | --- |
| `ui/nextjs/app/page.jsx:93–110,142,190` và `ui/nextjs/lib/home-page-event-stream.js:7–18` | Architecture gọi `/sprints` qua `loadDashboard` và stream refresh; còn dùng `PendingPlanApproval`. | Source đã đọc; cần trace call thực tế của approval trước khi bỏ. |
| `ui/nextjs/app/system/page.jsx:73–82,147–166` | Lọc agent `system_engineer`; còn render `PendingPlanApproval`. | Source đã đọc; chưa đo network. |
| `ui/nextjs/components/{architecture,system}-execution-controls.jsx:24–56,76–99` và `ui/nextjs/lib/owner-execution-client.js:7–18` | Hai UI gọi GET lúc mount, focus, typing, pausing timer và trước Pause khi chưa có ID; client đã có POST Continue theo execution ID. | Source đã đọc; không phải đo network thực tế. |
| `backend/src/transport/http/forge-v1-conversation-routes.js:12–26`, `backend/src/application/owner-execution-control.js:8–35` | Route kiểm project; control dùng conversation agent ID để chọn store và đối chiếu source message. | Source đã đọc; route đọc được chưa gọi `planOwnerAuth.verify` cho executions, cần xác nhận/cố định auth thay vì tin báo cáo trước. |
| `backend/src/application/owner-execution-checkpoint.js:34–43,60–82,190–196`, `backend/src/application/owner-sdk-stream.js:106–121` | `list` giữ terminal để audit; success patch `completed`, Discard close `discarded`; runner stop đánh dấu riêng. | Source đã đọc; chưa có evidence audit độc lập đáp ứng xóa record. |
| `workflows/report-pause-resume-architecture.md` | Trạng thái kiểm chứng pause/resume. | NO-GO; không thay đổi bởi plan này. |

Candidate paths chỉ để SL discovery, không phải allowlist sửa file.

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Guardrail |
| --- | --- | --- | --- |
| O1 | Hai trang chat không tải dữ liệu sprint/plan dư | Network sau load/reload/stream refresh của System và Architecture không phát `/sprints`, `/plans` vì dashboard ẩn; approval/handoff Architecture vẫn hoạt động khi owner thực sự thao tác. | Không retire backend API; không giảm approval gate. |
| O2 | Agent và executions đúng role | Cả danh sách, status và actions chỉ thấy/áp dụng đúng role của trang và conversation; thử token thiếu/sai, project và agent chéo, ID execution đoán được đều bị từ chối bởi Node. | Server authoritative; UI filter chỉ phòng vệ. |
| O3 | Checkpoint terminal được dọn an toàn | Sau completion thành công và Discard hợp lệ, không còn checkpoint runtime tương ứng sau restart; conversation history, audit receipt/lineage và approval evidence vẫn truy được; pending/uncertain vẫn còn và block replay. | Không dọn trước khi runner settled, durable terminal/audit và safety reconciliation. |
| O4 | Race/crash không gây mất trạng thái phục hồi | Test hai process, crash trước/sau terminal commit và trước/sau cleanup, Discard khi write active; không mở attempt mới hoặc phát lại write từ trạng thái chưa chắc chắn. | Cleanup idempotent; fail closed. |
| O5 | UI chỉ tải trạng thái cần thiết khi khôi phục | Reload trang và mở conversation cần khôi phục: tối đa một GET trạng thái tóm tắt cho conversation được chọn, không lộ checkpoint thô/receipts/provider thread; focus, typing, Pause/Continue/Discard và thời gian chờ không kích hoạt GET executions lặp. Một lượt mới vẫn có ID để Esc/Pause qua receipt/event; khi mất kết nối hiển thị trạng thái chưa chắc chắn và cho kiểm tra thủ công. | Server authoritative; không lấy checkpoint để render UI. |
| O6 | Continue là một POST và Node tự resume | Network ghi nhận đúng một POST Continue, không có GET executions phụ trợ; backend tự tìm checkpoint, kiểm tra quyền/role, lease và reconciliation rồi claim/replay tối đa một lần kể cả double-click, retry hoặc process khác. Response/event trả trạng thái UI cần; thiếu checkpoint hoặc mutation uncertain trả lỗi rõ và không replay. | Không bỏ human decision khi cần reconcile; giữ chống replay. |

SL lập SP, mapping coverage, verification cụ thể và mutable-file manifest sau approval đúng identity/revision/SHA. Plan không tự RUN/dispatch.

## 6. Rủi ro, giả định và câu hỏi mở

| Rủi ro / câu hỏi | Tác động | Evidence / giả định | Người chốt / cách xử lý |
| --- | --- | --- | --- |
| Không có audit terminal độc lập đủ để xóa checkpoint | Blocker O3 | Store hiện giữ terminal “for audit”; chưa chứng minh nguồn thay thế | Architecture/human chốt retention tối thiểu; không xóa khi chưa có evidence. |
| Bỏ GET định kỳ khi thiếu stream/receipt định danh | Major O5/O6 | UI hiện list lại để tìm attempt mới và kiểm tra `pausing`; cần xác minh event/response có ID/status và xử lý stale view | SL khảo sát contract hiện có; bổ sung projection/event tối thiểu hoặc kiểm tra thủ công, không tự động polling. |
| Continue đồng thời hoặc retry POST | Major O6 | `owner-execution-control.decide` hiện load/reconcile rồi gọi `replay` fire-and-forget; claim thực hiện sau trong store; chưa chứng minh idempotency | SL kiểm tra khóa/claim, receipt và lỗi replay, không coi response 202 là bằng chứng đã tiếp tục. |
| Execution auth hiện không verify owner token ở route đọc được | Blocker O2 | Code route hiện chỉ set actor label, không gọi verifier | SL xác minh wiring thực và bổ sung gate; HTTP negative tests bắt buộc. |
| UI approval phụ thuộc `/plans` và `/sprints` | Major O1 | `PendingPlanApproval` dùng cả hai API | SL phân tích trigger, giữ call hợp lệ theo yêu cầu nghiệp vụ; escalate nếu owner muốn bỏ luôn approval UI. |
| Phạm vi “checkpoint” có gồm ticket không? | Blocker khi mở rộng | Ngữ cảnh hiện chỉ System/Architecture chat | Human quyết định nếu cần mở rộng; không mặc định xóa ticket checkpoint. |

## 7. Acceptance criteria của plan

- [ ] Owner xác nhận cách hiểu scope ở mục 3; facts/assumptions không nhập làm một.
- [ ] Mỗi outcome được SL mapping sang verification, gồm HTTP/browser/network và crash/race, trước dispatch.
- [ ] Human approval đúng identity/revision/SHA theo contract hiệu lực; plan này không nghiệm thu pause/resume.
