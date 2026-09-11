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
- Input schema sai bị reject trước khi runtime thực thi.

## 7. Giai đoạn 4 - Chặn built-in và unknown tools

### Agent construction policy

Chỉ truyền `tools: forgeTools`. Không truyền hosted tools, MCP servers hoặc
tool provider mặc định ngoài allowlist.

### Gateway policy

- Validate tool definitions trước request.
- Validate mọi tool call trả về từ provider.
- Tool ngoài allowlist trả `OPENAI_TOOL_NOT_ALLOWED`.
- Không fallback tool lạ thành shell, patch, search hoặc read.
- Không dùng `toolChoice: "none"`; dùng auto để Agent có thể gọi Forge tools.

### Runtime policy

Ngay cả tool hợp lệ vẫn phải qua identity, role, project scope, path scope,
budget và lifecycle authorization.

### Tiêu chí hoàn thành

- Test chứng minh built-in tool không xuất hiện trong payload.
- Test provider giả lập trả tool lạ và runner reject đúng mã.
- Test MCP/built-in config bị reject khi runner khởi tạo.

## 8. Giai đoạn 5 - Runner lifecycle

### API nội bộ dự kiến

```js
const result = await runner.run({
  agentId,
  ticket,
  executionContext,
  correlationId,
  signal
});
```

### Terminal success

- Agent gọi `report_done` đúng schema.
- Nếu có code change, `commit_changes` đã thành công khi policy yêu cầu.
- Report, tool history, provider metadata và final state được persist.

### Terminal failure

- Provider/gateway failure không retry được.
- Tool không được phép hoặc input invalid.
- Budget/timeout/cancellation.
- Agent không gọi `report_done` trước khi hết giới hạn.
- Commit hoặc test bắt buộc thất bại.

Runner không trả từng vòng cho Supervisor như một workflow mới. Supervisor chỉ
nhận terminal outcome, còn audit/event stream có thể theo dõi riêng.

## 9. Giai đoạn 6 - Persistence và observability

### Persist

- execution id, ticket id, agent id, correlation id.
- provider response/session id nếu có.
- current turn/tool count/budget usage.
- tool input đã redact secret.
- tool result/error đã giới hạn kích thước.
- report_done payload.
- terminal status và failure code.

### Log event

```text
agent.execution.started
agent.tool_call.started
agent.tool_call.succeeded
agent.tool_call.failed
agent.execution.budget_exceeded
agent.execution.completed
agent.execution.failed
```

Không ghi raw API key, full Authorization header hoặc provider payload chứa
secret.

## 10. Giai đoạn 7 - Tích hợp song song với Supervisor

### Dispatch

- Thêm runner mode/config flag, ví dụ `agent_execution_mode=sdk`.
- Mặc định giữ mode hiện tại.
- Chỉ dispatch Agent OpenAI-compatible sang SDK runner khi flag bật.
- Các provider khác tiếp tục dùng adapter hiện tại.
- Không thay đổi response contract của API dispatch trong giai đoạn thử nghiệm.

### Supervisor boundary

Supervisor chịu trách nhiệm:

- chọn Agent;
- tạo execution context;
- enqueue execution;
- nhận terminal result;
- cập nhật ticket/lifecycle.

Supervisor không được:

- tự gọi Forge tool thay Agent;
- tự đọc file hoặc patch file;
- tự suy luận thay Agent khi tool loop đang chạy.

## 11. Giai đoạn 8 - Test strategy

### Unit tests

- Provider factory tạo đúng gateway/model/key.
- Reasoning effort được map đúng và reject giá trị invalid.
- Execution context immutable và đúng scope.
- Tool factory tạo đúng sáu tool.
- Built-in/unknown tool bị chặn.
- Secret bị redact khỏi log/result.
- `report_done` chỉ được gọi một lần.

### Integration test với fake gateway

Kịch bản bắt buộc:

```text
response 1: search_code
Node result
response 2: read_file
Node result
response 3: write_diff
Node result
response 4: run_test (pass)
Node result
response 5: commit_changes
Node result
response 6: report_done
terminal success
```

Kịch bản lỗi:

- `run_test` fail rồi Agent sửa và chạy lại.
- Provider gọi tool built-in.
- Agent đọc path ngoài scope.
- Checksum conflict ở `write_diff`.
- Vượt max tool calls.
- Gateway timeout/cancel.
- Agent gọi `report_done` trước commit khi commit bắt buộc.

### Regression tests

- Toàn bộ test R1/R2/R3 và `sender-worker` vẫn pass.
- Legacy provider adapters không bị thay đổi behavior.
- API dispatch cũ vẫn trả contract hiện tại.

## 12. Giai đoạn 9 - Shadow run và cutover

1. Chạy SDK runner trên fake gateway.
2. Chạy integration trên một Agent test riêng.
3. Shadow dispatch: pipeline cũ là nguồn kết quả, SDK runner chỉ ghi audit.
4. So sánh tool sequence, final report, latency và failure rate.
5. Bật SDK mode cho một role/Agent cụ thể.
6. Mở rộng theo feature flag.
7. Chỉ sau khi ổn định mới cân nhắc chuyển default.

Không xóa code pipeline cũ cho đến khi có quyết định migration riêng.

## 13. Thứ tự file dự kiến

1. `backend/package.json` và lockfile.
2. `backend/src/modules/agent/openai-provider-factory.js`.
3. `backend/src/modules/agent/agent-execution-context.js`.
4. `backend/src/modules/agent/forge-sdk-tool-factory.js`.
5. `backend/src/modules/agent/sdk-agent-runner.js`.
6. `backend/src/modules/agent/agent-runner-errors.js`.
7. Integration adapter trong Supervisor/production runtime.
8. Unit/integration/regression tests.
9. Feature flag và operational configuration.

## 14. Tiêu chí nghiệm thu tổng thể

- Agent tự hoàn thành vòng model/tool mà Supervisor không điều phối từng tool.
- Chỉ sáu Forge tools xuất hiện trong Agent run.
- Không có OpenAI built-in, MCP hoặc unknown tool được thực thi.
- API key đi qua credential resolver và không xuất hiện trong log/prompt.
- Gateway, model và reasoning effort lấy từ Agent profile đã validate.
- Mọi tool call đều có execution context đúng và được audit.
- `write_diff`, `run_test`, `commit_changes`, `report_done` tuân thủ lifecycle.
- Terminal result được persist và Supervisor nhận đúng một outcome cuối.
- Pipeline hiện tại và test regression không bị phá.
- Có feature flag để bật/tắt SDK runner và rollback về pipeline cũ.

