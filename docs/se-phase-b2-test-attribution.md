<!-- Báo cáo đối chiếu lỗi test của cụm B.2 dành cho Owner và AM, dùng snapshot đúng checksum trước di chuyển và cùng môi trường để phân biệt nguồn gốc lỗi với trạng thái nghiệm thu. -->
# Đối chiếu test B.2 — 2026-10-29

Người nhận: Owner và Architecture Manager. Nguồn yêu cầu: [handoff Phần B](se-phase-b-source-restructuring-handoff.md), Mục 3 và Mục 5.

## Kết quả

- Chạy 86 file test bị ảnh hưởng, chia 5 batch theo giới hạn command của Forge: 27 failure trên 17 file.
- Chạy lại 17 file lỗi trên hai cây archive dùng cùng môi trường: snapshot ngay trước B.2 và source sau B.2. Cả hai tái hiện cùng 27 failure.
- Hash assertion giống nhau sau chuẩn hóa riêng đường dẫn đã di chuyển. Mọi nội dung assertion giữ nguyên.
- Lưu đủ khối TAP của hai cây. Phép so sánh chỉ chuẩn hóa đường dẫn archive/di chuyển, duration và frame nội bộ `process.processTicksAndRejections` không ổn định; giữ error, expected, actual, operator và các frame source.
- Diagnostic PASS: `VERIFY-RUN-0cc73fee-6548-41cf-86e9-33a83901ad54`. Các test rộng vẫn FAIL; diagnostic chỉ xác định nguồn gốc.
- [Khối lỗi đầy đủ](../.forge/runtime/reports/phase-b2-failure-comparison.json), [5 receipt thực tế](../.forge/runtime/reports/phase-b2-test-batches.json), [receipt đối chiếu và lượt đầu khác frame Node](../.forge/runtime/reports/phase-b2-comparison-receipts.json).
- Runner diagnostic: [compare-source-restructuring.mjs](../backend/scripts/compare-source-restructuring.mjs), chạy bằng `node --test backend/scripts/compare-source-restructuring.mjs`. Script cần snapshot runtime của đợt này và nằm ngoài suite unit mặc định.

## Các file lỗi đã đối chiếu

