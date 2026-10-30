<!-- Preserves an ordered section of the historical Material Verification Worker design so engineers can recover its original requirements after document splitting. -->

Nếu anchor xuất hiện nhiều lần:

```json
{
  "operation_index": 1,
  "code": "AMBIGUOUS_ANCHOR",
  "message": "anchor_text exists multiple times and cannot identify a unique insertion point."
}
```

`insert_at_end` không cần anchor, chỉ append vào cuối file.

### 5. Sequential dry apply

Worker phải dry-apply trong memory, không ghi file thật.

Flow:

1. Đọc current file.
2. Verify checksum.
3. Clone content trong memory.
4. Apply từng operation tuần tự.
5. Sau mỗi operation, kiểm tra kết quả.
6. Nếu một operation fail, dừng và báo đúng `operation_index`.
7. Không tiếp tục apply các operation còn lại.
8. Tạo proposed content.
9. Không ghi disk.

Kết quả hợp lệ:

```json
{
  "valid": true,
  "proposed_content": "...",
  "applied_operations": 3,
  "after_checksum": "..."
}
```

Kết quả không hợp lệ:

```json
{
  "valid": false,
  "operation_index": 1,
  "code": "EXPECTED_CONTENT_NOT_FOUND"
}
```

Quan trọng: operation sau phải được đối chiếu với content đã bị operation trước thay đổi, không đối chiếu với original file.

## Materializer vs Material Verification Worker

### Materializer

Chịu trách nhiệm:

```text
parse response
normalize file format
apply thử structured patch
phân loại valid/invalid cơ bản
```

### Material Verification Worker

Chịu trách nhiệm:

```text
audit lại valid_patches
kiểm tra checksum
kiểm tra expected content
kiểm tra anchor uniqueness
kiểm tra patch structure
kiểm tra missing approved files
xác nhận proposed content thực sự dry-apply được
```

Materializer tạo candidate result. Material Verification Worker là cổng kiểm tra cuối trước khi hệ thống báo terminal result.

## Missing approved files

Nếu approved plan có `NEW` hoặc `MODIFY` nhưng R3 không trả file đó, hệ thống không throw trước materialization. File bị thiếu phải xuất hiện trong `invalid_patches`.

Ví dụ:

```json
{
  "patch_id": "MISSING-frontend/src/components/Header.jsx",
  "path": "frontend/src/components/Header.jsx",
  "format": "missing_submission",
  "status": "invalid",
  "file_result": "rejected",
  "error": {
    "operation_index": 0,
    "status": "invalid",
    "code": "MISSING_SUBMISSION",
    "message": "Approved file was not submitted by R3."
  }
}
```

## READ_ONLY files

READ_ONLY có thể xuất hiện trong plan và context, nhưng không được xuất hiện trong `submit_code_response.files`.

Nếu agent trả READ_ONLY file:

```json
{
  "code": "READ_ONLY_SUBMISSION_FORBIDDEN",
  "message": "READ_ONLY files must not be included in submit_code_response.files."
}
```

## Kết quả terminal

Terminal vẫn hiển thị đúng hai nhóm:

```text
[materialization] success
{
  "valid": [...],
  "invalid": [...],
  "invalid_count": 2
}
```

Mỗi invalid item nên có:

```json
{
  "patch_id": "PATCH-2",
  "path": "frontend/src/components/Header.jsx",
  "format": "structured_patch",
  "status": "invalid",
  "file_result": "rejected",
  "verification": {
    "checksum_ok": false,
    "structure_ok": true,
    "anchor_ok": false,
    "dry_apply_ok": false
  },
  "errors": [
    {
      "operation_index": 0,
      "code": "CHECKSUM_MISMATCH",
      "message": "Current file checksum does not match before_checksum."
    }
  ]
}
```

Mỗi valid item nên có:

```json
{
  "patch_id": "PATCH-1",
  "path": "frontend/src/app/layout.js",
  "format": "structured_patch",
  "status": "valid",
  "file_result": "materialized",
  "verification": {
    "checksum_ok": true,
    "structure_ok": true,
    "anchor_ok": true,
    "dry_apply_ok": true
  },
  "before_checksum": "...",
  "after_checksum": "..."
}
```

## Edge cases cần xử lý

### Anchor xuất hiện nhiều lần

Trả về:

```text
AMBIGUOUS_ANCHOR
```

Không tự chọn vị trí đầu tiên.

### Expected content khác whitespace

Trả về:

