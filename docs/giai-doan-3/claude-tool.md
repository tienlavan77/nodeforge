# Built-in tools của Claude Agent SDK

> Tài liệu này mô tả nhóm công cụ và cách cấp quyền trong `@anthropic-ai/claude-agent-sdk`. Phiên bản đang dùng trong NodeForge: `0.3.263`. Tên tool thực tế có thể thay đổi theo phiên bản Claude Code, cấu hình runtime, model và permission policy.
>
> Trong tài liệu này, **tool** là khả năng mà model có thể gọi trong một turn. `Options`, hook và control API là cơ chế điều khiển SDK, không phải tool mà model gọi trực tiếp.

## 1. Ba lớp công cụ cần phân biệt

### 1.1 Built-in Claude Code tools

Đây là các tool do Claude Code cung cấp sẵn cho agent. Chúng được bật bằng option `tools` hoặc preset `claude_code`.

### 1.2 MCP tools

MCP server cung cấp tool động, thường có tên dạng `mcp__<server>__<tool>`. Chúng không thuộc danh sách built-in cố định; tên, schema và quyền phụ thuộc server được đăng ký.

### 1.3 Custom tools và subagent tools

Ứng dụng có thể đăng ký custom tool qua MCP hoặc SDK tool definition. `Agent`/`Task` cho phép gọi subagent đã khai báo trong `agents`; subagent có thể nhận một allowlist tool riêng.

## 2. Các nhóm built-in chính

### 2.1 Đọc filesystem và tìm kiếm mã nguồn

| Tool | Mục đích | Ghi chú |
|---|---|---|
| `Read` | Đọc nội dung file hoặc tài nguyên trong workspace | Bị giới hạn bởi cwd, additional directories và read permission |
| `Glob` | Tìm file theo glob pattern | Dùng để định vị file trước khi đọc |
| `Grep` | Tìm chuỗi hoặc pattern trong file | Dùng để tìm symbol, route, config và references |
| `LSP` | Lấy thông tin ngôn ngữ như definition, references, diagnostics | Chỉ xuất hiện khi runtime/model có hỗ trợ LSP tương ứng |

`Read`, `Grep`, `Glob` là nhóm read-only phù hợp cho retrieval, review và lập ticket. `Grep`/`Glob` có thể không được expose ở một số native build; khi đó model có thể dùng `Bash` với `find`/`grep` nếu `Bash` được cấp.

### 2.2 Sửa file và thay đổi workspace

| Tool | Mục đích |
|---|---|
| `Edit` | Sửa một file hiện có bằng thay đổi có kiểm soát |
| `Write` | Tạo hoặc ghi lại file |
| `NotebookEdit` | Sửa cell trong Jupyter notebook |

Đây là nhóm mutation. Việc tool xuất hiện không đồng nghĩa thao tác được phép: permission mode, hook và sandbox vẫn có thể từ chối thao tác.

### 2.3 Chạy lệnh và process

| Tool | Mục đích |
|---|---|
| `Bash` | Chạy command trong môi trường làm việc |
| `Bash` background/task mode | Chạy tác vụ dài và nhận kết quả sau |
| `KillShell` | Dừng process/shell đang chạy |

`Bash` có blast radius lớn nhất trong nhóm built-in vì có thể đọc, sửa file, gọi chương trình và tác động môi trường. Cần dùng sandbox, allow/deny rule và approval policy thay vì chỉ dựa vào prompt.

### 2.4 Web và network

| Tool | Mục đích |
|---|---|
| `WebSearch` | Tìm thông tin trên web |
| `WebFetch` | Lấy và phân tích nội dung từ URL |

Web tool có thể bị tắt bởi runtime hoặc policy. Domain restriction, preflight và network policy phải được cấu hình riêng; quyền đọc filesystem không cấp quyền network.

### 2.5 Điều phối agent và task

| Tool | Mục đích |
|---|---|
| `Agent` | Khởi chạy subagent đã khai báo trong `agents` |
| `Task` | Tên/biến thể điều phối task tùy runtime và phiên bản CLI |
| `SendMessage` | Gửi thông tin cho agent hoặc phiên liên quan trong cơ chế collaboration |
| `TaskOutput` | Đọc kết quả task background |
| `TaskStop` | Dừng task đang chạy |

Các tên trên có thể được gộp hoặc đổi theo phiên bản runtime. Khi cần contract ổn định, kiểm tra `sdk.d.ts` và event/tool schema của đúng phiên bản đang cài.

### 2.6 Lập kế hoạch và tương tác người dùng

| Tool/capability | Mục đích |
|---|---|
| `EnterPlanMode` / plan mode | Lập kế hoạch mà chưa thực thi thay đổi |
| `ExitPlanMode` | Kết thúc plan mode và xin/nhận phê duyệt theo host |
| `AskUserQuestion` | Hỏi người dùng các lựa chọn hoặc thông tin còn thiếu |
| `TodoWrite` | Theo dõi danh sách việc trong phiên |
| `Skill` | Kích hoạt skill đã được cấu hình |

Một số mục ở đây là tên command hoặc host capability của Claude Code, không phải lúc nào cũng là tool wire độc lập trong mọi bản SDK. Không nên tự đưa chúng vào allowlist nếu chưa thấy chúng trong runtime tool schema.

### 2.7 Notebook, hình ảnh và tài nguyên đặc biệt

- `NotebookEdit`: chỉnh cell code/markdown trong `.ipynb`.
- `ViewImage`: đọc hình ảnh cục bộ khi image capability được bật.
- `Read` có thể đọc nhiều dạng tài nguyên do host hỗ trợ, nhưng giới hạn cụ thể do runtime quyết định.

