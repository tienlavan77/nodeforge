<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->

---

## 4. Sau R2 — Supervisor approval gate

Đây là gate bắt buộc trước R3.

Supervisor kiểm tra:

```text
concrete file paths
valid actions
task scope
allowed prefixes
candidate/index version
dependency scope
test scope
```

Sau đó tạo:

```text
approvedPlan
allowed_file_paths
allowed_symbols
approved_prefixes
before_checksums
```

Từ thời điểm này:

```text
approvedPlan = security boundary
```

Agent không được tự mở rộng plan trong R3.

---

## 5. R3 — Code submission

R3 chỉ thực thi plan đã duyệt, không discovery tự do.

### Tool được phép

```text
read_transcript_blocks
read_code
```

### Thứ tự trong R3

```text
read_transcript_blocks — nếu cần nhớ plan/rationale
        ↓
read_code — đọc current state của existing files
        ↓
submit_code_response
```

### `read_transcript_blocks`

Dùng khi Agent cần:

- plan rationale;
- file đã được chọn;
- quyết định ở R2;
- response R3 trước đó nếu R3 bị retry;
- context từ origin round.

### `read_code`

Dùng để:

- đọc file hiện tại trước khi tạo patch;
- kiểm tra code đã thay đổi sau R2;
- kiểm tra test hoặc type definition liên quan;
- xác nhận anchor/region cho patch.

Scope gồm:

```text
approvedPlan paths
+ explicitly approved test paths
+ read-only dependencies đã được Supervisor authorize
```

### R3 không được mở rộng scope

Agent không được:

- search toàn repository;
- chọn thêm file ngoài `approvedPlan`;
- tự thay đổi plan;
- đọc transcript repair không liên quan;
- dùng tool để thay thế `before_checksum`.

`before_checksum` là contract value do Supervisor push. Agent không được tự tính lại checksum từ file đang đọc rồi dùng nó thay thế contract value.

Supervisor push:

```text
approvedPlan
before_checksum
allowed_file_paths
required output contract
```

Agent pull:

```text
current file content
relevant symbols
nearby imports
tests
prior planning context
```

---

## 6. Material Worker — không gọi agent tools

Material Worker không gọi:

- `read_transcript_blocks`;
- `select_code_graph_candidates`;
- `search_code`;
- `read_code`.

MW dùng:

```text
approvedPlan
submitted code
current filesystem/material state
```

để dry-run:

```text
patch validation
checksum validation
anchor validation
new-file validation
```

và trả:

```json
{
  "valid": [],
  "invalid": [],
  "failed_operations": []
}
```

MW giữ:

```text
filesystem_write: false
```

Supervisor nhận kết quả và quyết định stop hoặc repair.

---

## 7. Sau Material Worker — Supervisor decision gate

### Thành công

```text
valid đầy đủ
invalid rỗng
```

Pipeline kết thúc hoặc chuyển sang verification tiếp theo.

### Có lỗi sửa được

```text
invalid không rỗng
repair budget còn
```

Supervisor tạo R4.

### Không thể sửa tiếp

```text
repair limit exceeded
