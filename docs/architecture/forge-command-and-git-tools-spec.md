# Đặc tả Kiến trúc: Node-Mediated `run_command` Tool, Bộ Tool Git Hoàn Chỉnh & Hợp đồng `lookup_schema`

Tài liệu này tổng hợp đầy đủ các quyết định kiến trúc đã thống nhất với Project Owner về việc cung cấp bộ công cụ thực thi lệnh dự án (**`run_command`**) và bộ công cụ Git hoàn chỉnh (**Forge Git Toolset**), vận hành 100% qua tiến trình **Node** và tích hợp hợp đồng tra cứu vào **`lookup_schema`**.

---

## 1. Nguyên tắc Kiến trúc Cốt lõi (Core Architectural Principles)

1. **100% Node-Mediated Execution (Không gọi trực tiếp binary/shell hệ thống từ Agent):**
   - Agent tuyệt đối không được mở shell tự do (`sh -c`, `bash`) hay gọi trực tiếp đường dẫn binary hệ thống (`/usr/bin/...`, `./node_modules/.bin/...`).
   - Mọi lệnh đều phải gửi dưới dạng yêu cầu có cấu trúc (`command`, `args`, `cwd`...) vào **Node Service** (`Node Command Service`, `Node Archive Service`, `Node Git Service`).
   - Tiến trình **Node** chịu trách nhiệm kiểm tra quyền (authorization), kiểm tra schema/policy của từng tham số, tự phân giải runtime/toolchain cố định (ưu tiên thực thi bằng Node native / `process.execPath` khi có thể, hoặc spawn với `shell: false`), giới hạn thời gian chạy (`timeout_ms` + `AbortSignal`), lọc biến môi trường nhạy cảm và cắt gọn/redact output.
2. **Tự động Đồng bộ Change Ledger & Checksum (`sha256`):**
   - Trước và ngay sau mọi lệnh có khả năng thay đổi file trong `projectRoot` (`run_command`, `git_branch switch`, `git_restore`, `git_stash`), Node tự động đối chiếu trạng thái working tree.
   - Mọi file được tạo mới, chỉnh sửa hoặc khôi phục đều được Node tự động cập nhật vào `changed_paths` và `active_file_checksums` (`sha256`) của phiên/ticket hiện tại để Agent gọi `edit_diff` hoặc `commit_changes` liền mạch mà không bị lệch ledger.
3. **Bắt buộc Đăng ký Hợp đồng vào `lookup_schema`:**
   - Cả hợp đồng `run_command` (`forge.run_command.v1`) và hợp đồng bộ tool Git (`forge.git_tools.v1`) đều phải được đăng ký vào `agent-schema-catalog.js` và `agent-schema-document.js` (hỗ trợ lọc theo `action`) để Agent tra cứu chính xác cấu trúc tham số, các cờ được phép/bị cấm và ví dụ mẫu trước khi gọi.

---

## 2. Thiết kế Công cụ `run_command` (Node-Mediated Command & Archive Service)

