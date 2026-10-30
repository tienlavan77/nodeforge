<!-- Đánh giá kỹ thuật và góp ý chi tiết của System Engineer cho tài liệu thảo luận mở rộng năng lực Coder & Reviewer. -->
# Technical Review & Feedback: Mở rộng năng lực Coder & Reviewer

**Tài liệu đối chiếu:** `workflows/discussion-coder-reviewer-capabilities.md`  
**Người đánh giá:** System Engineer (SE)  
**Trạng thái đánh giá:** Đồng thuận về kiến trúc tổng thể; đề xuất bổ sung 6 điểm kỹ thuật chi tiết để tránh lỗi ngầm khi triển khai.

---

## 1. Đánh giá tổng quan

Bản thảo luận `workflows/discussion-coder-reviewer-capabilities.md` đã xác định **rất chính xác gốc rễ (root cause)** của các điểm nghẽn hiện tại trong pipeline Coder – Reviewer:
- Mọi tham chiếu dòng code và SHA-256 trong bảng *Repository Facts* đều khớp 100% với mã nguồn thực tế.
- Giải quyết trực diện hai nguyên nhân lớn nhất gây lặp vòng sửa mù (`repair round`):
  1. Cơ chế `exploration-state.js` ép Coder phải gọi `edit_diff`/`write_diff` ngay khi chạm `edit_must_start_by` dù chưa đọc đủ symbol/contract.
  2. `ticket-focused-check.js` bắt buộc phải có `review_commit_sha` mới cho phép chạy `run_check`.
- Giữ vững các hàng rào bảo mật cốt lõi: không mở `.forge/runtime/` qua file tool chung, không cho Reviewer quyền sửa code, và không dùng receipt `pre_commit: true` làm bằng chứng nghiệm thu cuối (`report_done`).

---

## 2. 6 Góp ý kỹ thuật chi tiết (Gap Analysis & Implementation Notes)

Để khi chuyển sang pha `/plan` và tách ticket cho Coder không gặp lỗi tích hợp giữa các module, SE đề xuất bổ sung 6 điểm kỹ thuật sau vào đặc tả của từng Outcome:

### Góp ý 1 — Về `O1` (Mở quyền đọc `docs/` cho Coder): Cần xử lý cả `allowed_file_paths` / `allowed_prefixes`
- **Hiện trạng mã nguồn (`backend/src/tools/tool-authorization.js:21-32`):**
  ```js
  export function isAgentPathAllowed(path, context = {}) {
    if (isCoderBlockedPath(path, context)) return false;
    const files = context.allowed_file_paths ?? context.allowedFilePaths;
    const prefixes = context.allowed_prefixes ?? context.allowedPrefixes;
    if (!Array.isArray(files) && !Array.isArray(prefixes)) return true;
    return (Array.isArray(files) && files.includes(path)) || ...
  }
  ```
- **Vấn đề tiềm ẩn:**
  - Hiện tại `isAgentPathAllowed` chưa phân biệt thao tác `read` hay `write`.
  - Khi Coder chạy trong phạm vi một ticket, `context.allowed_file_paths` thường chỉ chứa danh sách file code của ticket (ví dụ `backend/src/...`). Nếu chỉ gỡ `isCoderBlockedPath` mà không cập nhật `isAgentPathAllowed` cho phép đọc `docs/`, thì lệnh `read_file("docs/...")` vẫn sẽ bị chặn bởi điều kiện `files.includes(path)` trả về `false`.
- **Đề xuất giải pháp cho `O1`:**
  - Bổ sung tham số `{ operation = "read" }` vào `isAgentPathAllowed(path, context, options)` (hoặc tách hàm `isAgentReadPathAllowed` / `isAgentWritePathAllowed`).
  - Với `operation === "read"`: cho phép Coder đọc `docs/` và `docs/**` (vẫn qua `assertRoleFileAccess` để chặn symlink và secret), bất kể `allowed_file_paths` của ticket có liệt kê `docs/` hay không.
  - Với `operation === "write"`: giữ nguyên chặn ghi vào `docs/` trừ khi path đó nằm rõ ràng trong `allowed_file_paths` của ticket manifest.

---

### Góp ý 2 — Về `O2` (Gia hạn Pre-edit Discovery): Đồng bộ cả 3 tầng giới hạn trong `exploration-state.js`
- **Hiện trạng mã nguồn (`backend/src/tools/exploration-state.js:89-110`):**
  Trước khi thực hiện edit đầu tiên, `assertDiscoveryBudget(context, kind)` kiểm tra **3 tầng trần nối tiếp nhau**:
  1. **Trần theo loại tool (`typeLimitFor`):** `state.read_limit`, `state.search_limit`, `state.candidate_limit` -> ném lỗi `EXPLORATION_TYPE_BUDGET_EXHAUSTED` (dòng 90–93).
  2. **Trần deadline trước edit:** `state.edit_must_start_by` -> ném lỗi `EXPLORATION_PREEDIT_DEADLINE` (dòng 96–98).
  3. **Trần tổng phiên:** `limit` (`state.discovery_limit`) -> ném lỗi `EXPLORATION_BUDGET_EXHAUSTED` (dòng 103–110).
