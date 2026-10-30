<!--
Mục đích nghiệp vụ: Tài liệu thiết kế kỹ thuật trực tiếp dành cho System Engineer (SE) để chuẩn hóa "Execution Environment Seam" (Lớp trừu tượng hóa Môi trường Thực thi) cho Multi-Project và các Target Projects trong NodeForge. Thiết kế này thống nhất toàn bộ các nhánh khởi chạy kiểm chứng (project sandbox, filesystem_namespace, browser_fixture) dưới một hợp đồng Adapter gắn chặt với cặp định danh (projectId, canonicalProjectRoot), bảo đảm cô lập tài nguyên giữa các dự án anh em chạy song song và tự động thu hồi tiến trình/socket khi đóng hoặc gỡ Target Project.
Mô tả kỹ thuật: Đặc tả chi tiết module backend/src/modules/supervisor/verification-environment-seam.js cùng cơ chế tích hợp vào ticket-verification-command.js, filesystem-namespace-runner.js, ticket-archive-materialization.js, ticket-verification-command-receipts.js, ticket-workspace-service.js và project-lifecycle.js mà không thay đổi enum hợp đồng công khai của Agent.
-->
# Kế hoạch Triển khai SE: Chuẩn hóa Execution Environment Seam cho Multi-Project / Target Projects

Tài liệu này đặc tả thiết kế kỹ thuật chi tiết cho **Phần 2: Chuẩn hóa Execution Environment Seam cho Multi-Project / Target Projects** để **System Engineer (SE)** triển khai vào `backend/src/modules/supervisor/` và đồng bộ với vòng đời Multi-Project (`backend/src/modules/projects/project-lifecycle.js`).

---

## 1. Bối cảnh và vấn đề kỹ thuật cần giải quyết

1. **Phân nhánh rời rạc trong `ticket-verification-command.js`**:
   - Hiện tại `executeTicketVerificationCommand` (`backend/src/modules/supervisor/ticket/ticket-verification-command.js`, `L12-L47`) đang tự phân nhánh trực tiếp giữa `environment === "filesystem_namespace"` (gọi `runFilesystemNamespace`) và nhánh `else` (gọi `filesystemVerificationCommand` rồi `spawn` trực tiếp).
   - Khi bổ sung **OS-level Write Sandbox (Bubblewrap Read-Only)** ở Phần 1 (`docs/architecture/ordinary-verification-write-sandbox.md`) và hỗ trợ các Target Projects có cấu trúc khác nhau, việc nhồi thêm điều kiện phân nhánh vào `ticket-verification-command.js` sẽ làm phình file, khó kiểm chứng tính bất biến của từng môi trường, và dễ rò rỉ biến môi trường (`process.env`) của host sang Target Project.
2. **Quản lý vòng đời Runner toàn cục chưa gắn với `projectLifecycle.remove(root)` / `close()`**:
   - Trong `backend/src/modules/supervisor/filesystem-namespace-runner.js` (`L8-L18`), `const managers = new Map()` lưu các bộ quản lý phiên theo `realpath(input.projectRoot)` ở cấp tiến trình, chỉ tự đóng sau `idleMs = 300000` (5 phút).
   - Khi một Target Project được gỡ khỏi tiến trình qua `projectLifecycle.remove(root)` hoặc khi đóng `ticketWorkspaceService.close()` (`backend/src/modules/supervisor/ticket/ticket-workspace-service.js`, `L176-L183`), chưa có đường gọi tường minh để dừng ngay phiên `filesystem_namespace` và giải phóng mục trong `managers` của `projectRoot` đó.
3. **Danh sách đường dẫn phụ thuộc (`node_modules`) đang cố định ở 3 nơi**:
   - Mảng `["node_modules", "backend/node_modules", "ui/nextjs/node_modules"]` đang được lặp lại tại:
     - `backend/src/modules/supervisor/ticket/ticket-archive-materialization.js` (`L22`),
     - `backend/src/modules/supervisor/ticket/ticket-verification-command-receipts.js` (`L17`),
     - `backend/src/modules/supervisor/ticket/ticket-workspace-service.js` (`L150`).
   - Với các Target Projects (dự án đích bên ngoài được quản lý qua Multi-Project), cần một hồ sơ bố cục phụ thuộc (`resolveProjectDependencyRoots`) tập trung, vừa giữ nguyên tương thích 100% với monorepo NodeForge vừa cho phép đọc bố cục workspace của Target Project một cách tất định.
