# Material Verification Worker

## Mục tiêu

Material Verification Worker là tầng kiểm tra độc lập sau khi R3 trả về `submit_code_response`. Worker này không thay thế materializer, mà xác nhận patch có hợp lệ về mặt vật liệu trước khi hệ thống báo kết quả terminal.

Worker cần trả lời các câu hỏi:

```text
patch có đúng cấu trúc không?
patch có đúng ngữ cảnh file hiện tại không?
checksum có khớp trạng thái file lúc lập kế hoạch không?
anchor/expected content có tồn tại và không mơ hồ không?
patch có thể dry-apply an toàn trong memory không?
```

## Vị trí trong pipeline

Flow hiện tại nên là:

```text
R3 submit_code_response
  ↓
Materializer
  ↓
Material Verification Worker
  ↓
task.materialization_result
  ↓
stop
```

Không nên tiếp tục sang repair hoặc verification test trong phạm vi hiện tại:

```text
Materializer
  ↓
Material Verification Worker
  ↓
Repair Worker
```

Worker chỉ kiểm tra và báo kết quả. Chưa ghi file thật, chưa sửa tự động, chưa chạy test.

## Các tầng kiểm tra

### 1. Patch structure

Kiểm tra shape trước khi đọc file hoặc apply.

Yêu cầu:

- `path` tồn tại và là đường dẫn hợp lệ.
- `format` hợp lệ:
  - `full_content`
  - `structured_patch`
- NEW file:
  - `exists === false`
  - `before_checksum === null`
  - `content` là string đầy đủ
- MODIFY file:
  - `exists === true`
  - `content.operations` là array
  - mỗi operation có `op`
  - không thừa field ngoài schema
  - không dùng line number, offset hoặc placeholder ngoài contract

Ví dụ lỗi cấu trúc:

```json
{
  "path": "frontend/src/components/Header.jsx",
  "status": "invalid",
  "code": "PATCH_STRUCTURE_INVALID",
  "message": "structured_patch.content.operations is missing."
}
```

### 2. Checksum verification

Checksum là guard chống stale context.

Flow:

```text
R3 request gửi file kèm before_checksum
  ↓
agent trả submit_code_response giữ before_checksum
  ↓
Worker đọc current file
  ↓
so sánh checksum current file với before_checksum
  ↓
nếu khác → invalid
```

Nếu checksum khác, nghĩa là:

- file đã thay đổi sau khi R3 được tạo
- agent trả checksum sai
- context bị stale
- working tree không còn đúng trạng thái đã duyệt

Không apply patch khi checksum mismatch vì có thể phá code hiện tại.

Ví dụ lỗi:

```json
{
  "code": "CHECKSUM_MISMATCH",
  "message": "Current file checksum does not match before_checksum provided in R3."
}
```

Với NEW file:

```text
before_checksum phải null
```

Nếu NEW nhưng file đã tồn tại:

```json
{
  "code": "NEW_FILE_ALREADY_EXISTS"
}
```

Với MODIFY nhưng file không tồn tại:

```json
{
  "code": "MODIFY_TARGET_MISSING"
}
```

### 3. Expected content verification

Với `replace_range` và `delete_range`, `expected_content` phải xuất hiện đúng trong current file.

Nguyên tắc:

- không fuzzy matching
- không bỏ qua whitespace
- không tự đoán indentation
- không dùng line number
- không dùng offset
- không chọn đoạn gần giống

Ví dụ operation hợp lệ:

```json
{
  "op": "replace_range",
  "expected_content": "existing code segment",
  "new_content": "replacement code segment"
}
```

Nếu không tìm thấy expected content:

```json
{
  "operation_index": 0,
  "code": "EXPECTED_CONTENT_NOT_FOUND",
  "message": "expected_content does not match the current file content."
}
```

### 4. Anchor verification

Với `insert_after`, `anchor_text` phải xuất hiện trong current file.

Nguyên tắc:

- anchor phải là string không rỗng
- anchor phải copy đúng từ current file
- nếu anchor xuất hiện nhiều lần thì phải từ chối vì mơ hồ
- không tự chọn lần xuất hiện đầu tiên
- không dùng anchor quá ngắn như một dấu ngoặc đơn lẻ

Nếu anchor không tìm thấy:

```json
{
  "operation_index": 1,
  "code": "ANCHOR_NOT_FOUND",
  "message": "anchor_text does not exist in the current file content."
}
```

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

```text
EXPECTED_CONTENT_NOT_FOUND
```

Không fuzzy normalize newline, tab hoặc space.

### NEW file nhưng đã tồn tại

Trả về:

```text
NEW_FILE_ALREADY_EXISTS
```

### MODIFY nhưng file không tồn tại

Trả về:

```text
MODIFY_TARGET_MISSING
```

### Thiếu before_checksum với MODIFY

Trả về:

```text
MISSING_BEFORE_CHECKSUM
```

### NEW file có before_checksum khác null

Trả về:

```text
INVALID_NEW_FILE_CHECKSUM
```

### READ_ONLY bị trả trong files

Trả về:

```text
READ_ONLY_SUBMISSION_FORBIDDEN
```

### Approved file bị thiếu

Trả về:

```text
MISSING_SUBMISSION
```

### Operation sequence phá chính nó

Operation 1 có thể pass, nhưng operation 2 dùng expected content đã bị operation 1 thay đổi. Worker phải apply tuần tự trong memory và báo lỗi đúng tại operation không còn khớp.

## Nguyên tắc an toàn

Worker hiện tại phải:

```text
dry-run in-memory
không ghi file thật
không thay đổi working tree
không tạo repair request
không chạy verification test
không tiếp tục pipeline sau khi báo kết quả
```

Nếu sau này cần kiểm tra thật trên working tree, nên tách thành chế độ riêng và có policy rõ ràng:

```text
verification_mode: "working_tree_preview"
```

## Đánh giá

Material Verification Worker rất cần thiết vì materializer hiện tại mới trả lời:

```text
patch có apply được không?
```

Nhưng chưa đủ mạnh để trả lời:

```text
patch có an toàn để coi là materialized không?
```

Hai kiểm tra quan trọng nhất là:

1. `checksum` — chống stale file và sai trạng thái working tree.
2. `anchor/expected content` — chống sửa nhầm vị trí hoặc sửa nội dung không tồn tại.

Khuyến nghị kiến trúc cuối:

```text
R3 submit_code_response
  ↓
Materializer: normalize + dry apply
  ↓
Material Verification Worker:
   - structure
   - checksum
   - expected content
   - anchor
   - sequential dry apply
   - missing approved files
   - READ_ONLY violation
  ↓
publish task.materialization_result
  ↓
stop
```