## 3. MCP resource và MCP tool

MCP có hai loại surface thường gặp:

- Resource operations: liệt kê/đọc resource của server, ví dụ `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`.
- Tool operations: tool do server định nghĩa, thường được namespace thành `mcp__server__tool`.

MCP tool không tự động có chỉ vì server tồn tại. Host phải đăng ký server, expose tool và áp dụng permission rule. Không nên ghi cứng danh sách MCP tool vào tài liệu built-in.

## 4. Cấu hình danh sách tool

### 4.1 Chọn bộ tool cơ sở bằng `tools`

```js
query(prompt, {
  tools: ["Read", "Grep", "Glob"],
  cwd: projectRoot
});
```

Các dạng hợp lệ:

- `tools: ["Read", "Grep", "Glob"]`: chỉ bật các tool được liệt kê.
- `tools: []`: tắt toàn bộ built-in tools.
- `tools: { type: "preset", preset: "claude_code" }`: dùng bộ tool mặc định của Claude Code.

### 4.2 `allowedTools` và `disallowedTools`

- `allowedTools`: tool được tự động cho phép mà không hỏi approval; không phải cơ chế duy nhất để giới hạn tool.
- `disallowedTools`: loại tool khỏi context và chặn không cho dùng.
- Muốn giới hạn tool khả dụng, ưu tiên `tools` với allowlist tối thiểu rồi dùng `disallowedTools` cho lớp deny bổ sung.

### 4.3 `toolAliases`

`toolAliases` ánh xạ tên tool model phát ra sang tên khác, ví dụ:

```js
toolAliases: { Bash: "mcp__workspace__bash" }
```

Alias chỉ đổi đường phân giải tên; không thay thế `disallowedTools`, sandbox hoặc governance.

## 5. Permission và sandbox

`permissionMode` thường có các giá trị:

- `default`: policy bình thường, thao tác nguy hiểm có thể cần hỏi.
- `acceptEdits`: tự chấp nhận thao tác sửa file theo policy.
- `plan`: chỉ lập kế hoạch, không thực thi thay đổi.
- `dontAsk`: không hỏi; thao tác chưa được cho phép sẽ bị từ chối.
- `auto`: dùng classifier/policy tự động.
- `bypassPermissions`: bỏ qua permission checks; chỉ dùng trong môi trường được kiểm soát và phải bật cờ cho phép nguy hiểm.

`canUseTool` là callback kiểm soát trước mỗi invocation. Hooks như `PreToolUse`, `PostToolUse`, `PostToolUseFailure` dùng để audit, chặn hoặc ghi nhận kết quả. Permission không thay thế validation đầu vào và giới hạn path ở tầng ứng dụng.

## 6. Ví dụ cấu hình theo loại agent

### 6.1 Agent chỉ đọc để lập ticket

```js
const options = {
  cwd: projectRoot,
  tools: ["Read", "Grep", "Glob"],
  disallowedTools: ["Bash", "Edit", "Write", "WebFetch", "WebSearch"],
  permissionMode: "dontAsk"
};
```

### 6.2 Agent sửa code và chạy test

```js
const options = {
  cwd: projectRoot,
  tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
  permissionMode: "default"
};
```

Cần bổ sung sandbox, path allowlist, command policy và hook audit theo môi trường triển khai.

## 7. Áp dụng trong NodeForge

Luồng Sprint Leader hiện chỉ cấp:

```js
options: { allowedTools: ["Read", "Grep", "Glob"] }
```

Mục đích là để leader tìm và xác minh `candidate_files`, không cho sửa code, chạy shell, gọi web hay dùng Forge MCP. Đây là read-only ticket drafting flow.

Các Forge tools như `search_code`, `read_code`, `read_file`, `write_diff`, `run_test`, `check_test` là tool NodeForge/MCP riêng, không phải built-in Claude Agent SDK. Luồng nào cần chúng phải đăng ký Forge MCP server và áp dụng governance context riêng.

## 8. Cách kiểm tra chính xác tool đang khả dụng

1. Kiểm tra version package trong `package.json` và lockfile.
2. Đọc `sdk.d.ts` của đúng package để biết option và type được hỗ trợ.
3. Kiểm tra runtime tool schema hoặc log `PreToolUse` để biết tool thực sự được expose.
4. Kiểm tra `tools`, `allowedTools`, `disallowedTools`, MCP server và permission mode cùng lúc.
5. Không suy luận rằng tool có trong Claude Code CLI thì chắc chắn có trong mọi bản Agent SDK.

## 9. Quy tắc an toàn

- Cấp quyền tối thiểu theo vai trò; ticket/retrieval chỉ cần `Read`, `Grep`, `Glob`.
- Không dùng prompt để thay thế hard permission hoặc sandbox.
- Không bật `Bash`, `Write`, `Edit` cho agent chỉ cần phân tích.
- Không log prompt, credential, token hoặc toàn bộ tool result nếu không cần.
- Với MCP, kiểm tra schema, namespace, authorization và audit cho từng `tools/call`.
- Sau khi nâng SDK, chạy lại test tool exposure, permission denial, MCP routing và output parsing.

## 10. Nguồn kiểm chứng trong repository

- Type definitions: `backend/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
- Package version: `backend/package.json`
- Sprint Leader read-only runner: `backend/src/application/ticket-sprint-leader.js`
- Claude gateway: `backend/src/modules/agent/claude-sdk-gateway.js`
- Forge tool registry: `backend/src/tools/index.js`
