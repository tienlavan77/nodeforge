<!-- Business purpose: define a fresh visual-surface plan for rebuilding the NodeForge home UI without changing backend conversation contracts. -->
# Plan: Trang home trống, giữ nguyên chức năng NodeForge

> **Trạng thái:** Owner xác nhận phần giao diện đã hoàn tất theo phong cách Claude Desktop; chưa kiểm chứng độc lập từ mã nguồn hoặc test, và chưa xác nhận các tiêu chí O1–O4. Plan vẫn DRAFT — chưa được approve và không cấp quyền triển khai.
> **Identity:** Đây là planning note trong `workflows/`; approval/execution phải dùng plan revision và SHA-256 canonical do Node quản lý.

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:** Route `/` hiện render header, các vùng Conversations/Workspace/Sprint, chat, dashboard và watcher; owner muốn bắt đầu với một bề mặt hiển thị trống.
- **Kết quả:** Giữ nguyên route `/`, nhưng presentation surface chỉ còn một landmark HTML tối giản; không reset, xóa hoặc migrate dữ liệu và không thay đổi các contract phía sau.
- **Giá trị:** Tách quyết định làm trống giao diện khỏi backend/API/SSE, giảm rủi ro mất lịch sử, optimistic send, retry hoặc stream correlation.

## 2. Phạm vi

### In scope

- Chỉ thay đổi presentation surface của canonical home route `ui/nextjs/app/page.jsx`.
- Giữ lifecycle/state cần thiết của `HomePage`: tải history, chọn conversation, optimistic message, retry, API client và project SSE subscription.
- Render một surface trống có landmark/accessibility label tối thiểu, không kế thừa bố cục Workspace/Sprint hiện tại.
- Kiểm tra build, route `/`, các contract client hiện hữu và việc không có thay đổi ngoài phạm vi.

### Out of scope

- Không sửa backend, API routes, schema, database, SSE protocol hoặc dữ liệu đã lưu.
- Không reset, xóa, migrate conversation/history, local state hay project data.
- Không xóa component/CSS legacy; không refactor ngoài phần cần để thay presentation surface.
- Không tạo route preview mới; không thay đổi `/agents` hoặc các route chức năng khác.
- Không yêu cầu giao diện pixel-perfect hay sao chép nhận diện của sản phẩm khác.

## 3. Hướng tiếp cận và guardrails

- **Ràng buộc bắt buộc:** `/` vẫn do `app/page.jsx` phục vụ; không đổi endpoint, payload, project/conversation scoping, event filtering, retry intent hoặc storage key. Không đặt early return trước các hook/effect cần duy trì lifecycle hiện hữu.
- **Hướng đề xuất:** giữ `HomePage` và các module state/stream/handler đã có; thay phần JSX hiển thị bằng một landmark trống. Không xóa module cũ trong revision này. Chi tiết tổ chức import và phần presentation chưa dùng do SL/Coder xử lý trong boundary này, sau khi kiểm tra build/lint.
- **Dependency thật sự:** phải xác minh bằng test rằng việc bỏ các child presentation không vô tình unmount subscription, history loading hoặc handler lifecycle. Nếu một capability chỉ có thể giữ bằng thay đổi public contract hoặc migration, phải dừng và quay lại owner.
- **Quyết định đã chốt:** visual-only; giữ route `/`; giữ dữ liệu và chức năng backend/API/SSE; không tạo plan/file khác ngoài artifact được yêu cầu.
- **Giả định cần ghi nhận:** “trang trống” không yêu cầu người dùng tiếp tục thấy composer, history hoặc dashboard trên `/`; nếu yêu cầu đó xuất hiện, đây là thay đổi outcome chứ không phải chi tiết delivery.

## 4. Khu vực dự kiến ảnh hưởng và evidence

| Thành phần / khu vực | Vai trò | Evidence / mức chắc chắn |
| --- | --- | --- |
| `ui/nextjs/app/page.jsx` | Canonical `/` route; hiện sở hữu state, history, SSE wiring và JSX Workspace/Sprint/Chat | Đã đọc; `HomePage` lines 33–239; checksum `sha256:5ba79d373469ca6c751b0bb0af8d0caef60c33e7b5db2f52bf12b0b1a1ff6660` |
| `ui/nextjs/README.md` | Behavior contract: switch, optimistic send, retry, stream correlation và project scope | Đã đọc; checksum `sha256:e1a3b007af34d80f4e024a5ad50af10f6112f1fe8b2404d5d1358388c683db3b` |
| `ui/nextjs/lib/home-page-event-stream.js` | Project SSE subscription và lọc message theo conversation | Đã đọc; `useProjectEventStream` lines 7–94; checksum `sha256:c1e86fa5b743351519a02451ead3a873af34a3fa595bfc098d8099a647b942ce` |
| `ui/nextjs/lib/home-page-message-handlers.js` | Gửi message, optimistic state, create conversation và retry | Đã đọc; `createHomeMessageHandlers` lines 6–89; checksum `sha256:6c69254b8a22c596ef0ec036c465cb824e92b6e7654ee9057f8fdd65fcba40e3` |
| `ui/nextjs/app/globals.css` và `ui/nextjs/app/layout.jsx` | Global style import và root document/metadata; không cần đổi cho visual-only boundary nếu không có evidence | Đã đọc; checksum lần lượt `sha256:f94c1dd911a67762404dd6519cc650079395047485743f89418c60268e5e21a4` và `sha256:00d6804338cb5788f44b154cb0039d0d33cd1587cc1d05f687e2c0cc3f2626f5` |
| `ui/nextjs/app/NodeForgeApp.jsx` | Dormant legacy app không được active `/` route import | Đã đọc; không thuộc mutable scope; checksum `sha256:3f67d276d3f53e2715e60f358504ab24829cf362c022f611e89279a24af079a6` |

