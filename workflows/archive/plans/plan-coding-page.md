# Plan: Remove Conversation Sidebar & Agent Selector from Coding Page

## 1. Mục tiêu / kết quả mong đợi
- **Vấn đề:** `ui/nextjs/app/coding/page.jsx` hiện chứa UI cho `ConversationSidebar` và một selector cho coding agents. Các thành phần này không được sử dụng trong giao diện “coding workspace”, gây lint warnings (`no‑unused‑vars`), tăng bundle size và tạo trạng thái UI không cần thiết.
- **Kết quả:**
  - Loại bỏ toàn bộ code và JSX liên quan tới `ConversationSidebar`.
  - Loại bỏ selector UI (listbox) cho agents, đồng thời xóa các import không dùng.
  - UI chỉ hiển thị `ConversationsAccordion` (danh sách hội thoại) và các hook cần thiết để fetch agents và conversations.
- **Giá trị:**
  - Bundle size giảm ≥ 2 KB.
  - Lint‑free (`npm run lint` không cảnh báo).
  - Trải nghiệm người dùng gọn gàng, không còn “Select agent” UI.

## 2. Phạm vi

### In scope
- **Mutable‑file manifest**: duy nhất `ui/nextjs/app/coding/page.jsx` (≤ 4 files).
- Cập nhật import statements, state (`openSidebar`), và JSX wrapper (`<ConversationSidebar …>`).
- Xóa toàn bộ block JSX của selector (`<div className="claude-architecture-list" …>`).
- Giữ lại logic fetch agents và `writeArchitectureManagerAgent` (để ghi lại agent mặc định) nhưng UI không cho phép người dùng thay đổi.

### Out of scope
- Thay đổi logic backend, API, hoặc contract liên quan tới agents.
- Thêm hoặc sửa bất kỳ component nào khác (VD: `ConversationsAccordion`, `WorkspaceMonitorPanels`).
- Migration dữ liệu, versioning, hoặc thay đổi `.forge/` runtime state.

## 3. Hướng tiếp cận và guardrails
- **Ràng buộc bắt buộc:** chỉ sửa `ui/nextjs/app/coding/page.jsx`; không thay đổi contract, API, hay schema.
- **Checksum pre‑change:** `sha256:90ade9852aed6cf23460a00dcd37483210f02d65a52ed7de2beb884e09c9d0a4` (được xác thực bằng `read_file`).
- **Lint:** không được có cảnh báo `no‑unused‑vars` hoặc import không dùng.
- **Runtime guard:** `writeArchitectureManagerAgent` chỉ được gọi trong `useEffect` (không phụ thuộc UI).
- **No contract change:** không thay đổi schema, API, hoặc secret handling.

### Đề xuất thực hiện
1. Xóa import `ConversationSidebar` và `WorkspaceMonitorPanels`.
2. Xóa state `openSidebar` và các hàm `setOpenSidebar`.
3. Loại bỏ JSX `<ConversationSidebar …>` bao quanh `<ConversationsAccordion …>`.
4. Xóa block selector (`<div className="claude-architecture-list" …>` và các nút con).
5. Giữ lại:
   - `architectureManagerSelection` & `writeArchitectureManagerAgent` (để ghi lại agent mặc định).
   - Logic fetch agents và conversations (không thay đổi).
6. Chạy `npm run lint`, `npm run build`, và kiểm tra UI để xác nhận không lỗi.

## 4. Khu vực dự kiến ảnh hưởng và evidence
| Thành phần / khu vực | Vai trò | Evidence / mức chắc chắn |
|---|---|---|
| `ui/nextjs/app/coding/page.jsx` | Component UI coding workspace | **SHA‑256:** `sha256:90ade9852aed6cf23460a00dcd37483210f02d65a52ed7de2beb884e09c9d0a4` (read via `read_file`) |
| `ui/nextjs/components/conversation-sidebar.jsx` | (được loại bỏ import) | Không còn được sử dụng sau thay đổi. |
| `ui/nextjs/components/WorkspaceMonitorPanels.jsx` | (được loại bỏ import) | Không còn được sử dụng sau thay đổi. |

## 5. Outcomes và điều kiện nghiệm thu
| Mã | Outcome bắt buộc | Acceptance criteria | Dependency / guardrail |
|---|---|---|---|
| O1 | Codebase clean, lint‑free | `npm run lint` returns **0 warnings/errors**; không còn import không dùng. | ✅ |
| O2 | UI không còn sidebar & agent selector | Trang `/coding` chỉ hiển thị `ConversationsAccordion`; không có `<ConversationSidebar>` hoặc `<div className="claude-architecture-list">`. | ✅ |
| O3 | Bundle size giảm | `npm run build` báo giảm ít nhất **2 KB** so với baseline. | ✅ |
| O4 | Không có console errors runtime | Khi mở `/coding` không có lỗi `setState` trên component đã unmount. | ✅ |

## 6. Rủi ro, giả định và câu hỏi mở
| Rủi ro / câu hỏi | Tác động | Evidence / giả định | Người chốt / cách xử lý |
|---|---|---|---|
| Backend có thể dựa vào UI selector để ghi log | Minor – mất một số log, không ảnh hưởng chức năng. | Kiểm tra `writeArchitectureManagerAgent` vẫn được gọi trong `useEffect`. | Architecture xác nhận không phụ thuộc UI. |
| Xóa `ConversationSidebar` có thể làm mất CSS/layout phụ thuộc. | Minor – UI có thể lệch. | Kiểm tra UI sau build; không có lỗi console. | Tester xác nhận. |
| Các công cụ khác (e.g., `WorkspaceMonitorPanels`) có thể được import ở nơi khác. | Không ảnh hưởng nếu không dùng ở `page.jsx`. | Phân tích import graph. | Architecture/SL kiểm tra. |

## 7. Acceptance criteria của plan
- [ ] Mục tiêu, in/out scope và outcomes nhất quán với yêu cầu.
- [ ] Facts (file checksum) được cung cấp và xác thực.
- [ ] Guardrails và dependency bắt buộc tách rõ, không vi phạm mutable‑file limit.
- [ ] Outcomes có tiêu chí kiểm tra được và đủ để SL lập ticket.
- [ ] Lint và build đều thành công, bundle size giảm.
- [ ] Human reviewer duyệt plan với đúng SHA‑256 và identity.

---

**Mutable‑file manifest**
- `ui/nextjs/app/coding/page.jsx`

**Pre‑change evidence**
- `ui/nextjs/app/coding/page.jsx` SHA‑256 = `sha256:90ade9852aed6cf23460a00dcd37483210f02d65a52ed7de2beb884e09c9d0a4`

---

*Sau khi plan được human‑approved, thay đổi sẽ được thực hiện bằng `write_diff` (hoặc `edit_diff`) với `before_checksum` ở trên.*