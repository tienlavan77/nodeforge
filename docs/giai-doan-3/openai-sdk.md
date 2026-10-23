# OpenAI Agents SDK cho NodeForge

## 1. Mục tiêu

NodeForge sử dụng OpenAI Agents SDK làm execution loop cho Agent OpenAI/Codex.
SDK chịu trách nhiệm điều phối vòng lặp model → tool call → tool result → model
tiếp tục. NodeForge Runtime vẫn giữ toàn bộ quyền governance, authorization,
persistence và lifecycle.

Thiết kế này cho phép Supervisor chỉ chọn Agent, truyền ticket cùng execution
context và nhận kết quả cuối. Agent tự suy luận, tự chọn tool, tự lặp lại sau
khi test thất bại và tự quyết định khi nào hoàn tất.

Đây là tài liệu thiết kế; chưa bao gồm việc triển khai SDK runner vào pipeline
hiện tại.

## 2. Kiến trúc tổng thể

```text
Supervisor
  → chọn agent profile
  → tạo execution_context bất biến
  → dispatch ticket

NodeForge Agent Runner
  → resolve gateway_url
  → resolve credential_ref thành API key trong memory
  → chọn model và reasoning effort
  → tạo OpenAIProvider
  → tạo Agent với đúng Forge tools
  → gọi SDK run()

OpenAI Agents SDK
  → model response
  → Forge function tool call
  → nhận tool result
  → tiếp tục vòng làm việc
  → dừng ở report_done hoặc terminal error

Forge Runtime
  → validate schema
  → authorize theo execution context
  → thực thi tool
  → kiểm soát budget, checksum, atomic apply và audit

Supervisor
  → nhận final report/result
  → cập nhật ticket và lifecycle state
```

SDK chỉ là bộ điều phối Agent loop. SDK không được phép truy cập trực tiếp
filesystem, git, process hoặc database của NodeForge.

## 3. Agent profile và gateway

Agent profile cần chứa tối thiểu:

```json
{
  "agent_id": "builder",
  "agent_name": "Builder",
  "role": "coder",
  "provider": "openai_compatible",
  "gateway_url": "https://gateway.example.com/v1",
  "credential_ref": "secret:agent:builder",
  "model": "gpt-5.6-sol",
  "reasoning": {
    "effort": "high"
  },
  "enabled": true
}
```

`gateway_url` là base URL tương thích OpenAI, không lưu sẵn `/responses`.
Gateway cần hỗ trợ tối thiểu endpoint Responses API tương thích với SDK.

API key không đi qua Supervisor, prompt hoặc UI. NodeForge resolve
`credential_ref` từ Secret Store rồi truyền key vào provider trong memory.
Database chỉ lưu reference và giá trị masked.

Mỗi Agent phải có provider riêng. Không dùng global API key hoặc global
provider vì hệ thống có thể chạy nhiều Agent với gateway và credential khác
nhau.

## 4. Model và mức độ suy nghĩ

Model được chọn từ Agent profile và phải được backend kiểm tra trước khi chạy.
Agent không được tự ý đổi model trong execution.

```js
const agent = new Agent({
  name: profile.agent_name,
  instructions,
  model: profile.model,
  modelSettings: {
    reasoning: {
      effort: profile.reasoning?.effort ?? "medium"
    }
  },
  tools: forgeTools
});
```

Các giá trị reasoning được phép ở NodeForge:

```text
none | low | medium | high | max
```

Backend phải kiểm tra khả năng của model/gateway. Nếu model không hỗ trợ một
mức reasoning, phải báo lỗi cấu hình rõ ràng hoặc hạ xuống mức mặc định theo
policy đã định; không silently gửi payload không tương thích.

Có thể bổ sung các execution limits sau vào profile hoặc execution context:

```json
{
  "max_turns": 80,
  "tool_timeout_ms": 120000,
  "context_budget": 100000
}
```

Các giới hạn này do NodeForge quản lý, không giao toàn quyền cho SDK.

## 5. Sáu Forge tools được expose cho Agent

Agent chỉ được thấy đúng sáu function tools sau:

| Tool | Vai trò |
| --- | --- |
| `search_code` | Tìm file/symbol/snippet liên quan từ task context hoặc query. Node quyết định kết quả và scope. |
| `read_file` | Đọc full content của một file đã được phép trong execution context. |
| `write_diff` | Ghi thay đổi vào file được phép, kèm checksum và kiểm soát atomic apply. |
| `run_test` | Chạy test/build/verify thật qua Node và trả kết quả cho Agent. |
| `commit_changes` | Commit thay đổi hợp lệ trên branch của ticket qua git wrapper. |
| `report_done` | Báo cáo terminal bắt buộc để kết thúc execution và trả kết quả cho Supervisor. |

Vòng làm việc chuẩn:

```text
search_code
  → read_file
  → write_diff
  → run_test
  → (nếu fail: read_file/write_diff/run_test lặp lại)
  → commit_changes
  → report_done
```

Không phải task nào cũng cần gọi đủ sáu tool. Task chỉ đọc/điều tra có thể
dừng sau `search_code` hoặc `read_file`. Task có thay đổi code phải chạy
`run_test`; task đã thay đổi code chỉ được hoàn tất sau `commit_changes` và
`report_done`, trừ khi execution policy cho phép trạng thái không commit.

