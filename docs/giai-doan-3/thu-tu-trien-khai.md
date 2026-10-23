# Thứ tự triển khai tool vào pipeline gọi Agent

## Trạng thái tài liệu

Tài liệu này là thiết kế triển khai cho bốn tool hiện có:

- `read_transcript_blocks`
- `select_code_graph_candidates`
- `search_code`
- `read_code`

Các tool hiện **chưa được nối vào Supervisor**. Nội dung dưới đây chỉ mô tả thứ tự và boundary cần triển khai sau khi cho phép Tầng 2.

Nguyên tắc nền tảng:

> Supervisor là orchestrator duy nhất. Agent chỉ gọi tool trong scope do Supervisor cấp. Worker không gọi worker khác.

> Agent không đọc trực tiếp filesystem hoặc database. Mọi truy xuất đều đi qua Forge-owned service.

---

## 1. Pipeline tổng thể

```text
R1 — Task intake
  → R2 — Discovery
  → R2 — Planning
  → Supervisor approval gate
  → R3 — Code submission
  → Material Worker
  → Supervisor verification decision
  → R4+ — Repair nếu cần
```

---

## 2. R1 — Task intake

### Tool mặc định

R1 không gọi code tools. Agent nhận:

```text
task statement
acceptance criteria
project context cơ bản
transcript summary nếu Supervisor đã push
```

`read_transcript_blocks` chỉ được dùng khi Agent thực sự cần memory lịch sử. Không nên tự động đọc toàn bộ transcript.

Ví dụ:

```json
{
  "rounds": [1, 2, 3],
  "include": "summary"
}
```

### Vì sao R1 chưa dùng code tools

R1 chưa có `approvedPlan`. Nếu cho Agent dùng `search_code` hoặc `read_code` tự do:

- chưa có file boundary cho ticket;
- Agent có thể khám phá ngoài phạm vi cần thiết;
- discovery có thể biến thành kế hoạch ngầm;
- Supervisor mất quyền kiểm soát security scope.

Kết quả R1 thường là:

```text
code_needed
```

hoặc nếu đủ thông tin:

```text
planning
```

---

## 3. R2 — Discovery

Đây là round đầu tiên dùng đầy đủ code tools.

### Thứ tự bắt buộc mặc định

```text
select_code_graph_candidates
        ↓
search_code
        ↓
read_code
```

Không phải R2 nào cũng cần cả ba tool, nhưng đây là thứ tự chuẩn.

### 3.1 Supervisor chuẩn bị discovery context

Supervisor hoặc Forge orchestration service chuẩn bị:

```text
task_id
execution_scope
allowed_prefixes
candidate set ban đầu
index_version
capabilities
retrieval budget
```

Candidate set phải đến từ Forge Code Graph/Index service. Agent không được tự đọc database để tạo candidates.

### 3.2 `select_code_graph_candidates`

Agent chọn tối đa bốn candidate từ danh sách Node đã cấp:

```text
context.candidates
  → select_code_graph_candidates
  → selected candidates
```

Tool chỉ chọn candidate, không tự query Code Index.

Nếu Agent gửi path không có trong `context.candidates`, tool phải reject.

### 3.3 `search_code`

Agent tìm metadata trong Code Index:

```text
implementation
usages
symbols
tests
related files
```

Luồng dữ liệu:

```text
search_code
  → Forge Code Search
  → Code Index
  → metadata kết quả
```

Tool không trả full file content và không expose database handle.

### 3.4 `read_code`

Agent đọc file hoặc symbol đã được authorize:

```text
selected candidates
search results
approved discovery paths
```

Luồng dữ liệu:

```text
read_code
  → Forge File Service.readForIndex()
  → live project file
```

Tool không dùng trực tiếp `fs` và không nhận filesystem handle.

### 3.5 Agent trả planning

Agent trả `planning` với concrete plan:

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
select_code_graph_candidates
```

Capability cuối cùng chỉ cấp sau khi Supervisor quyết định mở rộng discovery scope.

---

## 11. Retrieval budget đề xuất

Các tool dùng governance hiện có:

```text
DEFAULT_MAX_CALLS = 20
DEFAULT_MAX_BYTES = 200000
```

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

## 12. Tool context do Supervisor cấp

Security fields phải do runtime tạo, không lấy từ input của Agent:

```js
{
  task_id,
  supervisor_id,
  execution_scope: {
    task_id,
    round,
    origin_round,
    allowed_file_paths,
    approved_plan_paths
  },
  capabilities: [
    "read_transcript_blocks",
    "select_code_graph_candidates",
    "search_code",
    "read_code"
  ],
  allowed_file_paths,
  allowed_prefixes,
  candidates,
  index_version,
  context_budget: {
    max_calls,
    max_bytes
  },
  audit_retrieval,
  consume_retrieval
}
```

Agent chỉ gửi input nghiệp vụ:

```js
{
  query,
  path,
  start_line,
  end_line,
  symbol,
  selected,
  rounds,
  include
}
```

Agent không được gửi hoặc thay thế:

```js
{
  task_id: "other-task",
  allowed_file_paths: ["outside/scope"],
  capabilities: ["read_everything"]
}
```

Các field security phải do runtime kiểm soát, không được tin từ input Agent.

---

## 13. Push và pull boundary

### Supervisor push

```text
small binding facts
checksums
errors
failed_operations
valid_paths
locked_new_files
approvedPlan
execution scope
```

### Agent pull qua tool

```text
large existing file content
symbols
imports
tests
prior transcript details
code graph metadata
```

### Không được pull

```text
before_checksum
MW errors/failed_operations
Supervisor policy/valid_paths
```

---

## 14. Invariants

Các tool chỉ cung cấp context. Tool không được:

- quyết định `approvedPlan`;
- quyết định retry;
- quyết định valid/invalid;
- tự enqueue round;
- tự gọi worker khác;
- tự thay đổi execution scope;
- tự ghi filesystem;
- tự persist protocol ngoài cơ chế Supervisor quản lý;
- truy cập trực tiếp filesystem;
- truy cập trực tiếp Code Index database;
- nhận raw filesystem handle hoặc database handle.

Pipeline đúng:

```text
Supervisor tạo request + scope
  → Agent gọi tool trong scope
  → Agent trả tool result/response
  → Supervisor persist
  → Supervisor quyết định round tiếp theo
```

Việc nối tool vào Sender Worker/agentic loop là **Tầng 2**, chưa thực hiện trong tài liệu này.
