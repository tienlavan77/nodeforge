<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->

- `before_checksum` là contract value đã được Supervisor/MW xác nhận;
- `errors` là lý do MW reject, không phải dữ liệu filesystem;
- `failed_operations` cần phản ánh chính xác submission thất bại;
- `valid_paths` là policy của Supervisor;
- `locked_new_files` chứa NEW file hợp lệ nhưng chưa tồn tại trên disk;
- repair metadata do Supervisor sở hữu.

Vì `filesystem_write: false`, file NEW đã valid có thể chỉ tồn tại trong memory/material state. Supervisor phải push nội dung của chúng nếu repair patch phụ thuộc vào chúng.

### 6.2 `read_transcript_blocks` trong repair

Dùng để lấy episodic memory:

- R3 đã submit gì;
- plan rationale;
- repair round trước;
- response summary;
- full origin R3 khi cần.

Default:

```text
R4: R3 + current repair context
R5: R3 + R4 + current repair context
R6+: origin R3 + summary các repair cũ + repair liên quan trực tiếp
```

Ví dụ:

```json
{
  "rounds": [3, 4],
  "include": "response"
}
```

Không mặc định kéo full content của mọi round cũ. `transcript_blocks` index tất cả round; tool request chỉ mở rộng các round cần thiết.

### 6.3 `read_code` trong repair

Dùng để kiểm tra state hiện tại:

- existing MODIFY file;
- vùng anchor;
- imports liên quan;
- test liên quan;
- nội dung file đã tồn tại trên filesystem.

| Loại file | Cách lấy context |
|---|---|
| Existing MODIFY | `read_code` |
| Existing READ_ONLY | `read_code`, nếu được authorize |
| NEW đã valid nhưng chưa ghi disk | Supervisor push `locked_new_files` |
| NEW chưa valid | Không coi là tồn tại trên disk |
| Ngoài `valid_paths`/`allowed_file_paths` | Không được đọc |

### 6.4 `search_code` trong repair

Chỉ dùng khi lỗi yêu cầu thêm discovery, ví dụ:

- `ANCHOR_NOT_FOUND`;
- `AMBIGUOUS_ANCHOR`;
- patch target đã đổi;
- dependency/reference bị thay đổi;
- cần tìm test hoặc implementation liên quan trong approved scope.

Nếu search phát hiện file mới:

```text
search result
  → Supervisor kiểm tra
  → cập nhật repair scope/approvedPlan
  → mới cho read_code
```

Agent không được làm:

```text
search_code phát hiện path
  → read_code path đó ngay
```

### 6.5 `select_code_graph_candidates` trong repair

Mặc định không gọi lại.

Chỉ gọi khi:

- dependency graph ban đầu sai;
- R3 chạm module ngoài candidate set;
- Supervisor cho phép re-discovery;
- candidate selection vẫn nằm trong task scope.

Các lỗi đơn giản như `CHECKSUM_MISMATCH`, `MISSING_SUBMISSION` hoặc `PATCH_NOT_APPLICABLE` thường chỉ cần:

```text
failed_operations
read_code target
read_transcript_blocks R3
```

---

## 7. Bảng routing theo round

| Round | `read_transcript_blocks` | `select_code_graph_candidates` | `search_code` | `read_code` |
|---|---:|---:|---:|---:|
| R1 | Khi cần history | Không mặc định | Không | Không |
| R2 discovery | Summary khi cần | Có, ưu tiên đầu tiên | Có | Có |
| R3 submission | R1/R2 khi cần | Không | Không mặc định | Có |
| Material Worker | Không | Không | Không | Không |
| R4 repair | R3 + repair context | Không mặc định | Khi lỗi cần discovery | Có |
| R5+ repair | Origin + repair liên quan | Chỉ khi scope cần re-discovery | Trong scope | Có |

---

## 8. Retrieval budget

Các tool dùng governance hiện có:

```text
DEFAULT_MAX_CALLS = 20
DEFAULT_MAX_BYTES = 200000
```

Ngân sách đề xuất:

### R1

```text
max_calls: 4
max_bytes: 30000
```

### R2

```text
max_calls: 20
max_bytes: 200000
```

Phân bổ tham khảo:

```text
select_code_graph_candidates: 1–2 calls
search_code: 2–5 calls
read_code: 5–10 calls
read_transcript_blocks: 0–2 calls
```

### R3

```text
max_calls: 8
max_bytes: 100000
```

Chủ yếu dành cho `read_code`, không discovery rộng.

### R4+

```text
max_calls: 12
max_bytes: 150000
```

Phân bổ tham khảo:

```text
read_transcript_blocks: 1–3 calls
read_code: 3–8 calls
search_code: 0–3 calls
select_code_graph_candidates: 0–1 call
```

Nếu vượt budget:

```text
CONTEXT_BUDGET_EXCEEDED
```

Không được âm thầm cắt context. Supervisor phải persist event, sau đó giảm retrieval scope, push thêm binding facts, hoặc escalate `REPAIR_CONTEXT_TOO_LARGE`.

---

## 9. Tool context do Supervisor cấp

Security fields phải do runtime tạo, không lấy từ input của Agent:

