<!-- Nhận xét kỹ thuật và đề xuất bổ sung cho tài liệu workflows/discussion-owner-agent-capabilities.md -->
# Nhận Xét Kỹ Thuật & Đề Xuất Bổ Sung: `discussion-owner-agent-capabilities.md`

- **Tài liệu được rà soát:** `workflows/discussion-owner-agent-capabilities.md`
- **Ngày đánh giá:** 2026-10-21
- **Rà soát bổ sung chỉ dẫn 4 agent:** 2026-10-22 (đối chiếu working tree hiện tại; chưa phải xác nhận đã triển khai)
- **Người đánh giá:** System Engineer

---

## 1. Đánh giá tổng quan

Tài liệu `workflows/discussion-owner-agent-capabilities.md` đã xác định rất trúng các điểm nghẽn thực tế khi vận hành `architecture_manager` (AM), `system_engineer` (SE), `sprint_leader` (SL), `coder` và `reviewer`:
- Chuẩn hóa toàn bộ hệ thống về **5 công cụ khám phá trực tiếp** (`search_tree`, `list_files`, `search_text`, `read_file`, `read_lines`), loại bỏ hoàn toàn sự phụ thuộc vào `search_code` trong `sprint-leader-forge-tools.js`.
- Tháo gỡ lỗi chặn `read_lines` (`sed_lines`) đối với AM và Reviewer, cấp `git_status` / `git_diff` read-only cho AM, và khôi phục `WebSearch` cho SE ở chế độ `forge`.
- Mở rộng `paths` của `search_text` (`rg_search`) cho thư mục con nhiều cấp / file cụ thể và nâng cửa sổ đọc một lần từ `80` lên `250` dòng (khớp với quy tắc `<= 250 lines` của `CLAUDE.md`).

Qua đối chiếu trực tiếp với mã nguồn thực thi, dưới đây là **7 điểm kỹ thuật và bổ sung quan trọng** cần đưa vào kế hoạch triển khai để tránh bỏ sót edge case.

---

## 2. Chi tiết các điểm cần bổ sung và lưu ý kỹ thuật

### 2.1. [Mục 1] Cấp `git_status` và `git_diff` cho AM cả khi chạy `/plan` (`planning_input_only`)
- **Hiện trạng (`backend/src/tools/owner-conversation-tools.js`, dòng 16 & 32):**
  ```js
  const allowed = ownerRoleTools(role).filter((name) => !context?.planning_input_only || ["search_tree", "list_files", "search_text", "read_file", "read_lines"].includes(name));
  ...
  if (["system_engineer", "reviewer"].includes(role) && gitService?.status && gitService?.diffWorkingTree) Object.assign(implementations, createGitReadTools({ gitService, logger: { emit: () => {} } }));
  ```
- **Vấn đề:** Nếu chỉ thêm `git_status`, `git_diff` vào `ROLE_TOOLS.architecture_manager` (`owner-role-tool-policy.js`) và dòng 32 của `owner-conversation-tools.js`, thì khi chạy `/plan <file>` (`context.planning_input_only === true`), bộ lọc ở dòng 16 vẫn sẽ loại bỏ `git_status` và `git_diff`.
- **Đề xuất:** Cập nhật cả danh sách lọc ở dòng 16 của `owner-conversation-tools.js` thành:
  `["search_tree", "list_files", "search_text", "read_file", "read_lines", "git_status", "git_diff"]`
  để AM có thể kiểm tra working tree ngay trong bước discovery của `/plan`.

---

### 2.2. [Mục 2] Đồng bộ kiểm tra quyền đọc trong `sed-lines.js` (`read_lines`) với `read_file`
- **Hiện trạng (`backend/src/tools/sed-lines.js`, dòng 31 & 106–112):**
  - Dòng 31: `if (!isAgentPathAllowed(normalized.path, context) || (fileService && !approvedPath(normalized.path, context)))`
  - Hàm `approvedPath(path, context)` chỉ trả `true` khi `context.project_wide_access === true && role === "system_engineer"` hoặc khi `context.allowed_file_paths` / `context.allowed_prefixes` có chứa `path`.
  - Trong khi đó, `isAgentPathAllowed` (`backend/src/tools/tool-authorization.js`, dòng 35) cho phép đọc khi `context` không định nghĩa `allowed_file_paths` / `allowed_prefixes` (`if (!Array.isArray(files) && !Array.isArray(prefixes)) return true;`), vì quyền đọc theo role đã được `scopedFiles.assertReadPath(path)` (`file-service-role-policy.js`) kiểm soát chặt chẽ.
