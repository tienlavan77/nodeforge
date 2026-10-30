<!-- Tổng hợp thiết kế và quyết định của Owner về quy trình quản lý vòng đời Project, định danh slug URL, tiến trình SSE và cài đặt Project để lập Architecture Plan. -->
# Plan: Quản lý vòng đời Project hợp nhất, định danh Slug URL và tiến trình SSE thời gian thực

> Trạng thái: **Architecture Plan (Draft — chờ Owner Approve)**
> Tài liệu kế hoạch kiến trúc chính thức được lập từ các quyết định đã chốt của Owner, bao gồm mục tiêu, phạm vi, guardrails, dẫn chứng mã nguồn (`sha256`) và các Outcomes nghiệm thu (`O1`–`O4`). Kế hoạch này chưa cấp quyền thực thi cho tới khi được Owner Approve qua hệ thống.

## 1. Mục tiêu / kết quả mong đợi

- **Vấn đề:**
  1. API quản lý danh mục dự án đang tách rời ở nhánh riêng (`/lifecycle/*` với header `x-nodeforge-lifecycle: 1`) thay vì chuẩn RESTful dưới `/forge/v1/projects`.
  2. Form thêm project buộc người dùng chọn thủ công `Create` hay `Add`, chỉ nhập mỗi `root`, thiếu thông tin định danh (`name`, `description`, `author`) và sinh `project_id` dạng `PROJECT-<uuid>` kém thân thiện trên URL.
  3. Trang chủ `ProjectDirectory` đang dùng vòng lặp polling `setTimeout(..., 1500)` liên tục; trong khi đó SSE `/forge/v1/stream?project=<projectId>` lại chặn kết nối (`404 PROJECT_NOT_FOUND`) khi project đang ở trạng thái `running` (đang lập chỉ mục).
  4. `ArchitectureWorkspace` vẫn tham chiếu hằng số `PROJECT_ID` tĩnh ở một số luồng thay vì nhận động `projectId` từ route `/[projectId]`, và thẻ `ProjectCard` chưa hỗ trợ click toàn vùng hoặc Sửa/Xoá trực tiếp.
- **Kết quả:**
  - Hợp nhất toàn bộ CRUD và kiểm tra đường dẫn về `/forge/v1/projects` (`GET`, `POST`, `PUT /:projectId`, `DELETE /:projectId`, `POST /preflight`).
  - Tự động phát hiện trạng thái thư mục trên đường dẫn `root` (project đã có dữ liệu hay thư mục mới/trống) để quyết định quy trình khởi tạo mà không bắt người dùng chọn `Create`/`Add`.
  - Thu thập bắt buộc `(name, description, author, root)` khi thêm project; dùng slug của `name` làm `project_id` hiển thị trực tiếp trên URL (`/<projectId>`, `/<projectId>/coding`, `/<projectId>/system`) và mở rộng cấu hình cài đặt project (Git, lệnh chạy, AI default agents, phạm vi watch, tags/links).
  - Mở kết nối SSE `/forge/v1/stream?project=<projectId>` ngay khi project đang `running` để phát tiến trình thực tế trên thẻ `ProjectCard`, loại bỏ hoàn toàn vòng lặp polling 1.5s.
- **Giá trị:** Trải nghiệm quản trị đa dự án nhất quán, URL sạch sẽ, phản hồi tiến trình tức thời qua SSE, bảo toàn tuyệt đối mã nguồn và dữ liệu `.forge/` của các dự án hiện có.

## 2. Phạm vi

### In scope

