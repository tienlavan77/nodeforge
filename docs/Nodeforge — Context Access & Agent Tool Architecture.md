# Nodeforge — Context Access & Agent Tool Architecture

## 1. Mục tiêu

Nodeforge không nên biến Agent thành một phiên bản của Codex CLI có quyền tự do đọc toàn bộ repository.

Mục tiêu:

> Agent chỉ được truy cập dữ liệu cần thiết, thông qua các capability có kiểm soát và trong giới hạn Context Budget.

Thiết kế phải ưu tiên:

- Context nhỏ mặc định.
- Retrieval theo nhu cầu.
- Không inject toàn bộ transcript/repository vào mỗi request.
- Agent không tự do khám phá toàn bộ project.
- Nodeforge kiểm soát phạm vi dữ liệu Agent được phép truy cập.
- Không để Nodeforge phải tự đọc file/patch file thay cho Agent chỉ vì Agent thiếu tool.

---

## 2. Vấn đề với `transcript_blocks`

Ví dụ:

```json
{
  "transcript_blocks": [
    {
      "block_id": "round-1",
      "cacheable": false,
      "full_request_ref": "task/FORGE-UI-052/round_1/request",
      "full_response_ref": "task/FORGE-UI-052/round_1/response",
      "in_window": true,
      "instruction": "task",
      "response_summary": "code_needed",
      "round": 1
    }
  ]
}
```

`transcript_blocks` chỉ là **index/reference**, không phải full content.

Điều này là có chủ đích để tiết kiệm context.

Agent nhìn thấy:

```text
round-1
response_summary = code_needed
full_response_ref = ...
```

Nếu Agent cần nội dung đầy đủ thì phải có capability để đọc reference đó.

Nếu không có tool tương ứng, Agent sẽ báo:

> chưa được cung cấp công cụ để đọc reference.

Do đó việc có `File Service` hoặc `Transcript Service` ở backend **chưa đủ**.

Capability phải thực sự xuất hiện trong Agent tool definitions.

---

# 3. Tool không đồng nghĩa với quyền đọc tự do

Không nên thiết kế:

```text
Agent
 ├── read_file(any path)
 ├── search_files(any query)
 ├── read_repository()
 └── ...
```

Cách này dễ biến Nodeforge thành:

```text
Agent
 → search repository
 → đọc file A
 → đọc file B
 → đọc file C
 → đọc thêm dependency
 → context phình lớn
```

Kết quả là Nodeforge mất lợi thế Context Budget và trở thành một Codex CLI khác.

---

# 4. Kiến trúc mong muốn

```text
                    ┌─────────────────┐
                    │      Agent      │
                    │   Reasoning     │
                    └────────┬────────┘
                             │
                     Agent Tool Layer
                             │
                  Controlled Capabilities
                             │
          ┌──────────────────┼──────────────────┐
          ↓                  ↓                  ↓
  read_transcript      read_context        apply_patch
          │                  │                  │
          └──────────────────┼──────────────────┘
                             ↓
                       Nodeforge Runtime
                             │
          ┌──────────────────┼──────────────────┐
          ↓                  ↓                  ↓
      Services            Workers            Event Bus
```

Agent chịu trách nhiệm:

> quyết định cần làm gì.

Tool chịu trách nhiệm:

> cung cấp capability để Agent thực hiện hành động.

Nodeforge Runtime chịu trách nhiệm:

> boundary, authorization, identity, lifecycle, persistence, queue, event và recovery.

---

# 5. Context Engine là thành phần quan trọng

Nodeforge không nên để Agent tự quyết định toàn bộ repository cần đọc.

Nên có:

```text
Supervisor
    ↓
Context Service
    ↓
Context Budget
    ↓
Relevant Context
    ↓
Agent
```

Context Service quyết định dữ liệu nào được đưa vào context ban đầu.

Ví dụ:

```text
transcript_blocks
relevant_files
task metadata
project memory
task summary
```

Agent nhận context nhỏ trước.

Chỉ khi thật sự cần, Agent mới được mở rộng context thông qua controlled tool.

