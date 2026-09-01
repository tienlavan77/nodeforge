## Giai đoạn 2 — Khép vòng lặp 9 bước đầy đủ

> Nối tiếp trực tiếp từ 1-5b (patch xong, dừng) — Giai đoạn này thay đoạn "dừng" đó bằng: kiểm tra file mồ côi → wiring nếu cần → status_check → completed/continue. `2c` (dependency graph) đã hoàn thành trước `2a`; usage_query sẽ dùng graph để phát hiện file mồ côi. `2d` và lớp mở rộng Code Graph/Search đã có, vẫn độc lập và không chặn phần còn lại.

### 2c — Dependency graph (làm trước 2a)

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 2c-1 | Viết parser trích `import`/`require` cơ bản (regex, chỉ JS/ESM cho MVP) | ✅ Đã làm | Chưa cần AST đầy đủ — ticket hiện tại toàn file `.js`, đủ dùng bằng regex bắt `import ... from '...'`. |
| 2c-2 | `buildGraphForFile(path)` → `{imports: [], importedBy: []}` | ✅ Đã làm | Quét 1 lần lúc cần (lazy), chưa cần cache toàn bộ project ở bước này. |
| 2c-3 | `isImportedAnywhere(path)` | ✅ Đã làm | Dùng trực tiếp trong 2a để quyết định có cần `usage_query` hay không. |
| 2c-4 | `updateGraphAfterPatch(file)` | ✅ Đã làm | Gọi ngay sau mỗi lần patch (trong 1-5b và trong nhánh wiring ở 2a) — graph tự "mọc" theo patch, không cần agent khai báo. |

### 2a — usage_query / usage_needed / no_wiring_needed

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 2a-1 | Refactor: rút phần "gửi code_needed → nhận → patch" (1-5a/1-5b) thành 1 hàm dùng chung `handleCodeExchange(files, context)` | ☐ Chưa làm | Cần làm TRƯỚC 2a-3 vì nhánh wiring bên dưới dùng lại đúng logic này, tránh chép lại code. |
| 2a-2 | `checkUnwiredFiles(filesChanged)` — sau khi 1-5b patch xong, không dừng nữa mà gọi hàm này | ☐ Chưa làm | Dùng `isImportedAnywhere` (2c-3) cho từng file có `action: created`. Trả về danh sách file còn mồ côi. |
| 2a-3 | Nếu có file mồ côi → build + gửi `usage_query` | ☐ Chưa làm | Payload gồm `unwired_files` (path, status, imported_by rỗng) — đúng schema đã chốt trong thiết kế. |
| 2a-4 | `routeUsageResponse(envelope)` — rẽ theo `type` | ☐ Chưa làm | `usage_needed` → gọi lại `handleCodeExchange` (2a-1) cho file agent yêu cầu (thường là file cha) → patch → `updateGraphAfterPatch` (2c-4) → quay lại 2a-2 kiểm tra lại. `no_wiring_needed` → ghi nhận `reason`, coi như hết mồ côi, đi tiếp. |
| 2a-5 | Vòng lặp 2a-2 → 2a-4 cho tới khi `checkUnwiredFiles` trả rỗng | ☐ Chưa làm | Đây chính là điểm cần guard round counter thật (Giai đoạn 3) — ở Giai đoạn 2 tạm giới hạn cứng bằng 1 biến đếm đơn giản (vd tối đa 5 lần) để tránh loop test vô hạn. |

### 2b — status_check / completed / continue

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 2b-1 | `filterCriteriaForRole(criteria, role)` | ☐ Chưa làm | Lọc bỏ tiêu chí có keyword `test/build/kiểm tra` khỏi những gì gửi cho `coder` — dùng đúng logic đã thống nhất trong thiết kế. Ở Giai đoạn 2 role mặc định vẫn là `coder` (chưa có Tester/Reviewer — đó Giai đoạn 7), nhưng viết hàm tổng quát ngay để dùng lại sau. |
| 2b-2 | Sau khi 2a-5 xong (hết mồ côi) → build + gửi `status_check` | ☐ Chưa làm | Dùng `filterCriteriaForRole` (2b-1) để chọn đúng tập tiêu chí, kèm `files_changed` tổng hợp từ toàn bộ round đã patch (round patch chính + round wiring). |
| 2b-3 | `routeStatusResponse(envelope)` — rẽ theo `type` | ☐ Chưa làm | `completed` → lưu `report` (0b-2 `save`), `updateStatus(coder_completed)`, dừng vòng lặp — CHƯA verify/merge (đó Giai đoạn 4). `continue` → lấy `next_task`, quay lại 1-2 (`buildTaskRequest`) với mô tả mới, **giữ nguyên `task_id`**, tăng `step_id`. |
| 2b-4 | Giới hạn tạm số lần `continue` liên tiếp | ☐ Chưa làm | Biến đếm đơn giản (vd tối đa 3 lần) — bản đầy đủ là guard [3] Round counter ở Giai đoạn 3, ở đây chỉ cần đủ để không loop vô hạn khi test. |

### 2d — Code index (độc lập, không chặn 2a/2b)

| # | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| 2d-1 | Chọn phương án MVP: grep/keyword search (`ripgrep` hoặc quét `fs.readdir` + string match) | ✅ Đã làm | Đã nâng cấp thành Code Search trên SQLite/index DB, có path/symbol/content search và tokenizer Unicode. |
| 2d-2 | `searchSimilarFile(keyword)` → path gần nghĩa nhất | ✅ Đã làm | Relevant Tree/Code Search xếp hạng candidate theo path, symbol, content và graph relation. | Dùng để tự động điền `reference_pattern` — ở Giai đoạn 1 việc này đang viết tay trong ticket test. |
| 2d-3 | Tích hợp vào `buildTaskRequest` (1-2) | ✅ Đã làm | Stage‑1 gửi `code_graph_candidates`; hỗ trợ `scope`/`allowed_prefixes` để lọc đúng phạm vi trước top-N. |

**Thứ tự làm khuyến nghị:** `2c-1→2c-4` (✅ hoàn thành) → `2a-1` (refactor dùng chung với 1-5a/1-5b) → `2a-2→2a-5` (vòng wiring) → `2b-1→2b-4` (status check) → `2d` làm song song bất cứ lúc nào, không nằm trên đường găng.