- **Hợp nhất RESTful API `/forge/v1/projects`:**
  - `GET /forge/v1/projects`: Lấy danh sách toàn bộ project kèm thông tin chi tiết, trạng thái `readiness` và tiến trình hiện tại (chỉ gọi 1 lần khi mở trang).
  - `POST /forge/v1/projects/preflight`: Kiểm tra đường dẫn `root` trước khi tạo/thêm và tự động đọc thông tin gợi ý từ `.git/config`, `package.json` nếu là project có sẵn:
    - *Trường hợp 1 (Đã có dữ liệu/mã nguồn):* Báo trạng thái tìm thấy project trên đường dẫn để hệ thống tiếp nhận, chuẩn hoá comment qua Coder Agent (bằng Tiếng Anh) và lập chỉ mục (index).
    - *Trường hợp 2 (Chưa tồn tại nhưng thư mục cha hợp lệ, hoặc thư mục trống):* Báo trạng thái sẽ khởi tạo project mới (không cần thu thập dữ liệu và index).
    - *Trường hợp 3 (Không hợp lệ):* Báo lỗi cụ thể ngay tại form.
  - `POST /forge/v1/projects`: Thêm project vào hệ thống với `(name, description, author, root)` cùng các trường cấu hình mở rộng; tự động khởi tạo mới hoặc chạy quy trình chuẩn hoá comment + lập chỉ mục theo trạng thái thư mục.
  - `PUT /forge/v1/projects/:projectId`: Cập nhật thông tin và cấu hình cài đặt của project.
  - `DELETE /forge/v1/projects/:projectId`: Gỡ project khỏi danh mục quản lý của NodeForge (dừng watcher, dừng embedding worker, đóng SQLite `index.db` & `control.db`, ngắt SSE) mà **không xóa bất kỳ file nào trên đĩa hay trong `.forge/`**.
- **Định danh `project_id` bằng Slug từ `name`:**
  - Chuyển đổi `name` sang slug chuẩn URL (`^[a-z0-9]+(?:-[a-z0-9]+)*$`), kiểm tra chống trùng lặp trong catalog và chống trùng với các route hệ thống (`system`, `coding`, `code`, `agents`, `forge`, `control-api`, `lifecycle`, `projects`).
- **Mở rộng Schema & Cài đặt Project (Owner đã duyệt mục 5):**
  - Bổ sung vào `schemas/project/project.schema.json` và giao diện Edit Project Settings các trường: `description`, `author`, `git_url`, `default_branch`, `language`, `package_manager`, `commands` (`test`, `lint`, `build`, `dev`), `comment_language` (mặc định `"en"`), `default_agents` (`architecture_manager`, `sprint_leader`, `coder`, `reviewer`), `watch` (`include`, `exclude`), `tags`, `homepage_url`, `docs_url`.