---

# 6. Retrieval theo nhu cầu

Flow mong muốn:

```text
transcript_blocks
       ↓
Agent thấy response_summary
       ↓
Agent quyết định cần round-1
       ↓
read_transcript(full_response_ref)
       ↓
Tool trả full content
       ↓
Agent reasoning
```

Không nên:

```text
Node
 ↓
đọc toàn bộ transcript
 ↓
nhét toàn bộ transcript vào prompt
 ↓
Agent
```

---

# 7. Token behavior

Tool không làm dữ liệu trở thành "miễn phí token".

Nếu Agent gọi:

```text
read_transcript(ref)
```

và tool trả về 10 KiB content, content đó trở thành tool result mà model phải xử lý.

Do đó phần content được retrieval vẫn có token cost.

Lợi ích của retrieval là:

> Không phải request nào cũng phải mang toàn bộ dữ liệu.

Ví dụ:

```text
Context ban đầu:

transcript_blocks       ~100 tokens
task context            ~200 tokens
memory                  ~300 tokens
```

Agent cần round-1:

```text
read_transcript()
        ↓
+ transcript round-1
```

Thay vì:

```text
Mọi request
+ toàn bộ transcript lịch sử
```

---

# 8. Context Budget phải áp dụng cho Tool

Tool retrieval cũng phải chịu Context Budget.

Không nên để:

```text
read_transcript(full)
```

là cách duy nhất.

Có thể hỗ trợ:

```text
read_transcript(
  ref,
  mode: "summary"
)
```

hoặc:

```text
read_transcript(
  ref,
  mode: "chunk",
  offset: ...,
  limit: ...
)
```

hoặc:

```text
read_transcript(
  ref,
  mode: "full"
)
```

Mục tiêu:

```text
Agent cần summary
    ↓
~200 tokens
```

thay vì:

```text
Agent cần summary
    ↓
20,000 tokens
```

---

# 9. Agent Tools nên chia thành capability, không phải service

Không expose toàn bộ service nội bộ cho Agent.

Không nên:

```text
EventStore
HistoryStore
MemoryStore
Queue
SupervisorManager
FileService
TranscriptService
...
```

thành hàng chục Agent tools.

Thay vào đó có một Agent Tool Layer ổn định:

```text
Agent
  ↓
Agent Tool Layer
  ↓
Nodeforge Services
```

Ví dụ:

```text
read_transcript
read_context
read_file
patch_file
run_command
```

Nhưng mỗi tool phải có **scope và policy**.

---

# 10. Initial Tool Set

Các capability nền tảng có thể gồm:

```text
read_transcript
read_file
search_files
patch_file
run_command
```

Nhưng không phải tất cả đều phải được unrestricted.

### `read_transcript`

Cho phép Agent đọc transcript thông qua reference đã được cấp.

```text
read_transcript(ref)
```

Không cho phép Agent tự truy cập transcript ngoài task scope.

### `read_file`

Cho phép đọc file đã nằm trong phạm vi context/task.

Không nên mặc định cho Agent đọc mọi path trong repository.

### `search_files`

Là capability cần kiểm soát chặt hơn.

Nếu cần dùng, phải có:

- task scope
- result limit
- size limit
- context budget
- giới hạn số lần retrieval

Không nên có:

```text
search_files("*")
```

không giới hạn.

### `patch_file`

Agent có thể yêu cầu thay đổi file.

Nhưng file phải thuộc scope được Nodeforge cấp.

Nodeforge vẫn validate:

- task scope
- file scope
- patch validity
- identity
- atomic apply policy

### `run_command`

Cho phép Agent thực hiện command cần thiết.

Phải chịu execution policy và task scope.

---

# 11. Agent không được có `read_repository`

Không tạo capability kiểu:

```text
read_repository()
```

hoặc:

```text
dump_project()
```

hoặc bất kỳ tool nào trả toàn bộ repository.

Nodeforge phải ưu tiên:

```text
relevant context
+
on-demand controlled retrieval
```

thay vì:

