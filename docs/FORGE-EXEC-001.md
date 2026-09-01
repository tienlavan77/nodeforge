# Forge — Execution Layer Spec (Node xử lý response từ Agent)

**Doc ID:** FORGE-EXEC-001
**Liên quan:** FORGE-SCHEMA-014 (Claude), FORGE-SCHEMA-014-OAI (ChatGPT)
**Phạm vi:** Các function Node cần có để nhận `changes[]` từ agent, apply lên filesystem an toàn, verify, và quyết định commit/rollback/retry.

---

## 0. Luồng tổng quát

```
dispatchChange
   → verifyChecksum
   → dryRunApply (gọi 1 trong 4 handler ở nhóm 2, chế độ dry-run)
   → validateSyntax
   → backupFile
   → writeFile
   → runLint → runTests → runBuildCheck
   → evaluateApplyResult
        ├─ commit   → updateTaskState
        ├─ rollback → rollbackFile → buildRetryRequest
        └─ retry    → buildRetryRequest
   → logExecutionTrace (luôn chạy, mọi nhánh)
```

---

## 1. Nhóm Dispatch (điều phối theo loại diff)

### `dispatchChange(change)`
Đọc `change.type` (hoặc suy ra từ field có mặt: `diff` / `search_replace` / `content` / `operations`) → route sang đúng handler tương ứng ở nhóm 2. Đây là entry point duy nhất — các handler không gọi trực tiếp lẫn nhau.

---

## 2. Nhóm Handler theo từng dạng diff

### `applyUnifiedDiff(filePath, diffText)`
Parse unified diff, thử apply (dry-run trước). Nếu context không khớp → trả lỗi có cấu trúc (không throw thẳng), kèm vị trí lệch.

### `applySearchReplaceBlock(filePath, oldStr, newStr)`
Tìm `oldStr` trong file — bắt buộc kiểm tra **unique match**. Nếu 0 match hoặc >1 match → trả lỗi rõ ràng để Node quyết định retry hay escalate.

### `applyFullFileReplace(filePath, newContent)`
Ghi đè toàn bộ. Đơn giản nhất nhưng vẫn phải qua lớp backup (nhóm 4) trước khi ghi.

### `applyStructuredPatch(filePath, operations[])`
Duyệt từng `operation`, validate `start/end` hoặc `anchor` còn khớp với file hiện tại trước khi áp dụng tuần tự.

---

## 3. Nhóm Validate trước khi ghi (Pre-write Guard)

### `verifyChecksum(filePath, expectedChecksum)`
So `checksum_before` trong response với hash thật của file trên đĩa — chặn race condition (file đã bị đổi bởi agent khác/step khác từ lúc agent tạo diff).

### `dryRunApply(change)`
Chạy thử patch trong bộ nhớ (không ghi đĩa), trả kết quả "sẽ thành công hay không" — dùng chung cho mọi loại diff ở nhóm 2, để quyết định apply thật hay fallback.

### `validateSyntax(filePath, newContent, language)`
Sau khi có nội dung mới (trong bộ nhớ, chưa ghi), parse thử bằng linter/AST tương ứng ngôn ngữ (JS/PHP/SCSS...) — chặn agent sinh code hỏng cú pháp trước khi nó chạm vào file thật.

---

## 4. Nhóm Ghi file an toàn (Write Layer)

### `backupFile(filePath)`
Snapshot file gốc (copy sang thư mục backup hoặc git stash/commit tạm) trước khi ghi — điều kiện tiên quyết cho rollback.

### `writeFile(filePath, content)`
Ghi thật, chỉ được gọi sau khi qua toàn bộ guard ở nhóm 3.

### `rollbackFile(filePath)`
Khôi phục từ backup nếu bước sau (lint/test) fail.

---

## 5. Nhóm Verify sau khi ghi (Post-write Verification)

### `runLint(filePath)`
Chạy linter thật (ESLint, stylelint...) trên file vừa ghi — khác `validateSyntax` ở chỗ đây là check trên đĩa, dùng tool thật của project thay vì parser nội bộ.

### `runTests(scope)`
Chạy test suite liên quan (unit test của module vừa đổi, hoặc toàn bộ nếu `scope = "full"`). Trả kết quả pass/fail có cấu trúc (không phải raw stdout).

### `runBuildCheck()`
Nếu project có build step (webpack, vite...) — chạy thử build để chắc thay đổi không phá cấu trúc tổng.

---

## 6. Nhóm Quyết định & Retry Logic

### `evaluateApplyResult(result)`
Gộp kết quả từ dry-run/lint/test → quyết định: `commit` (giữ thay đổi), `rollback` (khôi phục + báo lỗi), hay `retry` (gửi lại agent kèm lỗi cụ thể).

### `buildRetryRequest(originalRequest, error)`
Tạo request mới cho agent, nhúng `previous_error` + `retry_of_step`, có thể **downgrade** `expected_output.type` (VD từ `unified_diff` → `search_replace_block` → `full_content`) nếu retry nhiều lần vẫn fail cùng 1 kiểu lỗi.

---

## 7. Nhóm State/Logging

### `updateTaskState(taskId, stepResult)`
Cập nhật `history_summary`, tăng `step_id`, lưu vào DB/queue — chuẩn bị context cho request tiếp theo.

### `logExecutionTrace(taskId, stepId, action, result)`
Ghi log chi tiết từng hành động (apply/rollback/retry) — cần thiết cho debug multi-agent orchestration khi có nhiều task chạy song song.

