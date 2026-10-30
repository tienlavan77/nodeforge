<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->

#### Mục đích

Đọc chính xác implementation, test, type/interface, import boundary và code liên quan.

Ví dụ đọc line range:

```json
{
  "path": "frontend/src/Header.jsx",
  "start_line": 1,
  "end_line": 180
}
```

Hoặc đọc symbol:

```json
{
  "path": "frontend/src/Header.jsx",
  "symbol": "Header"
}
```

R2 không nên đọc nguyên repository. Mỗi lần đọc phải liên quan trực tiếp đến discovery hoặc acceptance criteria.

### Kết thúc R2

R2 kết thúc khi Agent trả `planning` có plan concrete:

```json
{
  "plan": [
    {
      "path": "frontend/src/Header.jsx",
      "action": "MODIFY"
    },
    {
      "path": "frontend/src/Nav.jsx",
      "action": "NEW"
    }
  ]
}
```

Supervisor kiểm tra:

- path là concrete path;
- path nằm trong task scope;
- action hợp lệ;
- không có file ngoài scope;
- test files đã được xem xét nếu acceptance criteria yêu cầu;
- `READ_ONLY` không bị chuyển thành `MODIFY` ngầm.

Sau khi plan được duyệt, `approvedPlan` trở thành security boundary cho R3 và R4+.

---

## 4. R3 — Code submission

R3 không phải round discovery tự do. Đây là round thực thi plan đã duyệt.

### `read_code`

Được dùng để:

- đọc lại file hiện tại trước khi tạo patch;
- kiểm tra code đã thay đổi sau R2;
- kiểm tra test hoặc type definition liên quan;
- xác nhận anchor/region cho patch.

Scope gồm:

```text
approvedPlan paths
+ explicitly approved test paths
+ read-only dependencies đã được Supervisor authorize
```

### `read_transcript_blocks`

Dùng khi Agent cần nhớ:

- plan rationale;
- file đã được chọn;
- quyết định ở R2;
- response R3 trước đó nếu R3 bị retry;
- context từ origin round.

R3 ưu tiên đọc summary của R1/R2 khi request đã chứa đủ thông tin:

```json
{
  "rounds": [1, 2],
  "include": "summary"
}
```

### Không dùng R3 để mở rộng scope

Agent không được dùng R3 để:

- search toàn repository để tự mở rộng scope;
- chọn thêm file ngoài `approvedPlan`;
- tự thay đổi plan;
- đọc transcript repair không liên quan;
- dùng tool để thay thế `before_checksum`.

`before_checksum` là contract value do Supervisor push. Agent không được tự tính lại checksum từ file đang đọc rồi coi đó là contract value.

Supervisor push vào R3:

```text
approvedPlan
before_checksum
allowed_file_paths
required output contract
```

Agent pull bằng tool:

```text
current file content
relevant symbols
nearby imports
tests
prior planning context
```

---

## 5. Material Worker — không dùng agent tools

Material Worker không gọi:

- `search_code`;
- `read_code`;
- `select_code_graph_candidates`;
- `read_transcript_blocks`.

MW chỉ làm:

```text
approvedPlan + submitted code
    → dry-run materialization
    → checksum/anchor/patch verification
    → valid / invalid
```

Lý do:

- MW phải verify trên state thật;
- Agent không được tự kiểm chứng output của chính Agent;
- retrieval không được làm thay đổi kết quả verification;
- MW phải giữ `filesystem_write: false`.

Sau MW, Supervisor nhận:

```json
{
  "valid": [],
  "invalid": [],
  "failed_operations": []
}
```

Supervisor quyết định stop hoặc bắt đầu repair.

---

## 6. R4, R5 và các repair round

Repair là nơi bốn tool có giá trị lớn nhất, nhưng phải phân biệt rõ **push** và **pull**.

### 6.1 Dữ liệu Supervisor bắt buộc push

Agent không được tự pull các dữ liệu sau:

```text
before_checksum
errors
failed_operations
valid_paths
locked_new_files
repair round number
origin round
allowed_file_paths
```

Lý do:
