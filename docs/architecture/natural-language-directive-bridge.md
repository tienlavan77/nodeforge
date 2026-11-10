# Đặc tả Kiến trúc: Natural Language Directive Bridge (Gửi chỉ thị bằng câu văn tự nhiên cho AM, SE & Coder)

## 1. Mục tiêu
Cho phép Project Owner (và AM/SL) gửi yêu cầu bổ sung, hướng dẫn kỹ thuật hoặc lệnh tạm dừng an toàn cho **AM**, **SE** (trong luồng `AM ↔ SE ↔ RV` Handoff) hoặc **Coder** (trong luồng Ticket Runtime) bằng **câu văn bình thường trong chat** (hoặc lệnh ngắn gọn), không bắt buộc phải nhớ cú pháp phức tạp.

---

## 2. Hai Luồng Nhận Chỉ Thị Cần Hỗ Trợ

Hiện tại trong hệ thống có 2 luồng thực thi khác nhau:
1. **Luồng Ticket (`Coder` đang chạy qua `ticket-sdk-turns.js`):**
   - Đã có sẵn `backend/src/modules/supervisor/ticket/ticket-directive-inbox.js` lưu tại `.forge/runtime/ticket-directives/<projectHash>/<taskId>.json`.
2. **Luồng Handoff (`AM ↔ SE ↔ RV` đang chạy qua `am-se-handoff-service.js`):**
   - Khi `SE` hoặc `AM` đang thực thi một `handoffId` / `planId`, Owner nhắn thêm yêu cầu bằng câu văn tự nhiên (ví dụ: *"SE ơi nhớ giữ nguyên tương thích ngược cho hàm X nhé"* hoặc *"AM bổ sung thêm điều kiện kiểm tra quyền cho SE nhé"*).
   - Cần mở rộng cơ chế Directive Inbox (hoặc Handoff Directive Queue) cho cả `handoffId` / `role` (`am`, `se`) để khi đến ranh giới bước/turn kế tiếp trong `am-se-handoff-service.js` hoặc `owner-sdk-stream.js`, chỉ thị của Owner được rút ra (`drainPending`) và tiêm thẳng vào prompt của `AM` hoặc `SE`.

---

## 3. Thiết kế Kỹ thuật Chi tiết

### 3.1. Cổng 1 — Nhắn bằng câu văn tự nhiên trong Chat (Natural Language Trigger & Forge Tool)

1. **Nhận diện câu văn tự nhiên (`conversation-directive-trigger.js` hoặc qua Tool `send_execution_directive`):**
   - Khi Owner nhắn trong khung chat những câu mang tính chỉ thị/bổ sung cho tiến trình đang chạy, ví dụ:
     - *"nhắn SE: ưu tiên sửa trong relevant-tree.js thôi nhé"*
     - *"bổ sung cho SE đang chạy: nhớ chạy thêm unit test cho trường hợp lỗi"*
     - *"gửi yêu cầu thêm cho AM: giữ nguyên schema cũ"*
     - *"tạm dừng SE sau bước này"*
   - Hoặc khi Owner đang trò chuyện với AM và bảo: *"Bạn gửi yêu cầu này vào inbox cho SE / Coder đang chạy giúp tôi"*.
2. **Forge Tool `send_execution_directive` (Dùng chung cho cả Handoff `AM/SE` và Ticket `Coder`):**
   - **Tham số đầu vào:**
     ```js
     {
       target_role: "se | am | coder", // tự suy luận nếu đang có handoff hoặc ticket active
       target_id: "HANDOFF-... hoặc TICKET-... (tùy chọn - tự động lấy handoff/ticket đang active của project nếu bỏ trống)",
       kind: "implementation_guidance | focus_constraint | pause_after_turn",
       instruction: "Nội dung yêu cầu bằng câu văn tự nhiên của Owner",
       supersede_pending: false
     }
     ```
   - **Tự động phân giải `target_id`:**
     - Nếu `target_id` không được truyền, hệ thống tự động tìm Handoff `AM ↔ SE` đang `running`/`paused` gần nhất trong hội thoại hiện tại (hoặc Ticket đang `running` của dự án) để gắn chỉ thị vào đúng đích mà Owner không cần copy-paste mã ID dài.

### 3.2. Cổng 2 — Lệnh tắt trong Chat (Tùy chọn nhanh cho Owner)
Ngoài việc nói bằng câu văn tự nhiên để AM/Router tự bắt, hỗ trợ thêm các mẫu câu ngắn gọn trong `owner-chat-command-service.js`:
- `/se <nội dung câu văn bình thường>` $\rightarrow$ đẩy thẳng vào Inbox của `SE` trong Handoff đang chạy.
- `/am <nội dung câu văn bình thường>` $\rightarrow$ đẩy thẳng vào Inbox của `AM` trong Handoff đang chạy.
- `/coder <nội dung câu văn bình thường>` (hoặc `/directive <nội dung>`) $\rightarrow$ đẩy thẳng vào Inbox của `Coder` trong Ticket đang chạy.

### 3.3. Tiêm chỉ thị tại Ranh giới Turn / Bước của `AM` và `SE` (`am-se-handoff-service.js` & `owner-sdk-stream.js`)
- Sử dụng cùng cấu trúc khóa file an toàn của `ticket-directive-inbox.js` (cho phép `taskId` nhận cả `HANDOFF-...` lẫn `TICKET-...`).
- Tại `am-se-handoff-service.js` (trước mỗi vòng critique hoặc mỗi bước `SE` implementation / `AM` review) và tại ranh giới turn SDK:
  - Gọi `directiveInbox.drainPending({ taskId: handoffId })`.
  - Nếu có chỉ thị dành cho `SE` hoặc `AM`, nối khối `MID-FLIGHT DIRECTIVES` vào prompt của `SE` / `AM` ở ngay lượt đó.
  - Nếu có chỉ thị `pause_after_turn`, chuyển trạng thái handoff sang `paused` an toàn tại checkpoint hiện tại.

---

## 4. Các Hạng mục Triển khai cho SE

1. **Hạng mục O1 — Mở rộng `ticket-directive-inbox.js` & Tự động phân giải đích (`AM`, `SE`, `Coder`):**
   - Cho phép lưu và rút chỉ thị theo cả `taskId` (Ticket) và `handoffId` (Handoff `AM ↔ SE`) kèm trường `target_role` (`am`, `se`, `coder`).
   - Hỗ trợ tự động tìm `handoffId` hoặc `taskId` đang active khi người dùng không chỉ định ID.
2. **Hạng mục O2 — Mở Forge Tool `send_execution_directive` & Bộ nhận diện câu văn tự nhiên trong Chat:**
   - Đăng ký tool `send_execution_directive` trong `engineering-tool-names.js`, `engineering-tool-catalog.js`, `owner-conversation-tools.js` và `owner-role-tool-policy.js`.
   - Hỗ trợ nhận diện câu nhắn tự nhiên gửi cho `AM`/`SE`/`Coder` (và lệnh ngắn `/se ...`, `/am ...`, `/coder ...`) trong `owner-chat-command-service.js`.
3. **Hạng mục O3 — Rút và tiêm chỉ thị vào luồng `AM ↔ SE` Handoff:**
   - Tích hợp `drainPending` và `formatMidFlightDirectives` vào `am-se-handoff-service.js` / `am-se-handoff-helpers.js` để `AM` và `SE` nhận được yêu cầu bổ sung của Owner ngay trong quá trình phản biện hoặc code.