## 6. Tool adapter

Mỗi Forge tool được bọc thành SDK function tool. Adapter không thực hiện
filesystem hoặc git trực tiếp:

```js
tool({
  name: definition.name,
  description: definition.description,
  parameters: definition.inputSchema,
  strict: true,
  async execute(input, context, details) {
    return forgeToolRuntime.execute({
      toolName: definition.name,
      input,
      executionContext: context.execution_context,
      agentId: context.agent_id,
      ticketId: context.ticket_id,
      signal: details.signal
    });
  }
});
```

`forgeToolRuntime.execute()` là điểm bắt buộc để Node kiểm tra:

- Agent identity và role.
- Ticket/project scope.
- Execution context và approved paths.
- Schema và input size.
- Context/retrieval budget.
- Checksum trước khi ghi.
- Atomic apply và persistence.
- Tool timeout và cancellation.
- Audit event cho input/result/error.

## 7. Chặn toàn bộ OpenAI built-in tools

Không expose hoặc import các tool built-in/hosted của OpenAI:

```text
web search
file search
code interpreter
image generation
shell
apply patch
computer
tool search
programmatic tool calling
Codex tool
MCP tools/server
```

Agent construction chỉ truyền `tools: forgeTools` và không truyền hosted tools,
MCP servers hoặc built-in execution tools.

Không dùng `toolChoice: "none"`, vì sẽ chặn cả Forge tools. Dùng chế độ tự
chọn tool của SDK, đồng thời áp dụng allowlist ở NodeForge.

Gateway request phải validate toàn bộ tool definitions trước khi gửi. Nếu
provider trả về một tool call không thuộc allowlist sáu tool, NodeForge reject
với mã:

```text
OPENAI_TOOL_NOT_ALLOWED
```

Không được fallback tool lạ thành shell, patch, file search hoặc một capability
khác.

## 8. Prompt contract cho Agent

Prompt của Agent phải nêu rõ:

```text
You may use only the six Forge tools exposed in this run:
search_code, read_file, write_diff, run_test, commit_changes, report_done.

Call search_code before discovering files.
Call read_file only for paths returned by search_code or explicitly approved in
execution_context.
Use write_diff as the only code modification path.
Call run_test after modifying code.
If tests fail, inspect the result and iterate through the tools.
Call commit_changes before completion when code was modified and commit policy
allows it.
Call report_done exactly once to finish the execution.
Do not request directories, repository dumps, shell access, external search,
built-in OpenAI tools, MCP tools, or tools not present in this run.
```

Prompt chỉ hướng dẫn Agent. Enforcement thật phải nằm ở tool registry và Forge
Runtime, không phụ thuộc vào việc Agent tuân thủ prompt.

## 9. Execution context và session

Supervisor truyền một execution context đã freeze cho Agent, tối thiểu gồm:

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
    "max_context_bytes": 100000
  }
}
```

SDK session/run history có thể được dùng để tiếp tục vòng lặp, nhưng NodeForge
vẫn phải lưu execution context, tool call/result audit, provider response id,
budget và lifecycle trong store riêng. Không phụ thuộc hoàn toàn vào session
được lưu bên ngoài NodeForge.

## 10. Terminal conditions

Execution kết thúc hợp lệ khi:

- Agent gọi `report_done` đúng schema.
- Code đã sửa được commit nếu policy yêu cầu.
- Node đã lưu report, tool history và trạng thái cuối.

Execution kết thúc lỗi khi:

- Agent gọi tool ngoài allowlist.
- Input không hợp lệ hoặc vi phạm execution scope.
- Vượt max turns, max tool calls, context budget hoặc timeout.
- Provider/gateway lỗi không thể retry.
- Agent không gọi được `report_done` trước khi hết budget.

Supervisor chỉ nhận terminal outcome, không tự đọc file, tự suy luận, tự chọn
tool hoặc tự patch thay Agent.

## 11. Phạm vi triển khai sau này

Khi bắt đầu code, triển khai song song với pipeline hiện tại:

1. Thêm `sdk-agent-runner` cho provider OpenAI-compatible.
2. Map schema sáu Forge tools sang SDK function tools.
3. Thêm provider factory theo `gateway_url`, `credential_ref`, `model` và
   `reasoning.effort`.
4. Thêm allowlist và rejection cho built-in/unknown tools.
5. Thêm integration test: tool call → Forge result → SDK tiếp tục →
   `report_done`.
6. Chỉ chuyển Supervisor dispatch sang runner mới sau khi flow mới ổn định.

## 12. Quyết định đã thống nhất

- Dùng OpenAI Agents SDK để Agent tự quản lý vòng làm việc.
- Gọi Agent qua gateway OpenAI-compatible.
- API key do NodeForge resolve từ credential reference.
- Model và reasoning effort do Agent profile/backend quyết định.
- Agent chỉ được dùng sáu Forge tools.
- Chặn toàn bộ OpenAI built-in tools, MCP và capability ngoài allowlist.
- Forge Runtime vẫn sở hữu permission, scope, budget, checksum, atomic apply,
  audit, persistence và lifecycle.
- Tài liệu này là thiết kế; chưa code triển khai SDK runner.

