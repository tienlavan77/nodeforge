<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
context quá lớn
scope conflict
human decision required
```

Supervisor chuyển sang `needs_human_review`.

---

## 8. R4+ — Repair

Thứ tự chuẩn:

```text
Supervisor push binding facts
        ↓
read_transcript_blocks
        ↓
read_code
        ↓
search_code nếu lỗi cần discovery
        ↓
select_code_graph_candidates chỉ khi scope phải re-discover
        ↓
patch_repair_response
```

### 8.1 Supervisor push facts bắt buộc

Agent không được tự pull hoặc tự suy ra:

```text
valid_paths
invalid
errors
failed_operations
before_checksums
locked_new_files
origin round
repair round
allowed_file_paths
approved repair scope
```

Vì `filesystem_write: false`, file NEW đã valid có thể chỉ tồn tại trong memory/material state. Supervisor phải push nội dung `locked_new_files` nếu repair patch phụ thuộc vào chúng.

### 8.2 `read_transcript_blocks`

Dùng để đọc episodic memory:

```text
R3 đã submit gì
plan rationale
repair round trước
response summary
full origin R3 khi cần
```

Mặc định:

```text
R4: R3 + current repair context
R5: R3 + R4 + current repair context
R6+: origin R3 + summary các repair cũ + repair liên quan trực tiếp
```

Không mặc định kéo full content của mọi round cũ.

### 8.3 `read_code`

Dùng để đọc existing files trong repair scope:

```text
MODIFY target
READ_ONLY dependencies
anchor region
current imports
related tests
```

| Loại file | Cách lấy context |
|---|---|
| Existing MODIFY | `read_code` |
| Existing READ_ONLY | `read_code`, nếu được authorize |
| NEW đã valid nhưng chưa ghi disk | Supervisor push `locked_new_files` |
| NEW chưa valid | Không coi là tồn tại trên disk |
| Ngoài `valid_paths`/`allowed_file_paths` | Không được đọc |

### 8.4 `search_code`

Chỉ gọi nếu lỗi yêu cầu thêm discovery:

```text
ANCHOR_NOT_FOUND
AMBIGUOUS_ANCHOR
PATCH_NOT_APPLICABLE
dependency changed
missing related test
```

Nếu search phát hiện path mới:

```text
search result
  → Supervisor review
  → scope/plan update
  → allowlist update
  → read_code
```

Agent không được tự động đọc path mới ngay sau search.

### 8.5 `select_code_graph_candidates`

Mặc định không gọi lại trong R4/R5.

Chỉ gọi khi:

```text
dependency graph ban đầu sai
R3 phát hiện module liên quan mới
Supervisor cho phép re-discovery
repair scope được mở rộng có kiểm soát
```

Đây là tool cuối cùng trong repair vì nó có thể dẫn đến scope expansion.

---

## 9. Bảng thứ tự đầy đủ

| Giai đoạn | Thứ tự tool | Mục đích |
|---|---|---|
| R1 | `read_transcript_blocks` tùy chọn | Đọc memory lịch sử |
| R2 | `select_code_graph_candidates` → `search_code` → `read_code` | Discovery và planning |
| Approval gate | Không gọi tool | Supervisor tạo `approvedPlan` và allowlist |
| R3 | `read_transcript_blocks` tùy chọn → `read_code` | Đọc context theo plan và submit code |
| Material Worker | Không gọi agent tools | Dry-run verify |
| R4 | Push facts → `read_transcript_blocks` → `read_code` | Sửa lỗi theo context đã biết |
| R5+ | Transcript → read code → search khi cần → select candidates cuối cùng | Repair lặp có kiểm soát |

---

## 10. Capability theo round

Không cấp cả bốn capability cho mọi round.

### R1

```text
read_transcript_blocks
```

### R2

```text
read_transcript_blocks
select_code_graph_candidates
search_code
read_code
```

### R3

```text
read_transcript_blocks
read_code
```

### R4 repair thông thường

```text
read_transcript_blocks
read_code
```

### R4 repair cần discovery

```text
read_transcript_blocks
read_code
search_code
```

### Repair cần mở rộng graph

```text
read_transcript_blocks
read_code
search_code
