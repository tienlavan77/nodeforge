# Plan: UI workspace compact và không tràn

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** workspace đang có gutter/padding lớn; selector Architecture Manager có thể vượt sidebar; conversation list còn nhiều khung/padding; phần header chat dư tiêu đề; composer thấp và vùng cuộn có nguy cơ chồng lên message human.
- **Kết quả:** giao diện home compact, sidebar không tràn ngang, danh sách conversation tối giản nhưng vẫn giữ affordance/accessibility, composer cao hơn và nội dung cuộn độc lập.
- **Giá trị:** tăng diện tích nội dung chat, giảm nhiễu thị giác, giữ nguyên state/navigation và không thay đổi API hay persistence.

## 2. Phạm vi

### In scope

- Chuẩn hóa `--workspace-gutter` desktop/mobile về `15px` và rà các padding/gutter trực tiếp của home workspace.
- Sắp xếp khu vực brand/sidebar và hàng Architecture Manager theo chiều dọc hoặc layout co giãn; selector không vượt chiều rộng sidebar.
- Bỏ border/background/padding thừa của accordion và conversation blocks; icon action ẩn mặc định, hiện khi hover/focus; block đang chọn dùng underline nhẹ.
- Brand sidebar chỉ còn logo nhỏ bên phải và nút collapse; bỏ tiêu đề “Project Chat”.
- Tăng chiều cao composer khoảng 30% so với baseline hiện tại, bổ sung padding nội dung, giảm border active; bảo đảm message area/composer không chồng lấn và scrollbar không phủ human message.
- Cập nhật smoke/UI assertions cần thiết ở mức class/behavior nhỏ, không lặp coverage action pin/rename/archive/delete đã có.

### Out of scope

- Không đổi conversation API, schema, stream/event correlation, selection persistence hoặc lifecycle mounted.
- Không đổi hành vi CRUD/action của conversation; không refactor lớn component; không sửa legacy workspace nếu không chứng minh active route sử dụng nó.
- Không khóa implementation vào số ticket/file cụ thể; SL xác minh manifest thực tế theo policy.

## 3. Hướng tiếp cận và guardrails

- **Ràng buộc bắt buộc:** giữ callback `onSelectConversation`, active conversation state, collapse/reopen state và accessible keyboard/focus behavior. Giữ mobile breakpoint và không để action icons biến mất khỏi keyboard/focus users.
- **Hướng đề xuất:** ưu tiên CSS trong `shell-layout.css`, `home-workspace.css`, `conversations.css`; chỉ sửa JSX ở `page.jsx`/`conversation-sidebar.jsx` khi cần bỏ heading hoặc đổi cấu trúc brand. Dùng `min-width: 0`, `max-width: 100%`, `overflow: hidden`/`overflow-y: auto` đúng container; tránh `overflow: hidden` trên vùng cần cuộn.
- **Composer:** xác định baseline computed height trong browser/smoke trước khi đặt min-height; tăng xấp xỉ 30%, không làm mất resize/IME/Enter behavior.
- **Dependency thật sự:** cần xác nhận active route là `ui/nextjs/app/page.jsx` và import CSS hiện tại; verification phải bao gồm viewport hẹp và state navigation.
- **Quyết định chưa chốt:** “logo nhỏ” là ký tự/mark hiện có hay asset mới; mặc định giữ mark `N` hiện có để tránh scope asset. “Icon chỉ hover” vẫn hiện khi `:focus-visible` và trên mobile theo accessibility.

## 4. Khu vực dự kiến ảnh hưởng và evidence

