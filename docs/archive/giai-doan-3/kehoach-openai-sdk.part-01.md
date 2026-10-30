<!-- Preserves an ordered historical design section so repository cleanup retains the complete original technical discussion and supports checksum reconstruction. -->
# Kế hoạch triển khai OpenAI Agents SDK

## Trạng thái

Đây là kế hoạch triển khai, chưa thực hiện code và chưa thay thế pipeline
R1/R2/R3 hoặc `sender-worker` hiện tại.

Tài liệu thiết kế nền tảng: `docs/giai-doan-3/openai-sdk.md`.

## 1. Mục tiêu triển khai

Xây dựng một Agent Runner mới dùng OpenAI Agents SDK để Agent tự quản lý vòng
làm việc:

```text
model
  → Forge tool call
  → Node Runtime execute
  → tool result
  → model tiếp tục
  → report_done
```

Runner phải:

- Gọi qua OpenAI-compatible gateway.
- Resolve API key từ `credential_ref`, không đưa secret vào prompt hoặc queue.
- Chọn model và reasoning effort từ Agent profile/backend.
- Chỉ expose đúng sáu Forge tools.
- Chặn OpenAI built-in tools, MCP và tool ngoài allowlist.
- Truyền nguyên `execution_context` trong suốt execution.
- Để Forge Runtime kiểm soát permission, scope, budget, checksum, audit và
  lifecycle.
- Chạy song song với pipeline hiện tại trước khi cutover.

## 2. Phạm vi không làm trong đợt đầu

- Không xóa hoặc sửa semantics của R1/R2/R3.
- Không thay thế `sender-worker` ngay.
- Không cho SDK truy cập filesystem, shell, git hoặc database trực tiếp.
- Không expose `web_search`, `file_search`, `code_interpreter`, `shell`,
  `apply_patch`, `computer`, `tool_search`, `programmatic_tool_calling`,
  Codex tool hoặc MCP server.
- Không dùng global OpenAI API key/provider cho nhiều Agent.
- Không cho Agent tự chọn model, gateway hoặc reasoning effort trong task.
- Không chuyển Anthropic/Claude sang runner này; runner đầu tiên chỉ dành cho
  OpenAI-compatible provider.

## 3. Kiến trúc triển khai

```text
Supervisor dispatch
  → Agent execution service
  → sdk-agent-runner
      → profile resolver
      → credential resolver
      → OpenAIProvider factory
      → Forge SDK tool factory
      → Agents SDK run()
      → terminal result
  → execution state/result store
  → Supervisor nhận final outcome
```

Trong mỗi lần chạy:

1. Supervisor tạo hoặc lấy `execution_context` đã freeze.
2. Runner kiểm tra profile, provider, model, reasoning và budget.
3. Runner tạo provider theo gateway và credential của Agent.
4. Runner tạo Agent với sáu Forge tools.
5. SDK tự điều phối các lượt model/tool.
6. Mỗi tool call đi qua `forgeToolRuntime.execute()`.
7. Runner dừng ở `report_done`, lỗi terminal hoặc hết budget.
8. Runner lưu terminal result và trả một outcome duy nhất cho Supervisor.

## 4. Giai đoạn 1 - Chuẩn hóa dependency và cấu hình

### Files/module dự kiến

- `backend/package.json`
- `backend/src/modules/agent/sdk-agent-runner.js`
- `backend/src/modules/agent/openai-provider-factory.js`
- `backend/src/modules/agent/agent-execution-context.js`
- `backend/src/modules/agent/agent-runner-errors.js`

### Công việc

- Thêm dependency OpenAI Agents SDK tương thích với Node runtime.
- Xác định version cố định trong lockfile.
- Tạo provider factory nhận:
  - `gateway_url` dạng OpenAI-compatible base URL.
  - API key đã resolve.
  - `model`.
  - `useResponses`/API mode.
- Không log API key, credential value hoặc Authorization header.
- Chuẩn hóa profile:

```json
{
  "provider": "openai_compatible",
  "gateway_url": "https://gateway.example.com/v1",
  "credential_ref": "secret:agent:builder",
  "model": "gpt-5.6-sol",
  "reasoning": { "effort": "high" }
}
```

### Tiêu chí hoàn thành

- Có thể tạo provider riêng cho từng Agent.
- Gateway URL không bị nối lặp `/v1`, `/responses`.
- Credential chỉ tồn tại trong memory của execution.
- Profile không hợp lệ bị reject trước provider call.

## 5. Giai đoạn 2 - Execution context và budget

### Contract

```json
{
  "ticket_id": "FORGE-001",
  "project_id": "PROJECT-NODEFORGE",
  "agent_id": "builder",
  "task_context": "...",
  "acceptance_criteria": [],
  "approved_paths": [],
  "scope": "ticket",
  "budget": {
    "max_turns": 80,
    "max_tool_calls": 120,
    "max_context_bytes": 100000,
    "tool_timeout_ms": 120000
  }
}
```

### Công việc

- Tạo immutable execution context ở boundary dispatch.
- Không cho Agent sửa `ticket_id`, `project_id`, `agent_id`, `approved_paths`
  hoặc budget.
- Truyền context vào SDK run context để mọi tool adapter đọc được.
- Theo dõi số lượt model, số tool call, bytes retrieval và thời gian chạy.
- Dừng execution khi vượt bất kỳ limit nào.

### Tiêu chí hoàn thành

- Mọi tool call đều gắn đúng ticket/project/agent execution.
- Không có tool nào nhận context rỗng hoặc context của execution khác.
- Budget exhaustion trả lỗi chuẩn và được lưu audit.

## 6. Giai đoạn 3 - Forge SDK tool factory

### Sáu tool bắt buộc

```text
search_code
read_file
write_diff
run_test
commit_changes
report_done
```

### Công việc

- Tạo `forge-sdk-tool-factory.js` để map tool definition/schema hiện có sang
  SDK function tool.
- Dùng schema strict hiện có, không tạo schema song song không tương thích.
- Adapter chỉ gọi `forgeToolRuntime.execute()`.
- Truyền `execution_context`, `agent_id`, `ticket_id`, `signal` và correlation
  id vào runtime.
- Chuẩn hóa result/error thành JSON serializable.
- Ghi audit cho `tool_call.started`, `tool_call.succeeded` và
  `tool_call.failed`.

### Quy tắc từng tool

- `search_code`: Node quyết định file/symbol/snippet được trả về; không trả
  repository dump.
- `read_file`: chỉ đọc path đã được search hoặc approved trong context.
- `write_diff`: chỉ ghi file thuộc scope, kiểm tra checksum và atomic apply.
- `run_test`: Node thực thi test/build/verify; Agent phải nhận kết quả thật.
- `commit_changes`: chỉ commit branch/ticket được runtime cấp phép.
- `report_done`: terminal tool, được gọi đúng một lần.

### Tiêu chí hoàn thành

- SDK chỉ nhận đúng sáu tool definitions.
- Tool adapter không có thao tác filesystem/git/process trực tiếp.
