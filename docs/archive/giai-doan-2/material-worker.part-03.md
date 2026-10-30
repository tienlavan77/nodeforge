<!-- Preserves an ordered section of the historical Material Verification Worker design so engineers can recover its original requirements after document splitting. -->
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
