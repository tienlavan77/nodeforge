# Ticket: Chuẩn hóa Schema nội bộ cho Execution Layer

**Ticket ID:** FORGE-EXEC-002
**Type:** Schema Enhancement (internal)
**Priority:** High
**Liên quan:** FORGE-EXEC-001 (spec function), FORGE-SCHEMA-014 / 014-OAI (schema Node↔Agent)

---

## 1. Mục tiêu

Áp dụng `ExecutionResult` và `ExecutionContext` (định nghĩa tại FORGE-EXEC-001, mục 9) làm hợp đồng dữ liệu bắt buộc cho toàn bộ function trong Execution Layer (nhóm Dispatch, Handler, Pre-write Guard, Write Layer, Post-write Verification), thay vì mỗi hàm tự định nghĩa input/output riêng.

## 2. Vấn đề hiện tại

- Các hàm (`applyUnifiedDiff`, `applySearchReplaceBlock`, `verifyChecksum`, `runLint`, `runTests`...) chưa có hợp đồng dữ liệu chung — nguy cơ mỗi hàm trả lỗi theo format khác nhau (string, exception, object lỏng lẻo).
- `evaluateApplyResult` sẽ phải viết logic riêng cho từng loại kết quả nếu không chuẩn hóa, phá vỡ khả năng mở rộng khi thêm handler mới (VD thêm dạng diff thứ 5).
- Không có cơ chế trace thống nhất — khó replay lại toàn bộ pipeline của 1 step khi debug.

## 3. Thay đổi đề xuất

### 3.1. Định nghĩa `ExecutionResult` (bắt buộc cho mọi hàm ở nhóm 2/3/4/5 trong FORGE-EXEC-001)

```json
{
  "step_name": "string, bắt buộc",
  "success": "boolean, bắt buộc",
  "error_code": "enum | null, bắt buộc khi success=false",
  "error_message": "string | null, optional",
  "detail": "object, optional",
  "duration_ms": "number, optional"
}
```

### 3.2. Enum `error_code` cố định

```
CHECKSUM_MISMATCH | PATCH_NOT_APPLICABLE | AMBIGUOUS_MATCH | NO_MATCH |
SYNTAX_ERROR | LINT_FAILED | TEST_FAILED | BUILD_FAILED | IO_ERROR
```
Không được dùng string tự do — mọi handler mới phải map lỗi của mình vào 1 trong các giá trị trên, hoặc đề xuất bổ sung enum mới qua review.

### 3.3. Định nghĩa `ExecutionContext` (object xuyên suốt pipeline)

```json
{
  "task_id": "string",
  "step_id": "number",
  "change": "object — nguyên bản 1 phần tử changes[] từ agent",
  "trace": "array<ExecutionResult> — tích lũy qua từng bước"
}
```

**Quy tắc bắt buộc:** mọi hàm nhận `ExecutionContext` phải trả về `ExecutionContext` đã cập nhật (immutable-style, không mutate ẩn) để pipeline có thể pipe tuần tự.

## 4. Ảnh hưởng

- Toàn bộ hàm liệt kê trong FORGE-EXEC-001 (nhóm 2 → 5) cần refactor để tuân theo `ExecutionResult`.
- `evaluateApplyResult` viết lại theo switch-case trên `error_code` thay vì kiểm tra ngoại lệ/string.
- `logExecutionTrace` đơn giản hóa: chỉ cần dump `ExecutionContext.trace[]`, không cần gom log từ nhiều nguồn rời rạc.
- Không ảnh hưởng schema Node↔Agent (FORGE-SCHEMA-014/014-OAI) — đây là lớp nội bộ, hoàn toàn tách biệt.

## 5. Việc cần làm

- [ ] Định nghĩa `ExecutionResult` và `ExecutionContext` thành JSON Schema / TypeScript interface chính thức trong codebase Forge.
- [ ] Refactor các hàm nhóm 2 (`applyUnifiedDiff`, `applySearchReplaceBlock`, `applyFullFileReplace`, `applyStructuredPatch`) trả về đúng `ExecutionResult`.
- [ ] Refactor các hàm nhóm 3 (`verifyChecksum`, `dryRunApply`, `validateSyntax`) theo cùng chuẩn.
- [ ] Refactor các hàm nhóm 4 (`backupFile`, `writeFile`, `rollbackFile`) — bổ sung `error_code: IO_ERROR` khi cần.
- [ ] Refactor các hàm nhóm 5 (`runLint`, `runTests`, `runBuildCheck`) trả kết quả có cấu trúc thay vì raw stdout.
- [ ] Viết lại `evaluateApplyResult` dùng switch theo `error_code`.
- [ ] Viết lại `logExecutionTrace` dựa trên `ExecutionContext.trace[]`.
- [ ] Test case: giả lập từng `error_code`, verify `evaluateApplyResult` route đúng nhánh (commit/rollback/retry).
- [ ] Cập nhật tài liệu FORGE-EXEC-001 nếu phát sinh `error_code` mới trong quá trình implement.
