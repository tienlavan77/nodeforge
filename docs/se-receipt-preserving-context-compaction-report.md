<!--
Mục đích nghiệp vụ: Báo cáo bàn giao kết quả triển khai kỹ thuật của System Engineer (SE) cho Owner và Architecture Manager (AM) đối với thiết kế Receipt-Preserving Context Compaction & Mid-Flight Directive Injection cùng các bản vá ổn định vận hành Git, HTTP Proxy, Conversation UI và Project Stream.
Mô tả kỹ thuật: Tổng hợp chi tiết các file tạo mới/cập nhật, số lượng code_lines, mã băm sha256, danh sách kiểm thử đơn vị và ESLint đã thực thi kèm mã biên nhận (Log/Verification Receipts), và các giới hạn tồn đọng ngoài phạm vi.
-->
# Báo cáo Bàn giao SE: Receipt-Preserving Context Compaction, Mid-Flight Directive Injection & Ổn định Vận hành

- **Người nhận (Intended Recipient):** Project Owner & Architecture Manager (AM)
- **Người thực hiện:** System Engineer (SE)
- **Ngày báo cáo:** 2026-10-30
- **Tài liệu thiết kế tham chiếu:**
  1. `docs/architecture/receipt-preserving-context-compaction.md` (`sha256:9fe59cdaa6d14db45c02e8ec32b6230a66f1cd2d5a8f1bf6b4d97762fc5b709b`)
  2. `docs/architecture/ordinary-verification-write-sandbox.md` — **Phần 1** (`sha256:60d6c39f97bfc03aeae212d62351f073efe121e63bcfbfee8ffddb5cf25f6988`)
  3. `docs/architecture/multi-project-execution-environment-seam.md` — **Phần 2** (`sha256:b2f5c3601dda3ef38db20f507dba9ad132286de374cf88ad462f0e496c6edb2d`)
- **Trạng thái tổng thể:** **HOÀN TẤT (`PASS`)**

---

## 1. Triển khai Receipt-Preserving Context Compaction & Mid-Flight Directive Injection (4 Mảnh ghép A, B, C, D)

### 1.1. Chi tiết các thay đổi mã nguồn

