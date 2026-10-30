<!-- Báo cáo triển khai và kiểm chứng mở rộng năng lực ngữ cảnh, chẩn đoán sớm và nghiệm thu linh hoạt cho Coder & Reviewer (Outcomes O1–O6). -->
# Coder & Reviewer Capabilities Expansion — Implementation Report

Ngày triển khai và kiểm chứng: **2026-10-21 (UTC)**.
Tài liệu cơ sở: `workflows/discussion-coder-reviewer-capabilities.md` và `workflows/discussion-coder-reviewer-capabilities-feedback.md`.
Trạng thái: **HOÀN TẤT (`O1`–`O6`) — Toàn bộ 79/79 focused tests PASS**.

---

## 1. Tóm tắt phạm vi và kết quả triển khai theo Outcomes (`O1`–`O6`)

| Outcome | Nội dung yêu cầu | Chi tiết triển khai kỹ thuật | Trạng thái |
|---|---|---|---|
| **O1** | **Coder: Đọc ngữ cảnh kiến trúc (`docs/**`) & chẩn đoán lỗi của chính ticket (`check_test`)** | - Cập nhật `isCoderBlockedPath` và `isAgentPathAllowed` (`backend/src/tools/tool-authorization.js`) nhận tham số `{ operation = "read" \| "write" }`.<br>- Cho phép role `coder` đọc (`operation: "read"`) trong `docs/` và `docs/**` ngay cả khi không liệt kê trong `allowed_file_paths`, đồng thời giữ chặn ghi (`operation: "write"`) vào `docs/**` trừ khi ticket cấp phép tường minh. Các đường dẫn `workflows/**`, `.nodeforge/**`, `.git/**` vẫn bị khóa.<br>- Truyền `{ operation: "read" }` tại các công cụ đọc/tìm kiếm (`agent-lifecycle-tools.js`, `sed-lines.js`, `search-code.js`, `engineering-tool-implementations.js`).<br>- Mở rộng `getTestResult` (`ticket-verification-service.js`) và `check_test` (`agent-verification-tools.js`) để đọc cả `VERIFY-...` và `CHECK-...` receipts thuộc cùng `task_id`, trả về `stdout_redacted` và `stderr_redacted` đã qua `safeOutput`, và từ chối truy cập chéo ticket với mã lỗi `TEST_JOB_FORBIDDEN`. | **PASS** |
| **O2** | **Coder: Gia hạn pre-edit discovery có điều kiện & hỗ trợ `needs_context`** | - Trong `assertDiscoveryBudget` (`exploration-state.js`), khi chạm `edit_must_start_by` hoặc giới hạn theo loại (`typeLimitFor`), nếu `unproductive_streak === 0`, `preedit_extensions < 1` và có khai báo `target_symbol` / `symbol` / `reason`, hệ thống cấp đúng `+1` lượt gia hạn đồng bộ cho cả `state.edit_must_start_by` lẫn `read_limit` / `search_limit` / `candidate_limit`.<br>- Truyền `target_symbol`/`symbol`/`reason` từ `runtime-tool-governance.js` vào `context.discovery_extension_reason`.<br>- Mở rộng `schemas/agent/tools/report-done.schema.json` và `agent-report-tool.js` hỗ trợ `status: "needs_context"` (lưu report và phát mã `CODER_NEEDS_CONTEXT`). | **PASS** |
| **O3** | **Coder: Chạy `run_check` trước commit (`pre_commit: true`) & tạo file trong `authorized_create_prefixes`** | - Mở rộng `createTicketFocusedCheck` (`ticket-focused-check.js`) và `materializeTicketVerification` (`ticket-verification-materialization.js`): khi `context.review_commit_sha === null`, tự động đồng bộ manifest từ working ledger, kiểm tra SHA-256 trên đĩa khớp với `latest_sha`, giải nén archive từ `context.base_sha` rồi overlay trực tiếp các file sửa/mới/xóa (`null`) từ ledger, và ghi receipt với `pre_commit: true, commit_sha: null`.<br>- Bảo vệ cổng nghiệm thu: `assertPassedArtifact` (`ticket-verification-service.js`) và `assertTicketReviewEvidence` (`ticket-review-evidence.js`) từ chối mọi artifact có `pre_commit === true` hoặc thiếu `commit_sha`.<br>- Bổ sung `authorized_create_prefixes` và `mutable_file_budget` trong `ticket-execution-context.js` và `engineering-tool-binding.js`.<br>- Trong `ticket-change-ledger.js` (`rollback` và `release(..., { rollback: true })`), mọi file tạo mới (`initial_sha === null`) được `unlink` sạch khỏi working tree khi rollback. | **PASS** |
| **O4** | **Reviewer: Ngân sách đọc co giãn, giữ symbol outline, `review_diff` & thu gọn prompt lớn** | - Trong `reviewer-forge-tools.js`, ngân sách đọc tự động co giãn theo số file của manifest: `maxOutputBytes = Math.min(384_000, 128_000 + manifestCount * 16_000)`.<br>- Khi đọc committed file trong `reviewCache.read`, khôi phục `code_index` / `symbols` từ `codeCache` (nếu khớp SHA-256) hoặc trích xuất AST qua `extractorRegistry.extract(path, file.content)` để bảo toàn `symbol_map` và đọc theo cửa sổ `{ path, symbol }`.<br>- Bổ sung tool `review_diff` trả unified diff theo từng file giữa `base_sha` (hoặc `previous_review_commit`) và `review_commit_sha`.<br>- Trong `review-worker.js`, khi tổng dung lượng `Changed files` vượt quá `64 KB` (`64_000` bytes), prompt khởi tạo tự động rút gọn phần `Changed files` thành metadata (`path, sha256, deleted, line_count, notice`). | **PASS** |
| **O5** | **Reviewer: Chạy kiểm tra độc lập chỉ-đọc (`run_review_check`)** | - Bổ sung tool `run_review_check` trong `reviewer-forge-tools.js`, cho phép chạy lệnh `test`/`lint`/`typecheck` hợp lệ (qua `assertFocusedCheckCommand`) trên snapshot cô lập của `review_commit_sha` với giới hạn tối đa **2 lần/review** (`REVIEW_CHECK_BUDGET`), tự động dọn dẹp thư mục tạm trong khối `finally` và không ghi đè verification artifact của Coder. | **PASS** |
| **O6** | **Reviewer: Duyệt kèm tách backlog (`defer_to_backlog: true`) cho lỗi `minor` khi Gate ON** | - Cập nhật `review-finding-guidance.js`, `review-verdict-request.js` và `ticket-review-findings.js` cho phép `verdict: "approved"` đi kèm các finding có `severity === "minor"` và `defer_to_backlog === true` (lưu trạng thái `status: "deferred_to_backlog"`). Mọi finding `blocker`/`major` hoặc `minor` không có `defer_to_backlog: true` vẫn bị chặn khi `approved`.<br>- Cập nhật ` publishAutomaticReviewOutcome` (`automatic-review-audit.js`) để tự động tạo các mục backlog độc lập (deduplicate theo `job_key + finding_id`, `priority: "low"`) trong hàng đợi `review.backlog` ngay cả khi `review_gate: "on"`. | **PASS** |