- **Đề xuất:**
  1. Trong `sed-lines.js`: nếu `typeof fileService?.assertReadPath === "function"`, gọi `await fileService.assertReadPath(normalized.path)` để áp dụng đúng role policy và chống symlink/path nhạy cảm.
  2. Trong `approvedPath(path, context)` (`sed-lines.js`, dòng 106–112): nếu `context` không truyền mảng `allowed_file_paths` và `allowed_prefixes` (như trong owner conversation của `architecture_manager` hoặc `reviewer`), cho phép đi tiếp sau khi đã qua `isAgentPathAllowed` và `fileService.assertReadPath` / `assertRoleFileAccess(role, "read", path)`.

---

### 2.3. [Mục 4] Ba điểm cần sửa đồng bộ trong `rg-search.js` khi mở `paths` cho thư mục con và file đơn lẻ
- **Hiện trạng (`backend/src/tools/rg-search.js`):**
  1. **Dòng 101 (`buildArgs`):** Regex `!/^[A-Za-z0-9_-]+$/.test(path)` chỉ cho phép thư mục cấp 1.
  2. **Dòng 126 (`validatePaths`):**
     ```js
     if (!stat.isDirectory() || stat.isSymbolicLink() || ...) throw invalidInput("rg_search path must be a real project directory.");
     ```
     Nếu truyền đường dẫn tới một **file cụ thể** (ví dụ `paths: ["backend/src/tools/rg-search.js"]`), `stat.isDirectory()` sẽ trả về `false` và ném lỗi!
  3. **Dòng 130 (`validatePaths`):**
     ```js
     if (!listed.stdout.split("\n").some((file) => file.startsWith(`${path}/`))) throw invalidInput("rg_search path is ignored or has no searchable files.");
     ```
     Khi `path` là một file đơn lẻ, lệnh `rg --files -- <path>` sẽ in ra chính xác `path` (không có dấu `/` ở cuối), khiến `file.startsWith(\`${path}/\`)` luôn trả về `false`!
- **Đề xuất:**
  - Cập nhật regex ở `schemas/agent/tools/rg-search.schema.json` (dòng 10), `backend/src/tools/rg-search.js` (dòng 101) và gỡ override thừa ở `backend/src/tools/owner-conversation-tools.js` (dòng 35) để chấp nhận đường dẫn tương đối nhiều cấp an toàn (các segment cách nhau bởi `/`, không chứa `.`, `..`, segment ẩn bắt đầu bằng `.` trừ `.forge` của SE).
  - Tại dòng 126 của `rg-search.js`, đổi `!stat.isDirectory()` thành `(!stat.isDirectory() && !stat.isFile())`.
  - Tại dòng 130 của `rg-search.js`, đổi điều kiện kiểm tra thành:
    `!listed.stdout.split("\n").some((file) => file === path || file.startsWith(\`${path}/\`))`

---

### 2.4. [Mục 5] Đồng bộ giới hạn cửa sổ đọc `250` dòng cho cả Reviewer (`committed-review-window.js` & `reviewer-forge-tools.js`) và Schema
- **Hiện trạng:** Ngoài `agent-lifecycle-tools.js` (`READ_WINDOW_LINE_LIMIT = 80`) và `sed-lines.js` (`MAX_LINES = 80`) đã nêu trong tài liệu, còn **4 vị trí khác** đang khóa cứng con số `80` dòng:
  1. `backend/src/modules/supervisor/committed-review-window.js` (dòng 11):
     `input.end_line - input.start_line + 1 > 80` (dùng cho `read_lines` của Reviewer).
  2. `backend/src/modules/supervisor/reviewer-forge-tools.js` (dòng 28 & 184):
     `const MAX_WINDOW_LINES = 80;` và thông báo lỗi `"Reviewer read_file window must contain at most 80 lines."`.
  3. `schemas/agent/tools/read-file.schema.json` (dòng 30):
     `"description": "max lines to return: 250 for Markdown, 80 for source files"`.
  4. `backend/src/tools/agent-lifecycle-tools.js` (dòng 67), `backend/src/tools/index.js` và `backend/src/application/owner-sdk-stream.js` (dòng 98):
     Các chuỗi hướng dẫn `(at most 80 lines)`.