| Mảnh ghép | Đường dẫn file | Thao tác | `code_lines` (`<= 250`) | Checksum (`sha256`) | Nội dung kỹ thuật đã thực hiện |
| :---: | :--- | :---: | :---: | :--- | :--- |
| **A** | `backend/src/modules/supervisor/ticket/ticket-read-cache.js` | Cập nhật | `102` | `sha256:eb36c5ca94a6a6767ec26dd22c0a0c20c66f9e25076a12e1d9bbb6c92fafd40f` | Mở rộng `rememberRead` cho `read_file` (cả full content lẫn metadata index) và `read_lines`/`sed_lines`; bổ sung `recordMutationChecksum` (hỗ trợ `edit_diff`, `write_diff` text receipt, `move_file`, `delete_file`) với cờ `window_invalidated: true` để bảo toàn `sha256` mới nhất cho `before_checksum` mà không chặn `assertReadNotRepeated` khi đọc lại cửa sổ sau sửa đổi; cung cấp `activeFileChecksums`. |
| **A & D** | `backend/src/modules/supervisor/ticket/ticket-work-progress.js` | Cập nhật | `30` | `sha256:187b354f4205cbff1735c3a87b9a866f7c2c4593f67c7e4b1dbdabd095e7792d` | Đính kèm `Active file checksums` và `formatMidFlightDirectives` vào `ticketWorkContinuationPrompt`; hỗ trợ nạp schema từ `.forge/schemas/` và `schemas/`. |
| **A, C & D** | `backend/src/modules/supervisor/ticket/ticket-resume.js` | Cập nhật | `203` | `sha256:fc89312d46a94cc893ac8119d91a2f02586e0975bcccd7f50392cdfbb8dd81a7` | Gọi `recordMutationChecksum` sau các thao tác sửa/xóa/chuyển file; lưu `delivered_directives` và cờ `sessionRolledOver` trong `checkpointPayload` (đảm bảo khi rollover đặt `sessionId = null` / `threadId = null` không bị ghi đè ngược bởi `state.resume` cũ); nhúng `Active file checksums` và `deliveredDirectives` vào `buildResumePrompt`. |
| **B & C** | `backend/src/modules/supervisor/ticket/ticket-context-compaction.js` | **Tạo mới** | `133` | `sha256:584440ab2c689a62f24c66c4c0e124c99e5f940cba980d40a53c739e91b87f15` | Triển khai `formatActiveReceiptDigest` (`<= 2000` ký tự), `compactFunctionCallingHistory` (giữ initial prompt + 6 items cuối, thay các tool output `> 1200` ký tự hoặc bản đọc cũ của file đã sửa bằng `compacted_receipt` stub), `extractTurnInputTokens`, `shouldRolloverSdkSession` (`DEFAULT_ROLLOVER_INPUT_TOKENS = 120000`), và `buildCompactedRolloverPrompt`. |
| **D** | `backend/src/modules/supervisor/ticket/ticket-directive-inbox.js` | **Tạo mới** | `148` | `sha256:4874b9088d101d034a0594540732369b8558fbf65dece3d228bc6e44541ab5ea` | Triển khai `createTicketDirectiveInbox` (`enqueue`, `list`, `drainPending`) lưu tại `.forge/runtime/ticket-directives/<projectHash>/<taskId>.json` với khóa `acquireTicketFileLock`; kiểm tra chặt `ALLOWED_DIRECTIVE_ROLES` (`project_owner`, `sprint_leader`, `architecture_manager`, `node`), `ALLOWED_DIRECTIVE_KINDS` (`implementation_guidance`, `focus_constraint`, `pause_after_turn`), `supersedePending`, `sanitizeDeliveredDirectives` và `formatMidFlightDirectives`. |
| **C & D** | `backend/src/modules/supervisor/ticket/ticket-sdk-turns.js` | Cập nhật | `92` | `sha256:869aaba2ec37d23ae5780e85fa572a96e3a13217e618081d90528b4aeb254c0d` | Rút chỉ thị tại ranh giới turn qua `drainPending`; xử lý `pause_after_turn` (lưu checkpoint `status: "paused_by_directive"`, phát log `supervisor.sdk_turn_paused_by_directive`, ném mã `DIRECTIVE_PAUSE_REQUESTED`); miễn trừ `AGENT_PROGRESS_STALLED` đúng 1 nhịp khi có chỉ thị mới; xoay vòng phiên SDK khi đạt ngưỡng token và phát log `supervisor.sdk_context_compacted`. |
| **B & D** | `backend/src/modules/supervisor/function-calling-task-executor.js` | Cập nhật | `102` | `sha256:5c6bd5209631fae3d0ef90fc5a80c533b9472bda96fc2ab5facdfd81e96a4fd4` | Gọi `compactFunctionCallingHistory` giữa các turn trước khi truyền `history` vào `gateway.execute`; bảo toàn checkpoint `paused_by_directive` khi gặp `DIRECTIVE_PAUSE_REQUESTED`. |
| **D** | `backend/src/modules/supervisor/nodeforge-task-executors.js` | Cập nhật | `189` | `sha256:a64b94446b9d1adf4270351896b323c38bd6200b3e75d66073f44335e0f94cb3` | Bảo toàn trạng thái checkpoint `paused_by_directive` trong khối `catch` của `runToolTicket` và `runCodexTask` khi dừng chủ động bởi `DIRECTIVE_PAUSE_REQUESTED`. |
| **Tests** | `backend/tests/unit/ticket-context-compaction.test.js` | **Tạo mới** | `189` | `sha256:bf0b62d6fba84597879bc5eb2cc90595b1cb58561cc5470671f2dfbb5617c494` | Kiểm thử đơn vị toàn diện cho Mảnh ghép A, B, C. |
| **Tests** | `backend/tests/unit/ticket-directive-inbox.test.js` | **Tạo mới** | `182` | `sha256:3134830ad033954024e471b0c985b97c0523069322de9a7df3779f626a5247e3` | Kiểm thử đơn vị toàn diện cho Mảnh ghép D (role guard, idempotency, `supersedePending`, cô lập multi-project, stall exemption, `pause_after_turn`). |

