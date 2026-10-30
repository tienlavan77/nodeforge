<!-- Preserves an ordered historical design section so repository cleanup retains the complete original technical discussion and supports checksum reconstruction. -->
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