4. **Kiểm tra ranh giới đường dẫn (`cwd`, `tempDir`) theo từng Target Project trước khi spawn**:
   - Trước khi bất kỳ Adapter nào thực thi lệnh kiểm tra cho Dự án A (`projectRoot`), cần một cổng kiểm tra tiền điều kiện (`preflightScope`) thống nhất để chứng minh `cwd` (thư mục archive hoặc worktree) và `tempDir` thực sự nằm bên trong `canonicalProjectRoot` của Dự án A, ngăn chặn hoàn toàn nguy cơ trỏ nhầm sang Dự án B khi chạy song song.

---

## 2. Ranh giới an toàn và quy tắc bất biến (Guardrails)

- **Giữ nguyên hợp đồng công khai của Agent (`verificationRunnerEnvironmentSchema`)**:
  - Tuyệt đối không thay đổi schema `schemas/governance/agent-exchange-payload.schema.json` hay hàm `assertVerificationRunnerEnvironment` (`backend/src/modules/supervisor/verification-runner-environment.js`). Agent vẫn chỉ truyền `environment: "project" | "filesystem_namespace"` (hoặc bỏ trống).
  - Việc ánh xạ từ yêu cầu của Agent và loại bước kiểm tra (`step.kind`) sang Adapter thực thi cụ thể là trách nhiệm nội bộ của Node thông qua `VerificationEnvironmentSeam`.
- **Fail-Closed & Không Fallback ngầm**:
  - Nếu Adapter được chọn cho Target Project không khả dụng hoặc vi phạm ranh giới đường dẫn (`VERIFY_ENVIRONMENT_SCOPE_VIOLATION`, `VERIFY_ENVIRONMENT_INVALID`), phải từ chối thực thi ngay trước khi chạy lệnh kiểm tra, tuyệt đối không tự động hạ cấp (fallback) từ `filesystem_namespace` hoặc `project_sandbox` về `spawn` trần trên host.
- **Cô lập tuyệt đối giữa các Target Projects chạy song song**:
  - Mỗi lệnh thực thi phải gắn với `canonicalProjectRoot` riêng; không chia sẻ `TMPDIR`, socket, hay trạng thái mount giữa Dự án A và Dự án B.
- **Tuân thủ giới hạn 250 `code_lines` và quy tắc Comment của `CLAUDE.md`**:
  - Mọi file mới và hàm mới phải có comment mô tả rõ mục đích nghiệp vụ (business purpose) và mô tả kỹ thuật (technical description) bằng một ngôn ngữ thống nhất; không vượt quá 250 `code_lines`.

---

## 3. Thiết kế chi tiết `VerificationEnvironmentSeam`

### 3.1. Module trung tâm `backend/src/modules/supervisor/verification-environment-seam.js`

Tạo module mới đóng vai trò là cửa ngõ duy nhất (Seam) kết nối giữa tầng điều phối kiểm tra (`ticket-verification-command.js`, `ticket-focused-check.js`, `ticket-verification-regression.js`, `review-verification-service.js`) và các bộ thực thi môi trường:

1. **Hàm chuẩn hóa bố cục phụ thuộc `resolveProjectDependencyRoots(projectRoot)`**:
   - Trả về danh sách đường dẫn tương đối chứa `node_modules` cần liên kết vào archive/worktree và băm trong `dependencyRevision`.
   - Mặc định trả về hằng số bất biến `DEFAULT_DEPENDENCY_ROOTS = Object.freeze(["node_modules", "backend/node_modules", "ui/nextjs/node_modules"])` để bảo toàn 100% hành vi hiện hữu của NodeForge và các Target Projects tiêu chuẩn.
   - Cung cấp điểm mở rộng sạch tại một chỗ duy nhất để cả 3 module (`ticket-archive-materialization.js`, `ticket-verification-command-receipts.js`, `ticket-workspace-service.js`) cùng import `DEFAULT_DEPENDENCY_ROOTS` / `resolveProjectDependencyRoots`, chấm dứt tình trạng trùng lặp mảng cứng ở 3 file.

