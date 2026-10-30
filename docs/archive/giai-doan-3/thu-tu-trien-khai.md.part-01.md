<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
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