- **Đề xuất:** Nâng đồng bộ tất cả các vị trí trên từ `80` lên `250` dòng để cả AM, SE, SL, Coder và Reviewer đều đọc được trọn vẹn 1 file chuẩn (`<= 250 dòng`) trong 1 lần gọi.

---

### 2.5. [Mục 6 + Bổ sung mới] Thu thập `discoveredPaths` từ `search_text` cho Sprint Leader
- **Hiện trạng (`backend/src/tools/sprint-leader-forge-tools.js`, dòng 42–46):**
  ```js
  if (name === "search_code") for (const match of result.matches) if (typeof match.path === "string") discoveredPaths.add(match.path);
  if (name === "search_tree") for (const entry of result.entries) if (entry.type === "file" && typeof entry.path === "string") discoveredPaths.add(entry.path);
  if (name === "read_file" && typeof result.path === "string") discoveredPaths.add(result.path);
  if (name === "read_lines" && result.exit_code === 0) discoveredPaths.add(input.path);
  if (name === "list_files") for (const path of result.stdout.split("\n").filter(Boolean)) discoveredPaths.add(path);
  ```
- **Vấn đề:** Khi gỡ bỏ `search_code` khỏi Sprint Leader và chuyển sang dùng `search_text`, hiện chưa có logic trích xuất đường dẫn file từ `result.stdout` của `search_text` (định dạng `path:line:content` hoặc `path:content`) vào tập `discoveredPaths`.
- **Đề xuất:** Khi xóa `search_code` trong `sprint-leader-forge-tools.js`, bổ sung thu thập file path từ `search_text`:
  ```js
  if (name === "search_text" && typeof result.stdout === "string") {
    for (const line of result.stdout.split("\n").filter(Boolean)) {
      const match = /^([^:\0]+):/.exec(line);
      if (match) discoveredPaths.add(match[1]);
    }
  }
  ```

---

### 2.6. [Bổ sung mới] Ghi nhận `recordRead` và trả về `discovery_budget` trong `sed-lines.js` (`read_lines`)
- **Hiện trạng (`backend/src/tools/sed-lines.js`):**
  - Khi Coder gọi `read_file` (`agent-lifecycle-tools.js`), công cụ luôn gọi `recordRead(context, { path, window })` và trả về `discovery_budget: discoveryNotice(context)` để Coder biết số lượt đọc còn lại (`remaining_reads`) cũng như ghi nhận file vào `exploration_state.files_read`.
  - Tuy nhiên, khi Coder gọi `read_lines` (`sed-lines.js`), hàm `execute` chưa gọi `recordRead` và chưa đính kèm `discovery_budget` vào kết quả trả về.
- **Đề xuất:** Bổ sung `recordRead(context, { path: normalized.path, window: \`\${normalized.start_line}-\${normalized.end_line}\` })` và `discovery_budget: discoveryNotice(context)` vào kết quả trả về của `sed-lines.js` để thống nhất hành vi theo dõi ngân sách khám phá giữa `read_file` và `read_lines`.

---

### 2.7. [Bổ sung mới] Mở rộng `list_files` (`rg_files`) hỗ trợ glob dương (`--glob=PATTERN`)
- **Hiện trạng (`backend/src/tools/rg-files.js`, dòng 80–85):**
  ```js
  function isAllowedFlag(flag) {
    return /^--(?:i?glob)=![^!].*$/s.test(flag)
      || /^--max-depth=\d+$/.test(flag)
      || /^--type(?:-not)?=[A-Za-z0-9_-]+$/.test(flag)
      || flag === "--sort=path";
  }
  ```
- **Vấn đề:** `list_files` hiện chỉ cho phép glob phủ định (`--glob=!PATTERN` có dấu `!`), không cho phép glob dương như `--glob=*.test.js` hay `--glob=backend/src/**`. Điều này khiến các agent không thể dùng `list_files` để lọc nhanh các file theo hậu tố hoặc thư mục con mà phải lấy toàn bộ danh sách file trong repo.
- **Đề xuất:** Cho phép cả glob dương lẫn glob phủ định an toàn trong `rg-files.js` (và cập nhật `rg-files.schema.json`), miễn pattern không chứa `..` hoặc ký tự NUL:
  `/^--(?:i?glob)=[^!\0].*$/s` hoặc `/^--(?:i?glob)=!?[^\0]+$/s` (kèm kiểm tra không chứa `..`).