---

## 2. Kết quả kiểm chứng (Focused Verification)

Đã chạy bộ kiểm thử tập trung gồm file test mới (`coder-reviewer-capabilities.test.js`) và 9 bộ unit/integration test liên quan trực tiếp tới các module vừa sửa:

```bash
node --test \
  backend/tests/unit/coder-reviewer-capabilities.test.js \
  backend/tests/unit/ticket-focused-check.test.js \
  backend/tests/unit/reviewer-forge-tools.test.js \
  backend/tests/unit/runtime-tool-governance.test.js \
  backend/tests/unit/ticket-execution-context.test.js \
  backend/tests/unit/review-finding-guidance.test.js \
  backend/tests/unit/ticket-review-findings.test.js \
  backend/tests/unit/automatic-ticket-review.test.js \
  backend/tests/unit/review-worker.test.js \
  backend/tests/integration/ticket-change-ledger.test.js
```

- **Tổng số tests:** `79`
- **Kết quả:** `79 pass`, `0 fail`, `0 skipped`
- **Các kịch bản kiểm thử mới trong `backend/tests/unit/coder-reviewer-capabilities.test.js`:**
  1. `O1`: Coder đọc được `docs/**` ngoài `allowed_file_paths`, bị chặn ghi vào `docs/**` trừ khi được cấp phép tường minh, và bị chặn đọc `workflows/**`.
  2. `O1`: `check_test` trả về `stdout_redacted`/`stderr_redacted` cho cùng `task_id` và chặn truy cập chéo ticket với `TEST_JOB_FORBIDDEN`.
  3. `O2`: Gia hạn pre-edit discovery `+1` đồng bộ cho cả `read_limit` và `edit_must_start_by` khi có `target_symbol` và `unproductive_streak === 0`, từ chối gia hạn lần 2, và hỗ trợ `report_done({ status: "needs_context" })`.
  4. `O3`: `run_check` ở chế độ pre-commit overlay working ledger lên `base_sha` và sinh receipt `pre_commit: true, commit_sha: null`; tạo file mới trong `authorized_create_prefixes` và tự động `unlink` khi rollback.
  5. `O4 & O5`: Ngân sách đọc co giãn (`288,000` bytes cho 10 files), bảo toàn symbol map & đọc theo symbol trên committed file, cung cấp `review_diff` và giới hạn `run_review_check` tối đa 2 lần/review (`REVIEW_CHECK_BUDGET`).
  6. `O6`: Duyệt `verdict: "approved"` kèm `minor` finding có `defer_to_backlog: true` khi `gate: "on"`, từ chối `major` finding khi `approved`, và tự động đẩy mục follow-up vào `review.backlog`.