| Thành phần / khu vực | Vai trò | Evidence / mức chắc chắn |
| --- | --- | --- |
| `ui/nextjs/app/page.jsx` | Active home layout, Architecture selector, Project Chat heading, message/composer regions | Đã khảo sát; `rg_search` xác nhận lines 198–207 |
| `ui/nextjs/components/conversation-sidebar.jsx` | Sidebar collapse/reopen, brand, mobile rail, selector mount | Đã đọc; checksum `sha256:61fbafd6c3bfbfe75d5d1a72cbad308aee2eae1a600065455fa58c0f1b924663` |
| `ui/nextjs/app/styles/shell-layout.css` | Workspace gutter token và responsive overflow/layout | Đã đọc; checksum `sha256:3032b8b7378ba1ca8cf8ca05cfe841fe84552f4fc5ddace1c1d108a01effbd7b` |
| `ui/nextjs/app/styles/home-workspace.css` | Active home panels, selector, chat messages, composer | Đã đọc; checksum `sha256:c23174359658e9dcf6af340adf32b5492a4c3b082da2442f07eadebf1a08b1d6` |
| `ui/nextjs/app/styles/conversations.css` | Accordion/block borders, padding, action visibility, selected state | `rg_search` đã xác nhận các selector hiện hành; cần đọc checksum trước khi sửa |
| `ui/nextjs/components/ConversationsBlock.jsx` | Row/action semantics và selected class | `rg_search` xác nhận `is-active`/`is-selected` và action aria labels; không đổi behavior |
| `ui/nextjs/components/home-chat-composer.jsx` | Draft, IME, history, submit behavior | Đã đọc; checksum `sha256:1dbe67a388153c501756bcda1d89c5c0c93ff717cc58e0313b84b8e8c442f89e` |

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Dependency / guardrail |
| --- | --- | --- | --- |
| O1 | Workspace compact và responsive | CSS token là `15px`; desktop/mobile không tạo horizontal overflow; selector nằm trong sidebar | Giữ breakpoint và min-width contracts |
| O2 | Conversation navigation tối giản | accordion/block không còn khung/padding thừa; selected có underline nhẹ; actions hover/focus/mobile vẫn reachable | Không lặp action CRUD tests |
| O3 | Sidebar/header gọn | brand chỉ còn logo nhỏ + collapse; không còn title “PROJECT CHAT”; collapse/reopen không reset conversation/messages | Giữ callback/state/mounted behavior |
| O4 | Chat đọc/nhập ổn định | composer cao hơn baseline xấp xỉ 30%, có padding và active border mảnh; scrollbar chỉ thuộc message viewport, không đè human message | Giữ IME, Enter/Shift+Enter, scroll-to-latest |

## 6. Rủi ro, giả định và câu hỏi mở

| Rủi ro / câu hỏi | Tác động | Evidence / giả định | Người chốt / cách xử lý |
| --- | --- | --- | --- |
| CSS legacy có selector trùng active route | Major | `README.md` ghi rõ legacy/foundation overlap | SL audit cascade, chỉ sửa selector active; escalate nếu cần migration |
| Hover-only icons khó dùng touch/keyboard | Major | yêu cầu hover nhưng action hiện có aria labels | SL giữ focus-visible và mobile fallback |
| Scrollbar phủ nội dung human | Major | message area dùng `overflow:auto`, message width 92% | SL kiểm tra `box-sizing`, padding-inline và viewport thực |
| Exact 30% phụ thuộc font/viewport | Minor | chưa có browser computed baseline | SL đo baseline rồi chọn min-height hợp lý, ghi evidence |

## 7. Acceptance criteria của plan

- [ ] Mục tiêu, in/out scope và outcomes nhất quán với yêu cầu UI.
- [ ] Không thay đổi API, state/navigation, persistence hoặc action semantics.
- [ ] Facts repository-specific có evidence; checksum chỉ dùng cho file đã đọc.
- [ ] SL lập SP với manifest thực tế, tối đa bốn mutable files mỗi ticket và verification responsive/accessibility.
- [ ] Verification gồm focused UI tests, lint/build phù hợp và kiểm tra overflow ở desktop/mobile.
- [ ] Human approval đúng revision/SHA-256 trước handoff; Architecture không tự sửa UI source, RUN hoặc dispatch.