---

## 3. Rà soát toàn diện chỉ dẫn Node cho AM, SL, Coder và Reviewer

### 3.1. Quy ước và phạm vi

- **5 công cụ khám phá trực tiếp:** `search_tree`, `list_files`, `search_text`, `read_file`, `read_lines`. Đây là bộ discovery, không phải toàn bộ quyền của mỗi role.
- **AM:** bổ sung `git_status`, `git_diff` chỉ đọc, kể cả `/plan`; không cấp shell/test hay Git write.
- **SL lập sprint/ticket:** chỉ dùng 5 công cụ discovery; bỏ `search_code` khỏi registry, prompt và test liên quan. **SL blocker triage** giữ riêng 7 công cụ đọc: 5 công cụ discovery cộng `git_status`, `git_diff`.
- **Coder:** đồng bộ cửa sổ source tối đa `250` dòng trong rulebook, prompt, notice và tool/schema; không thay đổi quyền thực thi ticket.
- **Reviewer:** 5 công cụ discovery cộng công cụ review đã cấp; nguồn/diff/check phải gắn với commit review, không suy diễn bằng working tree.
- Các số dòng dưới đây là vị trí lúc rà soát; ưu tiên tên hàm/chuỗi khi file thay đổi. Chỉ nâng giới hạn **dòng source**, không thay mọi hằng `80` (ví dụ số entry của `search_tree`).

### 3.2. Bảng điểm lệch và yêu cầu đồng bộ

| Agent | File / vị trí hiện tại | Hiện trạng đã đối chiếu | Yêu cầu khi triển khai |
| :--- | :--- | :--- | :--- |
| AM | `backend/src/application/owner-sdk-stream.js:98` | Prompt architecture vẫn ghi `at most 80 lines`; chưa hướng dẫn `git_status` / `git_diff`. | Đổi thành `250`; nêu rõ 2 Git tool chỉ đọc, đồng bộ quyền cả `/plan` như mục 2.1. |
| SL | `backend/src/application/sprint-plan-leader.js:71` (`buildPrompt`) | Vẫn liệt kê `search_code`, ép `limit` từ `1 through 80`. | Bỏ `search_code`; `limit` là số nguyên `1–250`, khớp validator thực tế. |
| SL | `backend/src/application/ticket-sprint-leader.js:77` (`buildPrompt`) | Vẫn yêu cầu khám phá bằng `search_code`. | Chỉ liệt kê 5 công cụ discovery trực tiếp. |
| SL | `backend/src/tools/sprint-leader-forge-tools.js` | Vẫn đăng ký `search_code`; chưa thu thập `discoveredPaths` từ `search_text`. | Gỡ tool và dependency tương ứng; thu thập path như mục 2.5, cập nhật test. |
| SL | `workflows/agents/sprint-leader/README.md:25`, `:41`, `:80`, `:130` | Còn thuật ngữ `Code Index / Forge discovery` hoặc `Forge/Code Index`. | Gọi đúng tên 5 công cụ trực tiếp; không trình bày Code Index là tool SL cần gọi. |
| SL blocker | `backend/src/modules/supervisor/blocker-recovery-agent.js` và `blocker-role-prompt.js` | Nhánh triage phân biệt điều phối Sprint với quyết định Architecture, dùng 7 công cụ đọc chuẩn. | Giữ ranh giới Sprint và 2 Git tool chỉ đọc; không áp dụng nhầm giới hạn 5 tool của luồng lập sprint/ticket. |
| Coder | `workflows/agents/coder/README.md:25` | Rulebook ghi `source windows are limited to 80 lines`. | Đổi thành `250 lines`; giữ yêu cầu whole-file checksum. |
| Coder | `backend/src/modules/supervisor/nodeforge-task-prompts.js:46`, `:48` (`buildCodexTicketPrompt`) | Hai câu hướng dẫn source/read_lines tối đa `80`. | Cả hai đổi thành `250`, đồng bộ tham số `path`, `start_line`, `end_line`. |
| Coder | `backend/src/modules/supervisor/nodeforge-task-prompts.js:125`, `:142` (`buildToolTicketPrompt`) | Đọc rulebook với `end_line up to 80`; source window tối đa `80`. | Đổi cả hai thành `250`; rulebook vẫn read-only với Coder. |
| Coder / chung | `backend/src/tools/agent-lifecycle-tools.js:15`, `:67` | `READ_WINDOW_LINE_LIMIT = 80`; metadata notice cũng ghi `80`. | Đổi cả hằng thực thi và notice thành `250`, không chỉ sửa lời nhắc. |
| Coder / chung | `backend/src/tools/index.js:49` và `schemas/agent/tools/read-file.schema.json:30` | Description còn `up to 80 source lines` / `80 for source files`; schema maximum đã là `250`. | Đồng bộ description source với `250`; giữ semantics Markdown/source và checksum. |
| Reviewer | `workflows/agents/reviewer/README.md` và `backend/src/modules/supervisor/review-worker.js:58`–`:79` | Worker ghép rulebook, autonomy, verdict, exchange evidence và diff; câu discovery ở dòng 67 chỉ nêu `list_files`, `search_text`. | Hướng dẫn đủ 5 công cụ discovery và cách dùng `review_diff`, `run_review_check`, không thay đổi tiêu chuẩn verdict. |
| Reviewer | `backend/src/modules/supervisor/review-worker.js:128` (`toolInstruction`) | Vẫn ghi `at most 80 lines`; tool có thể được liệt kê động nhưng chưa giải thích diff/check. | Đổi thành `250`; bổ sung hướng dẫn review theo commit tại mục 3.3. |
| Reviewer | `backend/src/modules/supervisor/review-exchange-evidence.js:73`, `:75` | Đọc snapshot finding vẫn mặc định `input.limit ?? 80`, validator `end - start >= 80`, lỗi `1-80 lines`. | Đồng bộ mặc định, validator và lỗi thành `250` / `1-250`; không bỏ kiểm tra số nguyên, thứ tự dòng và phạm vi snapshot. |
| Reviewer | `backend/src/modules/supervisor/reviewer-forge-tools.js:28`, `:184` | `MAX_WINDOW_LINES = 80`; thông báo lỗi cũng khóa `80`. | Nâng cửa sổ và lỗi lên `250`; giữ nguyên giới hạn số file, byte và số check. |
| Reviewer | `backend/src/modules/supervisor/committed-review-window.js:11` | Validator chặn cửa sổ source `> 80`. | Cho phép `1–250` dòng trên source commit; không đổi kiểm tra provenance. |