```text
full repository access
```

---

# 12. Patch cũng phải có boundary

Không nên:

```text
Agent
 ↓
patch_file(any_path)
```

Nên:

```text
Agent
 ↓
patch_file(file_ref, patch)
 ↓
Nodeforge Tool Runtime
 ↓
validate scope
 ↓
Patch Service
 ↓
Apply Gate
```

Agent được quyền yêu cầu thay đổi.

Nodeforge vẫn bảo vệ execution boundary.

---

# 13. Phân chia trách nhiệm

## Agent

- Reasoning.
- Quyết định cần đọc gì.
- Quyết định cần sửa gì.
- Quyết định khi nào cần retrieval.
- Quyết định khi nào cần command.

## Context Service

- Xây dựng context ban đầu.
- Chọn relevant information.
- Quản lý context budget.
- Cung cấp references.
- Không nhét toàn bộ lịch sử vào Agent.

## Agent Tool Layer

- Expose capability cho Agent.
- Validate input.
- Kiểm soát scope.
- Resolve reference.
- Gọi service tương ứng.
- Trả kết quả có giới hạn.

## Supervisor

- Task lifecycle.
- Workflow orchestration.
- Identity/correlation.
- Queue/event coordination.
- Recovery.
- Không thay Agent reasoning.

## Services/Workers

- Thực hiện operation chuyên biệt.
- Không tự quyết định workflow của Agent.

---

# 14. Nguyên tắc kiến trúc cốt lõi

### Principle 1 — Reference First

Context mặc định chứa reference/summary thay vì full content.

```text
reference → retrieval → content
```

### Principle 2 — On-Demand Retrieval

Agent chỉ lấy full content khi thực sự cần.

### Principle 3 — Controlled Access

Tool không đồng nghĩa unrestricted access.

### Principle 4 — Budgeted Retrieval

Mọi retrieval đều phải chịu Context Budget.

### Principle 5 — Task Scope

Agent chỉ được truy cập dữ liệu liên quan task/current execution scope.

### Principle 6 — No Repository Dump

Không cung cấp tool cho phép Agent lấy toàn bộ repository.

### Principle 7 — Agent Owns Reasoning

Nodeforge không nên đọc file/patch file rồi suy nghĩ thay Agent chỉ vì Agent thiếu capability.

### Principle 8 — Runtime Owns Safety

Nodeforge Runtime vẫn kiểm soát identity, permission, lifecycle, persistence, queue, event và atomic apply.

---

# 15. Kiến trúc cuối cùng

```text
                         Nodeforge
                            │
                     ┌──────┴──────┐
                     │ Context     │
                     │ Engine      │
                     └──────┬──────┘
                            │
                    Budgeted Context
                            │
                            ↓
                       ┌─────────┐
                       │  Agent  │
                       │Reasoning│
                       └────┬────┘
                            │
                     Controlled Tools
                            │
          ┌─────────────────┼─────────────────┐
          ↓                 ↓                 ↓
   read_transcript     read_file        patch_file
          │                 │                 │
          ↓                 ↓                 ↓
   Transcript Service   File Service    Patch Service
          │                 │                 │
          └─────────────────┼─────────────────┘
                            ↓
                     Nodeforge Runtime
                            │
                 Supervisor / Workers /
                 Queue / Event / Recovery
```

## Kết luận

Nodeforge **không nên đi theo hướng "cho Agent tất cả tool để Agent tự do làm mọi thứ"**.

Mục tiêu đúng là:

> **Cho Agent đủ capability để tự chủ, nhưng không cho Agent tự do truy cập toàn bộ dữ liệu.**

Agent phải có khả năng:

```text
reason
  ↓
request specific capability
  ↓
retrieve only required data
  ↓
reason again
  ↓
execute controlled action
```

Thay vì:

```text
reason
  ↓
đọc toàn repository
  ↓
context phình lớn
  ↓
reason
  ↓
đọc thêm
```

Đây là điểm khác biệt quan trọng giữa **Nodeforge Agent Runtime** và một CLI coding agent thông thường.