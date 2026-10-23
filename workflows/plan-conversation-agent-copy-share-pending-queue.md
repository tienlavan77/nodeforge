# Plan: Copy/share phản hồi agent và hàng đợi message chờ trên khung conversation

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** khung conversation hiện chỉ có copy/edit/retry cho `owner.message` (`ConversationMessageActions`), phản hồi `agent` thiếu thao tác copy/share nhanh. Khi agent đang `WORKING`, message mới của user bị gửi ngay qua `postOwnerMessage` và cạnh tranh với lượt đang chạy, không có trạng thái chờ hay thứ tự FIFO rõ ràng.
- **Kết quả:** mỗi phản hồi agent có nút copy và share hoạt động ổn định; khi agent bận, user vẫn nhập được message, message được đưa vào hàng đợi chờ FIFO hiển thị ngay trên statusbar khu vực `project/git`, và được tự động gửi tuần tự khi agent kết thúc phiên. Không mất thứ tự, không gửi trùng, không làm sai trạng thái `WORKING/READY`.
- **Giá trị:** tăng tốc thao tác chia sẻ kết quả agent và cho phép soạn trước nhiều turn trong khi agent đang chạy, giảm thao tác thủ công và lỗi gửi đè.

## 2. Phạm vi

### In scope

- Thêm thao tác **copy** và **share** cho từng phản hồi agent trong khung conversation trên cả hai workspace (Home và System/Architecture), tái dùng/ mở rộng `conversation-message-content.jsx` và `conversation-message-actions.jsx` hoặc tách component con hợp lý.
- Hàng đợi **pending FIFO** phía UI cho `owner.message` khi `workingByAgent[agentId] === WORKING`: enqueue, render trạng thái chờ, dequeue và auto-send khi agent về `READY/FAILED`, hiển thị danh sách chờ ngay trên `statusbar` cạnh `ConversationProjectGit`/`project/git`.
- Tích hợp với `createSendMessageHandler`/`postOwnerMessage` và `useAgentEventStreams`/`workingByAgent` hiện có; giữ optimistic pending hiện tại cho message đang bay.

### Out of scope

- Thay đổi contract backend `/forge/v1/conversations/:id/messages` hay `postOwnerMessage` ngoài việc gọi tuần tự; không thêm API queue server-side trong scope này.
- Lưu hàng đợi pending ra `localStorage`/DB hay đồng bộ cross-tab; hàng đợi là in-memory theo phiên UI.
- Sửa approval, sprint/plan, checkpoint/execution lifecycle hay logic System/Architecture role-scoped đã có trong plan checkpoint-cleanup.
- Thay đổi `.forge/` runtime state hay contract stream `node-client.js` ngoài việc tiêu thụ trạng thái `WORKING`.

## 3. Hướng tiếp cận và guardrails

- **Ràng buộc bắt buộc:** giữ contract `message_type`/`message.from` (`owner`/`agent`/`system`), không đổi `conversation` naming theo `vocabulary/glossary.md`. Copy/share chỉ đọc `message.text` đã render, không lộ secret. Không nuốt lỗi `catch` (log/rethrow hoặc `no-silent-catch` có lý do). Mỗi file <=250 dòng, split thay vì phình file.
- **Hướng đề xuất:** mở rộng `ConversationMessageActions` hoặc tạo `ConversationAgentMessageActions` riêng cho `from==="agent"` với copy qua `navigator.clipboard.writeText` + fallback textarea + Web Share (`navigator.share`/`canShare`) fallback về copy + toast. Share text thuần, không share HTML. Hàng đợi pending là `useRef` + `useState` map theo `agentId` trong `NodeForgeApp.jsx`/`ui/nextjs/app/page.jsx` và `system/page.jsx`, composer chuyển sang `enqueue` khi `isWorking`; `useEffect` theo `workingByAgent` trigger `dequeue+send` một lần, có guard chống double-send. UI queue render như strip/list nhỏ phía trên `footer.statusbar`, tái dùng `ConversationProjectGit` làm anchor; mỗi item hiện preview + nút hủy/reorder tối thiểu (hủy một item).
- **Dependency thật sự:** cần chốt nguồn truth cho `isWorking` (chỉ `workingByAgent` từ SSE/workspace, không tự suy từ pending local) và thứ tự hiển thị lịch sử khi optimistic + SSE dequeue trùng.
- **Quyết định chưa chốt:** share có cần copy link conversation/message ID không (hiện share text); pending queue có cho phép edit trước khi gửi hay chỉ hủy; có giữ tối đa N item/FIFO overflow behavior.

