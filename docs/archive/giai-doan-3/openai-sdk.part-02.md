<!-- Preserves an ordered historical design section so repository cleanup retains the complete original technical discussion and supports checksum reconstruction. -->

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