Các file trên là vùng discovery/evidence, không phải mutable-file allowlist cố định. SL xác minh manifest thực tế trước khi lập SP.

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Dependency / guardrail |
| --- | --- | --- | --- |
| O1 | Route `/` có surface trống | Mở `/` thành công; DOM hiển thị landmark tối giản; header, region actions, chat, Sprint và Workspace không còn xuất hiện trên surface; không có route mới | Giữ canonical route và accessibility tối thiểu |
| O2 | Backend-facing behavior không bị thay đổi | Không có diff backend/API/schema/SSE; source diff giữ project scope, history state, optimistic send, retry, API client và SSE lifecycle; không có thao tác clear/migrate dữ liệu | Giữ nguyên contract trong `ui/nextjs/README.md` |
| O3 | Không hồi quy ứng dụng | Next build và test hiện hữu liên quan pass; smoke test `/` pass; `/agents` vẫn mở; không có lỗi hydration/runtime hoặc overflow do surface mới | Không dọn code cũ trước khi verification đạt |
| O4 | Legacy capability còn đường khôi phục | Các component/lib/CSS cũ vẫn tồn tại; không có delete/migration trong revision này; thay đổi tương lai có thể nối lại Chat/Workspace/Sprint mà không đổi API | Mọi cleanup hoặc thay đổi UX tiếp theo cần plan revision riêng nếu chạm outcome |

**Gợi ý delivery (không bắt buộc):** Coder thay presentation trước, chạy build/smoke và kiểm tra hook/effect lifecycle; Reviewer đối chiếu diff với contract và xác nhận không có backend/data/API/SSE thay đổi. Không dispatch từ planning note này.

## 6. Rủi ro, giả định và câu hỏi mở

| Rủi ro / câu hỏi | Tác động | Evidence / giả định | Người chốt / cách xử lý |
| --- | --- | --- | --- |
| Bỏ child khỏi JSX có thể làm mất UI event handler dù backend contract còn nguyên | Major | `page.jsx` hiện gắn composer/sidebar/panel vào cùng route; blank surface chủ ý không hiển thị chúng | SL kiểm tra lifecycle; owner chốt lại nếu `/` vẫn phải tương tác |
| Giữ SSE/history lifecycle trên trang trống có thể vẫn tạo request nền | Minor | `useProjectEventStream` và history wiring đang được gọi từ `HomePage` | Giữ theo quyết định hiện tại; chỉ đổi khi owner chốt guardrail tải nền khác |
| Global CSS vẫn chứa selector cũ và được import | Minor | `globals.css` import các domain stylesheet; cleanup không nằm trong scope | Không sửa/xóa CSS ở revision này; audit riêng sau verification |
| Có người hiểu “trang trống” là reset chức năng | Blocker nếu xảy ra | Owner đã chốt visual-only trong yêu cầu hiện tại | Không reset/migrate; escalate nếu yêu cầu thay đổi |

## 7. Acceptance criteria của plan

- [x] Owner xác nhận phần giao diện đã hoàn tất theo phong cách Claude Desktop; ghi nhận đây là xác nhận của owner, chưa phải kiểm chứng độc lập.
- [ ] Mục tiêu, in/out scope và O1–O4 phản ánh đúng quyết định: giữ `/`, chỉ làm trống UI.
- [ ] Facts repository-specific có evidence/checksum; assumptions và trade-off được tách riêng.
- [ ] Guardrails bảo vệ API, SSE, history, optimistic send, retry, project scope và dữ liệu.
- [ ] Không có mutable-file manifest, số ticket hoặc thứ tự delivery bị khóa; SL còn quyền lập SP trong boundary.
- [ ] Không tự approve, RUN hoặc dispatch; human phải approve đúng canonical plan revision/SHA-256 trước thực thi.