| Test file | Failure | Dấu hiệu thực tế |
| --- | ---: | --- |
| [git-read-tools.test.js](../backend/tests/tools/git-read-tools.test.js) | 1 | coder Git reads exclude docs and include schema changes |
| [agent-line-budget-integration.test.js](../backend/tests/unit/agent-line-budget-integration.test.js) | 1 | object-expression division permits boundary writes and edits with accurate metadata |
| [coder-path-permissions.test.js](../backend/tests/unit/coder-path-permissions.test.js) | 1 | coder can edit schemas and read docs but cannot write docs through a prefix grant |
| [reviewer-discovery-tools.test.js](../backend/tests/unit/reviewer-discovery-tools.test.js) | 1 | Reviewer owner chat uses canonical Forge tools including read-only Git |
| [system-engineer-forge-storage.test.js](../backend/tests/unit/system-engineer-forge-storage.test.js) | 1 | SE Forge access includes hidden runtime files but rejects symlinks and retains other roles' boundaries |
| [coder-unified-forge-tools.test.js](../backend/tests/unit/coder-unified-forge-tools.test.js) | 1 | Coder canonical read_file returns bounded source, checksum and scope denial |
| [coder-reviewer-capabilities.test.js](../backend/tests/unit/coder-reviewer-capabilities.test.js) | 2 | O1: Coder can read docs/** outside allowed_file_paths while writes to docs/** remain blocked unless explicitly allowed; O3: pre-commit run_check materializes working ledger overlay with pre_commit: true, and authorized_create_prefixes + rollback unlink new files |
| [coder-tool-quota.test.js](../backend/tests/unit/coder-tool-quota.test.js) | 1 | Coder quota removal preserves authorization, Stop and original tool errors |
| [compatible-role-tools.test.js](../backend/tests/unit/compatible-role-tools.test.js) | 4 | ollama architecture_manager blocker investigation receives seven read-only tools; ollama sprint_leader blocker investigation receives seven read-only tools; openai architecture_manager blocker investigation receives seven read-only tools; openai sprint_leader blocker investigation receives seven read-only tools |
| [owner-sdk-tools.test.js](../backend/tests/unit/owner-sdk-tools.test.js) | 3 | owner search schemas and execution agree on nested directories and files; Architecture Manager delete invalidates the shared code cache after File Service success; read_file returns cached Markdown content for Architecture and Coder while code stays metadata-only |
| [agent-code-cache.test.js](../backend/tests/unit/agent-code-cache.test.js) | 2 | Sprint Leader shares CodeCacheService across search_text, read_file and read_lines; blocker SL and AM reuse project cache and reject a path replaced by a symlink |
| [blocker-dependency-evidence.test.js](../backend/tests/unit/blocker-dependency-evidence.test.js) | 2 | agent dependency reads and evidence validation agree without weakening the normal FileService boundary; every role can read dependencies but cannot overwrite, edit, create or delete their contents |
| [browser-verification.test.js](../backend/tests/unit/browser-verification.test.js) | 2 | browser tools load root dependencies and never fall back to runtime copies; verification service persists browser evidence and rejects missing receipts before artifact reuse |
| [claude-file-tools.test.js](../backend/tests/unit/claude-file-tools.test.js) | 1 | Claude coder discovery obeys ticket scope under runtime governance |
| [dependency-agent-read.test.js](../backend/tests/unit/dependency-agent-read.test.js) | 2 | all coding roles discover and read backend/UI package links while bypassing the source cache; production Coder and Reviewer registries expose the same dependency reads and bounded discovery |
| [owner-engineer-tools.test.js](../backend/tests/unit/owner-engineer-tools.test.js) | 1 | System Engineer uses Node services for edit, checks, exact-path commit, push, and terminal logs |
| [purpose-summary-search-compatibility.test.js](../backend/tests/integration/purpose-summary-search-compatibility.test.js) | 1 | purpose summaries supplement search projections and preserve structural context |

## Các cổng khác của B.2

- SDK/security comparison/gitkeep PASS: `VERIFY-RUN-1d66a6df-d795-41f1-8854-373dd41850a7`.
- Lint các file bị ảnh hưởng PASS qua 10 batch; [receipt](../.forge/runtime/reports/phase-b2-lint-receipts.json).
- Typecheck PASS `VERIFY-RUN-6a915a46-29b6-4ee5-bf97-396bf4c80d6d`; schema PASS `VERIFY-RUN-99fe9e86-3566-4f23-a58c-9ee7ffa4ed47`; bootstrap entrypoint PASS `VERIFY-RUN-8d13a916-2243-4811-a5e5-81255f44ce73`.
- Benchmark sau B.2 PASS `VERIFY-RUN-9e509ec1-27d5-4ffa-92e6-24400e9bc537`, đủ 11/11 case. R@4 0,2121; P@4 0,1364; R@8 0,3712; P@8 0,1023; hub 0/11. Điểm, `missing` và semantic_matches của từng case đều bằng baseline chính thức. Semantic_matches vẫn là 0; bằng điểm không chứng minh semantic đã được cải thiện.
- Lượt benchmark đầu timeout 600 giây ở 7/11 case. Giữ [lượt timeout](../.forge/runtime/reports/phase-b2-retrieval-timeout.json) và [lượt hoàn tất](../.forge/runtime/reports/phase-b2-retrieval-retry.json).
- [Bảng tổng hợp](../.forge/runtime/reports/phase-b2-verification-summary.json) và [tiến độ chung](se-repo-restructuring-progress.md).

## Quyết định từ Owner & AM (2026-10-29) — NGHIỆM THU B.0, B.1, B.2 & CHO PHÉP CHUYỂN SANG B.3

1. **Công nhận nghiệm thu Bước B.0, B.1 và B.2 (`PASS`):**
   - **B.0:** `VERIFY-RUN-af4b5e4c-220f-4fd2-98c5-ec3894863458` (`PASS`).
   - **B.1:** Đã chuyển `agent-stream-bridge.js`, đổi tên `supervisor-adapter-registry.js`, dọn 3 module không còn consumer; smoke test `VERIFY-RUN-9224d15e-b889-45c1-99d3-95db1c76e8ea` (`PASS`) và Retrieval Benchmark B.1 `VERIFY-RUN-7eeb2642-28ba-40c5-8f75-dc28ae852fc1` (`11/11`, khớp 100% baseline).
   - **B.2:** Đã di chuyển 43 module vào 4 miền (`discovery`, `roles`, `reporting`, `governance`), giữ `tools/execution-file-access.js` theo ngoại lệ security baseline, cập nhật 154 file; lint 10 batch (`PASS`), typecheck `VERIFY-RUN-6a915a46-29b6-4ee5-bf97-396bf4c80d6d` (`PASS`), schema `VERIFY-RUN-99fe9e86-3566-4f23-a58c-9ee7ffa4ed47` (`PASS`), bootstrap `VERIFY-RUN-8d13a916-2243-4811-a58c-9ee7ffa4ed47` / `8d13a916-2243-4811-a5e5-81255f44ce73` (`PASS`), và Retrieval Benchmark B.2 `VERIFY-RUN-9e509ec1-27d5-4ffa-92e6-24400e9bc537` (`11/11`, khớp 100% baseline).
2. **Quyết định về 27 lỗi trên 17 file test (`VERIFY-RUN-0cc73fee-6548-41cf-86e9-33a83901ad54`):**
   - Phép đối chiếu bằng `backend/scripts/compare-source-restructuring.mjs` trên cùng môi trường (`environment_sha256` đồng nhất) với snapshot đúng checksum ngay trước B.2 đã chứng minh **100% các lỗi này (27 failures / 17 files) là lỗi tồn đọng trên working tree trước B.2** (do các thay đổi runtime đồng thời ngoài phạm vi như nâng `READ_TOOLS` từ 7 lên 8 với `lookup_schema`, mở quyền đọc `docs/` và `.gitkeep` qua `coder-project-access.js` / `protected-path-policy.js`). Việc tái cấu trúc B.2 **không gây ra bất kỳ lỗi hồi quy mới nào**.
   - **Quyết định của AM:** **KHÔNG** sửa runtime policy và **KHÔNG** sửa kỳ vọng của 17 file test này trong lúc đang làm Phần B để giữ ranh giới tái cấu trúc thuần túy (pure structural refactoring). Chính thức áp dụng nguyên tắc **No-New-Failure Attribution** cho cả B.2 và toàn bộ 6 đợt của B.3 (đã cập nhật vào Mục 5 của `docs/se-phase-b-source-restructuring-handoff.md`): mọi bài test ngoài danh sách tồn đọng phải `PASS`, và bất kỳ bài test nào chạm tới 17 file tồn đọng chỉ cần chứng minh bằng snapshot ngay trước cụm di chuyển rằng không phát sinh failure mới.
3. **Về `backend/src/modules/agents/.gitkeep`:**
   - Code policy `isProjectGitkeepPath` trong `protected-path-policy.js` đã hỗ trợ `.gitkeep` dưới mọi thư mục thường, chỉ chờ tiến trình API/MCP nạp lại. SE không bị chặn bởi file placeholder này: có thể thử xóa lại sau khi API được restart (hoặc ở bước dọn cuối Phần B), không cản trở việc triển khai Bước B.3 ngay bây giờ.
4. **Hành động tiếp theo:** SE bắt đầu triển khai ngay **Bước B.3 (6 đợt cuốn chiếu `B.3.1` $\rightarrow$ `B.3.6` trong `backend/src/modules/supervisor/`)** theo `docs/se-phase-b-source-restructuring-handoff.md`.
