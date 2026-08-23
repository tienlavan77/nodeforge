# Forge — Sprint 1 Chi Tiết: Wire Execution Handlers + Dọn Vệ Sinh Ops

**Doc ID:** FORGE-SPRINT-001-DETAIL
**Thuộc:** FORGE-SPRINT-PLAN-002, Nhóm A + Nhóm B
**Lưu ý:** "Phase" ở đây là **trình tự thực thi nội bộ trong Sprint**, không phải đơn vị giao việc cho Forge — Forge vẫn chỉ nhận **ticket**. Mỗi phase gồm 1 hoặc nhiều ticket đã làm phẳng, có thứ tự bắt buộc vì phase sau phụ thuộc kết quả phase trước.

---

## Mục tiêu Sprint 1

Kết thúc sprint, Execution Layer (`execution-layer.js`) phải **thực sự chạy được** — nhận `changes[]` từ Agent, apply lên filesystem thật, có backup/rollback, không còn là skeleton. Song song, dọn sạch rác kỹ thuật (git, thư mục cũ) để không cản trở các sprint sau.

**Điều kiện hoàn thành (Definition of Done):** 1 đoạn code giả lập (`ExecutionContext` mẫu với `change` thật) chạy qua `dispatchChange` → apply thành công lên 1 file test → backup tồn tại → rollback hoạt động khi giả lập lỗi — toàn bộ có test tự động pass.

---

## Phase 1 — Chuẩn bị & Khảo sát (trước khi viết code)

*Không tạo code mới, chỉ xác nhận môi trường và interface đã đúng như thiết kế.*

| Việc | Chi tiết | Ticket liên quan |
|---|---|---|
| Xác nhận interface `ExecutionResult`/`ExecutionContext` hiện tại khớp FORGE-EXEC-002 | Đọc lại `execution-result.schema.json`, `execution-context.schema.json` đã có trong repo, đối chiếu 9 error code | — (khảo sát) |
| Liệt kê chữ ký hàm (function signature) mong đợi cho 5 module sắp viết | `applyUnifiedDiff(filePath, diffText)`, `applySearchReplaceBlock(filePath, oldStr, newStr)`, `applyFullFileReplace(filePath, newContent)`, `applyStructuredPatch(filePath, operations[])`, `backupFile(filePath)`/`rollbackFile(filePath)` | FORGE-EXEC-001a→e |
| Xác nhận thư viện diff cần dùng đã có trong `package.json` chưa (VD `diff`, `diff-match-patch`) | Nếu chưa, thêm vào dependency trước khi code, tránh block giữa chừng | FORGE-EXEC-001a |

**Output của Phase 1:** 1 checklist ngắn xác nhận "sẵn sàng code", không có deliverable code.

---

## Phase 2 — Viết 5 module Handler (song song hóa được)

*Đây là phần việc chính, có thể chia cho nhiều người làm song song vì 5 module độc lập nhau.*

### 2.1. FORGE-EXEC-001b — `applySearchReplaceBlock` (làm TRƯỚC tiên, ưu tiên cao nhất)

**Lý do làm trước:** đã xác định đây là dạng an toàn nhất, dùng làm mặc định cho hầu hết task — nên có sớm để Phase 3 (test tích hợp) có ngay 1 đường chạy được, không phải chờ đủ cả 5 module.

- Input: `filePath`, `oldStr`, `newStr`.
- Logic: đọc file, đếm số lần xuất hiện `oldStr` — nếu `0` → trả `ExecutionResult` với `error_code: NO_MATCH`; nếu `>1` → `error_code: AMBIGUOUS_MATCH`; nếu `1` → thay thế, trả `success: true`.
- Có chế độ `dry_run: boolean` — khi `true`, chỉ trả kết quả sẽ ra sao, không ghi gì.

### 2.2. FORGE-EXEC-001e — `backupFile` / `rollbackFile` (làm NGAY SAU 001b)

**Lý do làm sớm thứ 2:** mọi handler khác đều cần gọi qua backup trước khi ghi — làm sớm để 001a/c/d có thể tái sử dụng ngay khi viết.

- `backupFile(filePath)`: copy nội dung hiện tại sang vị trí tạm (VD `.forge/runtime/backup/<task_id>/<round>/<filename>`), trả `ExecutionResult` chứa `backup_ref`.
- `rollbackFile(filePath)`: đọc lại từ `backup_ref`, ghi đè về file gốc, trả `ExecutionResult`.
- Xử lý `error_code: IO_ERROR` nếu backup/restore thất bại (permission, disk...).

### 2.3. FORGE-EXEC-001c — `applyFullFileReplace`

- Đơn giản nhất về logic — chỉ cần gọi `backupFile` trước, rồi ghi đè `newContent`.
- Làm song song với 2.4/2.5 vì không phụ thuộc gì thêm ngoài `backupFile` (đã xong ở 2.2).

### 2.4. FORGE-EXEC-001a — `applyUnifiedDiff`

- Dùng thư viện diff đã xác nhận ở Phase 1.
- Bắt buộc có `dry_run` trước — nếu context không khớp → `error_code: PATCH_NOT_APPLICABLE`, kèm `detail` mô tả vị trí lệch.
- Đây là module rủi ro cao nhất kỹ thuật (đã phân tích ở thiết kế trước: phụ thuộc số dòng chính xác) — nên có thêm test case biên: file đã đổi nhẹ giữa lúc agent tạo diff và lúc apply.

### 2.5. FORGE-EXEC-001d — `applyStructuredPatch`