2. **Hàm kiểm tra ranh giới Multi-Project `assertVerificationExecutionScope({ projectRoot, cwd, tempDir })`**:
   - Phân giải `canonicalProjectRoot = await realpath(projectRoot)` và `canonicalCwd = await realpath(cwd)`.
   - Kiểm tra `canonicalCwd === canonicalProjectRoot || canonicalCwd.startsWith(`${canonicalProjectRoot}/`)`. Nếu sai lệch (ví dụ trỏ sang dự án anh em hoặc thoát qua symlink), ném lỗi `ConfigurationError` với `code: "VERIFY_ENVIRONMENT_SCOPE_VIOLATION"`.
   - Nếu có `tempDir`, phân giải và xác nhận `canonicalTempDir` cũng thuộc `canonicalProjectRoot` (hoặc nằm trong `canonicalCwd`), đồng thời không trùng với thư mục `.forge` gốc của dự án hay danh mục toàn cục (`NODEFORGE_PROJECT_CATALOG_PATH`).

3. **3 Adapter thực thi chuẩn hóa dưới cùng một giao diện**:
   Mỗi Adapter tuân thủ hợp đồng `{ kind, resolveRevisionInputs(), execute({ projectRoot, canonicalProjectRoot, argv, cwd, tempDir, timeoutMs, signal, onOutput }), close(canonicalProjectRoot) }`:
   - **Adapter 1 — `filesystem_namespace`**:
     - Được chọn khi `environment === "filesystem_namespace"`.
     - Kiểm tra bắt buộc `command[0] === process.execPath` (giữ nguyên mã lỗi `VERIFY_ENVIRONMENT_INVALID`).
     - Ủy quyền cho `runFilesystemNamespace({ projectRoot: canonicalProjectRoot, argv: command, cwd, timeoutMs, signal, onOutput })` và trả về `runtime_environment` nguyên vẹn.
   - **Adapter 2 — `browser_fixture`**:
     - Được chọn khi lệnh kiểm tra là browser runner (`argv.some(arg => arg.includes("verify-ticket-browser.mjs"))`).
     - Thực thi trên giao diện loopback cô lập (`127.0.0.1:0`) với môi trường đã lọc sạch biến toàn cục gây nhiễu (`delete env.NODE_TEST_CONTEXT`, đặt `PWD: cwd`, `TMPDIR: tempDir`), trả về `runtime_environment: { type: "browser_fixture", project_root: canonicalProjectRoot }`.
   - **Adapter 3 — `project_sandbox` (Mặc định cho `environment === "project"` hoặc `undefined`)**:
     - Giữ tương thích với `filesystemVerificationCommand(argv, cwd, env)` cho bài kiểm tra tích hợp đặc thù `project-filesystem-environment.test.js`.
     - Với mọi lệnh kiểm tra thông thường (`typecheck`, `lint`, `test`, `backend_tests`, `schema_validation`), thực thi qua trình khởi chạy cô lập của dự án (kết nối trực tiếp với Bubblewrap Read-Only Sandbox ở Phần 1 khi bật cờ/policy sandbox trên host, hoặc runner đã khóa chặt `cwd`/`tempDir`/env theo đúng `canonicalProjectRoot`), trả về `runtime_environment: { type: "project_sandbox", project_root: canonicalProjectRoot }`.

4. **Hàm điều phối `executeWithVerificationEnvironmentSeam(input)`**:
   - Gọi `assertVerificationRunnerEnvironment(input.environment)`.
   - Nếu có `input.projectRoot`, gọi `assertVerificationExecutionScope({ projectRoot: input.projectRoot, cwd: input.cwd, tempDir: input.tempDir })`.
   - Chọn đúng Adapter theo thứ tự ưu tiên tất định (`filesystem_namespace` -> `browser_fixture` -> `project_sandbox`) và thực thi.

---

### 3.2. Đồng bộ vòng đời thu hồi tài nguyên khi đóng / gỡ Target Project