- **Quy trình Chuẩn hóa Comment Tiếng Anh & Lập chỉ mục theo Phương án B (Quyết định #1, #3, #4 của Owner):**
  - **Không bắt buộc chuẩn hóa lại code cũ về tiêu chuẩn hiện tại của Forge** đối với mã nguồn đã có sẵn (không ép tách file > 250 dòng hay sửa đổi logic thực thi của code cũ).
  - **Chuẩn hóa comment bằng Tiếng Anh (`en`):** Khi thêm project có sẵn, quét các file mã nguồn hợp lệ thiếu comment mô tả đầu file hoặc trước hàm/symbol và điều phối Agent Coder bổ sung/chuẩn hóa comment bằng **Tiếng Anh (`comment_language: "en"`)** với guardrail chỉ thêm comment, tuyệt đối không sửa đổi logic code.
  - **Phương án B (Khóa trạng thái cho đến khi hoàn tất 100%):** Khoá project ở trạng thái đang xử lý (`running`), đợi Coder chuẩn hoá comment Tiếng Anh và lập chỉ mục (`rebuildIndex` + embedding) xong 100% các file rồi mới mở khoá `ready`.
- **Giao diện `ProjectDirectory`, `ProjectCard` & `ArchitectureWorkspace`:**
  - Bỏ hoàn toàn vòng lặp polling 1.5s trên `ProjectDirectory`.
  - Mở khóa SSE `/forge/v1/stream?project=<projectId>` ngay khi project đang `running` để hiển thị thanh tiến trình trực tiếp trên `ProjectCard`; khi SSE báo `ready`, thẻ bật sáng để click vào làm việc ngay.
  - Toàn bộ vùng `ProjectCard` (khi `ready`) click được để mở `/<projectId>` (trừ vùng nút Sửa/Xoá ở góc thẻ); hiển thị rõ lỗi từ backend (không nuốt lỗi).
  - Sửa `ArchitectureWorkspace` và các trang con dưới `/[projectId]` nhận `projectId` động từ route thay vì hằng số tĩnh `PROJECT_ID`.

### Out of scope

- **Không chuẩn hóa/viết lại logic code hoặc ép quy chuẩn độ dài file (250 dòng) của Forge** đối với code đã có sẵn trong project.
- **Không xóa file mã nguồn hoặc thư mục `.forge/` trên đĩa** khi thực hiện `DELETE /forge/v1/projects/:projectId`.
- Multi-tenant ACL / phân quyền nhiều người dùng (thuộc phạm vi B tách riêng).

## 3. Hướng tiếp cận và guardrails

- **Ràng buộc bắt buộc (Owner đã khóa):**
  1. **Bảo toàn code hiện có (Quyết định #1):** Đối với code đã có sẵn trong project được thêm vào, không chuẩn hóa code về tiêu chuẩn hiện tại của Forge (không sửa đổi logic thực thi hay cấu trúc code).
  2. **Trường thông tin mở rộng (Quyết định #2 — Đồng ý mục 5):** Hỗ trợ đầy đủ bảng trường thông tin ở mục 5 trong `project.schema.json` và UI Edit Project Settings.
  3. **Chuẩn hóa comment bằng Tiếng Anh (Quyết định #3 — Mục 6):** Quét và điều phối Agent Coder bổ sung/chuẩn hóa comment đầu file và trước hàm/symbol bằng **Tiếng Anh (`en`)** trước khi trích xuất AST & Purpose Summary đưa vào `index.db`.
  4. **Chế độ mở khóa `ready` theo Phương án B (Quyết định #4):** Khóa project ở trạng thái đang xử lý (`running`), đợi Coder chuẩn hóa comment và index xong 100% các file rồi mới chuyển sang `ready`.
  5. **An toàn dữ liệu khi Xóa:** `DELETE /forge/v1/projects/:projectId` chỉ giải phóng tài nguyên runtime (watcher, worker, SQLite connections, SSE connections) và xóa bản ghi trong global catalog; giữ nguyên 100% dữ liệu trên đĩa và trong `.forge/`.
  6. **Không nuốt lỗi & Không polling:** Giữ nguyên mã lỗi (`code`) và thông báo chi tiết (`message`) từ backend; cập nhật tiến trình hoàn toàn qua SSE Project Stream, bỏ hẳn `setTimeout` polling 1.5s.
- **Hướng đề xuất (có evidence):**
  - Mở rộng `project_id` pattern trong `schemas/project/project.schema.json`, `schemas/project/project-operation.schema.json`, `schemas/project/project-lifecycle-transport.schema.json` và `backend/src/modules/projects/project-catalog.js` để chấp nhận cả slug URL (`^[a-z0-9]+(?:-[a-z0-9]+)*$`) lẫn định dạng `PROJECT-...` cũ nhằm đảm bảo backward-compatibility.
  - Trong `backend/scripts/control-api-project-applications.mjs` và `backend/src/transport/http/forge-v1-router.js`, tách điều kiện kiểm tra kết nối `/forge/v1/stream?project=<projectId>` khỏi điều kiện chặn `running` của các API nghiệp vụ khác: cho phép `resolveStreams` kết nối vào `runtime.connect` ngay khi project đang ở trạng thái `running` (chuẩn hóa comment / index).
  - Mở rộng các giai đoạn tiến trình (`preflight` -> `comment_normalization` -> `scan/index` -> `resolve` -> `embedding` -> `ready`) và phát sự kiện thời gian thực qua `project-stream.js`.
- **Dependency thật sự:**
  - Cập nhật contract schema & định danh slug (`project_id`) trong `project-registry.js` / `project-catalog.js` phải hoàn tất trước khi nối route CRUD `/forge/v1/projects` và UI `ProjectDirectory`.
  - Mở khóa SSE stream cho trạng thái `running` phải sẵn sàng trước khi gỡ bỏ polling 1.5s ở `ProjectDirectory`.
- **Quyết định chưa chốt:** Không còn câu hỏi mở cấp Owner (cả 4 điểm xác nhận đều đã được Owner chốt rõ ràng).

## 4. Khu vực dự kiến ảnh hưởng và evidence

| Thành phần / khu vực | Vai trò | Evidence / mức chắc chắn |
| --- | --- | --- |
| `schemas/project/project.schema.json` | Schema cấu hình `.forge/runtime/project.json`; cần bổ sung `description`, `author`, `git_url`, `commands`, `comment_language`, `default_agents`, `tags`, `homepage_url`, `docs_url` | `sha256:17a4006ef18e0987db26eea5a9e712ad747044a3318cb2846ecd99390f94ee0d` |
| `schemas/project/project-lifecycle-transport.schema.json` | Schema transport danh mục dự án; hiện đang khóa cứng `"pattern": "^PROJECT-"` ở dòng 119 | `sha256:19faed1f91909211f8345286ebb6a7768d977372d8b94062fa32d932930643d2` |
| `schemas/project/project-operation.schema.json` | Schema tiến trình khởi tạo/index project (`progress`, `stages`, `counters`, `embedding`) | `sha256:8e23abe24e25a20d310fce7a6ec54c55a659cc892e7c0b6396c8a17b1475920f` |
| `backend/src/modules/projects/project-registry.js` | Sinh/đọc `.forge/runtime/project.json`; cần tạo `project_id` dạng slug từ `name` và lưu/cập nhật metadata đầy đủ | `sha256:b6d8f3651357e602765cde518c18825ffa3978b0d08e01fc0a61893560bf24a7` |
| `backend/src/modules/projects/project-catalog.js` | Lưu trữ danh mục global; hiện đang kiểm tra regex `!/^PROJECT-[A-Za-z0-9-]+$/` ở dòng 20 | `sha256:eef0cfc6c996754cfbc2670a28c91550c1f8d29b8c8cebbd2b897332ed13df92` |
| `backend/src/modules/projects/project-lifecycle.js` | Điều phối `create`, `add`, `remove`, `list`, `directory`, preflight đường dẫn và quản lý map `runtimes` | `sha256:d1427c08d3048bd9555d58231b1367a4196c6085792618400ea6ac80bad14177` |
| `backend/src/modules/projects/project-runtime.js` | Khởi tạo `controlDb`, `indexDb`, watcher, embedding worker và `projectStream` cho từng project; đóng sạch kết nối khi `remove` | `sha256:3faa6f898f5645ee8dfb597ea7740c710135c66021b4e168b09a6e381be207cd` |
| `backend/src/tools/agent-code-conventions.js` | Kiểm tra `hasFileHeaderComment`, `hasPrecedingComment`, `validateCommentLanguage` phục vụ quét file thiếu comment | `sha256:5889bc6852f4826e6983f80a1a487187fd6e631f110bbe2fb6a246e3494b0b4e` |
| `backend/src/modules/supervisor/nodeforge-task-executors.js` | Điều phối Agent Coder thực thi chuẩn hóa comment với guardrail chỉ sửa comment | `sha256:b2d7c5e1c95ed8089c136c49511e86f869c51f48ec11ac49285d18b72ab4b96a` |
| `backend/src/modules/index/index-progress.js` | Bộ thu thập tiến trình (`preflight`, `comment_normalization`, `scan/index`, `resolve`, `startup/readiness`) | `sha256:2d03d5614ba24979fae478fce8ae5df81731730790119bc6cd50b5f094f155dd` |
| `backend/src/modules/index/index-rebuild.js` | Quét file dự án, trích xuất AST + Purpose Summary và xếp hàng tạo vector embedding | `sha256:3e2759e8160c90b054697300def11cf7f22b8ec9fabc474146181fcc8fa4b0eb` |
| `backend/scripts/control-api-project-applications.mjs` | Quản lý application bundle per-project; dòng 53, 69, 80 đang chặn `["failed", "running"].includes(runtime.status?.().progress?.status)` khiến stream bị 404 lúc đang index | `sha256:223d0a001e87a61180513aa0ca768e7eb43b0dd571490c9d62fafed83a705114` |
| `backend/src/transport/http/forge-v1-router.js` | Router chính `/forge/v1/*`; cần định tuyến CRUD `/forge/v1/projects` và cho phép `resolveStreams` kết nối SSE khi project đang `running` | `sha256:3a186c0eca22c0f2d7e017b495910cfc4bed9f9731f5a6b8e7dceaec581232de` |
| `backend/src/transport/sse/project-stream.js` | Phát SSE theo `projectId`; cần bổ sung event tiến trình chuẩn hóa comment + index vào `PROJECT_EVENT_TYPES` | `sha256:8bade8c3d13455be942ac88c357997438dc695d526113cbf88bcabf78bc89312` |
| `ui/nextjs/components/project-directory.jsx` | Trang chủ danh sách project và Modal thêm/sửa project; dòng 54 đang chạy `setTimeout(observe, 1500)` cần thay bằng SSE | `sha256:4ba20de9806e08d6b771bdc161c2190d5379ecb7e4034e8e2beed982e9fc976a` |
| `ui/nextjs/components/project-card.jsx` | Thẻ hiển thị project; cần hỗ trợ click toàn vùng khi `ready`, hiển thị tiến trình SSE khi `running`, và nút Sửa/Xóa | `sha256:42f871460c0d685d45aa6d364297032b2b067a29a341e1192d4eeb246ef8f75f` |
| `ui/nextjs/components/architecture-workspace.jsx` | Workspace hội thoại kiến trúc; dòng 48, 86, 97, 110, 134, 174... đang dùng hằng số `PROJECT_ID` tĩnh cần chuyển sang prop/state `projectId` động từ route | `sha256:e4b6e908af2feaee60004baef03dad0e4eac70f8ec04e20ca34733d8d089b3ae` |
| `ui/nextjs/app/[projectId]/page.jsx` | Route page `/[projectId]`; cần truyền `projectId` từ route params/selection xuống `ArchitectureWorkspace` | `sha256:6db7c4cfb43834e089c3dcfbbe5916695c49e2e2dce6ac489485db3638569a69` |
| `ui/nextjs/lib/project-navigation.js` | Xử lý đường dẫn `/<projectId>`, `/<projectId>/system`, `/<projectId>/coding` và danh sách `globalRoutes` | `sha256:1d2670c3b4e17b05f338d7eca1bd83308fc9d37d974122e9a822db3228852d30` |

Các khu vực/candidate files định hướng discovery, không phải mutable-file allowlist cố định. SL xác minh đường thực tế trước khi chốt manifest.

## 5. Outcomes và điều kiện nghiệm thu

| Mã | Outcome bắt buộc | Acceptance criteria quan sát được | Dependency / guardrail |
| --- | --- | --- | --- |
| O1 | Định danh Slug URL & Mở rộng Schema cấu hình Project | 1. Tạo project với `name` (vd `"Dự Án Bán Hàng"`) sinh `project_id` dạng slug chuẩn URL (`du-an-ban-hang`), chống trùng lặp trong catalog và chống trùng với các route hệ thống (`system`, `coding`, `code`, `agents`, `forge`, `control-api`, `lifecycle`, `projects`).<br>2. `project.schema.json` và `.forge/runtime/project.json` lưu và kiểm tra hợp lệ các trường ở mục 5: `name`, `description`, `author`, `root`, `git_url`, `default_branch`, `language`, `package_manager`, `commands` (`test`, `lint`, `build`, `dev`), `comment_language` (mặc định `"en"`), `default_agents`, `watch` (`include`, `exclude`), `tags`, `homepage_url`, `docs_url`.<br>3. Các project hiện có dùng `PROJECT-...` vẫn đọc và hoạt động bình thường (backward-compatible). | Không làm hỏng dữ liệu `.forge/runtime/project.json` đã tồn tại. |
| O2 | Hợp nhất API `/forge/v1/projects` (Preflight, Add/Init tự động, Edit, Delete an toàn) | 1. `POST /forge/v1/projects/preflight` trả về chính xác 3 trạng thái đường dẫn: (a) Đã có mã nguồn/dữ liệu kèm gợi ý tự động từ `.git/config` & `package.json`, (b) Chưa tồn tại (nhưng thư mục cha hợp lệ) hoặc thư mục trống, (c) Không hợp lệ kèm mã lỗi và thông báo cụ thể.<br>2. `POST /forge/v1/projects` tự động khởi tạo thư mục mới hoặc tiếp nhận thư mục có sẵn mà không cần tham số `Create`/`Add` thủ công.<br>3. `PUT /forge/v1/projects/:projectId` cập nhật thành công metadata và cấu hình cài đặt trong `.forge/runtime/project.json`.<br>4. `DELETE /forge/v1/projects/:projectId` dừng watcher, dừng embedding worker, đóng `index.db` & `control.db`, ngắt SSE và xóa khỏi global catalog nhưng **giữ nguyên 100% file trong thư mục gốc và `.forge/` trên đĩa**. | Phụ thuộc O1. Tuân thủ Quyết định #1, #2 của Owner. |
| O3 | Chuẩn hóa Comment Tiếng Anh qua Coder Agent, Lập chỉ mục & Mở SSE theo Phương án B | 1. Với project có sẵn mã nguồn, hệ thống quét các file hợp lệ thiếu comment đầu file hoặc trước hàm/symbol và điều phối Agent Coder bổ sung comment bằng **Tiếng Anh (`en`)**; tuyệt đối **không chuẩn hóa hay sửa đổi logic thực thi/cấu trúc của code đã có**.<br>2. Kết nối `GET /forge/v1/stream?project=<projectId>` được chấp nhận ngay khi project đang ở trạng thái `running`, phát tiến trình thời gian thực qua `project-stream.js` (`preflight` -> `comment_normalization` -> `scan/index` -> `resolve` -> `embedding` -> `ready`).<br>3. Theo **Phương án B**, khóa project ở trạng thái đang xử lý (`running`), đợi Coder chuẩn hóa comment Tiếng Anh và lập chỉ mục xong 100% các file rồi mới mở khóa `ready`. | Phụ thuộc O1, O2. Tuân thủ Quyết định #1, #3, #4 (Phương án B) của Owner. |
| O4 | Giao diện `ProjectDirectory`, `ProjectCard` (SSE, Không Polling, Click toàn vùng, Sửa/Xóa) & `ArchitectureWorkspace` động | 1. Trang chủ chỉ gọi `GET /forge/v1/projects` 1 lần khi mở trang; xóa bỏ hoàn toàn vòng lặp `setTimeout(..., 1500)` polling.<br>2. Modal thêm project kiểm tra đường dẫn qua preflight, hiển thị rõ trạng thái đường dẫn, thu thập `(name, description, author, root)` và đóng ngay sau khi submit thành công để hiển thị thanh tiến trình SSE trực tiếp trên `ProjectCard`.<br>3. Khi `ready`, toàn bộ vùng `ProjectCard` click được để điều hướng tới `/<projectId>` (trừ vùng nút Sửa/Xóa ở góc thẻ); Modal Edit cho phép sửa các trường ở mục 5; nút Xóa gỡ project khỏi danh sách.<br>4. `ArchitectureWorkspace` và các màn hình con sử dụng `projectId` động từ route `/<projectId>` thay vì hằng số tĩnh `PROJECT_ID`. Không nuốt lỗi backend ở cả Modal lẫn Card. | Phụ thuộc O2, O3. |

**Gợi ý delivery (không bắt buộc):** O1 (Schema & Slug Identity) -> O2 (Unified `/forge/v1/projects` CRUD + Preflight + Safe Delete) & O3 (English Comment Normalization + SSE Stream khi `running` + Phương án B) -> O4 (UI `ProjectDirectory`, `ProjectCard`, Edit Modal & Dynamic `projectId` trong `ArchitectureWorkspace`). SL chủ động phân rã ticket và lập manifest dựa trên khảo sát thực tế.

## 6. Rủi ro, giả định và câu hỏi mở

| Rủi ro / câu hỏi | Tác động | Evidence / giả định | Người chốt / cách xử lý |
| --- | --- | --- | --- |
| Tương thích ngược với project đang dùng `PROJECT-<uuid>` hoặc `PROJECT-NODEFORGE` | Major | `project-catalog.js` và `project-lifecycle-transport.schema.json` hiện kiểm tra regex `^PROJECT-` (`sha256:eef0cfc6…`, `sha256:19faed1f…`). | **Architecture / SL:** Cho phép regex nhận cả slug thường (`^[a-z0-9]+(?:-[a-z0-9]+)*$`) và `^PROJECT-[A-Za-z0-9_-]+$` để không làm gãy project hiện hữu và bộ test cũ. |
| Xung đột route giữa `project_id` dạng slug và các trang tĩnh của Next.js | Major | Next.js có các route tĩnh `/system`, `/coding`, `/code`, `/agents`, `/control-api` (`ui/nextjs/lib/project-navigation.js`, `sha256:1d2670c3…`). | **Architecture / SL:** Chặn danh sách từ khóa hệ thống (`system`, `coding`, `code`, `agents`, `forge`, `control-api`, `lifecycle`, `projects`, `api`, `_next`) khi tạo slug hoặc tự động gắn hậu tố nếu trùng. |
| Mở SSE khi project đang `running` nhưng vẫn phải khóa workspace theo Phương án B | Major | `control-api-project-applications.mjs` (`sha256:223d0a00…`) hiện chặn mọi lệnh `resolve(projectId)` khi `status` là `running`. | **Architecture / SL:** Cho phép tầng `resolveStreams` kết nối trực tiếp vào `runtime.connect` của `projectLifecycle` để nhận SSE tiến trình chuẩn hóa comment & index, trong khi các route workspace khác vẫn đợi `readiness === "ready"` theo Phương án B. |
| Bảo toàn code thực thi khi Coder Agent thêm comment Tiếng Anh | Major | Owner đã chốt: Không chuẩn hóa code đã có về tiêu chuẩn Forge, chỉ chuẩn hóa comment bằng Tiếng Anh (`en`). | **Owner đã chốt** (Quyết định #1 & #3): Kiểm tra tự động AST/code-diff trước và sau khi Coder chỉnh sửa để đảm bảo chỉ có dòng comment được thêm vào, không thay đổi bất kỳ câu lệnh thực thi nào. |

## 7. Acceptance criteria của plan

- [x] Mục tiêu, in/out scope và outcomes nhất quán với toàn bộ 4 quyết định của Owner.
- [x] Facts repository-specific có evidence và SHA-256 đầy đủ; không còn câu hỏi mở chặn kế hoạch.
- [x] Guardrails và dependency bắt buộc tách khỏi gợi ý delivery.
- [x] Outcomes (`O1`–`O4`) có tiêu chí kiểm tra được và đủ để SL lập SP chủ động.
- [x] Không áp đặt số ticket, tên ticket hoặc mutable-file manifest khi chưa cần human quyết định.
- [ ] SL phải chứng minh coverage và tuân thủ policy ticket hiện hành trước dispatch.
- [ ] Approval đúng identity/revision/SHA-256; lập SP không tự RUN/dispatch.
