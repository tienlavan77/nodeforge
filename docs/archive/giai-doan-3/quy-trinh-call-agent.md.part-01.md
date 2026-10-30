<!-- Preserves an ordered historical design section so repository restructuring retains the complete technical discussion and supports reconstruction against its original checksum. -->
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