**Điều chỉnh so với bảng rà soát ban đầu:** `review-exchange-evidence.js` hiện không còn prompt “use windows of at most 80 lines” tại dòng 34; đã dùng `reviewQueryPrompt(exchange)`. `review-worker.js:128` cũng đã yêu cầu `query_review` và theo cursor để lấy đầy đủ lịch sử findings/reports. Vì vậy chỉ sửa giới hạn còn tồn tại ở nhánh đọc snapshot, không khôi phục chỉ dẫn đọc evidence JSON thay cho `query_review`.

**Kiểm đếm Coder:** có **8 vị trí văn bản trong 6 file**, không phải 7: 1 rulebook + 4 câu ticket prompt + 1 metadata notice + 1 tool description + 1 schema description. Hằng `READ_WINDOW_LINE_LIMIT` là một điểm thực thi bổ sung cần đổi cùng lúc.

### 3.3. Hướng dẫn Reviewer cần bổ sung vào prompt

- Dùng `search_tree`, `list_files` để tìm file; `search_text` tìm nội dung; `read_file`, `read_lines` đọc metadata/source với cửa sổ tối đa `250` dòng, vẫn tuân thủ byte budget.
- Dùng `review_diff({path})` xem diff từng file giữa `base_sha` (hoặc `previous_review_commit` khi review lại) và `review_commit_sha`; không dùng diff working tree thay cho diff commit.
- Dùng `run_review_check({type,command})` chạy tối đa **2 check độc lập mỗi review**, loại `test`, `lint` hoặc `typecheck`, trên môi trường cô lập của `review_commit_sha`; chọn lệnh hẹp nhất liên quan acceptance criteria.
- Giữ hướng dẫn `query_review` theo cursor cho lịch sử findings/reports; giữ provenance `review_evidence`. `git_status`, `git_diff` chỉ phản ánh working tree, không là bằng chứng verified commit.

### 3.4. Tiêu chí nghiệm thu cho đợt triển khai sau