---

## 8. Ghi chú thiết kế

- `dispatchChange` là **entry point duy nhất** — không có handler nào ở nhóm 2 được gọi trực tiếp từ ngoài, tránh bỏ sót bước validate.
- Mọi handler ở nhóm 2 nên có **chế độ dry-run** dùng chung code path với apply thật, chỉ khác flag — tránh 2 bộ logic riêng dễ lệch nhau (dry-run pass nhưng apply thật lại khác hành vi).
- `logExecutionTrace` chạy ở **mọi nhánh**, kể cả khi lỗi — không đặt trong nhánh `commit` only.
- Độ ưu tiên chọn `applyXxx` mặc định (theo `expected_output.type`): `search_replace_block` > `full_content` (file nhỏ) > `structured_patch` > `unified_diff` (rủi ro cao nhất, chỉ dùng khi các dạng khác không phù hợp).

---

## 9. Schema chuẩn hóa nội bộ (Execution Layer Contract)

Đây là hợp đồng dữ liệu **giữa các function trong Execution Layer** — khác với schema Node↔Agent (giao tiếp bên ngoài). Mọi hàm ở nhóm 2, 3, 5 bắt buộc tuân theo 2 object dưới đây, không được tự định nghĩa format input/output riêng.

### 9.1. `ExecutionResult` — kết quả trả về của MỌI hàm trong nhóm 2, 3, 4, 5

```json
{
  "step_name": "applySearchReplaceBlock",
  "success": true,
  "error_code": null,
  "error_message": null,
  "detail": {
    "file_path": "assets/js/components/DocumentViewer.js",
    "matched_at_line": 42
  },
  "duration_ms": 12
}
```

| Field | Kiểu | Bắt buộc | Ghi chú |
|---|---|---|---|
| `step_name` | string | ✅ | Tên hàm sinh ra kết quả này, dùng để trace |
| `success` | boolean | ✅ | Không dùng try/throw ra ngoài — mọi lỗi phải trả về qua field này |
| `error_code` | enum \| null | ✅ khi `success=false` | Xem bảng 9.2 |
| `error_message` | string \| null | optional | Message người đọc được, phục vụ log/debug, KHÔNG dùng để route logic |
| `detail` | object | optional | Dữ liệu đặc thù theo từng hàm (vị trí match, số dòng lệch...) |
| `duration_ms` | number | optional | Phục vụ monitor hiệu năng pipeline |

### 9.2. `error_code` — enum cố định (không dùng string tự do)

| error_code | Sinh ra bởi | Ý nghĩa |
|---|---|---|
| `CHECKSUM_MISMATCH` | `verifyChecksum` | File trên đĩa đã đổi so với lúc agent tạo diff |
| `PATCH_NOT_APPLICABLE` | `applyUnifiedDiff`, `applyStructuredPatch` | Context/vị trí không khớp file thật |
| `AMBIGUOUS_MATCH` | `applySearchReplaceBlock` | `oldStr` khớp >1 vị trí trong file |
| `NO_MATCH` | `applySearchReplaceBlock` | `oldStr` không tìm thấy trong file |
| `SYNTAX_ERROR` | `validateSyntax` | Nội dung mới không parse được theo ngôn ngữ khai báo |
| `LINT_FAILED` | `runLint` | Vi phạm rule linter của project |
| `TEST_FAILED` | `runTests` | 1 hoặc nhiều test liên quan fail |
| `BUILD_FAILED` | `runBuildCheck` | Build step lỗi sau khi apply thay đổi |
| `IO_ERROR` | `backupFile`, `writeFile`, `rollbackFile` | Lỗi hệ thống file (permission, disk...) |

→ `evaluateApplyResult` route quyết định (`commit/rollback/retry`) bằng switch theo `error_code`, không string-match.

### 9.3. `ExecutionContext` — object truyền xuyên suốt pipeline

```json
{
  "task_id": "task_8f3a2b",
  "step_id": 3,
  "change": { "...": "1 phần tử trong changes[] gốc từ agent" },
  "trace": []
}
```

| Field | Kiểu | Ghi chú |
|---|---|---|
| `task_id` / `step_id` | string / number | Khớp với schema Node↔Agent, dùng để liên kết log |
| `change` | object | Nguyên bản phần tử `changes[]` agent trả về, giữ nguyên không sửa |
| `trace` | array<ExecutionResult> | **Tích lũy** — mỗi hàm tự `push` kết quả của mình vào đây trước khi chuyển tiếp hàm sau |

**Quy tắc bắt buộc:** mọi hàm nhận `ExecutionContext` làm input đều phải trả về `ExecutionContext` đã cập nhật (không mutate ẩn, không trả object khác cấu trúc) — để pipeline ở mục 0 có thể pipe tuần tự qua từng hàm mà không cần logic chuyển đổi giữa các bước.

### 9.4. Lợi ích

| Không chuẩn hóa | Có chuẩn hóa |
|---|---|
| Mỗi handler tự quăng lỗi kiểu khác nhau | `evaluateApplyResult` xử lý 1 dạng duy nhất |
| Debug phải đọc log rời rạc từng bước | `trace[]` là nguồn sự thật duy nhất, replay lại toàn bộ pipeline của 1 step |
| Thêm handler mới phải sửa `evaluateApplyResult` | Handler mới chỉ cần trả đúng `ExecutionResult`, tự động tương thích |
