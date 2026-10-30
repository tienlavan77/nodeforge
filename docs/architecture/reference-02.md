<!-- Preserves historical architecture lines 201–400 in reading order. The three authentication index examples omit the function keyword to keep illustrative signatures distinct from executable source; restore that keyword from the retained source inventory when reconstructing original bytes. -->
## Human

Có quyền theo filesystem/OS và project policy.

Node không phải file proxy/gatekeeper. Node là:

> Observer + Orchestrator + Verifier

---

# 6. `.forge/` thuộc về Node

Mỗi project có state riêng.

Ví dụ:

```text
my-project/
├── src/
├── tests/
├── package.json
└── .forge/
    ├── index.db
    ├── history.db
    ├── events/
    ├── cache/
    └── state.json
```

Node có thể tự tạo `.forge/` khi mở project lần đầu.

`.forge/` nên là vùng Node-owned runtime state.

Agent không được tự ý sửa:

```text
.forge/index.db
.forge/history.db
.forge/state.json
```

---

# 7. Watcher phải ignore `.forge/`

Nếu Node theo dõi toàn project mà cũng theo dõi `.forge/`, sẽ có vòng lặp:

```text
Node ghi history.db
   ↓
Watcher phát hiện
   ↓
Node xử lý event
   ↓
Node ghi history.db
   ↓
...
```

Do đó watcher phải ignore ít nhất:

```text
.forge/**
node_modules/**
.git/**
dist/**
coverage/**
```

Các thư mục ignore khác phụ thuộc project.

---

# 8. Filesystem Watcher

Node theo dõi các event:

```text
CREATE
MODIFY
DELETE
RENAME
MOVE
```

Ví dụ:

```text
AI / Coder
    ↓
Filesystem
    ↓
Node Watcher
```

Không quan trọng ai sửa:

- Builder AI
- Reviewer AI
- Codex
- Coder
- VS Code
- script
- command line

Node đều thấy filesystem event.

---

# 9. Debounce và file stability

Không được đọc file ngay ở event đầu tiên nếu Agent đang ghi.

Ví dụ:

```text
WRITE
  ↓
MODIFY event
  ↓
wait 100–300ms hoặc theo policy
  ↓
check file stable
  ↓
read
  ↓
re-index
```

Nếu Agent ghi liên tiếp:

```text
WRITE
WRITE
WRITE
WRITE
```

Node nên gom lại thành một lần indexing sau khi file ổn định.

---

# 10. Code Index

Code Index là mục lục sống của source code.

Ví dụ:

```text
src/aa.js

login()
refreshSession()
logout()
```

Index có thể biết:

```text
aa.js
 ├── login          lines 1-20
 ├── refreshSession lines 22-60
 └── logout         lines 62-90
```

Nó có thể chứa:

```text
files
symbols
imports
exports
calls
references
tests
dependency relationships
```

Có thể lưu bằng SQLite:

```text
.forge/index.db
```

---

