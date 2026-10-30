<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
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
