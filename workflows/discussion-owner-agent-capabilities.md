<!-- Tóm tắt yêu cầu mở rộng quyền và hoàn thiện bộ công cụ Forge cho Architecture Manager, System Engineer và các agent trong hệ thống (đã hợp nhất phản hồi kỹ thuật từ workflows/discussion-owner-agent-capabilities-feedback.md). -->
# Đề xuất mở rộng quyền và tối ưu bộ công cụ Forge cho Architecture Manager, System Engineer và các Agent

## 1. Mục tiêu (Goals)

- Chuẩn hóa toàn bộ hệ thống về **5 công cụ khám phá trực tiếp** (`search_tree`, `list_files`, `search_text`, `read_file`, `read_lines`), loại bỏ hoàn toàn sự phụ thuộc vào `search_code` / `select_code_graph_candidates` (bao gồm cả trong `sprint-leader-forge-tools.js`).
- Tháo gỡ các điểm nghẽn thực tế khi `architecture_manager` (AM), `system_engineer` (SE), `sprint_leader` (SL), `coder` và `reviewer` khám phá codebase, kiểm tra trạng thái Git, đọc file source code và tra cứu tài liệu bên ngoài.
- Giữ nguyên ranh giới bảo mật (security boundaries): chặn truy cập đường dẫn nhạy cảm, symlink, `..`, và giữ nguyên phạm vi các thư mục được phép ghi của từng role.

---

## 2. Phạm vi và các quyết định kỹ thuật (Scope & Decisions)

### 2.1. Mở rộng quyền và sửa lỗi đọc cho Architecture Manager (AM) & Reviewer

1. **Cấp quyền Read-Only `git_status` và `git_diff` cho `architecture_manager` (kể cả khi chạy `/plan`):**
   - **Hiện trạng (Evidence):**
     - `backend/src/tools/owner-role-tool-policy.js` (dòng 6–7): `architecture_manager` chỉ có `READ_TOOLS`, `write_diff`, `edit_diff`, `delete_file`; chưa có `git_status`, `git_diff`.
     - `backend/src/tools/owner-conversation-tools.js` (dòng 16 & 32):
       - Dòng 16: `const allowed = ownerRoleTools(role).filter((name) => !context?.planning_input_only || ["search_tree", "list_files", "search_text", "read_file", "read_lines"].includes(name));`
       - Dòng 32: Chỉ gắn `createGitReadTools` khi `["system_engineer", "reviewer"].includes(role)`.
   - **Quyết định:**
     - Thêm `git_status` và `git_diff` vào `ROLE_TOOLS.architecture_manager` trong `backend/src/tools/owner-role-tool-policy.js`.
     - Trong `backend/src/tools/owner-conversation-tools.js`, bật `createGitReadTools` cho `["architecture_manager", "system_engineer", "reviewer"]` (dòng 32) và cập nhật danh sách lọc `planning_input_only` (dòng 16) thành `["search_tree", "list_files", "search_text", "read_file", "read_lines", "git_status", "git_diff"]` để AM kiểm tra được working tree ngay trong bước discovery của `/plan`.

2. **Đồng bộ kiểm tra quyền đọc và theo dõi ngân sách khám phá trong `sed-lines.js` (`read_lines`) với `read_file`:**
   - **Hiện trạng (Evidence):**
     - `backend/src/tools/sed-lines.js` (dòng 31 & 106–112): `approvedPath(path, context)` chỉ trả về `true` khi `context.project_wide_access === true && role === "system_engineer"` hoặc khi `context.allowed_file_paths` / `context.allowed_prefixes` có chứa `path`. Trong khi đó, `isAgentPathAllowed` (`backend/src/tools/tool-authorization.js`, dòng 35) cho phép đọc khi `context` không định nghĩa `allowed_file_paths` / `allowed_prefixes` (như trong hội thoại của `architecture_manager` và `reviewer`, nơi quyền đọc đã được `scopedFiles.assertReadPath(path)` kiểm soát). Hệ quả là AM gọi `read_lines` luôn bị lỗi `SED_LINES_INPUT_INVALID`.
     - Ngoài ra, `sed-lines.js` chưa gọi `recordRead(context, ...)` và chưa đính kèm `discovery_budget: discoveryNotice(context)` vào kết quả trả về như `read_file` (`backend/src/tools/agent-lifecycle-tools.js`).
   - **Quyết định:**
     - Trong `backend/src/tools/sed-lines.js`: nếu `typeof fileService?.assertReadPath === "function"`, gọi `await fileService.assertReadPath(normalized.path)` để áp dụng đúng role policy và chống symlink/path nhạy cảm.
     - Cập nhật `approvedPath(path, context)` trong `sed-lines.js`: khi `context` không truyền mảng `allowed_file_paths` và `allowed_prefixes`, cho phép đi tiếp sau khi đã qua `isAgentPathAllowed` và `fileService.assertReadPath` / `assertRoleFileAccess(role, "read", path)`.
     - Bổ sung `recordRead(context, { path: normalized.path, window: `${normalized.start_line}-${normalized.end_line}` })` và `discovery_budget: discoveryNotice(context)` vào kết quả trả về của `sed-lines.js`.