### 1.2. Triển khai Phần 1 (`Ordinary Verification Write Sandbox`) & Phần 2 (`Multi-Project Execution Environment Seam`)

| Phần | Đường dẫn file | Thao tác | `code_lines` (`<= 250`) | Checksum (`sha256`) | Nội dung kỹ thuật đã thực hiện |
| :---: | :--- | :---: | :---: | :--- | :--- |
| **Phần 1** | `backend/src/modules/supervisor/ordinary-verification-sandbox.js` | **Tạo mới** | `167` | `sha256:d4be65a0ac205f5c093b13d665ed8807715f4b0ab749353b334f6ec8fa8146ab` | Triển khai `buildOrdinaryVerificationSandboxPlan` và `runOrdinaryVerificationSandbox`: khởi tạo Bubblewrap (`bwrap`) ngắn hạn theo từng lệnh kiểm tra với `--die-with-parent`, `--new-session`, `--cap-drop ALL`, `--clearenv`; bind read-only `canonicalProjectRoot` và `canonicalCwd`; mask `.forge` gốc, thư mục cha chứa sibling projects, `HOME`, và catalog toàn cục bằng `--tmpfs`; chỉ mở quyền ghi (`--bind`) cho `.forge-tmp`, `.forge/runtime` của archive và `outputDirs` hợp lệ; fail-closed (`VERIFY_SANDBOX_UNAVAILABLE`, `VERIFY_ENVIRONMENT_SCOPE_VIOLATION`, `VERIFY_SANDBOX_FAILED`) không fallback về host `spawn`. |
| **Phần 2** | `backend/src/modules/supervisor/verification-environment-seam.js` | **Tạo mới** | `147` | `sha256:f9939263e26d83526811342e7895315ef0d3939d02fdfbf22c209086be9f927c` | Triển khai `DEFAULT_DEPENDENCY_ROOTS`, `resolveProjectDependencyRoots`, `assertVerificationExecutionScope` (kiểm tra ranh giới `canonicalProjectRoot`, `canonicalCwd`, `canonicalTempDir`, chống symlink escape), `executeWithVerificationEnvironmentSeam` (định tuyến 3 Adapter: `filesystem_namespace`, `browser_fixture`, `project_sandbox`), và `closeVerificationEnvironmentSeam`. |
| **Phần 2** | `backend/src/modules/supervisor/filesystem-namespace-runner.js` | Cập nhật | `112` | `sha256:f55c0c8cfe44685c8935fec1a4251d64a86bf4b4bdc00e92c8104a5a6f7b305e` | Bổ sung và export `closeFilesystemNamespaceRunner(projectRoot)` để dừng phiên `filesystem_namespace` và giải phóng mục trong `managers` khi đóng hoặc gỡ Target Project. |
| **Phần 1 & 2** | `backend/src/modules/supervisor/ticket/ticket-verification-command.js` | Cập nhật | `22` | `sha256:922032551737f9605214dc9f9c20cb69cae2a0947d95055db41a88854566588d` | Ủy quyền thực thi qua `executeWithVerificationEnvironmentSeam` trong khi giữ nguyên `output_sha256` và `failure_evidence`. |
| **Phần 2** | `backend/src/modules/supervisor/ticket/ticket-archive-materialization.js` | Cập nhật | `62` | `sha256:82f56a2abff5e229cd8bdb525cdc388be93db801e73bd93b9f0ff59ded7697ac` | Sử dụng `resolveProjectDependencyRoots(projectRoot)` thay cho mảng cứng. |
| **Phần 2** | `backend/src/modules/supervisor/ticket/ticket-verification-command-receipts.js` | Cập nhật | `53` | `sha256:2372872068386db4a9821e811eac828b2668965ea20736d8156e741e3f0def7d` | Sử dụng `resolveProjectDependencyRoots(root)` trong `dependencyRevision(root)`. |
| **Phần 2** | `backend/src/modules/supervisor/ticket/ticket-workspace-service.js` | Cập nhật | `172` | `sha256:fbc8657ed25802bde6058d6dae1bb547f9ce1f200aa1752bcb7d4ae0d4260b1c` | Sử dụng `resolveProjectDependencyRoots(root)` trong `linkDependencies` và gọi `await closeVerificationEnvironmentSeam(root)` trong `close()`. |
| **Tests (P1)** | `backend/tests/unit/ordinary-verification-sandbox.test.js` | **Tạo mới** | `198` | `sha256:ae886b18033a3246d0c7a69c6154923f4f7a4cc9cb22ad9156c1413124ca9eda` | Kiểm thử đơn vị cho Phần 1: fail-closed khi thiếu `bwrap`, kiểm tra mount plan read-only/masked/writable, chặn symlink escape, chạy song song 2 dự án anh em, timeout, abort, và lỗi mount. |
| **Tests (P2)** | `backend/tests/unit/verification-environment-seam.test.js` | **Tạo mới** | `135` | `sha256:7865f300825514d091ef7959dda5e75bc1bc35640602ecaf8ad4f347343b2756` | Kiểm thử đơn vị cho Phần 2: `resolveProjectDependencyRoots`, `assertVerificationExecutionScope`, định tuyến 3 Adapter, cô lập 2 dự án anh em chạy song song, và `closeVerificationEnvironmentSeam`. |