1. **Bổ sung `closeFilesystemNamespaceRunner(projectRoot)` trong `backend/src/modules/supervisor/filesystem-namespace-runner.js`**:
   - Cho phép đóng chủ động phiên `filesystem_namespace` của một `projectRoot` cụ thể và xóa khỏi `managers`:
     ```js
     // Stops and removes the cached filesystem namespace runner for a disposed project root.
     export async function closeFilesystemNamespaceRunner(projectRoot) {
       if (!projectRoot) return;
       let root;
       try { root = await realpath(projectRoot); }
       catch (error) { if (error.code !== "ENOENT") throw error; root = resolve(projectRoot); }
       const manager = managers.get(root);
       if (!manager) return;
       managers.delete(root);
       await manager.close();
     }
     ```
2. **Hàm `closeVerificationEnvironmentSeam(projectRoot)` trong `verification-environment-seam.js`**:
   - Gọi `await closeFilesystemNamespaceRunner(projectRoot)` (và dọn dẹp mọi tài nguyên runner gắn với `projectRoot`).
3. **Kết nối vào `ticket-workspace-service.js` và `project-lifecycle.js`**:
   - Trong `close()` của `backend/src/modules/supervisor/ticket/ticket-workspace-service.js` (`L176-L183`): gọi `await closeVerificationEnvironmentSeam(root)` để đảm bảo khi đóng workspace hoặc gỡ Target Project qua `project-runtime-disposal.js` (`releaseRuntime`), không còn tiến trình namespace hay socket mồ côi nào của dự án đó tồn tại.

---

## 4. Danh sách file SE dự kiến chạm và kế hoạch kiểm thử

| File | Thao tác | Mô tả |
| :--- | :---: | :--- |
| `backend/src/modules/supervisor/verification-environment-seam.js` | **Tạo mới** | Định nghĩa `DEFAULT_DEPENDENCY_ROOTS`, `resolveProjectDependencyRoots`, `assertVerificationExecutionScope`, bộ định tuyến Adapter (`filesystem_namespace`, `browser_fixture`, `project_sandbox`), `executeWithVerificationEnvironmentSeam`, và `closeVerificationEnvironmentSeam` (dưới 250 `code_lines`). |
| `backend/src/modules/supervisor/filesystem-namespace-runner.js` | **Cập nhật** | Bổ sung và export `closeFilesystemNamespaceRunner(projectRoot)` để thu hồi runner theo từng Target Project khi đóng/gỡ dự án. |
| `backend/src/modules/supervisor/ticket/ticket-verification-command.js` | **Cập nhật** | Ủy quyền việc chọn và khởi chạy môi trường cho `executeWithVerificationEnvironmentSeam` trong khi giữ nguyên bộ băm luồng `stdout`/`stderr` (`output_sha256`) và `failure_evidence`. |
| `backend/src/modules/supervisor/ticket/ticket-archive-materialization.js` | **Cập nhật** | Sử dụng `resolveProjectDependencyRoots(projectRoot)` thay cho mảng cứng `["node_modules", ...]`. |
| `backend/src/modules/supervisor/ticket/ticket-verification-command-receipts.js` | **Cập nhật** | Sử dụng `resolveProjectDependencyRoots(root)` trong `dependencyRevision(root)` để đồng bộ nhất quán với bước tạo archive. |
| `backend/src/modules/supervisor/ticket/ticket-workspace-service.js` | **Cập nhật** | Sử dụng `resolveProjectDependencyRoots(root)` trong `linkDependencies` và gọi `closeVerificationEnvironmentSeam(root)` trong `close()`. |
| `backend/tests/unit/verification-environment-seam.test.js` | **Tạo mới** | Kiểm thử đơn vị cho Seam: định tuyến đúng 3 Adapter, chặn `VERIFY_ENVIRONMENT_SCOPE_VIOLATION` khi `cwd` hoặc `tempDir` trỏ sang dự án anh em, cô lập 2 Target Projects chạy song song, và thu hồi sạch `filesystem_namespace` khi gọi `closeVerificationEnvironmentSeam(projectRoot)`. |

### Lệnh kiểm chứng dành cho SE sau khi code

```sh
TMPDIR=/tmp node --test \
  backend/tests/unit/verification-environment-seam.test.js \
  backend/tests/unit/filesystem-namespace-runner.test.js \
  backend/tests/unit/filesystem-verification-command.test.js \
  backend/tests/unit/ticket-verification-output.test.js \
  backend/tests/unit/ticket-verification-command-receipts.test.js \
  backend/tests/unit/ticket-verification-runner-revision.test.js
```
