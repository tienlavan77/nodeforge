<!-- Ghi lại cơ chế phối hợp bền vững giữa các Ticket Supervisor khi nhiều Coder cùng sửa một file. -->
# Liên lạc giữa các Ticket Supervisor khi tranh chấp file

## Bối cảnh đã kiểm chứng

Root-only chạy một Supervisor runtime cho mỗi ticket trong cùng Control API. Hai Supervisor có thể giao việc đồng thời cho hai Coder khác nhau. Quyền ghi file được quản lý theo `project_id + path` tại `ticket-change-ledger.js`.

Thử nghiệm trên project tạm dùng đúng ID, tên, provider và model của Siêu code (Codex) và Cú đêm (Claude), với credential thử nghiệm từ môi trường:

1. Ticket A của Siêu code ghi `backend/src/witness.js` và giữ file claim qua bước review.
2. Ticket B của Cú đêm gọi Forge `edit_diff` trên cùng file và nhận `FILE_CLAIM_CONFLICT` (event `LOG-a6df93eb-6437-46aa-b49a-911165dc04c4`). B tiếp tục thử tool, rồi RUN đầu kết thúc `REPORT_FAILED`.
3. A đạt `report_done`, artifact pass, Reviewer approved và release file claim.
4. B chỉ tiếp tục sau một RUN thủ công. RUN đó dùng checkpoint, ghi file, commit, artifact pass và đạt `report_done`.

Điều đã đạt là **không ghi đè file của ticket A**. Điều còn thiếu là **chờ và tiếp tục ticket B tự động**. Thử nghiệm B dừng tại `report_done`, chưa kiểm tra review B. Bằng chứng commit và artifact nằm trong `workflows/immutable-ticket-acceptance-record.md`.

## Những thành phần đang có

| Thành phần | Khả năng hiện tại | Giới hạn liên quan |
| --- | --- | --- |
| `supervisor-state-store.js` | Lưu bền vững quan hệ `task_id → supervisor_id` và ownership bằng File Service. | Không lưu ticket đang chờ một đường dẫn. |
| `execution-event-bus.js` | Ghi event vào `eventStore`, fanout theo `supervisor_id` và subscriber `*`. | Fanout trực tiếp chỉ đến subscriber trong tiến trình hiện tại; sau restart phải đọc trạng thái bền vững. |
| `worker-signal-bus.js` | Đánh thức worker trong tiến trình. | Không phải kênh liên tiến trình. |
| `durable-queue.js` + `file-queue-store.js` | Job có lease, ack, reject, recover và khóa file. `agent.request` đang phục vụ Coder/Reviewer. | Không có `available_at`/delay; `reject()` đưa job về `queued` ngay và tối đa ba lần thì dead-letter. Không thể dùng nguyên trạng để đợi file. |
| `ticket-change-ledger.js` | File claim và write được khóa, persist theo project/path; `release()` giải phóng claim. | Xung đột hiện throw `FILE_CLAIM_CONFLICT`; chưa persist waiter hoặc phát tín hiệu release. |

Không cần registry Supervisor mới chứa `hostname`/`pid` để giải bài toán này. Supervisor ownership đã được lưu; cần thêm trạng thái chờ theo file và cơ chế phục hồi. Event là tín hiệu đánh thức nhanh, **không** là nguồn sự thật duy nhất.

## Thiết kế đề xuất

1. Khi một Forge write gặp claim của ticket khác, ghi một waiter bền vững theo `project_id + path + ticket_id`, gồm owner đang thấy, thứ tự FIFO, checkpoint, attempt và thời điểm đăng ký. Kiểm tra claim và đăng ký waiter dưới cùng khóa path; kiểm tra lại sau đăng ký để không bỏ lỡ release chen giữa.
2. Đưa ticket B sang trạng thái không terminal `FILE_CLAIM_WAITING` và dừng lượt SDK có kiểm soát. Không giữ `edit_diff` mở để chờ, vì sẽ giữ phiên agent và có thể hết timeout. Không để lỗi tool đẩy agent vào vòng thử `edit_diff`/`report_done` như thử nghiệm vừa rồi.
3. Chỉ release file claim khi đường nghiệp vụ thực sự hoàn tất hoặc có quyết định terminal rõ ràng. Release Coder occupancy không mặc nhiên là release file. Sau khi persist release, phát `file_claim_released` có `project_id`, `path`, owner vừa release, claim generation và event ID.
4. Consumer đánh thức waiter đầu hàng và dispatch lại qua `agent.request` hiện có với attempt/idempotency key mới. Nếu owner khác vẫn đang giữ file, waiter giữ nguyên vị trí. Không tạo queue hoặc DAG thứ hai.
5. Khi tiếp tục, B phải đọc lại source và checksum hiện tại rồi lập lại diff của mình. Không phát lại nguyên `edit_diff` với `before_checksum` của thời điểm A chưa sửa file.
6. Sau restart hoặc khi tín hiệu bị lỡ, quét trạng thái waiter bền vững và claim hiện tại để khôi phục. Tín hiệu in-memory chỉ giảm độ trễ, không quyết định tính đúng.
7. Xử lý waiter bị hủy và chu trình chờ nhiều file (A giữ X đợi Y, B giữ Y đợi X). Không tự chiếm claim hoặc tự hợp nhất source; phát hiện deadlock thì escalate có bằng chứng.

Trong ví dụ của kế hoạch `plan-inter-supervisor-file-claim.md`, `released_task_id` là **ticket A**, còn `taskId` của waiter là **ticket B**. Không được so hai ID này như thể chúng phải bằng nhau; cần đối chiếu event với owner/claim generation mà B đã thấy, rồi kiểm tra claim lại dưới khóa.

## Chính sách mặc định đề xuất

- **Phạm vi:** follow-up thuộc root-only Ticket Supervisor, không sửa mô hình ticket/worktree cũ.
- **Lưu trữ:** File Service và ledger hiện có; không thêm database hay bus riêng chỉ cho file claim.
- **Thứ tự:** FIFO theo mỗi file; không để ticket đến sau chen ngang waiter đã đăng ký.
- **Thời gian:** cảnh báo vận hành sau 30 phút chờ. Không tự đánh failed chỉ vì owner còn code/review; giữ waiter bền vững đến khi release, hủy hoặc quyết định escalate của người có quyền.
- **Retry:** đánh thức ngay khi có release, kèm quét phục hồi có giới hạn sau restart. Nếu bổ sung `available_at` vào `agent.request`, dùng nó cho retry lỗi hạ tầng, không tạo vòng retry nhanh khi claim vẫn thuộc ticket khác.

## Điều kiện nghiệm thu

1. Hai Supervisor và hai Coder cùng sửa một file: B vào `FILE_CLAIM_WAITING`, không kết thúc `REPORT_FAILED`; A review approved/release; B tự chạy lại và đạt `report_done` không cần người RUN.
2. Hai waiter cùng path được phục vụ FIFO; ticket khác project không nhận nhầm tín hiệu.
3. Restart Control API trước và sau release vẫn đánh thức đúng một lần, không tạo hai commit hoặc hai RUN cho cùng attempt.
4. Source/checksum của B được làm mới sau commit A; không ghi đè thay đổi A do áp dụng diff cũ.
5. Cancel, terminal failure, review kéo dài và deadlock nhiều file có trạng thái/audit rõ ràng; không rò claim hoặc giữ agent WORKING vô hạn do waiter mồ côi.