### 2.2. Mở rộng quyền cho System Engineer (SE)

3. **Bật `WebSearch` cho System Engineer ngay cả khi chạy ở chế độ `forge` (mặc định):**
   - **Hiện trạng (Evidence):**
     - `backend/src/application/owner-sdk-stream.js` (dòng 82–84):
       `const allowBuiltinWebSearch = roleAllowsBuiltinWebSearch && sdkSearchAvailable && (!systemEngineer || builtin);`
     - Biểu thức `(!systemEngineer || builtin)` vô tình tắt `WebSearch` khi SE chạy ở chế độ `forge` (`builtin === false`).
   - **Quyết định:**
     - Sửa điều kiện tại `backend/src/application/owner-sdk-stream.js` (dòng 84) thành `const allowBuiltinWebSearch = roleAllowsBuiltinWebSearch && sdkSearchAvailable;` để cả `architecture_manager` và `system_engineer` (ở cả mode `forge` và `builtin`) đều dùng được `WebSearch` khi SDK hỗ trợ.
     - Cập nhật unit test trong `backend/tests/unit/system-engineer-sdk-tools.test.js`.

### 2.3. Nâng cấp công cụ dùng chung cho toàn bộ các Role (AM, SE, SL, Coder, Reviewer)

4. **Mở rộng `paths` của `search_text` (`rg_search`) cho phép truyền đường dẫn thư mục con nhiều cấp và file đơn lẻ:**
   - **Hiện trạng (Evidence):**
     - `schemas/agent/tools/rg-search.schema.json` (dòng 10) và `backend/src/tools/rg-search.js` (dòng 101, `buildArgs`) khóa `paths` bằng regex `^[A-Za-z0-9_-]+$` (chỉ cho phép thư mục cấp 1).
     - `backend/src/tools/rg-search.js` (dòng 126, `validatePaths`): kiểm tra `!stat.isDirectory()` khiến truyền đường dẫn tới một file cụ thể bị ném lỗi `"rg_search path must be a real project directory."`.
     - `backend/src/tools/rg-search.js` (dòng 130, `validatePaths`): kiểm tra `!listed.stdout.split("\n").some((file) => file.startsWith(`${path}/`))` khiến khi `path` là một file đơn lẻ (`rg --files -- <path>` in ra đúng `path` không có `/`), điều kiện luôn trả về `false`.
   - **Quyết định:**
     - Cập nhật regex ở `schemas/agent/tools/rg-search.schema.json` (dòng 10), `backend/src/tools/rg-search.js` (dòng 101) và đồng bộ/gỡ override thừa ở `backend/src/tools/owner-conversation-tools.js` (dòng 35) để chấp nhận đường dẫn tương đối nhiều cấp an toàn (các segment cách nhau bởi `/`, không chứa `.`, `..`, segment ẩn bắt đầu bằng `.` trừ `.forge` của SE).
     - Trong `validatePaths` (`backend/src/tools/rg-search.js`, dòng 126): đổi `!stat.isDirectory()` thành `(!stat.isDirectory() && !stat.isFile())`.
     - Trong `validatePaths` (`backend/src/tools/rg-search.js`, dòng 130): đổi điều kiện kiểm tra thành `!listed.stdout.split("\n").some((file) => file === path || file.startsWith(`${path}/`))`.

5. **Mở rộng `list_files` (`rg_files`) hỗ trợ glob dương (`--glob=PATTERN`, `--iglob=PATTERN`):**
   - **Hiện trạng (Evidence):**
     - `backend/src/tools/rg-files.js` (dòng 80–85, `isAllowedFlag`) và `schemas/agent/tools/rg-files.schema.json` (dòng 10) hiện chỉ cho phép glob phủ định (`/^--(?:i?glob)=![^!].*$/s`), khiến agent không thể dùng `list_files` để lọc nhanh file theo thư mục con hoặc hậu tố (như `--glob=backend/src/**` hay `--glob=*.test.js`).
   - **Quyết định:**
     - Cho phép cả glob dương lẫn glob phủ định an toàn trong `backend/src/tools/rg-files.js` (`isAllowedFlag`) và cập nhật mô tả trong `schemas/agent/tools/rg-files.schema.json` (kèm kiểm tra pattern không chứa `..` hoặc ký tự NUL `\0`).

