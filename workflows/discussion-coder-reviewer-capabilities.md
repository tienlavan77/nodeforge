<!-- Tóm tắt thảo luận kiến trúc (đã hợp nhất phản biện kỹ thuật của SE) về việc mở rộng quyền đọc ngữ cảnh, chẩn đoán sớm và nghiệm thu linh hoạt cho Coder và Reviewer. -->
# Discussion Summary: Mở rộng năng lực ngữ cảnh, chẩn đoán sớm và nghiệm thu linh hoạt cho Coder & Reviewer

## 1. Mục tiêu / Kết quả mong đợi

- **Vấn đề:**
  - **Coder** đang bị chặn đọc `docs/` (`backend/src/tools/tool-authorization.js:21-32`), bị ép phải gọi tool edit (`edit_diff`/`write_diff`) ngay khi chạm trần pre-edit discovery (`backend/src/tools/exploration-state.js:89-114`), không có quyền chạy `run_check` trước khi tạo Git commit (`backend/src/modules/supervisor/ticket-focused-check.js:18-23`), không tự đọc được chi tiết stdout/stderr đã redact của các lần verification/check vừa fail trên chính ticket của mình, và không thể tách file helper/test mới khi chạm giới hạn 250 dòng (`CLAUDE.md`) nếu đường dẫn file mới chưa nằm trong baseline manifest tĩnh (`backend/src/modules/supervisor/ticket-execution-context.js:30-34, 71-84`).
  - **Reviewer** bị giới hạn cứng `MAX_OUTPUT_BYTES = 128_000` và mất symbol map (`index_status: "unavailable"`) khi đọc file thuộc committed review evidence (`backend/src/modules/supervisor/reviewer-forge-tools.js:17, 46-51`), thiếu tool xem diff chuẩn theo commit cho từng file (`git_diff` hiện chỉ đọc working tree tại `backend/src/modules/supervisor/review-worker.js:61`), không có công cụ chạy kiểm tra độc lập chỉ-đọc trên snapshot `review_commit_sha`, và ở chế độ `review_gate: "on"` phải chọn giữa chặn toàn bộ ticket (`request_changes`) hoặc bỏ qua lỗi nhỏ (`minor`).
- **Kết quả mong đợi:** Mở đúng các quyền đọc ngữ cảnh kiến trúc, chẩn đoán sớm trước commit, tách file trong vùng được ủy quyền và nghiệm thu tách backlog cho lỗi nhỏ đối với Coder & Reviewer bên trong hàng rào bảo mật/provenance của NodeForge.
- **Giá trị:** Giảm số vòng lặp sửa mù (`repair round`), giúp Coder tuân thủ quy tắc ≤ 250 dòng/file của `CLAUDE.md` mà không vướng lỗi scope tĩnh, giúp Reviewer kiểm tra chính xác các ticket nhiều file mà không tràn budget đọc, và tránh nghẽn pipeline vì các góp ý nhỏ (`minor`).

---

## 2. Phạm vi (Scope)

### In scope
- **Nhóm quyền Coder (`O1`–`O3`):**
  1. Mở quyền read-only vào `docs/` (phân tách rõ `operation: "read"` và `"write"` trong `isAgentPathAllowed`) và cung cấp khả năng đọc verification/diagnostic receipts lịch sử (đã redact secret) thuộc chính `task_id` đang thực thi.
  2. Thay cơ chế ép buộc gọi tool edit khi chạm trần pre-edit discovery bằng cơ chế xin gia hạn discovery có điều kiện (khai báo rõ `target_symbol`/contract cần tra cứu, tăng đồng bộ cả `edit_must_start_by` lẫn `read_limit`/`search_limit`) hoặc trả trạng thái `needs_context`, đồng thời giữ nguyên cơ chế chặn lặp vô ích (`unproductive_streak`).
  3. Cho phép chạy `run_check` trên working ledger trước khi `commit_changes` (giải nén `base_sha` rồi overlay `manifest_paths` từ ledger, sinh receipt gắn cờ `pre_commit: true`), và cho phép tạo/tách file helper hoặc test mới trong `authorized_create_prefixes` khi SL cấp trong ticket contract (tuân thủ tổng `mutable_file_budget`, file lock và `unlink` các entry `initial_sha: null` khi rollback).