---

## 2. Các bản vá ổn định vận hành đã thực hiện cùng phiên

1. **Sửa lỗi `GIT_ADD_FAILED` (`pathspec ':(literal)backend/src/domain/.gitkeep' did not match any files`) & `ECONNRESET` khi Commit/Push kho mã lớn:**
   - `backend/src/infrastructure/git/git-service.js` (`code_lines: 207`, `sha256:54bb5d38117314de88e7a0ac076bd4cd5229885b88352cf569dd5865980253f6`): Xử lý các đường dẫn đã staged delete (`--no-renames --diff-filter=D`) khi `git add -f` gặp lỗi pathspec; nâng `MAX_GIT_BUFFER = 64MB` và `timeoutMs = 120_000`.
   - `backend/src/transport/http/forge-v1-git-routes.js` (`code_lines: 45`, `sha256:b919961783616d7c4799cb76f541b43476f9ccdffc4e4fc7bf7182b394dff571`): Thu thập cả đường dẫn mới và đường dẫn cũ của các bản ghi rename/copy (`R`/`C`) trong `parseChangedPaths`.
   - `backend/src/transport/http/server.js` (`code_lines: 231`, `sha256:1f0a046d0024fe8c56177f6ab5ec1cd3ce42cdcff38e802ab7dbee6199d267e4`): Cấu hình `keepAliveTimeout = 65_000` và `headersTimeout = 66_000` để tránh đóng socket keep-alive sau 5 giây gây `ECONNRESET` trên Next.js Proxy.
