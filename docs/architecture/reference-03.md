<!-- Preserves original architecture reference lines 387–562 in their original order so repository documentation remains navigable in bounded files without losing historical design detail. -->
# 11. Incremental Index

Không index lại toàn bộ repository mỗi lần một file thay đổi.

Nếu:

```text
aa.js MODIFY
```

thì:

```text
MODIFY
 ↓
re-index aa.js
```

Nếu:

```text
CREATE
```

thì index file mới.

Nếu:

```text
DELETE
```

thì remove khỏi index.

Nếu:

```text
RENAME/MOVE
```

thì cập nhật path và các quan hệ liên quan.

---

# 12. File ID ổn định

Không nên chỉ dùng path làm identity của file.

Ví dụ:

```text
src/auth.js
    ↓
src/security/auth.js
```

Node nên có `file_id` ổn định để theo dõi rename/move tốt hơn.

Rename có thể ảnh hưởng:

- Code Index
- imports
- references
- tests
- history
- dependency graph

---

# 13. Code Index không phải source of truth

Code Index là cache có cấu trúc.

Source of truth:

```text
Filesystem + Git
```

Nếu index hỏng hoặc không nhất quán:

```text
index inconsistent
       ↓
full rebuild
```

Có thể có command:

```text
forge index rebuild
```

Hoặc Node tự phát hiện và rebuild.

---

# 14. Context Broker / Context Engine

Node không đưa toàn bộ project cho AI.

Node đóng vai trò Context Broker:

```text
             BUILDER
                 │
          cần context
                 │
                 ▼
              NODE
                 │
        ┌────────┼─────────┐
        ▼        ▼         ▼
      Index    Files      Git
        │
        ▼
   đúng dữ liệu
        │
        ▼
     BUILDER
```

Agent có thể yêu cầu:

```text
READ_FILE
READ_SYMBOL
READ_RANGE
SEARCH
GET_CALLERS
GET_DEFINITION
GET_IMPORTS
GET_DIFF
GET_TESTS
```

Node trả phần cần thiết.

---

# 15. Không gửi cả file mặc định

Ví dụ file nhỏ:

```text
aa.js = 80 dòng
```

Có thể gửi toàn bộ.

File lớn:

```text
aa.js = 1.000 dòng
```

Nếu Builder chỉ cần:

```text
refreshSession()
```

Node có thể trả:

```text
aa.js:420-468
```

Nếu Agent cần thêm context, nó request tiếp.

Mục tiêu:

> Ít token nhưng đủ context.

---