- [ ] Prompt/rulebook của 4 agent, tool descriptions, schema, notice và validator thống nhất source window `1–250`; không còn chỉ dẫn source `80` trong các vị trí được liệt kê.
- [ ] Kiểm thử biên đúng từng luồng: chấp nhận `250` dòng; từ chối `251`, giá trị không nguyên, âm/0 hoặc khoảng dòng đảo; bao gồm committed source và snapshot review findings.
- [ ] SL lập sprint/ticket chỉ có 5 tool discovery, không prompt nào yêu cầu `search_code`; `search_text` vẫn bổ sung được `discoveredPaths`. SL blocker giữ 7 tool đọc, không mở quyền ghi.
- [ ] AM dùng được `git_status`, `git_diff` trong hội thoại và `/plan`; không thêm shell/test/Git write.
- [ ] Reviewer prompt nêu đủ discovery, `review_diff`, `run_review_check`; check thứ ba bị từ chối, evidence/diff/check vẫn gắn đúng commit và lịch sử qua `query_review` không bị cắt.
- [ ] Chỉ chạy unit test liên quan tool/prompt/validator thay đổi; giữ checksum, path/role policy, byte budget và các giới hạn không phải số dòng. Không chạy full suite nếu owner không yêu cầu.

**Trạng thái:** đây là bổ sung tài liệu rà soát và tiêu chí triển khai; chưa sửa runtime/prompt/rulebook và chưa xác nhận các tiêu chí runtime đã pass.

---

## 4. Tóm tắt danh sách file dự kiến tác động khi triển khai

1. `backend/src/tools/owner-role-tool-policy.js` (thêm `git_status`, `git_diff` cho `architecture_manager`)
2. `backend/src/tools/owner-conversation-tools.js` (bật `createGitReadTools` cho `architecture_manager`, mở `planning_input_only` whitelist, đồng bộ schema `search_text`)
3. `backend/src/tools/sed-lines.js` (nâng `MAX_LINES = 250`, sửa `approvedPath` + `assertReadPath`, thêm `recordRead` & `discovery_budget`)
4. `backend/src/application/owner-sdk-stream.js` (bật `WebSearch` cho `system_engineer` ở chế độ `forge`, cập nhật prompt `250 lines`)
5. `schemas/agent/tools/rg-search.schema.json` & `backend/src/tools/rg-search.js` (mở `paths` cho thư mục con nhiều cấp và file cụ thể trong `buildArgs` + `validatePaths`)
6. `backend/src/tools/rg-files.js` & `schemas/agent/tools/rg-files.schema.json` (cho phép `--glob=PATTERN` dương an toàn)
7. `backend/src/tools/agent-lifecycle-tools.js`, `backend/src/tools/index.js`, `schemas/agent/tools/read-file.schema.json` (nâng `READ_WINDOW_LINE_LIMIT = 250`)
8. `backend/src/modules/supervisor/committed-review-window.js` & `backend/src/modules/supervisor/reviewer-forge-tools.js` (nâng `MAX_WINDOW_LINES = 250` cho Reviewer)
9. `backend/src/tools/sprint-leader-forge-tools.js` (gỡ `search_code`, thêm thu thập `discoveredPaths` từ `search_text`)
10. Các bộ unit test tương ứng (`owner-sdk-tools.test.js`, `system-engineer-sdk-tools.test.js`, `rg-search.test.js`, `rg-files.test.js`, `sed-lines.test.js`, `sprint-leader-forge-tools.test.js`, `agent-lifecycle-tools-v2.test.js`, `reviewer-forge-tools.test.js`).
11. `backend/src/application/sprint-plan-leader.js`, `backend/src/application/ticket-sprint-leader.js`, `workflows/agents/sprint-leader/README.md` (bỏ chỉ dẫn `search_code` / Code Index cũ, nâng read limit).
12. `workflows/agents/coder/README.md`, `backend/src/modules/supervisor/nodeforge-task-prompts.js` (đồng bộ 5 vị trí hướng dẫn Coder lên `250`).
13. `backend/src/modules/supervisor/review-worker.js`, `backend/src/modules/supervisor/review-exchange-evidence.js` (prompt discovery/diff/check, validator snapshot); đối chiếu `workflows/agents/reviewer/README.md`.
14. Unit test hẹp cho prompt SL/Coder, review worker/exchange/committed window và ngân sách 2 review check; bổ sung theo cấu trúc test hiện có, không khôi phục test đã bị xóa trong thay đổi khác.