- **Nhóm quyền Reviewer (`O4`–`O6`):**
  4. Tự động co giãn `MAX_OUTPUT_BYTES` theo quy mô manifest (cơ sở 128 KB + 16 KB/file, trần 384 KB), khôi phục symbol outline/metadata từ `codeCache`/AST extractor khi đọc committed file trong `reviewCache`, bổ sung tool `review_diff` đọc diff theo từng file từ retained Git commits (`base_sha` / `previous_review_commit` -> `review_commit_sha`), và giảm tải prompt khởi tạo khi tổng dung lượng `files` lớn (> 64 KB).
  5. Cung cấp tool kiểm tra độc lập chỉ-đọc (`run_review_check`) chạy trên archive cô lập của `review_commit_sha` (tối đa 1–2 lần/review, không ghi đè verification artifact của Coder).
  6. Hỗ trợ duyệt kèm tách backlog cho lỗi nhỏ (`verdict: "approved"` kèm finding `severity: "minor"`, `defer_to_backlog: true`) khi `review_gate: "on"` (cập nhật cả validator trong `review-verdict-request.js` và `reviewFindings.validateReview`), tự động ghi vào `.forge/runtime/queues/review.backlog.json` (dedupe theo `job_key + finding_id`).

### Out of scope (Giữ nguyên ranh giới cấm)
- Không cho Coder hoặc Reviewer sửa `acceptance_criteria`, `execution_policy`, hoặc tự ký approval.
- Không cho Reviewer quyền sửa code (`write_diff`/`edit_diff`/`delete_file`) hay tạo Git commit.
- Không cho Coder tự đóng (`fixed`/`withdraw`) finding của Reviewer.
- Không mở quyền đọc/ghi `.forge/` trực tiếp qua file tool (`read_file`/`write_diff`), không đọc secrets, không xóa/reset Git history nhánh chung.

---

## 3. Quyết định đã thống nhất, Guardrails & Chi tiết tích hợp (Hợp nhất phản biện SE)