- **Vấn đề tiềm ẩn:**
  - Nếu Coder xin gia hạn tại `edit_must_start_by` (+1 hoặc +2 bước) để đọc thêm 1 file contract, nhưng tại thời điểm đó `state.read_calls` cũng vừa chạm `state.read_limit`, thì bước đọc được gia hạn sẽ lập tức bị chặn bởi tầng số 1 (`EXPLORATION_TYPE_BUDGET_EXHAUSTED`).
- **Đề xuất giải pháp cho `O2`:**
  - Khi cấp gia hạn pre-edit có điều kiện (`unproductive_streak === 0` + có khai báo target symbol/contract cụ thể), cần tăng đồng bộ cả `state.edit_must_start_by` **và** `state.read_limit` / `state.search_limit` tương ứng với bước gia hạn đó.
  - Quy định rõ giao diện khai báo lý do gia hạn (ví dụ: thêm trường tùy chọn `reason` / `target_symbol` vào input của tool đọc/tìm kiếm, hoặc khi ném lỗi deadline lần đầu thì hướng dẫn rõ cách gọi kèm `target_symbol` để mở khóa +1 bước).

---

### Góp ý 3 — Về `O3` (Chạy `run_check` trước khi commit): Cơ chế Materialize từ Working Ledger
- **Hiện trạng mã nguồn (`backend/src/modules/supervisor/ticket-focused-check.js:18-23` & `ticket-verification-materialization.js:9-29`):**
  - `materializeTicketVerification` hiện gọi `materializeTicketArchive({ projectRoot, commitSha })` (dùng `git archive` từ `commitSha`), sau đó chỉ đắp (`overlay`) các file **ngoài ticket** (`environment.files`) lên archive, còn các file thuộc `ticketPaths` thì giữ nguyên theo `commitSha`.
- **Vấn đề tiềm ẩn:**
  - Khi chạy `run_check` trước khi commit (`review_commit_sha === null`), các thay đổi của Coder đang nằm ở working tree / working ledger chứ chưa nằm trong Git commit nào. Nếu `materializeTicketVerification` chạy trên `base_sha` mà bỏ qua `owned.has(relative)`, archive sẽ chỉ chứa code cũ ở `base_sha` chứ không chứa code mới của Coder!
- **Đề xuất giải pháp cho `O3`:**
  - Khi `context.review_commit_sha === null` (chế độ `pre_commit: true`):
    1. Đồng bộ manifest mới nhất từ `changeLedger` (`syncManifest`) để lấy `source_revision` và `manifest_paths` hiện hành.
    2. Giải nén archive gốc từ `context.base_sha`.
    3. **Overlay trực tiếp nội dung các file trong `manifest_paths` hiện tại** (từ working tree đã qua kiểm tra hash của ledger, bao gồm cả xóa file nếu file bị mark deleted trong ledger) lên thư mục archive trước khi chạy lệnh test/lint.
    4. Ghi receipt với `pre_commit: true`, `commit_sha: null`, `source_revision: context.source_revision`.

---

### Góp ý 4 — Về `O3` (`authorized_create_prefixes` khi tách file > 250 dòng): Tương thích với Baseline Guard và Rollback
- **Hiện trạng mã nguồn:**
  - `ticket-baseline-guard.js:35-44` yêu cầu mọi file trong `receipt.file_checksums` phải tồn tại tại thời điểm khởi tạo và khớp SHA-256 trên đĩa.
  - `ticket-execution-context.js:33, 76` chỉ kiểm tra `!Object.hasOwn(current.approved_baseline.file_checksums, path)`.
- **Đề xuất giải pháp cho `O3`:**
  1. **Không trộn file chưa tồn tại vào `file_checksums` ban đầu:** Giữ nguyên `approved_baseline.file_checksums` cho các file đã tồn tại ở `base_sha`. Bổ sung trường `authorized_create_prefixes: string[]` và `mutable_file_budget: number` vào `approved_baseline` (hoặc lấy từ `approved_baseline.contract`).
  2. **Hàm kiểm tra đường dẫn hợp lệ (`isApprovedTicketPath`):** Trong `assertApprovedPath` và `syncManifest`, một `path` hợp lệ khi:
     - Có trong `approved_baseline.file_checksums`, **HOẶC**
     - Khớp với một prefix trong `authorized_create_prefixes` (đã chuẩn hóa, không chứa `..`, không phải symlink) **VÀ** tổng số file trong `manifest.entries` (cũ + mới) `<= mutable_file_budget`.
  3. **Xử lý Rollback / Discard an toàn:** Với các file tạo mới, `initial_sha` trong `changeLedger` là `null`. Cần đảm bảo khi rollback hoặc discard ticket, mọi entry có `initial_sha === null` sẽ được **xóa (`unlink`)** khỏi working tree và giải phóng file lock, không để sót file mồ côi (`untracked files`) làm bẩn `git status --porcelain` của các lần chạy sau.

---