- Duyệt tuần tự `operations[]`, mỗi operation validate `start/end` hoặc `anchor` còn khớp file hiện tại trước khi áp dụng.
- Có thể làm sau cùng nếu nguồn lực hạn chế — theo thiết kế trước, đây là dạng ít ưu tiên nhất trong 4 loại diff (dùng khi cần thao tác nhiều điểm rời rạc trong 1 file).

**Song song hóa gợi ý (nếu có ≥2 người):**
```
Người 1: 2.1 (search_replace) → 2.2 (backup/rollback) → 2.3 (full_file)
Người 2: chờ 2.2 xong → 2.4 (unified_diff)
Người 3: chờ 2.2 xong → 2.5 (structured_patch)
```

---

## Phase 3 — Wire vào `dispatchChange` + Validate nội bộ

*Ticket: FORGE-EXEC-001f*

| Việc | Chi tiết |
|---|---|
| Nối 5 module vào `dispatchChange` | Đọc `change.type` (hoặc suy ra từ field có mặt) → route đúng handler, đúng như thiết kế FORGE-EXEC-001 gốc |
| Đảm bảo mọi handler trả đúng `ExecutionResult` | Không có handler nào throw exception thô ra ngoài — mọi lỗi phải qua `error_code` enum đã chuẩn hóa |
| Test đơn vị cho từng handler | Mỗi module 2.1-2.5 có ít nhất: 1 test case `success`, 1 test case lỗi tương ứng đúng `error_code` của nó |
| Test tích hợp `dispatchChange` | Giả lập `ExecutionContext` đầy đủ, chạy qua toàn bộ: verifyChecksum (đã có) → dryRunApply → apply thật → backup tồn tại |

**Output của Phase 3:** `execution-layer.js` không còn là skeleton — `dispatchChange` chạy được thật với dữ liệu giả lập, có test tự động pass.

---

## Phase 4 — Dọn vệ sinh Ops (chạy song song từ đầu Sprint, độc lập Phase 1-3)

*Không phụ thuộc kỹ thuật vào Phase 1-3, có thể giao cho người khác làm song song ngay từ ngày đầu sprint.*

| Ticket | Việc | Chi tiết |
|---|---|---|
| FORGE-OPS-001a | Dọn `.node-control` cũ | Xác nhận không còn service/script nào tham chiếu tới database legacy trong thư mục này trước khi xóa; nếu còn, cập nhật reference sang `.forge/runtime/` trước |
| FORGE-OPS-001b | Dọn worktree | Rà toàn bộ file uncommitted/untracked hiện có — phân 2 nhóm: (a) đáng giữ → commit theo message rõ ràng, nhóm theo từng phần liên quan; (b) rác/thử nghiệm → xóa hoặc `.gitignore` |
| FORGE-OPS-001c | Tài liệu hóa vận hành VPS | Viết hướng dẫn ngắn: cách xác nhận Watcher/Control API đang chạy đúng trên VPS (không dùng PID macOS) — VD dùng `curl` tới port 3100, hoặc query trực tiếp `nf/index.db` xem log gần nhất |

---

## Phase 5 — Kiểm tra tổng hợp cuối Sprint (Definition of Done)

| Việc | Tiêu chí đạt |
|---|---|
| Chạy `npm run validate:schemas && npm run lint && npm run typecheck` | Pass, 0 lỗi |
| Chạy test đơn vị + tích hợp Execution Layer | Pass toàn bộ, bao gồm test case mới ở Phase 3 |
| Giả lập 1 `changes[]` mẫu (dạng `search_replace_block`) chạy qua `dispatchChange` trên file test thật | Apply thành công, có backup, `ExecutionResult` trả đúng cấu trúc |
| Giả lập 1 lỗi cố ý (VD `oldStr` không tồn tại) | Trả đúng `error_code: NO_MATCH`, không throw exception thô, không ghi đè file |
| `.node-control` cũ đã dọn, worktree sạch (git status không còn file rác) | Xác nhận bằng `git status` |
| Tài liệu vận hành VPS đã viết, ít nhất 1 người khác đọc hiểu và làm theo được | Review chéo |

---

## Bảng tổng hợp Ticket ↔ Phase (tham chiếu nhanh)

| Ticket | Phase |
|---|---|
| FORGE-EXEC-001b (search_replace) | Phase 2.1 |
| FORGE-EXEC-001e (backup/rollback) | Phase 2.2 |
| FORGE-EXEC-001c (full_file) | Phase 2.3 |
| FORGE-EXEC-001a (unified_diff) | Phase 2.4 |
| FORGE-EXEC-001d (structured_patch) | Phase 2.5 |
| FORGE-EXEC-001f (wire + validate) | Phase 3 |
| FORGE-OPS-001a/b/c | Phase 4 (song song, độc lập) |
| — (kiểm tra tổng) | Phase 5 |

---

## Rủi ro cần theo dõi trong Sprint 1

- **FORGE-EXEC-001a (unified_diff)** dễ trễ nhất do độ phức tạp kỹ thuật — nếu tới giữa sprint vẫn chưa xong, cân nhắc **hạ ưu tiên xuống Sprint 2**, không block Phase 3/5 vì `search_replace_block` (2.1) đã đủ để có 1 đường chạy hoàn chỉnh cho Phase 5.
- Nếu Phase 4 (Ops) phát hiện vấn đề lớn hơn dự kiến khi dọn `.node-control` (VD có service đang phụ thuộc ngầm chưa biết), cần báo ngay, không tự ý xóa — có thể ảnh hưởng Watcher đang chạy trên VPS.