## 4. Khu vực dự kiến ảnh hưởng và evidence

| Thành phần / khu vực | Vai trò | Evidence / mức chắc chắn |
| --- | --- | --- |
| `ui/nextjs/components/conversation-message-actions.jsx:1-79`, `ui/nextjs/components/conversation-message-content.jsx:1-115` | Copy hiện cho owner, code-block copy riêng | Đã đọc source; chắc chắn |
| `ui/nextjs/app/page.jsx:161`, `ui/nextjs/app/system/page.jsx:159`, `ui/nextjs/tests/message-actions.test.js:1-29` | Chỉ owner wrap `ConversationMessageActions` | Đã đọc; chắc chắn |
| `ui/nextjs/app/NodeForgeApp.jsx:24,77-78,172`, `ui/nextjs/lib/node-forge-send-message.js:1-62` | `workingByAgent`/`isWorking` và `createSendMessageHandler` gửi ngay | Đã đọc; chắc chắn |
| `ui/nextjs/components/NodeForgeShell.jsx:126`, `ui/nextjs/components/conversation-project-git.jsx:1-14`, `ui/nextjs/lib/node-client.js:199-212` | Vị trí `statusbar` + `project/git` và `postOwnerMessage` | Đã đọc; chắc chắn |
| `ui/nextjs/app/styles/foundation.css:218`, `shell-theme.css:210` | Style `statusbar` để đặt strip pending phía trên | Đã đọc; chắc chắn |

Candidate paths chỉ định hướng discovery, không phải allowlist.

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Dependency / guardrail |
| --- | --- | --- | --- |
| O1 | Copy/share cho phản hồi agent | Mỗi `agent` message hiện nút Copy (clipboard + fallback) và Share (Web Share API khi có, fallback copy+toast); thao tác thành công/báo lỗi rõ, không ảnh hưởng owner actions; unit/test UI xác nhận aria-label `Copy agent message`/`Share agent message` | Giữ vocabulary `conversation`; không nuốt lỗi |
| O2 | Hàng đợi message chờ FIFO trên statusbar | Khi `WORKING`, gửi từ composer enqueue FIFO, hiển thị list chờ ngay trên `statusbar` khu vực `project/git` với preview + trạng thái chờ; khi agent kết thúc, message đầu queue tự gửi đúng một lần theo FIFO; hủy một item hoạt động; reload không yêu cầu persist queue | Truth `workingByAgent` từ SSE; idempotent send |
| O3 | Không phá luồng chat hiện có | Owner copy/edit/retry, agent typing, optimistic history, SSE dedup vẫn đúng; không double-send khi double-click hoặc retry network | Dùng `messageId`/`correlationId` hiện có |

**Gợi ý delivery (không bắt buộc):** SL tách O1 (UI actions) và O2 (queue state + strip) song song sau khi chốt share fallback và vị trí strip; thêm ticket discovery nhỏ cho a11y/toast.

## 6. Rủi ro, giả định và câu hỏi mở

| Rủi ro / câu hỏi | Tác động | Evidence / giả định | Người chốt / cách xử lý |
| --- | --- | --- | --- |
| Web Share không khả dụng trên desktop | Minor O1 | Giả định fallback copy | SL quyết fallback copy + global toast; không block |
| Race dequeue khi `WORKING` flap | Major O2 | `workingByAgent` từ SSE có thể chập chờn | SL guard bằng ref `sendingQueue` + chỉ dequeue khi `!isWorking` ổn định |
| Queue lớn gây tràn UI | Minor O2 | Giả định queue ngắn | SL giới hạn hiển thị + scroll, document max hiển thị |
| Share có cần kèm link/messageId | Minor O1 | Chưa chốt | Human/Architecture chốt trước SL |

## 7. Acceptance criteria của plan

- [ ] Mục tiêu, in/out scope và outcomes nhất quán với yêu cầu copy/share agent + pending FIFO trên statusbar project/git.
- [ ] Facts có evidence source; assumptions/open questions ghi rõ.
- [ ] Guardrails và dependency bắt buộc tách khỏi gợi ý delivery.
- [ ] Outcomes có tiêu chí kiểm tra được đủ để SL lập SP chủ động.
- [ ] Không áp đặt số ticket/tên ticket/mutable-file manifest.
- [ ] SL chứng minh coverage và tuân thủ policy ticket trước dispatch.
- [ ] Approval đúng identity/revision/SHA-256; lập SP không tự RUN/dispatch.