### Góp ý 5 — Về `O4` (Reviewer giữ Symbol Map khi đọc file trong `ticketEvidence`)
- **Hiện trạng mã nguồn (`backend/src/modules/supervisor/reviewer-forge-tools.js:46-51`):**
  ```js
  const reviewCache = codeCache && ticketEvidence ? { ...codeCache, read: async ({ path }) => {
    const file = ticketEvidence.files.find((item) => item.path === path);
    if (!file || file.deleted) return codeCache.read({ path });
    const live = await verifiedReviewFile(file, ticketEvidence, fileService, projectRoot);
    return { ...live, content: file.content, sha256: file.sha256, content_sha256: file.sha256, size_bytes: Buffer.byteLength(file.content), cache: { status: "bypass", cached_at: null, expires_at: null }, index_status: "unavailable" };
  } } : codeCache;
  ```
- **Vấn đề tiềm ẩn:**
  - `verifiedReviewFile` chỉ gọi `fileService.readForIndex`, không gọi `codeCache.read({ path })` hay AST extractor, rồi trả về `index_status: "unavailable"`. Do đó `createReadFileTool` không có danh sách symbols để hiển thị outline cho Reviewer.
- **Đề xuất giải pháp cho `O4`:**
  - Sau khi `verifiedReviewFile` xác nhận `live.sha256 === file.sha256` (nghĩa là file trên đĩa khớp tuyệt đối với bản commit đang review), gọi `const cached = await codeCache.read({ path })`.
  - Nếu `cached?.sha256 === file.sha256`, giữ nguyên `symbols`, `outline`, và `index_status` từ `cached` (hoặc trích xuất trực tiếp bằng `extractorRegistry.extract(path, file.content)` nếu index chưa kịp cập nhật) thay vì gán cứng `index_status: "unavailable"`.

---

### Góp ý 6 — Về `O4` & `O6` (Giảm tải Prompt khởi tạo của Reviewer & Cập nhật Validator cho `defer_to_backlog`)
1. **Tối ưu Prompt khởi tạo trong `review-worker.js` (Bổ trợ `O4`):**
   - Tại `review-worker.js:70-71`, hệ thống đang nhúng toàn bộ chuỗi `Patch: ${patch}` **cùng lúc với** toàn bộ nội dung `Changed files: ${JSON.stringify(files)}` vào prompt đầu tiên. Với các ticket sửa nhiều file, prompt ban đầu rất nặng.
   - Khi đã có tool `review_diff` theo từng file và ngân sách đọc co giãn ở `O4`, có thể cân nhắc chỉ nhúng metadata (`path, sha256, line_count`) khi tổng dung lượng `files` vượt ngưỡng (ví dụ > 64 KB), để Reviewer dùng `review_diff` và `read_lines` đọc đúng vùng cần kiểm tra.
2. **Cập nhật Verdict Validator cho `O6` (`defer_to_backlog: true`):**
   - Trong `review-verdict-request.js` và bộ kiểm tra `reviewFindings.validateReview` (`review-worker.js:129-135`), hiện tại nếu `verdict === "approved"` mà vẫn còn finding mới trong mảng `findings` thì validator sẽ từ chối với lỗi `REVIEW_FINDINGS_UNRESOLVED` hoặc `REVIEW_VERDICT_INVALID`.
   - Cần ghi rõ vào tiêu chí của `O6`: Cập nhật cả parser/validator trong `review-verdict-request.js` và `review-findings` để cho phép `verdict === "approved"` đi kèm các finding có `severity === "minor"` và `defer_to_backlog === true` (trong khi vẫn chặn cứng nếu có bất kỳ finding nào mang `severity === "major"` hoặc `"blocker"`, hoặc `minor` nhưng `defer_to_backlog !== true`).

---

## 3. Đề xuất thứ tự ưu tiên triển khai

Lộ trình 2 đợt trong mục 7 của bản thảo luận rất hợp lý. SE đề xuất thứ tự chi tiết bên trong từng đợt như sau:

1. **Đợt 1 (An toàn cao, giải phóng ngay ngữ cảnh cho Agent):**
   - `O1` (Mở đọc `docs/` + tool xem check receipt đã redact của cùng `task_id`).
   - `O2` (Gia hạn có điều kiện trong `exploration-state.js`, đồng bộ `edit_must_start_by` và `typeLimit`).
   - `O4` (Nâng trần `MAX_OUTPUT_BYTES` theo số file manifest, giữ symbol outline trong `reviewCache`, thêm `review_diff`).
2. **Đợt 2 (Nâng cấp vòng đời Verification, Tách file & Nghiệm thu):**
   - `O3` (Hỗ trợ `run_check` chế độ `pre_commit: true` + `authorized_create_prefixes` kèm xử lý rollback `initial_sha: null`).
   - `O5` (Tool `run_review_check` chỉ-đọc trên archive cô lập của `review_commit_sha`).
   - `O6` (Hỗ trợ `defer_to_backlog: true` cho lỗi `minor` khi `review_gate: "on"` và ghi vào `.forge/runtime/queues/review.backlog.json`).
