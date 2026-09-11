# Quy trình gọi Agent và sử dụng các tool

## Trạng thái tài liệu

Tài liệu này mô tả **thiết kế routing** cho bốn tool hiện có:

- `read_transcript_blocks`
- `select_code_graph_candidates`
- `search_code`
- `read_code`

Các tool hiện **chưa được nối vào Supervisor**. Nội dung dưới đây là quy trình đề xuất cho Tầng 2; chưa thay đổi runtime.

Nguyên tắc nền tảng:

> Supervisor là orchestrator duy nhất. SW, MW, RW và VW chỉ trả kết quả về Supervisor; không worker nào gọi worker khác.

> Supervisor quyết định round và scope. Agent dùng tool để pull context trong scope đã được cấp.

---

## 1. Tổng quan pipeline
    
```text
R1 — Task
  Agent nhận yêu cầu công việc.
  Có thể đọc memory lịch sử khi cần.

R2 — Code discovery / Planning
  Agent dùng select_code_graph_candidates.
  Agent dùng search_code.
  Agent dùng read_code.
  Agent trả approvedPlan.

R3 — Code submission
  Agent dùng read_code để kiểm tra context còn thiếu.
  Agent dùng read_transcript_blocks khi cần xem lại quyết định trước đó.
  Agent trả code.

Material Worker
  Không dùng agent tools.
  Verify trong memory/filesystem.
  Trả valid + invalid cho Supervisor.

R4+ — Repair
  Supervisor push các facts bắt buộc.
  Agent dùng read_code để kiểm tra file hiện tại.
  Agent dùng read_transcript_blocks để xem lại R3 hoặc repair history.
  Agent trả patch repair.
```

---

## 2. R1 — Nhận task

### Tool được phép

`read_transcript_blocks` chỉ dùng khi Agent thực sự cần memory lịch sử. R1 không nên tự động đọc toàn bộ transcript.

Ví dụ:

```json
{
  "rounds": [1, 2, 3],
  "include": "summary"
}
```

Nếu cần kiểm tra một quyết định cụ thể, Agent chỉ yêu cầu block liên quan.

### Vì sao R1 chưa dùng code tools

R1 chưa có `approvedPlan`. Nếu cho Agent dùng `search_code` hoặc `read_code` tự do:

- chưa có file boundary cho ticket;
- Agent có thể khám phá ngoài phạm vi cần thiết;
- discovery có thể biến thành kế hoạch ngầm;
- Supervisor mất quyền kiểm soát security scope.

R1 chủ yếu xác định Agent cần thêm code context nào và trả một trong các response:

```text
code_needed
```

hoặc, nếu đủ thông tin:

```text
planning
```

---

## 3. R2 — Code discovery và planning

Đây là round phù hợp nhất để dùng ba code tools.

### Thứ tự mặc định

```text
select_code_graph_candidates
        ↓
search_code
        ↓
read_code
        ↓
planning response
```

Không phải R2 nào cũng cần gọi đủ cả ba tool.

### 3.1 `select_code_graph_candidates`

#### Mục đích

Thu hẹp codebase từ task statement:

- module liên quan;
- symbol liên quan;
- dependency lân cận;
- các file có điểm liên quan cao.

#### Cách dùng

Tool chỉ trả candidate metadata, không trả full content:

```json
{
  "query": "header navigation rendering",
  "limit": 4
}
```

Ví dụ kết quả:

```json
{
  "path": "frontend/src/Header.jsx",
  "symbol": "Header",
  "score": 0.94,
  "reason": "exports Header and imports navigation"
}
```

Tool này giúp Agent chọn một số candidate nhỏ. Sau đó Agent mới đọc các candidate đã được scope.

### 3.2 `search_code`

#### Mục đích

Tìm implementation, usages, tests, imports/exports và patterns tương tự.

Query nên cụ thể:

```text
export function Header
navigation items
onClick
render route
existing test for Header
```

Ví dụ:

```json
{
  "query": "Header navigation",
  "paths": [
    "frontend/src",
    "frontend/tests"
  ],
  "max_results": 20
}
```

`search_code` chỉ trả metadata hoặc snippet giới hạn; không thay thế `read_code`:

```json
{
  "path": "frontend/src/App.jsx",
  "line_start": 12,
  "line_end": 28,
  "symbol": "App",
  "score": 0.82
}
```

Không nên search toàn repository vô hạn với các query như `find everything`, `search entire repository` hoặc `all files`.

### 3.3 `read_code`

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
    "search_code",
    "read_code"
  ],
  allowed_file_paths,
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

Các field security phải bị runtime bỏ qua hoặc reject, không được tin từ input.

---

## 10. Quy tắc push và pull

### Push — Supervisor đưa thẳng vào request

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

### Pull — Agent tự lấy bằng tool

```text
large existing file content
symbols
imports
tests
prior transcript details
code graph context
```

### Không được pull

Ba nhóm không bao giờ để Agent tự suy ra bằng retrieval:

```text
before_checksum
MW errors/failed_operations
Supervisor policy/valid_paths
```

---

## 11. Các invariant không được vi phạm

Các tool chỉ cung cấp context. Tool không được:

- quyết định `approvedPlan`;
- quyết định retry;
- quyết định valid/invalid;
- tự enqueue round;
- tự gọi worker khác;
- tự thay đổi execution scope;
- tự ghi filesystem;
- tự persist protocol ngoài cơ chế Supervisor quản lý.

Pipeline đúng là:

```text
Supervisor tạo request + scope
  → Agent gọi tool trong scope
  → Agent trả response/tool result
  → Supervisor persist và quyết định round tiếp theo
```

Việc nối tool vào Sender Worker/agentic loop là **Tầng 2**, chưa thực hiện trong tài liệu này.