2. **Sửa lỗi Xoá, Ghim, Đổi tên, Lưu trữ Conversation trên UI:**
   - `backend/src/transport/http/forge-v1-router.js` (`code_lines: 228`, `sha256:4100361ebf44f0ee09e983962b4c9c7323fbbc825f7d6a853c2fa4ebf2504100`): Tự động tra cứu `conversationCrudService?.get?.(parts[1])?.project_id` khi request tới `/forge/v1/conversations/:id...` thiếu query `project`.
   - `ui/nextjs/components/ConversationsBlock.jsx` (`code_lines: 175`, `sha256:c34b0d10e9c5b55366444f2dc3ff370aa928ae15ad47dd736385fdb6437a69ce`), `ui/nextjs/components/ConversationsAccordion.jsx` (`code_lines: 205`, `sha256:55157584343a6a2c5b5e5e6c8a137ff2d950f06d5ed0830ca3acfed7b4f4f172`), `ui/nextjs/components/conversation-pinning.js` (`code_lines: 28`, `sha256:8fe96dc0a31bf744925aa2313931e9dfa2fd1022c7e1947471d66b28cfcbe2f7`): Truyền `?project=...`, bỏ hộp thoại `window.confirm` bị lặp lần 2 khi xoá, chặn gọi lặp `onBlur` sau khi nhấn `Enter` đổi tên, và lưu thứ tự `persistOrder` sau khi ghim/đổi tên.
3. **Bắn event `command` của toàn bộ 15 Forge tools lên `projectStream` (Khung chat `RAN ...` & Panel `Agent activity`):**
   - `backend/src/application/system-engineer-sdk-transcript.js` (`code_lines: 109`, `sha256:cc18d847141537f4b9c028f0121616f2be55946cd846ddaf6358db6f4a196973`) & `backend/src/tools/roles/owner-conversation-tools.js` (`code_lines: 83`, `sha256:ad811e5c6d180642f281fab166ec98950cdda030e9dc1124412cc57cbc95695a`): Bổ sung `formatForgeToolCommand` để chuẩn hóa lệnh cho cả Claude (`mcp__forge__*`) và Codex (`mcp_tool_call` server `forge`) lên cả `sdk_event` (`RAN ...`) và `agent.activity.summary`.

---

## 3. Bằng chứng Kiểm thử & ESLint đã thực thi

1. **Kiểm thử Context Compaction & Directive Inbox (`PASS`, `exit_code: 0`):**
   - Lệnh: `node --test backend/tests/unit/ticket-context-compaction.test.js backend/tests/unit/ticket-directive-inbox.test.js backend/tests/unit/ticket-sdk-turns.test.js backend/tests/unit/ticket-work-progress.test.js`
   - Log Receipts: `LOG-ad0f8081-cce2-4416-82eb-815e27a06764`, `LOG-f46d219c-6387-4299-a9d3-586c4b697ed3`
   - Watcher Verification Receipts: `VERIFY-RUN-4250053f-052d-488b-8820-10ccf9334073`, `VERIFY-RUN-14439137-5958-4ddb-b3db-c913215e5e74`
2. **Kiểm thử Git Service & Routes (`PASS`, `exit_code: 0`):**
   - Lệnh: `node --test backend/tests/unit/git-service.test.js backend/tests/unit/forge-v1-git-routes.test.js backend/tests/unit/agent-commit-changes.test.js ui/nextjs/tests/control-api-proxy-restart.test.js`
   - Log Receipt: `LOG-88638416-2f92-4da5-b953-d0f081d221b6`
3. **Kiểm thử Conversation Actions & Navigation (`PASS`, `exit_code: 0`):**
   - Lệnh: `node --test ui/nextjs/tests/conversation-actions.test.js ui/nextjs/tests/conversations-navigation.test.js ui/nextjs/tests/conversation-create.test.js backend/tests/unit/project-request-context.test.js`
   - Log Receipts: `LOG-130d21e5-2129-45dd-bb22-d22f1673d754`, `LOG-c438c353-f9ca-464a-a49f-02b801a2db08`
4. **Kiểm thử System Engineer SDK Transcript & Events (`PASS`, `exit_code: 0`):**
   - Lệnh: `node --test backend/tests/unit/system-engineer-sdk-transcript.test.js backend/tests/unit/system-engineer-sdk-events.test.js backend/tests/unit/system-engineer-sdk-tools.test.js`
   - Log Receipt: `LOG-817a584b-2a5e-43f3-afb0-40169aa03260`