---

## 3. Danh mục các file đã sửa đổi & tạo mới (kèm dòng và SHA-256)

Tất cả các file viết mới và các module giới hạn đều tuân thủ quy tắc `<= 250 dòng` và có summary comments theo `CLAUDE.md`.

| File | Số dòng | SHA-256 |
|---|---:|---|
| `backend/src/tools/tool-authorization.js` | 37 | `sha256:5ea1cff0db9cfdc2c015d08f942085338ddaabc9ec76e7662e12a07fff70a789` |
| `backend/src/tools/agent-lifecycle-tools.js` | 226 | `sha256:90bb9af5a6ca913475e2c1b8ea5149bce99952bf6ae05e6c8be98572b0664b8f` |
| `backend/src/tools/sed-lines.js` | 183 | `sha256:b2be409db62e242a376f94dcbb78f14d2f1f9c21e70080852a7dfab01f3f1024` |
| `backend/src/tools/search-code.js` | 135 | `sha256:7f4a49fc1e17f73ecbb91aa1bc52da66017580f63b521843634f6031323922ae` |
| `backend/src/tools/engineering-tool-implementations.js` | 26 | `sha256:a3e64170691db556e962ef083cb74b0d3bc26b8424ed92b34d2bffa9edf14787` |
| `backend/src/tools/agent-verification-tools.js` | 102 | `sha256:1e77374b0ca0e4ecbbd38a4292024d4eb4ea86bdecb1a1563dbb407cb02fc0b1` |
| `backend/src/tools/engineering-tool-binding.js` | 86 | `sha256:ea462d92c5acb48755f3d61397cea835cb796d433c16362fd4664865ced5755c` |
| `backend/src/modules/governance/runtime-tool-governance-state.js` | 139 | `sha256:76c0031257fbbbbd675ca356bf11e3e77ba49cb19466f09b402431f735b9874e` |
| `backend/src/modules/governance/runtime-tool-governance.js` | 185 | `sha256:9ad527401bcb39495c4947ef1cca7ea35f08fc2fc9dc185e9a257e4fc839c0ab` |
| `backend/src/modules/supervisor/ticket-verification-service.js` | 249 | `sha256:21415c85238b74fe91237ff0398fe98feb80f0f854486f2a1f29e6fd27be88d3` |
| `backend/src/tools/exploration-state-factory.js` | 87 | `sha256:75e08da4c02dc7c5b30b1f59dca9983daab716119d92d5268e3caa9b632c6267` |
| `backend/src/tools/exploration-state.js` | 228 | `sha256:46b1b13d6441bc5b9f9480babef6baf9caf5206a5b278629a9ce93e9c5ed5022` |
| `schemas/agent/tools/report-done.schema.json` | 38 | `sha256:df5a4a8e07609c7469c88d9a9d6183ea076b8f6468cc926f0b01f95ebcd230f7` |
| `backend/src/tools/agent-report-tool.js` | 221 | `sha256:1e6e84e3d3f7b58aa879ab6148b0b7d56ba0cd0597d3232b2cf9f7f9578f62ee` |
| `backend/src/modules/supervisor/ticket-verification-materialization.js` | 62 | `sha256:3d43baecba6bd6d27e480f4300d7844a25959f2da010cf0fd75c088a1736549e` |
| `backend/src/modules/supervisor/ticket-focused-check.js` | 65 | `sha256:72553ce3c036b9c8aa3d0e3dc18b3fc9945be599f0bdca521eb22ee943ca36b8` |
| `backend/src/modules/supervisor/ticket-review-evidence.js` | 40 | `sha256:5e85afbf147c773395b59b86542d5e7314c7938b73332815b0ba52eb9623a71c` |
| `backend/src/modules/supervisor/ticket-execution-context.js` | 144 | `sha256:4b089547da279fac8181d4e6e4a57f8ed6d89e53d2279047fdeb6d2a4f06a47d` |
| `backend/src/modules/supervisor/ticket-change-ledger.js` | 317 | `sha256:364723efead5c2bf6b2626d847d5f24a40fe9b8b667256514dbec00edefb2026` |
| `backend/src/modules/supervisor/ticket-workspace-service.js` | 191 | `sha256:6688ff1b21cc8eb459bf43bf294d1707502b4f2994087035d7c129ae4aaf9298` |
| `backend/src/modules/supervisor/ticket-root-workspace.js` | 132 | `sha256:47adeeb99ff4bff1ef1ede06a367181eb2642f5d148f3c8c0598b31075a1ba53` |
| `backend/src/modules/supervisor/reviewer-forge-tools.js` | 249 | `sha256:8faa173f873638a35bc68f4f7b325565fc758a9cc5d38193c14d4db5731e5dbd` |
| `backend/src/modules/supervisor/review-worker.js` | 225 | `sha256:8bf06fa771377be3733672cb43eae246bea3d5ad65e05690201eb889f42d67cd` |
| `backend/src/modules/supervisor/review-finding-guidance.js` | 72 | `sha256:bb1bc05e2121dd13529c83ae66866dd71d13a38d7f2ca3ea2504025f4ee63492` |
| `backend/src/modules/supervisor/review-verdict-request.js` | 41 | `sha256:75db1a417b38a71d5d83517bbad63352d8f96cc0667f0c342fbc170d91dc280e` |
| `backend/src/modules/supervisor/ticket-review-findings.js` | 224 | `sha256:bed3312dfd3f701b9733e9cbaf9e4757deef1bfee08db5aa2d7d666a95e29813` |
| `backend/src/modules/supervisor/automatic-review-audit.js` | 56 | `sha256:217fd280ea8519ee92a59bf7a7cf9d832653770590a06d3e98e4b3ea645e39b7` |
| `backend/tests/unit/coder-reviewer-capabilities.test.js` | 246 | `sha256:7f75c818027e55b4e24d528da8d9f388cac6fc88fc0c7b5e7d2ae38249e7c63d` |

---

## 4. Trạng thái Git & Lưu ý vận hành

- Giữ nguyên toàn bộ thay đổi trên working tree, chưa thực hiện `git commit` hay `git push` theo đúng nguyên tắc vận hành (chỉ commit/push khi Owner yêu cầu).
- Báo cáo này được lưu tại `workflows/report-coder-reviewer-capabilities.md`.