1. **Tách biệt quyền Read và Write trên `docs/` cho Coder (`O1` — SE Gap #1):**
   - Bổ sung phân biệt `{ operation = "read" | "write" }` trong `isAgentPathAllowed` (`backend/src/tools/tool-authorization.js:21-32`).
   - Với `operation === "read"`: cho phép Coder đọc/tìm kiếm trong `docs/` và `docs/**` (vẫn qua `assertRoleFileAccess` để chặn symlink và secret), bất kể `context.allowed_file_paths` của ticket có liệt kê `docs/` hay không.
   - Với `operation === "write"`: giữ nguyên chặn ghi vào `docs/` trừ khi path nằm rõ ràng trong `allowed_file_paths` của ticket manifest.
2. **Truy cập có kiểm soát vào kết quả chẩn đoán (`verification/check receipts` — `O1`):**
   - Coder chỉ được đọc stdout/stderr đã qua `safeOutput` (redacted) của chính `task_id` hiện tại thông qua tool chuyên biệt do Node kiểm soát, tuyệt đối không mở đường dẫn `.forge/runtime/` cho file tool chung.
3. **Đồng bộ 3 tầng giới hạn khi gia hạn Pre-edit Discovery (`O2` — SE Gap #2):**
   - Trong `exploration-state.js:89-110`, `assertDiscoveryBudget` kiểm tra 3 tầng nối tiếp (`typeLimitFor` -> `edit_must_start_by` -> `discovery_limit`).
   - Khi chạm `edit_must_start_by`, nếu Coder khai báo rõ `target_symbol` / lý do tra cứu contract và `unproductive_streak === 0`, hệ thống cấp gia hạn có điều kiện bằng cách **tăng đồng bộ cả `state.edit_must_start_by` lẫn `state.read_limit` / `state.search_limit`** tương ứng để tránh chết ngay ở `EXPLORATION_TYPE_BUDGET_EXHAUSTED`; hoặc cho phép trả trạng thái `needs_context` thay vì ép sửa mù.
4. **Cơ chế Materialize từ Working Ledger cho `pre_commit` check (`O3` — SE Gap #3):**
   - Khi `context.review_commit_sha === null` (chế độ `pre_commit: true`), `run_check` gọi `syncManifest` từ `changeLedger`, giải nén archive gốc từ `context.base_sha`, sau đó **overlay trực tiếp các file trong `manifest_paths` hiện hành từ working ledger** (bao gồm `unlink` các file bị đánh dấu xóa trong ledger) lên thư mục archive trước khi chạy check, rồi ghi receipt với `pre_commit: true`, `commit_sha: null`, `source_revision: context.source_revision`.
   - Gate `report_done` và `assertTicketReviewEvidence` bắt buộc kiểm tra receipt/artifact có `pre_commit !== true` và khớp `review_commit_sha`.
5. **Tạo file mới trong `authorized_create_prefixes` & Rollback an toàn (`O3` — SE Gap #4):**
   - Không trộn file chưa tồn tại vào `approved_baseline.file_checksums` lúc khởi tạo (`ticket-baseline-guard.js:35-44`). Thay vào đó, tách riêng trường `authorized_create_prefixes: string[]` và `mutable_file_budget: number`.
   - Trong `assertApprovedPath` và `syncManifest`, đường dẫn hợp lệ khi nằm trong `file_checksums` **hoặc** khớp `authorized_create_prefixes` (không chứa `..`, không phải symlink), vượt qua `acquireTicketFileLock`, và tổng số file trong `manifest.entries` `<= mutable_file_budget`.
   - Khi rollback/discard ticket, mọi entry có `initial_sha === null` bắt buộc được **xóa (`unlink`)** khỏi working tree và giải phóng lock để không để lại untracked files làm bẩn `git status --porcelain`.
6. **Bảo toàn Symbol Outline, Tối ưu Prompt & Nghiệm thu `defer_to_backlog` của Reviewer (`O4`, `O5`, `O6` — SE Gap #5 & #6):**
   - Trong `reviewer-forge-tools.js:46-51`, sau khi `verifiedReviewFile` xác nhận `live.sha256 === file.sha256`, lấy lại `symbols`/`outline` từ `codeCache.read({ path })` (nếu khớp SHA-256) hoặc trích xuất AST thay vì gán cứng `index_status: "unavailable"`.
   - Trong `review-worker.js:70-71`, khi tổng dung lượng `files` vượt ngưỡng (> 64 KB), chỉ nhúng metadata (`path, sha256, line_count`) vào prompt đầu tiên để Reviewer chủ động dùng `review_diff` và `read_lines`.
   - Cập nhật cả parser/validator trong `review-verdict-request.js` và `reviewFindings.validateReview` (`review-worker.js:129-135`) để cho phép `verdict === "approved"` khi mọi finding mở đều là `severity: "minor"` kèm `defer_to_backlog: true`. Mọi finding `blocker` hoặc `major` (hoặc `minor` nhưng `defer_to_backlog !== true`) đều chặn `verdict: "approved"`.

---

## 4. Evidence mã nguồn đã khảo sát (Repository Facts)

| Thành phần / File | Hiện trạng (Facts) | Tham chiếu & SHA-256 |
|---|---|---|
| `backend/src/tools/tool-authorization.js` | `isCoderBlockedPath` và `isAgentPathAllowed` (dòng 21–32) chặn cứng role `coder` trên `docs/**` và chưa tách `operation: "read"` khỏi `"write"` khi đối chiếu `allowed_file_paths`. | `sha256:d4258de6f249988dfa9ea1a2fea34e60b61594a079438b2d450a5b7ecbb73c1c` |
| `backend/src/tools/exploration-state.js` | `assertDiscoveryBudget` (dòng 70–114) kiểm tra nối tiếp `typeLimitFor`, `edit_must_start_by`, `discovery_limit` và ép buộc: *"Your ONLY next action is edit_diff or write_diff"*. | `sha256:992930b09bb613a144726603e0e32b0fb7e6a69b73a5fb6a4f023214302de40f` |
| `backend/src/modules/supervisor/ticket-focused-check.js` | `createTicketFocusedCheck` (dòng 18–23) chặn `if (!context?.review_commit_sha) throw fail("TICKET_COMMIT_REQUIRED", ...)`. | `sha256:cd4170744b0986e0b9b63444e9a2b3f88fbb9ec33f368c352bf7dfbe8ab6eef7` |
| `backend/src/modules/supervisor/ticket-verification-materialization.js` | `materializeTicketVerification` (dòng 9–44) giải nén `commitSha` và bỏ qua `owned.has(relative)`, cần nhánh overlay `manifest_paths` khi chạy `pre_commit: true` từ `base_sha`. | `sha256:14cc322d61d89891a3f701db7dec23b36865385d7af4920d32acf9300eac99c7` |
| `backend/src/modules/supervisor/ticket-execution-context.js` | `assertApprovedPath` (dòng 30–34) và `syncManifest` (dòng 71–84) từ chối mọi đường dẫn không nằm sẵn trong `approved_baseline.file_checksums`. | `sha256:bec3ee87354a8902dae389c9028a49c9814cc31629b45ac10dbf88587ac501dc` |
| `backend/src/modules/supervisor/ticket-baseline-guard.js` | `verifyTicketBaseline` (dòng 21–50) yêu cầu mọi file trong `receipt.file_checksums` phải tồn tại trên đĩa ở thời điểm khởi tạo. | `sha256:1d8ac32ddb94e72d903bd0a0aeaec5a204da5cc111e0263282a75bc63fe9b42a` |
| `backend/src/modules/supervisor/reviewer-forge-tools.js` | Đặt cứng `MAX_OUTPUT_BYTES = 128_000` (dòng 17); `reviewCache.read` (dòng 46–51) ghi đè `index_status: "unavailable"` làm mất symbol outline. | `sha256:3a32806e8d27de4e7450c674dbfa0d11f18f6f8333aae9b49ae8bed44c1896ee` |
| `backend/src/modules/supervisor/review-worker.js` | Nhúng cả `patch` lẫn `files` vào prompt đầu (dòng 70–71) và gọi `reviewFindings.validateReview` (dòng 129–135). | `sha256:abf7c3276957b9441c7866f3a56ad5c37cfd95d29396f67a437b753b25260b49` |
| `backend/src/modules/supervisor/review-verdict-request.js` | Điều phối `requestReviewVerdict` và `parseReviewVerdict` (dòng 19–41), cần đồng bộ quy tắc `approved` kèm `minor` + `defer_to_backlog: true`. | `sha256:dbd4ae67526fe331bfb0d35a85209985d2a980b635cdfae7c7730ba0f75e05ce` |
| `workflows/agents/architecture/README.md` | Quy định khung kế hoạch theo outcomes (`O1`..`On`) và phân quyền giữa Architecture Manager với Sprint Leader. | `sha256:f89a981f59e443a2613252c2d176ae2753b7a848ddfe90f0cabbe8bd111d0443` |

---

## 5. Danh mục Outcomes và Điều kiện nghiệm thu (`O1`–`O6`)

| Mã | Outcome bắt buộc | Điều kiện nghiệm thu quan sát được (Acceptance Criteria) | Guardrail / Ràng buộc bắt buộc |
|---|---|---|---|
| **O1** | **Coder: Đọc ngữ cảnh kiến trúc & chẩn đoán lỗi của chính ticket** | - `isAgentPathAllowed` phân biệt `operation: "read"` / `"write"`, cho phép Coder gọi `read_file`/`read_lines`/`search_text`/`list_files`/`search_tree` trong `docs/**` dù không liệt kê trong `allowed_file_paths`.<br>- Coder tra cứu được stdout/stderr đã redact của các lần verification/check vừa chạy thuộc cùng `task_id`. | Cấm ghi vào `docs/` (trừ khi manifest ticket yêu cầu); cấm đọc receipt của `task_id` khác hoặc truy cập `.forge/` qua file tool. |
| **O2** | **Coder: Gia hạn discovery có điều kiện, bỏ ép sửa mù** | - Khi chạm trần pre-edit discovery trong `exploration-state.js`, nếu Coder khai báo rõ `target_symbol`/contract cần tra cứu và `unproductive_streak === 0`, hệ thống tăng đồng bộ cả `edit_must_start_by` lẫn `read_limit`/`search_limit` (+1 bước gia hạn), hoặc cho phép trả `needs_context`.<br>- `unproductive_streak` (đọc/search trùng lặp) vẫn bị chặn. | Không bỏ giới hạn tổng discovery của toàn phiên; giữ chặn vòng lặp vô ích. |
| **O3** | **Coder: Chạy `run_check` trước commit & tách file trong prefix ủy quyền** | - `run_check` khi chưa có `review_commit_sha` tự động `syncManifest`, giải nén `base_sha` rồi overlay `manifest_paths` từ working ledger (kể cả xóa file bị mark deleted), sinh receipt gắn cờ `pre_commit: true`.<br>- `report_done` vẫn bắt buộc receipt pass trên `review_commit_sha` đã khóa (`pre_commit !== true`).<br>- Khi ticket có `authorized_create_prefixes`, Coder tạo được file mới trong prefix đó nếu tổng số file ≤ `mutable_file_budget` và qua được `acquireTicketFileLock`; khi rollback/discard, mọi file có `initial_sha === null` được `unlink` sạch sẽ. | Receipt `pre_commit: true` không bao giờ được dùng làm bằng chứng nghiệm thu cuối (`report_done`). Không trộn file chưa tồn tại vào `file_checksums` lúc khởi tạo baseline. |
| **O4** | **Reviewer: Ngân sách đọc co giãn, giữ symbol map & xem `review_diff` chuẩn** | - `MAX_OUTPUT_BYTES` trong `reviewer-forge-tools.js` co giãn theo số file của manifest (128 KB + 16 KB/file, tối đa 384 KB).<br>- `reviewCache.read` giữ nguyên `symbols`/`outline` từ `codeCache` hoặc AST extractor khi `live.sha256 === file.sha256`.<br>- Tool `review_diff` trả diff chuẩn theo từng file giữa `base_sha` hoặc `previous_review_commit` với `review_commit_sha`; prompt khởi tạo trong `review-worker.js` chỉ nhúng metadata khi tổng `files` > 64 KB. | Giữ nguyên `assertReviewerReadPath`, chặn symlink và giới hạn cửa sổ mỗi lần đọc (`MAX_WINDOW_LINES`). |
| **O5** | **Reviewer: Chạy kiểm tra độc lập chỉ-đọc (`run_review_check`)** | - Reviewer gọi được `run_review_check` (chỉ lệnh test/lint/typecheck cho phép) trên snapshot cô lập của `review_commit_sha` với trần 1–2 lần/review.<br>- Môi trường chạy cô lập, không làm bẩn working tree và không ghi đè verification artifact của Coder. | Read-only hoàn toàn; timeout và giới hạn số lần gọi mỗi review job. |
| **O6** | **Reviewer: Duyệt kèm đẩy lỗi Minor sang backlog (`defer_to_backlog`) khi Gate ON** | - Ở `review_gate: "on"`, cả `review-verdict-request.js` và `reviewFindings.validateReview` cho phép `verdict: "approved"` khi mọi finding mở đều là `severity: "minor"` kèm `defer_to_backlog: true`.<br>- Ticket được phép integrate; Node tự động ghi các finding `minor` đó vào `review.backlog.json` (dedupe theo `job_key + finding_id`). | Bất kỳ finding `blocker` hoặc `major` nào đang mở (hoặc `minor` nhưng `defer_to_backlog !== true`) đều bị từ chối `approved` và không được integrate. |

---

## 6. Giả định, Rủi ro và Câu hỏi mở

| Loại | Nội dung | Tác động | Hướng xử lý / Người quyết định |
|---|---|---|---|
| **Giả định (Đã xác minh cùng SE)** | Các file tạo mới qua `authorized_create_prefixes` chưa tồn tại ở `base_sha`, do đó được tách riêng khỏi `approved_baseline.file_checksums` ban đầu và mang `initial_sha: null` trong `changeLedger`; khi rollback sẽ được `unlink` khỏi đĩa. | Major | Đã chốt trong Guardrail số 5 (`O3`) để tương thích 100% với `ticket-baseline-guard.js`. |
| **Rủi ro (Risk)** | Chạy `run_check` pre-commit (`O3`) và `run_review_check` (`O5`) tạo thêm các thư mục archive tạm thời; nếu tiến trình bị hủy đột ngột có thể để lại thư mục tạm. | Minor | Tái sử dụng khối `try ... finally { await archive.cleanup(); }` hiện có của `materializeTicketVerification`. |
| **Rủi ro (Risk)** | Cho phép tạo file mới trong `authorized_create_prefixes` có thể dẫn tới hai ticket song song tạo trùng tên file helper mới. | Major | Bắt buộc đi qua `acquireTicketFileLock` trước khi ghi file mới vào working ledger và cập nhật `syncManifest`. |
| **Câu hỏi mở (Đã có hướng mặc định)** | Trần số lần gọi `run_review_check` mỗi phiên review (`O5`), ngưỡng thu gọn prompt `review-worker.js` (`O4`) và lượng bước cộng thêm khi gia hạn pre-edit discovery (`O2`). | Minor | Mặc định theo thảo luận: tối đa **2 lần** `run_review_check`/review job, ngưỡng **64 KB** cho prompt `files`, và **+1 bước** (đồng bộ cả `edit_must_start_by` lẫn `typeLimit`) cho pre-edit discovery. |

---

## 7. Gợi ý lộ trình phân đợt cho Sprint Leader (Không bắt buộc)

- **Đợt 1 — Mở nút thắt đọc & khám phá (`O1`, `O2`, `O4`):** Tách `operation: "read" | "write"` cho `docs/` + tool đọc check receipt đã redact (`O1`); gia hạn pre-edit đồng bộ `edit_must_start_by` & `typeLimit` (`O2`); nâng trần `MAX_OUTPUT_BYTES`, khôi phục symbol outline trong `reviewCache` và thêm `review_diff` (`O4`).
- **Đợt 2 — Tăng tốc vòng lặp kiểm thử & gỡ nghẽn nghiệm thu (`O3`, `O5`, `O6`):** Mở rộng `run_check` chế độ `pre_commit: true` (overlay `manifest_paths` từ working ledger) + `authorized_create_prefixes` kèm rollback `unlink` cho `initial_sha: null` (`O3`); thêm `run_review_check` chỉ-đọc trên archive cô lập (`O5`); hỗ trợ `defer_to_backlog: true` cho lỗi `minor` khi `review_gate: "on"` (`O6`).