5. **Kiểm thử Phần 1 (`Ordinary Verification Write Sandbox`) & Phần 2 (`Verification Environment Seam`) (`PASS`, `exit_code: 0`):**
   - Lệnh: `node --test backend/tests/unit/ordinary-verification-sandbox.test.js backend/tests/unit/verification-environment-seam.test.js backend/tests/unit/filesystem-namespace-runner.test.js backend/tests/unit/filesystem-verification-command.test.js backend/tests/unit/ticket-verification-output.test.js backend/tests/unit/ticket-verification-command-receipts.test.js backend/tests/unit/ticket-verification-runner-revision.test.js`
   - Log Receipts: `LOG-17400ebd-67db-462c-8e6c-6103f822c12d`, `LOG-ee6068dc-032f-4af0-8bb8-63aab05fd9e0`
   - Watcher Verification Receipts: `VERIFY-RUN-0f5a719c-cbd3-4266-96a7-ee9814049f79`, `VERIFY-RUN-97633dda-1fd9-4ad0-8650-eb5b04615946`, `VERIFY-RUN-9e1858c2-3662-4d47-9cf2-870168a32b89`
6. **ESLint (`PASS`, `exit_code: 0`):**
   - Lệnh 1 (Context Compaction & Directive Inbox): `pnpm exec eslint --rulesdir eslint-rules backend/src/modules/supervisor/ticket/ticket-context-compaction.js backend/src/modules/supervisor/ticket/ticket-directive-inbox.js backend/src/modules/supervisor/ticket/ticket-read-cache.js backend/src/modules/supervisor/ticket/ticket-resume.js backend/src/modules/supervisor/ticket/ticket-work-progress.js backend/src/modules/supervisor/ticket/ticket-sdk-turns.js backend/src/modules/supervisor/function-calling-task-executor.js backend/src/modules/supervisor/nodeforge-task-executors.js backend/tests/unit/ticket-context-compaction.test.js backend/tests/unit/ticket-directive-inbox.test.js` (`LOG-66ec41ee-13e5-4553-8930-1d31de201f9c`)
   - Lệnh 2 (Phần 1 Sandbox & Phần 2 Seam): `pnpm exec eslint --rulesdir eslint-rules backend/src/modules/supervisor/ordinary-verification-sandbox.js backend/src/modules/supervisor/verification-environment-seam.js backend/src/modules/supervisor/filesystem-namespace-runner.js backend/src/modules/supervisor/ticket/ticket-verification-command.js backend/src/modules/supervisor/ticket/ticket-archive-materialization.js backend/src/modules/supervisor/ticket/ticket-verification-command-receipts.js backend/src/modules/supervisor/ticket/ticket-workspace-service.js backend/tests/unit/ordinary-verification-sandbox.test.js backend/tests/unit/verification-environment-seam.test.js` (`LOG-3e3c6aa1-35ac-4354-8ced-ee3a1ea1db6c`, `LOG-55390ff9-81de-46e9-a217-60f1eb63de5e`)

---

## 4. Giới hạn còn lại & Hành động tiếp theo

- **Giới hạn tồn đọng ngoài phạm vi:**
  - Trong `backend/tests/unit/function-calling-task-executor.test.js`, case `compatible Coder keeps scope, schema, workflow and completion restrictions` đang fail sẵn từ trước do đường dẫn `workflows/agents/coder/README.md` đã được chuyển vào `docs/archive/workflows/` ở Phần A nên `isProtectedPath` không còn khớp đường dẫn cũ.
  - Chưa thực hiện `commit_changes` / `push_commit` hoặc restart tiến trình Control API khi chưa có lệnh trực tiếp từ Owner.
- **Khuyến nghị cho Owner:**
  - Chạy `/r api` trên màn hình điều khiển để tiến trình Control API nạp toàn bộ các module mới, sau đó có thể thực hiện **Commit & Push** trên UI hoặc chỉ đạo SE commit/push trực tiếp.
