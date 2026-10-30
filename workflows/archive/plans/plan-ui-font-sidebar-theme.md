<!-- Đề xuất điều chỉnh cỡ chữ và vị trí nút đổi theme ở sidebar; không phải phê duyệt triển khai. -->
# Plan: Cỡ chữ 12pt và vị trí ThemeToggle khi sidebar thu gọn

> **Trạng thái:** đề xuất theo yêu cầu UI mới của owner; không sửa hay cấp approval cho plan Pause/Resume Architecture.

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** cỡ chữ UI chưa theo yêu cầu 12pt; khi sidebar desktop thu gọn, icon đổi theme đứng trên icon mở rộng/thu gọn.
- **Kết quả:** nội dung chữ giao diện chat/workspace dùng cỡ chữ nền 12pt; trong sidebar thu gọn, icon ThemeToggle nằm ngay bên dưới icon collapse/expand và vẫn thao tác được.
- **Giá trị:** tính nhất quán và dễ nhận biết của sidebar mà không làm thay đổi hội thoại hay trạng thái theme.

## 2. Phạm vi

### In scope

- Typography cho chữ thông thường trong shell chat/workspace và các override cần thiết để đạt cỡ chữ hiển thị 12pt; không áp 12pt lên glyph/icon, kích thước nút hoặc SVG.
- Bố cục hai controls sidebar desktop khi thu gọn; kiểm tra responsive, keyboard focus, tương phản và trạng thái theme.

### Out of scope

- Đổi API, lưu theme/sidebar preference, navigation hoặc state conversation; thay đổi UX Pause/Resume hay quyền Architecture.
- Thiết kế lại toàn bộ typography hierarchy hay ép nhãn/icon thành 12pt nếu làm mất khả năng sử dụng.

## 3. Hướng tiếp cận và guardrails

- **Ràng buộc:** 12pt là cỡ chữ hiển thị cho text thông thường (tương đương 16px ở tỷ lệ CSS mặc định); không dùng pixel cố định để vô hiệu hóa zoom người dùng. Các phần tử icon vẫn giữ hit target và accessible label. Không thay đổi thứ tự chức năng hay khiến theme toggle biến mất khi thu gọn.
- **Hướng đề xuất:** kiểm tra các khai báo `font-size` có specificity cao hơn trước khi chọn phạm vi CSS; ưu tiên đơn vị `rem`/`pt` thích hợp và điều chỉnh override có chủ đích, không dùng selector toàn cục cưỡng bức làm hỏng icon hoặc responsive. Khi sidebar thu gọn, đảm bảo thứ tự trực quan và tab là collapse/expand rồi ThemeToggle; khi mở rộng giữ trải nghiệm hiện tại.
- **Dependency thật sự:** SL xác minh CSS cascade, các breakpoints và biến thể sidebar trước khi chốt cách triển khai. Không cần thay đổi backend hoặc contract dữ liệu.
- **Giả định phạm vi:** “font-size 12pt” áp dụng chữ thông thường của UI chat/workspace, không phải văn bản trong tài liệu Markdown của repository. Nếu owner muốn tất cả màn hình bao gồm modal/agent directory cùng một cỡ, SL cần xác nhận trước khi mở rộng ngoài phạm vi này.

## 4. Khu vực dự kiến ảnh hưởng và evidence

| Khu vực | Evidence / mức chắc chắn |
| --- | --- |
| `ui/nextjs/app/styles/foundation.css` | `:root` đang khai báo `font-size: 15px` (dòng 7); có override chữ/controls theo px. Cần khảo sát cascade thực tế. |
| `ui/nextjs/components/conversation-sidebar.jsx` | Trong `.home-sidebar-controls`, `<ThemeToggle />` được render trước nút `.home-sidebar-collapse` (dòng 60–62); sidebar có class `is-collapsed`. |
| `ui/nextjs/app/styles/responsive-workspace.css` | `.conversation-sidebar.is-collapsed .home-sidebar-controls` dùng `flex-direction: column` (dòng 56), nên thứ tự DOM hiện tại đặt toggle ở trên. |
| `ui/nextjs/tests/conversations-navigation.test.js` | Bài test hiện kiểm tra ThemeToggle xuất hiện trước `.home-sidebar-collapse` và quy tắc flex-column (dòng 207–213); cần cập nhật theo hành vi mới. |

Các file trên chỉ định hướng discovery, không phải manifest sửa file của SL.

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Guardrail |
| --- | --- | --- | --- |
| U1 | Cỡ chữ 12pt | Trên chat/workspace desktop và mobile, text thông thường đo được 12pt (16 CSS px ở zoom mặc định), không bị override cũ triệt tiêu; chữ vẫn wrap/không tràn ở breakpoint áp dụng và zoom 200%. | Giữ kích thước icon, hit target, hierarchy có chủ đích. |
| U2 | Vị trí theme đúng khi thu gọn | Ở sidebar desktop thu gọn, collapse/expand nằm trên ThemeToggle; cả hai thấy được, điều hướng theo thứ tự bàn phím tương ứng và thao tác theme/expand vẫn hoạt động. Sidebar mở rộng và mobile không bị mất toggle hay lặp control đang hiển thị. | Không đổi persistence/logic theme hoặc conversation. |
| U3 | Kiểm chứng hồi quy | Kiểm tra CSS/DOM cùng test giao diện tại desktop/mobile, dark/light, zoom và keyboard; cập nhật kỳ vọng test cũ về thứ tự controls; không có regression navigation/sidebar. | SL chọn verification phù hợp trước acceptance. |

SL chủ động phân rã và mapping outcomes vào SP sau approval đúng identity/revision/SHA; đây không phải quyền RUN/dispatch.

## 6. Rủi ro, giả định và câu hỏi mở

| Rủi ro / câu hỏi | Mức | Xử lý |
| --- | --- | --- |
| Root 12pt không thắng các override 15px hoặc làm tràn layout tại zoom | Major | Đo computed style và kiểm tra breakpoint/zoom; chỉnh phạm vi override có chủ đích. |
| Đổi thứ tự bằng CSS đơn thuần khiến thứ tự tab không khớp thứ tự nhìn | Major | Đồng bộ DOM và visual order hoặc chứng minh tương đương bằng kiểm tra bàn phím. |
| “12pt” có bao gồm mọi màn hình/modal? | Assumption | Mặc định áp text thông thường chat/workspace; owner xác nhận nếu cần mở rộng toàn ứng dụng. |

## 7. Acceptance criteria của plan

- [ ] U1–U3 được mapping tới verification; facts repository-specific đã có evidence, phạm vi chưa rõ được nêu như giả định.
- [ ] Không mở rộng thay đổi Pause/Resume hay quyền role; SL lập SP sau exact human approval, không tự dispatch.