6. **Đồng bộ nâng giới hạn cửa sổ đọc code một lần từ `80` dòng lên `250` dòng trên toàn hệ thống:**
   - **Hiện trạng (Evidence):**
     - Quy chuẩn `CLAUDE.md` quy định mỗi file code tối đa `250` dòng, nhưng cửa sổ đọc code đang bị khóa ở `80` dòng tại 6 vị trí:
       1. `backend/src/tools/agent-lifecycle-tools.js` (dòng 15 & 67): `READ_WINDOW_LINE_LIMIT = 80`.
       2. `backend/src/tools/sed-lines.js` (dòng 14): `MAX_LINES = 80`.
       3. `backend/src/modules/supervisor/committed-review-window.js` (dòng 11): `input.end_line - input.start_line + 1 > 80`.
       4. `backend/src/modules/supervisor/reviewer-forge-tools.js` (dòng 28 & 184): `MAX_WINDOW_LINES = 80` và thông báo lỗi `"Reviewer read_file window must contain at most 80 lines."`.
       5. `schemas/agent/tools/read-file.schema.json` (dòng 30): `"max lines to return: 250 for Markdown, 80 for source files"`.
       6. `backend/src/tools/index.js` và `backend/src/application/owner-sdk-stream.js` (dòng 98): các chuỗi mô tả/prompt `(at most 80 lines)`.
   - **Quyết định:**
     - Nâng đồng bộ tất cả các vị trí trên từ `80` lên `250` dòng để mọi agent (AM, SE, SL, Coder, Reviewer) đều đọc trọn vẹn 1 file chuẩn (`<= 250 dòng`) trong 1 lần gọi.

7. **Gỡ bỏ `search_code` khỏi Sprint Leader (SL) và thu thập `discoveredPaths` từ `search_text`:**
   - **Hiện trạng (Evidence):**
     - `backend/src/tools/sprint-leader-forge-tools.js` (dòng 5–6, 14, 23–34, 41–46): SL vẫn đăng ký `search_code` và chưa có logic trích xuất đường dẫn file từ `result.stdout` của `search_text` vào tập `discoveredPaths`.
   - **Quyết định:**
     - Gỡ bỏ `search_code` khỏi `backend/src/tools/sprint-leader-forge-tools.js` (và các prompt/test liên quan của SL), chỉ giữ lại đúng 5 công cụ khám phá trực tiếp (`search_tree`, `list_files`, `search_text`, `read_file`, `read_lines`).
     - Bổ sung trích xuất đường dẫn file từ `result.stdout` của `search_text` (định dạng `path:line:content` hoặc `path:content`) vào `discoveredPaths` trong `sprint-leader-forge-tools.js`.

---

## 3. Danh sách file dự kiến tác động

**Bổ sung rà soát 2026-10-22:** xem mục 3–4 trong `workflows/discussion-owner-agent-capabilities-feedback.md` để lấy bảng chỉ dẫn Node cho AM, SL, Coder, Reviewer, các điểm cần đồng bộ prompt/validator `250` dòng và tiêu chí nghiệm thu. Bảng này bổ sung phạm vi file dưới đây; đây vẫn là đề xuất triển khai, không phải báo cáo runtime đã sửa.

1. `backend/src/tools/owner-role-tool-policy.js`
2. `backend/src/tools/owner-conversation-tools.js`
3. `backend/src/tools/sed-lines.js`
4. `backend/src/application/owner-sdk-stream.js`
5. `schemas/agent/tools/rg-search.schema.json` & `backend/src/tools/rg-search.js`
6. `schemas/agent/tools/rg-files.schema.json` & `backend/src/tools/rg-files.js`
7. `schemas/agent/tools/read-file.schema.json`, `backend/src/tools/agent-lifecycle-tools.js` & `backend/src/tools/index.js`
8. `backend/src/modules/supervisor/committed-review-window.js` & `backend/src/modules/supervisor/reviewer-forge-tools.js`
9. `backend/src/tools/sprint-leader-forge-tools.js`
10. Các bộ unit test tương ứng (`owner-sdk-tools.test.js`, `system-engineer-sdk-tools.test.js`, `rg-search.test.js`, `rg-files.test.js`, `sed-lines.test.js`, `sprint-leader-forge-tools.test.js`, `agent-lifecycle-tools-v2.test.js`, `reviewer-forge-tools.test.js`, `agent-line-budget-integration.test.js`).

---

## 4. Out of Scope, Giả định, Rủi ro và Câu hỏi mở

- **Out of Scope:** Không thay đổi quyền ghi/xóa file của `architecture_manager` (`ARCHITECTURE.md`, `docs/`, `Skills/`, `workflows/`); không cấp quyền chạy lệnh shell/test hay ghi Git cho AM.
- **Giả định (Assumptions):** Mọi đường dẫn truyền vào `search_text`, `list_files`, `read_file`, `read_lines` vẫn đi qua `isAgentPathAllowed` và `assertRoleFileAccess` để chặn `.git`, `node_modules` (trừ phạm vi dependency read cho phép), symlink và các file nhạy cảm.
- **Rủi ro & Giảm thiểu:** Tăng cửa sổ đọc lên 250 dòng vẫn nằm trong trần bảo vệ byte hiện có (`MAX_CONTENT = 200000` trong `agent-lifecycle-tools.js`, `MAX_OUTPUT_BYTES = 200000` trong `sed-lines.js`, và giới hạn byte của Reviewer/Sprint Leader).
- **Câu hỏi mở (Open Questions):** Không còn câu hỏi mở hay điểm nghẽn nào. Tài liệu đã sẵn sàng để lập kế hoạch triển khai.
