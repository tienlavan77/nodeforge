<!-- Tài liệu mô tả các built-in tool và event của Codex SDK dùng cho discovery candidate trong NodeForge. -->

# Codex SDK tools

Tài liệu này mô tả `@openai/codex-sdk` 0.154.0 đang được NodeForge sử dụng.

## Phân loại

Codex có các item sau trong stream:

| Item | Vai trò | Hành động | Dữ liệu chính |
| --- | --- | --- | --- |
| `command_execution` | Chạy lệnh shell | Có | `command`, `aggregated_output`, `exit_code`, `status` |
| `file_change` | Kết quả patch file | Có | `changes[]`, `status` |
| `web_search` | Tìm kiếm web | Có | `query` |
| `mcp_tool_call` | Gọi MCP server | Có, external | `server`, `tool`, `arguments`, `result`, `error`, `status` |
| `agent_message` | Câu trả lời cuối | Không | `text` |
| `reasoning` | Tóm tắt suy luận | Không | `text` |
| `todo_list` | Kế hoạch công việc | Không | `items[]` |
| `error` | Lỗi trong stream | Không | `message` |

## Built-in tools

### `command_execution`

Đây là tool chính để Agent khám phá codebase. Codex không có các tool riêng tên `Read`, `Grep` hoặc `Glob`; Agent thực hiện các thao tác tương đương bằng shell:

```bash
rg --files
rg -n "symbol|keyword" backend ui
find backend -type f
sed -n '1,160p' backend/src/example.js
cat backend/src/example.js
```

Item có trạng thái `in_progress`, `completed` hoặc `failed`:

```json
{
  "type": "command_execution",
  "command": "rg -n \"ticket_id\" backend/src",
  "aggregated_output": "...",
  "exit_code": 0,
  "status": "completed"
}
```

Candidate chỉ được xem là đã kiểm chứng khi có command thành công đọc hoặc xác nhận file và symbol tương ứng.

### `file_change`

Item này mô tả patch mà Agent đã tạo hoặc áp dụng:

```json
{
  "type": "file_change",
  "changes": [
    { "path": "backend/src/example.js", "kind": "update" }
  ],
  "status": "completed"
}
```

`kind` có thể là `add`, `update` hoặc `delete`. Đây là kết quả thay đổi file, không phải API `edit_file` riêng.

### `web_search`

```json
{ "type": "web_search", "query": "..." }
```

Chế độ được điều khiển bởi `webSearchMode`: `disabled`, `cached` hoặc `live`. NodeForge hiện đặt `disabled` cho Sprint Leader, vì candidate cần dựa trên codebase local.

## MCP và item trạng thái

### `mcp_tool_call`

Đây là lời gọi tới MCP server bên ngoài, không phải built-in tool:

```json
{
  "type": "mcp_tool_call",
  "server": "forge",
  "tool": "read_code",
  "arguments": {},
  "status": "completed",
  "result": {}
}
```

NodeForge chỉ có item này khi truyền `options.forgeTools` và dựng MCP bridge.

### `agent_message`

```json
{ "type": "agent_message", "text": "```json ... ```" }
```

Đây là nội dung cuối mà NodeForge parse thành ticket hoặc sprint plan. Với Codex SDK, gateway trả nội dung này ở `result.text`.

### `reasoning`, `todo_list`, `error`

`reasoning` là tóm tắt suy luận; `todo_list` là kế hoạch; `error` chứa lỗi stream. Không item nào trong ba loại này chứng minh Agent đã đọc file.

## Event vòng đời

SDK phát các event:

- `thread.started`
- `turn.started`
- `item.started`
- `item.updated`
- `item.completed`
- `turn.completed`
- `turn.failed`
- `error`

NodeForge cần ghi nhận `item.completed` cho `command_execution`, gồm command, output, exit code và status.

## Cấu hình Thread

SDK không hỗ trợ `allowedTools` như Claude SDK. Built-in tools được bật mặc định. Các tùy chọn liên quan là:

```js
{
  sandboxMode: "workspace-write",
  approvalPolicy: "never",
  networkAccessEnabled: false,
  workingDirectory: projectRoot,
  additionalDirectories: []
}
```

- `sandboxMode`: `read-only`, `workspace-write` hoặc `danger-full-access`.
- `approvalPolicy`: `never`, `on-request`, `on-failure` hoặc `untrusted`.
- `networkAccessEnabled`: bật hoặc tắt mạng trong workspace sandbox.
- `workingDirectory`: thư mục codebase mà Agent được khám phá.

Nếu Codex chạy lồng trong một sandbox khác và `command_execution` trả lỗi `bwrap: ... Operation not permitted`, tool đã được bật nhưng sandbox con không khởi tạo được. Cần xử lý lớp sandbox trước khi đánh giá candidate.

## Quy tắc candidate cho NodeForge

1. Prompt Codex phải yêu cầu dùng `rg`, `find`, `sed` hoặc `cat`, không gọi tên `Read/Grep/Glob`.
2. `candidate_files` vẫn là trường bắt buộc trong ticket cuối.
3. Server chỉ kiểm tra path nằm trong project, file tồn tại và symbol có thể xác định; server không thay candidate bằng retrieval khác.
4. Nếu command discovery thất bại, không được coi candidate là đã xác minh.
5. `candidate_files` trong `agent_message` phải được đối chiếu với các `command_execution` event trước khi lưu.