### 2.1. Hợp đồng Đầu vào (`input_schema`)
```json
{
  "command": "node | pnpm | npm | npx | php | zip | unzip",
  "args": ["..."],
  "cwd": ".",
  "timeout_ms": 60000
}
```
- `command`: Tên capability cố định trong danh mục cho phép (không nhận đường dẫn file thực thi). Từ khóa `git` bị từ chối tại `run_command` để bắt buộc đi qua bộ **Forge Git Tools** chuyên biệt.
- `args`: Mảng chuỗi tham số (`string[]`, tối đa 64 phần tử). Không đi qua shell nên không thể chèn toán tử lệnh (`;`, `&&`, `||`, `|`, `` ` ``, `$()`).
- `cwd`: Đường dẫn tương đối bên trong `projectRoot` (mặc định `"."`). Chặn tuyệt đối `..` thoát khỏi `projectRoot` và đường dẫn tuyệt đối.
- `timeout_ms`: Mặc định `60_000` ms (tối đa `180_000` ms), hủy tức thì khi `context.abortSignal` kích hoạt.

### 2.2. Quy tắc Thực thi & Chốt chặn tại Node cho từng `command`

| `command` | Cơ chế thực thi tại Node | Các thao tác / tham số được phép | Các thao tác / tham số bị cấm |
|---|---|---|---|
| **`node`** | Chạy bằng chính `process.execPath` của tiến trình Node hiện hành (`shell: false`). | - Chạy script trong project (`node scripts/...`)<br>- Kiểm tra cú pháp (`node --check <file>`)<br>- Chạy test (`node --test <files...>`)<br>- Chạy biểu thức kiểm tra ngắn (`node -e "<code>"` / `node --input-type=module -e "<code>"`) | - Đường dẫn script ngoài `projectRoot`<br>- Sửa/xóa trực tiếp `.git/` hoặc `.forge/`<br>- Mở tiến trình daemon/server treo vô hạn |
| **`pnpm`** | Do Node Command Service phân giải và chạy với `shell: false` trong `cwd` thuộc project. | - `run <script>`, `test`, `lint`, `typecheck`, `build`, `validate:schemas`<br>- `install`, `add <pkg>`, `remove <pkg>`, `list`, `outdated`, `why`<br>- `exec <tool> ...`, `--dir <subdir>`, `--filter <pkg>` | - `publish`, `login`, `logout`, `config set --global`<br>- `--dir` trỏ ra ngoài `projectRoot`<br>- `dlx` tải gói tùy ý từ mạng khi không được phép |
| **`npm`** | Do Node Command Service phân giải và chạy với `shell: false`. | - `run <script>`, `test`, `install`, `ci`, `ls`, `outdated`, `pkg get`<br>- `exec -- <tool> ...` | - `publish`, `login`, `adduser`, `owner`, `token`<br>- `-g` / `--global`, `--prefix` ngoài `projectRoot` |
| **`npx`** | Do Node Command Service chạy ở chế độ ưu tiên binary nội bộ (`--no-install`). | - Chạy các CLI có trong `node_modules/.bin` của project (`tsc`, `eslint`, `prettier`, `vitest`, `jest`, `playwright`, `prisma`...) | - Tải/thực thi package lạ từ URL/git remote bên ngoài<br>- Cờ `-c` gọi shell |
| **`php`** | Do Node Command Service phân giải binary `php` chuẩn và chạy với `shell: false`. | - Kiểm tra cú pháp (`php -l <file.php>`)<br>- Chạy script PHP trong project (`php <script.php> ...`)<br>- Chạy inline kiểm tra (`php -r "<code>"`) | - `-S` (built-in web server)<br>- `-c` trỏ file cấu hình ngoài project<br>- Can thiệp file ngoài `projectRoot` |
| **`zip`** | Thực thi qua **Node Archive Service** (ưu tiên xử lý trong Node hoặc bọc kiểm tra đường dẫn). | - Đóng gói các file/thư mục tương đối trong `projectRoot` thành file `.zip` nằm trong `projectRoot` (`args: ["-r", "<out.zip>", "<in1>", ...]`). | - Đường dẫn nguồn hoặc đích nằm ngoài `projectRoot`, hoặc bao gồm `.git/` / `.forge/`. |
| **`unzip`** | Thực thi qua **Node Archive Service** có kiểm tra từng entry trước khi ghi. | - Liệt kê (`["-l", "<archive.zip>"]`) hoặc giải nén (`["-o", "<archive.zip>", "-d", "<target_dir>"]`) vào thư mục trong `projectRoot`. | - Chặn *Zip Slip* (entry chứa `..`, đường dẫn tuyệt đối hoặc symlink thoát khỏi `projectRoot`). |

### 2.3. Kết quả Trả về của `run_command`
```json
{
  "command": "pnpm",
  "args": ["--dir", "backend", "run", "validate:schemas"],
  "cwd": ".",
  "exit_code": 0,
  "duration_ms": 842,
  "stdout": "... (bounded & secret-redacted, max 8KB) ...",
  "stderr": "... (bounded & secret-redacted, max 8KB) ...",
  "truncated": false,
  "changed_paths": ["..."],
  "active_file_checksums": { "path": "sha256:..." }
}
```

---

## 3. Thiết kế Bộ Tool Git Hoàn Chỉnh (100% qua `Node Git Service`)

Toàn bộ thao tác Git của Agent được thực hiện qua `backend/src/infrastructure/git/git-service.js` của Node (dưới `mutationLock` và kiểm tra scope/protected branches):

### 3.1. Nhóm Tool Git Read-Only (Cấp cho mọi Role: AM, SE, SL, Coder, RV và Subagent)

1. **`git_status` (Nâng cấp tương thích ngược):**
   - Tham số: `{ paths?: string[] }` (nếu để trống `{}` thì hoạt động y hệt hiện tại).
   - Kết quả: `{ stdout, branch, head_sha, ahead, behind, has_conflicts, clean, modified_count, untracked_count, staged_count }`.
2. **`git_diff` (Nâng cấp tương thích ngược — Khắc phục lỗi `GIT_READ_OUTPUT_TOO_LARGE`):**
   - Tham số: `{ paths?: string[], base?: string, head?: string, staged?: boolean, stat_only?: boolean, unified?: number }`.
   - Cho phép lọc diff theo từng file/thư mục, xem diff giữa 2 commit/branch, xem staged diff, hoặc chỉ lấy `--stat`/`--name-status` khi diff lớn.
3. **`git_log` (Tool mới):**
   - Tham số: `{ limit?: number (1..100, default 20), path?: string, revision?: string, grep?: string }`.
   - Kết quả: Danh sách commits có cấu trúc `{ commits: [{ sha, short_sha, author, date, subject, body }] }`.
4. **`git_show` (Tool mới):**
   - Tham số: `{ revision: string, path?: string, paths?: string[], stat_only?: boolean }`.
   - Nếu truyền `path` (1 file): trả về nội dung và `sha256` của file đó tại `revision` mà không làm đổi working tree.
   - Nếu không truyền `path`: trả về metadata của commit kèm danh sách file thay đổi và bản vá (lọc theo `paths` nếu có).
5. **`git_blame` (Tool mới):**
   - Tham số: `{ path: string, start_line?: number, end_line?: number }` (giới hạn tối đa 200 dòng mỗi lần gọi).
   - Kết quả: Danh sách dòng kèm `commit_sha`, `author`, `timestamp`, `line_number`, `content`.

### 3.2. Nhóm Tool Git Điều Hành & Nhánh (Cấp cho SE và Coder theo quyền hạn)

6. **`git_branch` (Tool mới):**
   - Tham số: `{ action: "list" | "current" | "create" | "switch" | "delete_merged", name?: string, start_point?: string }`.
   - `list` / `current` là read-only (mọi role đều dùng được).
   - `create` / `switch` / `delete_merged` chạy dưới `mutationLock` của Node, chặn thao tác xóa/ghi đè nhánh bảo vệ (`main`, `master`, `production`), và tự động cập nhật `active_file_checksums` sau khi `switch`.
7. **`git_restore` (Tool mới — Khôi phục có kiểm soát theo đường dẫn):**
   - Tham số: `{ action: "restore_worktree" | "unstage", paths: string[], source?: string }`.
   - Bắt buộc chỉ định rõ `paths: string[]` (trong phạm vi được phép của role/ticket); cấm `reset --hard` toàn cục để bảo vệ công việc đồng thời. Tự động cập nhật lại `changed_paths` và `active_file_checksums`.
8. **`git_stash` (Tool mới):**
   - Tham số: `{ action: "list" | "push" | "pop" | "apply", message?: string, paths?: string[], index?: number }`.
   - Tự động đồng bộ `changed_paths` và `active_file_checksums` khi `push` / `pop` / `apply`.
9. **`commit_changes` & `push_commit` (Giữ nguyên chốt chặn an toàn hiện có):**
   - Chỉ commit các file trong change ledger đã được Node ghi nhận và chỉ push commit SHA vừa tạo trên nhánh không bị khóa.

---

## 4. Tích hợp Hợp đồng vào `lookup_schema`

Cập nhật `backend/src/modules/governance/agent-schema-catalog.js`, `backend/src/modules/governance/agent-schema-document.js` và thêm 2 file schema gốc trong `schemas/tools/`:

1. **Hợp đồng `forge.run_command.v1` (`schemas/tools/run-command-contract.schema.json`):**
   - Tra cứu tổng quát: `lookup_schema({ schema_id: "forge.run_command.v1" })` hoặc `lookup_schema({ task: "run_command" })`.
   - Tra cứu theo từng lệnh cụ thể qua `action`:
     - `lookup_schema({ schema_id: "forge.run_command.v1", action: "pnpm" | "npm" | "npx" | "node" | "php" | "zip" | "unzip" })`
   - Trả về đúng nhánh schema (`args` pattern, flags hợp lệ/bị cấm) và `example` chuẩn cho lệnh đó.
2. **Hợp đồng `forge.git_tools.v1` (`schemas/tools/git-tools-contract.schema.json`):**
   - Tra cứu tổng quát: `lookup_schema({ schema_id: "forge.git_tools.v1" })` hoặc `lookup_schema({ task: "git_tools" })`.
   - Tra cứu theo từng tool cụ thể qua `action`:
     - `lookup_schema({ schema_id: "forge.git_tools.v1", action: "git_status" | "git_diff" | "git_log" | "git_show" | "git_blame" | "git_branch" | "git_restore" | "git_stash" | "commit_changes" | "push_commit" })`
   - Trả về schema đầu vào, quy tắc an toàn của Node và `example` mẫu.
3. **Cập nhật Role README & System Prompts:**
   - Bổ sung `forge.run_command.v1` và `forge.git_tools.v1` vào bảng `## Required schema lookup` trong `workflows/agents/system-engineer/README.md`, `workflows/agents/coder/README.md` (và `forge.git_tools.v1` cho AM, SL, RV).
   - Cập nhật danh sách tool trong `engineering-tool-catalog.js`, `engineering-tool-names.js`, `owner-role-tool-policy.js`, `owner-sdk-stream.js` và `nodeforge-task-prompts.js`.

---

## 5. Bảng Phân Quyền Tổng Hợp theo Role

| Công cụ / Nhóm lệnh | System Engineer (SE) | Coder (Ticket Runtime) | AM / SL / Reviewer | Subagent (`delegate_subagent`) |
|---|---|---|---|---|
| `lookup_schema` (`forge.run_command.v1`, `forge.git_tools.v1`) | Có | Có | Có | Không cần (chỉ 5+5 tool đọc) |
| `run_command` (`node`, `pnpm`, `npm`, `npx`, `php`, `zip`, `unzip`) | Có (Toàn project) | Có (Theo scope ticket) | Không | Không |
| `run_check` (Verification Gate: `test`, `lint`, `typecheck`, `build`) | Có | Có | Không | Không |
| `git_status`, `git_diff`, `git_log`, `git_show`, `git_blame` | Có | Có | Có (Read-only) | Có (Read-only) |
| `git_branch` (`list`, `current`) | Có | Có | Có (Read-only) | Không |
| `git_branch` (`create`, `switch`, `delete_merged`) | Có | Theo policy ticket | Không | Không |
| `git_restore`, `git_stash`, `commit_changes` | Có | Có (Trong ledger ticket) | Không | Không |
| `push_commit` | Có (Khi Owner yêu cầu) | Có (Khi ticket yêu cầu) | Không | Không |
