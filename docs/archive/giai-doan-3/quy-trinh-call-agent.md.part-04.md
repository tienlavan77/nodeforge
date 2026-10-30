<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
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
