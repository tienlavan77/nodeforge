<!-- Preserves an ordered section of the historical Material Verification Worker design so engineers can recover its original requirements after document splitting. -->
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
